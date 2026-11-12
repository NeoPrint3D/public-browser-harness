#!/usr/bin/env node
/**
 * Public Browser harness — a small supervisor for an always-on Chrome.
 *
 * It owns one Chrome process per named profile:
 *   - a persistent `--user-data-dir` (cookies, logins, extensions survive),
 *   - a stable CDP port on 127.0.0.1,
 *   - health checks and automatic restarts,
 *   - systemd user units so the browser survives logout/reboot.
 *
 * Agents do not talk to this process. They start their own
 * `public-browser --attach --port <port>` MCP server, which connects to the
 * Chrome this harness keeps alive. Every agent gets its own tab; the profile
 * (cookies, logins) is shared.
 *
 * Usage: node harness/harness.mjs <command> [profile] [options]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(HERE, "profiles.json");
const HARNESS_VERSION = "1.0.0";
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_PORT = 9222;
const DEFAULT_STATE_DIR = "~/.public-browser/harness";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_RESTART_DELAY_MS = 1_000;
const DEFAULT_MAX_RESTART_DELAY_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;

// ── small helpers ──────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function expandHome(value) {
  if (typeof value !== "string" || value === "") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function readPid(file) {
  const raw = readTextFile(file);
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return pid > 0 ? pid : null;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function shellQuote(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function sdQuote(value) {
  return `"${String(value).replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function findOnPath(names) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

// ── config ─────────────────────────────────────────────────────────────

/**
 * Validate and normalise a harness config. Exported for tests.
 *
 * @param {unknown} raw
 * @param {string} [source]
 */
export function validateConfig(raw, source = "profiles.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: expected a JSON object.`);
  }
  if (!raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) {
    throw new Error(`${source}: "profiles" must be an object.`);
  }

  const names = Object.keys(raw.profiles);
  if (names.length === 0) {
    throw new Error(`${source}: "profiles" must contain at least one profile.`);
  }

  if (raw.ownerUid !== undefined && (!Number.isInteger(raw.ownerUid) || raw.ownerUid < 0)) {
    throw new Error(`${source}: ownerUid must be a non-negative integer.`);
  }
  const stateDir = path.resolve(expandHome(raw.stateDir || DEFAULT_STATE_DIR));
  const seenPorts = new Map();
  const seenDirectories = new Map();
  const profiles = {};

  for (const name of names) {
    if (!PROFILE_NAME_RE.test(name)) {
      throw new Error(
        `${source}: profile name ${JSON.stringify(name)} is invalid. ` +
          "Use letters, digits, dot, underscore or dash (max 64 chars).",
      );
    }
    const p = raw.profiles[name];
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new Error(`${source}: profile "${name}" must be an object.`);
    }

    if (p.profileDirectory !== undefined && (typeof p.profileDirectory !== "string" || !p.profileDirectory || /[\/\\\\]/.test(p.profileDirectory) || [".", ".."].includes(p.profileDirectory))) {
      throw new Error(`${source}: profileDirectory must be a single directory name.`);
    }
    if (p.expectedProfileName !== undefined && (typeof p.expectedProfileName !== "string" || !p.expectedProfileName)) {
      throw new Error(`${source}: expectedProfileName must be a non-empty string.`);
    }
    const port = p.port === undefined ? DEFAULT_PORT : Number(p.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${source}: profile "${name}" has invalid port ${JSON.stringify(p.port)}.`);
    }
    if (seenPorts.has(port)) {
      throw new Error(
        `${source}: profiles "${seenPorts.get(port)}" and "${name}" both use port ${port}. ` +
          "Give every profile its own CDP port.",
      );
    }
    seenPorts.set(port, name);

    const baseDir = path.join(stateDir, name);
    const userDataDir = path.resolve(expandHome(p.userDataDir || path.join(baseDir, "chrome-profile")));
    const downloadDir = path.resolve(expandHome(p.downloadDir || path.join(baseDir, "downloads")));
    const directoryKey = fs.existsSync(userDataDir) ? fs.realpathSync(userDataDir) : userDataDir;
    if (seenDirectories.has(directoryKey)) {
      throw new Error(`${source}: profiles "${seenDirectories.get(directoryKey)}" and "${name}" share userDataDir.`);
    }
    seenDirectories.set(directoryKey, name);
    for (const key of ["startupTimeoutMs", "restartDelayMs", "maxRestartDelayMs", "healthTimeoutMs", "maxLogBytes"]) {
      if (p[key] !== undefined && (!Number.isInteger(p[key]) || p[key] < 1)) {
        throw new Error(`${source}: profile "${name}".${key} must be a positive integer.`);
      }
    }

    for (const key of ["headless", "stealth", "restoreLastSession", "noSandbox", "disableDevShm"]) {
      if (p[key] !== undefined && typeof p[key] !== "boolean") {
        throw new Error(`${source}: profile "${name}".${key} must be a boolean.`);
      }
    }
    if (p.extraArgs !== undefined && (!Array.isArray(p.extraArgs) || p.extraArgs.some((arg) => typeof arg !== "string"))) {
      throw new Error(`${source}: profile "${name}".extraArgs must be an array of strings.`);
    }
    if (p.extraArgs?.some((arg) => /^--(?:remote-debugging(?:-[\w-]+)?|remote-allow-origins|user-data-dir|profile-directory)(?:=|$)/.test(arg))) {
      throw new Error(`${source}: profile "${name}".extraArgs must not override CDP or profile ownership flags.`);
    }
    if (p.env !== undefined && (typeof p.env !== "object" || p.env === null || Array.isArray(p.env))) {
      throw new Error(`${source}: profile "${name}".env must be an object.`);
    }
    if (p.passwordStore !== undefined && p.passwordStore !== null && typeof p.passwordStore !== "string") {
      throw new Error(`${source}: profile "${name}".passwordStore must be a string or null.`);
    }

    profiles[name] = {
      name,
      port,
      stateDir: baseDir,
      userDataDir,
      downloadDir,
      headless: p.headless === true,
      stealth: p.stealth !== false,
      restoreLastSession: p.restoreLastSession !== false,
      windowSize: typeof p.windowSize === "string" ? p.windowSize : "1440,900",
      startupUrl: typeof p.startupUrl === "string" && p.startupUrl ? p.startupUrl : "about:blank",
      profileDirectory: typeof p.profileDirectory === "string" ? p.profileDirectory : "Default",
      expectedProfileName: p.expectedProfileName,
      extraArgs: Array.isArray(p.extraArgs) ? p.extraArgs.map(String) : [],
      env: p.env && typeof p.env === "object" ? p.env : {},
      chromePath: p.chromePath ? expandHome(String(p.chromePath)) : undefined,
      noSandbox: p.noSandbox,
      disableDevShm: p.disableDevShm,
      passwordStore: p.passwordStore,
      startupTimeoutMs: Number.isFinite(Number(p.startupTimeoutMs))
        ? Number(p.startupTimeoutMs)
        : DEFAULT_STARTUP_TIMEOUT_MS,
      restartDelayMs: Number.isFinite(Number(p.restartDelayMs))
        ? Number(p.restartDelayMs)
        : DEFAULT_RESTART_DELAY_MS,
      maxRestartDelayMs: Number.isFinite(Number(p.maxRestartDelayMs))
        ? Number(p.maxRestartDelayMs)
        : DEFAULT_MAX_RESTART_DELAY_MS,
      healthTimeoutMs: Number.isFinite(Number(p.healthTimeoutMs))
        ? Number(p.healthTimeoutMs)
        : DEFAULT_HEALTH_TIMEOUT_MS,
      maxLogBytes: Number.isFinite(Number(p.maxLogBytes)) ? Number(p.maxLogBytes) : DEFAULT_MAX_LOG_BYTES,
    };
  }

  const defaultProfile =
    typeof raw.defaultProfile === "string" && raw.defaultProfile
      ? raw.defaultProfile
      : names[0];
  if (!profiles[defaultProfile]) {
    throw new Error(`${source}: defaultProfile "${defaultProfile}" does not exist in profiles.`);
  }

  return {
    configPath: source,
    ownerUid: raw.ownerUid,
    defaultProfile,
    stateDir,
    chromePath: raw.chromePath ? expandHome(String(raw.chromePath)) : undefined,
    profiles,
    profileNames: names,
  };
}

function mergeConfig(base, extra) {
  const merged = { ...base, ...extra };
  merged.profiles = { ...(base.profiles || {}) };
  for (const [name, profile] of Object.entries(extra.profiles || {})) {
    merged.profiles[name] = { ...(merged.profiles[name] || {}), ...profile };
  }
  return merged;
}

export function loadConfig(options = {}) {
  const configPath = path.resolve(
    expandHome(
      options.configPath ||
        process.env.PUBLIC_BROWSER_HARNESS_CONFIG ||
        DEFAULT_CONFIG_PATH,
    ),
  );
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `cannot read harness config ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Optional, git-ignored per-machine overrides next to the main config.
  const localPath = path.join(path.dirname(configPath), "profiles.local.json");
  if (fs.existsSync(localPath)) {
    try {
      raw = mergeConfig(raw, JSON.parse(fs.readFileSync(localPath, "utf8")));
    } catch (err) {
      throw new Error(
        `cannot read ${localPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return validateConfig(raw, configPath);
}

export function resolveProfile(config, name) {
  const profileName = name || config.defaultProfile;
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(
      `unknown profile "${profileName}". Known profiles: ${config.profileNames.join(", ")}.`,
    );
  }
  return profile;
}

// ── Chrome discovery / arguments ───────────────────────────────────────

const CHROME_CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    `${process.env.ProgramFiles || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"] || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findChromePath(config, profile) {
  const explicit =
    (profile && profile.chromePath) ||
    (config && config.chromePath) ||
    process.env.CHROME_PATH;
  if (explicit) {
    const resolved = expandHome(explicit);
    if (!isExecutable(resolved)) {
      throw new Error(
        `Chrome binary ${resolved} is not executable. Set CHROME_PATH or "chromePath" in the config.`,
      );
    }
    return resolved;
  }

  const candidates = CHROME_CANDIDATES[process.platform] || [];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  if (process.platform === "linux") {
    const onPath = findOnPath([
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]);
    if (onPath) return onPath;
  }

  throw new Error(
    "Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH " +
      '(for example CHROME_PATH="/usr/bin/google-chrome").',
  );
}

export function isChromeDefaultUserDataDir(dir) {
  const target = path.resolve(expandHome(dir));
  const home = os.homedir();
  const defaults = [
    path.join(home, ".config", "google-chrome"),
    path.join(home, ".config", "google-chrome-beta"),
    path.join(home, ".config", "google-chrome-unstable"),
    path.join(home, ".config", "chromium"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Chromium"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  ].filter(Boolean);
  const normalise = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  return defaults.some((candidate) => normalise(path.resolve(candidate)) === normalise(target));
}

/**
 * Build the Chrome command line for a profile. Exported for tests.
 */
export function buildChromeArgs(profile) {
  const args = [
    `--remote-debugging-port=${profile.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile.userDataDir}`,
    `--profile-directory=${profile.profileDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--enable-features=CDPScreenshotNewSurface",
    
    "--keep-alive-for-test",
    `--window-size=${profile.windowSize}`,
  ];

  if (profile.headless) args.push("--headless=new");
  if (profile.restoreLastSession) args.push("--restore-last-session");
  if (profile.stealth) args.push("--disable-blink-features=AutomationControlled");

  if (process.platform === "linux") {
    if (profile.passwordStore !== null) {
      args.push(`--password-store=${profile.passwordStore || "basic"}`);
    }
    const runningAsRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    if (profile.noSandbox === true || (profile.noSandbox !== false && runningAsRoot)) {
      args.push("--no-sandbox");
      if (profile.disableDevShm !== false) args.push("--disable-dev-shm-usage");
    }
  }

  args.push(...profile.extraArgs);
  args.push(profile.startupUrl);
  return args;
}

// ── state / health ─────────────────────────────────────────────────────

function statePaths(profile) {
  const dir = profile.stateDir;
  return {
    dir,
    pidFile: path.join(dir, "harness.pid"),
    chromePidFile: path.join(dir, "chrome.pid"),
    lockFile: path.join(dir, "harness.lock"),
    logFile: path.join(dir, "harness.log"),
  };
}

function isDetachedChild() {
  return process.env.PUBLIC_BROWSER_HARNESS_DETACHED === "1";
}

function logLine(profile, message, options = {}) {
  const paths = statePaths(profile);
  ensureDir(paths.dir);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(paths.logFile, line, { mode: 0o600 });
  } catch {
    /* logging must never crash the supervisor */
  }
  if (!isDetachedChild() || options.forceConsole) {
    process.stderr.write(line);
  }
}

function rotateLog(profile) {
  const paths = statePaths(profile);
  try {
    const stat = fs.statSync(paths.logFile);
    if (stat.size > profile.maxLogBytes) {
      fs.renameSync(paths.logFile, `${paths.logFile}.1`);
    }
  } catch {
    /* no log yet */
  }
}

export function readHealth(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/json/version",
        timeout: timeoutMs,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("error", (err) => resolve({ ok: false, error: err.message }));
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 65536) request.destroy(new Error("CDP health response too large"));
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            const info = JSON.parse(body);
            if (typeof info.Browser !== "string" || typeof info.webSocketDebuggerUrl !== "string" || !/^ws:\/\//.test(info.webSocketDebuggerUrl)) {
              resolve({ ok: false, error: "not a Chrome CDP endpoint" });
              return;
            }
            resolve({ ok: true, version: info.Browser, webSocketDebuggerUrl: info.webSocketDebuggerUrl });
          } catch {
            resolve({ ok: false, error: "invalid JSON from /json/version" });
          }
        });
      },
    );
    // A total deadline also bounds a server that trickles response bytes.
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
    request.once("close", () => clearTimeout(deadline));
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

function isPortOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForHealth(profile, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || profile.startupTimeoutMs);
  while (Date.now() < deadline) {
    if (options.isExited && options.isExited()) {
      throw new Error("Chrome exited before it became reachable.");
    }
    const health = await readHealth(profile.port, profile.healthTimeoutMs);
    if (health.ok) return health;
    await sleep(250);
  }
  throw new Error(
    `Chrome did not answer on http://127.0.0.1:${profile.port}/json/version within ` +
      `${options.timeoutMs || profile.startupTimeoutMs}ms.`,
  );
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

function acquireLock(profile) {
  const paths = statePaths(profile);
  ensureDir(paths.dir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(paths.lockFile, "wx", 0o600);
      fs.writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          port: profile.port,
          startedAt: new Date().toISOString(),
        }),
      );
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const info = readJsonFile(paths.lockFile);
      if (info && info.pid && isPidAlive(info.pid)) {
        throw new Error(
          `profile "${profile.name}" is already supervised by PID ${info.pid} ` +
            `(port ${info.port}). Run "harness status" or stop that supervisor first.`,
        );
      }
      fs.rmSync(paths.lockFile, { force: true });
    }
  }
  throw new Error(`cannot acquire the harness lock for profile "${profile.name}".`);
}

function releaseLock(profile) {
  const paths = statePaths(profile);
  const info = readJsonFile(paths.lockFile);
  if (!info || info.pid === process.pid) {
    fs.rmSync(paths.lockFile, { force: true });
  }
  const pid = readPid(paths.pidFile);
  if (!pid || pid === process.pid) fs.rmSync(paths.pidFile, { force: true });
}

// ── supervisor ─────────────────────────────────────────────────────────

export function assertOwner(config, uid = process.getuid?.()) {
  if (config.ownerUid !== undefined && uid !== config.ownerUid) {
    throw new Error(`This harness belongs to UID ${config.ownerUid}, not UID ${uid}. Run it as the owning user, without sudo.`);
  }
}

export function assertProfileIdentity(profile) {
  if (!profile.expectedProfileName) return;
  const state = readJsonFile(path.join(profile.userDataDir, "Local State"));
  const actual = state?.profile?.info_cache?.[profile.profileDirectory]?.name;
  if (actual !== profile.expectedProfileName) {
    throw new Error(`Refusing wrong Chrome profile: expected ${JSON.stringify(profile.expectedProfileName)} in ${profile.userDataDir}/${profile.profileDirectory}, found ${JSON.stringify(actual) ?? "missing"}. Check Local State and config; no profile will be created automatically.`);
  }
}

async function runSupervisor(config, profileName) {
  assertOwner(config);
  const profile = resolveProfile(config, profileName);
  assertProfileIdentity(profile);
  const paths = statePaths(profile);

  if (isChromeDefaultUserDataDir(profile.userDataDir)) {
    throw new Error(
      `profile "${profile.name}" points at Chrome's default user-data directory ` +
        `(${profile.userDataDir}). Chrome 136+ refuses remote debugging there. ` +
        "Use a dedicated directory such as ~/.public-browser/harness/<profile>/chrome-profile.",
    );
  }

  ensureDir(paths.dir);
  ensureDir(profile.userDataDir);
  ensureDir(profile.downloadDir);
  acquireLock(profile);
  fs.writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
  rotateLog(profile);

  let child = null;
  let stopping = false;
  let backoff = profile.restartDelayMs;
  let startedAt = 0;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logLine(profile, `received ${signal}; shutting down`, { forceConsole: true });
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await waitForExit(child, 10_000);
      if (!exited) {
        logLine(profile, "Chrome did not exit after SIGTERM; sending SIGKILL", {
          forceConsole: true,
        });
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
    }
    fs.rmSync(paths.chromePidFile, { force: true });
    releaseLock(profile);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  logLine(
    profile,
    `supervisor started (pid ${process.pid}, port ${profile.port}, ` +
      `user-data-dir ${profile.userDataDir})`,
    { forceConsole: true },
  );

  while (!stopping) {
    // If something already serves CDP on the port, supervise it instead of
    // starting a second Chrome against the same profile.
    const existing = await readHealth(profile.port, profile.healthTimeoutMs);
    if (existing.ok) {
      const chromePid = readPid(paths.chromePidFile);
      if (!chromePid || !isPidAlive(chromePid)) {
        throw new Error(`port ${profile.port} serves an unmanaged Chrome; refusing to adopt an unknown profile.`);
      }
      logLine(
        profile,
        `Chrome already healthy on port ${profile.port} (${existing.version}); ` +
          "supervising it without launching a new instance",
      );
      while (!stopping) {
        await sleep(5_000);
        if (stopping) break;
        const health = await readHealth(profile.port, profile.healthTimeoutMs);
        if (!health.ok) {
          logLine(profile, "the adopted Chrome disappeared; launching a new one");
          break;
        }
      }
      if (stopping) break;
    }

    if (!stopping && !existing.ok && (await isPortOpen(profile.port))) {
      logLine(
        profile,
        `port ${profile.port} is in use by another process that is not a CDP endpoint; ` +
          `retrying in ${backoff}ms`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, profile.maxRestartDelayMs);
      continue;
    }

    if (stopping) break;

    let chromePath;
    try {
      chromePath = findChromePath(config, profile);
    } catch (err) {
      logLine(profile, err instanceof Error ? err.message : String(err), {
        forceConsole: true,
      });
      await sleep(profile.maxRestartDelayMs);
      continue;
    }

    assertProfileIdentity(profile);
    rotateLog(profile);
    const args = buildChromeArgs(profile);
    logLine(profile, `launching ${chromePath} ${args.map(shellQuote).join(" ")}`);

    const logFd = fs.openSync(paths.logFile, "a", 0o600);
    let spawnError = null;
    try {
      child = spawn(chromePath, args, {
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, ...profile.env },
        detached: false,
      });
      child.once("error", (err) => {
        logLine(profile, `Chrome process error: ${err.message}`, { forceConsole: true });
      });
    } catch (err) {
      spawnError = err;
    } finally {
      fs.closeSync(logFd);
    }

    if (spawnError || !child || !child.pid) {
      logLine(
        profile,
        `failed to spawn Chrome: ${spawnError instanceof Error ? spawnError.message : "no PID"}; ` +
          `retrying in ${backoff}ms`,
        { forceConsole: true },
      );
      child = null;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, profile.maxRestartDelayMs);
      continue;
    }

    fs.writeFileSync(paths.chromePidFile, String(child.pid), { mode: 0o600 });
    startedAt = Date.now();
    let earlyExit = false;
    const onExit = (code, signal) => {
      earlyExit = true;
      logLine(
        profile,
        `Chrome exited (code ${code ?? "null"}, signal ${signal ?? "none"})`,
        { forceConsole: true },
      );
    };
    child.once("exit", onExit);

    try {
      const health = await waitForHealth(profile, {
        timeoutMs: profile.startupTimeoutMs,
        isExited: () => earlyExit,
      });
      logLine(
        profile,
        `Chrome ready on http://127.0.0.1:${profile.port} (${health.version})`,
        { forceConsole: true },
      );
      backoff = profile.restartDelayMs;
    } catch (err) {
      logLine(
        profile,
        `Chrome did not become healthy: ${err instanceof Error ? err.message : String(err)}`,
        { forceConsole: true },
      );
      // A Chrome that runs but never exposes CDP would otherwise block the
      // supervisor forever. Kill it and let the restart loop try again.
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const exited = await waitForExit(child, 5_000);
        if (!exited) child.kill("SIGKILL");
      }
    }

    // Watch for a hung CDP server as well as process exits. Three consecutive
    // failures avoid restarting Chrome for a brief busy renderer.
    let healthFailures = 0;
    while (!stopping && !earlyExit && child.exitCode === null && child.signalCode === null) {
      if (await waitForExit(child, 5_000)) break;
      const health = await readHealth(profile.port, profile.healthTimeoutMs);
      healthFailures = health.ok ? 0 : healthFailures + 1;
      if (healthFailures >= 3) {
        logLine(profile, "Chrome failed three health checks; restarting", { forceConsole: true });
        child.kill("SIGTERM");
        if (!(await waitForExit(child, 5_000))) {
          child.kill("SIGKILL");
          await waitForExit(child, 5_000);
        }
        break;
      }
    }
    child.removeListener("exit", onExit);
    child = null;
    fs.rmSync(paths.chromePidFile, { force: true });

    if (stopping) break;

    const uptime = Date.now() - startedAt;
    if (uptime > 60_000) backoff = profile.restartDelayMs;
    logLine(profile, `restarting Chrome in ${backoff}ms`, { forceConsole: true });
    await sleep(backoff);
    backoff = Math.min(backoff * 2, profile.maxRestartDelayMs);
  }

  releaseLock(profile);
}

// ── commands ───────────────────────────────────────────────────────────

async function up(config, profileName, _options = {}) {
  const profile = resolveProfile(config, profileName);
  const paths = statePaths(profile);

  if (isChromeDefaultUserDataDir(profile.userDataDir)) {
    throw new Error(
      `profile "${profile.name}" points at Chrome's default user-data directory. ` +
        "Chrome 136+ refuses remote debugging there; use a dedicated directory.",
    );
  }

  const existing = await readHealth(profile.port, 1000);
  if (existing.ok && isPidAlive(readPid(paths.pidFile))) {
    console.log(
      `profile "${profile.name}" is already up on http://127.0.0.1:${profile.port} ` +
        `(${existing.version})`,
    );
    return;
  }
  if (existing.ok && !isPidAlive(readPid(paths.chromePidFile))) {
    throw new Error(`port ${profile.port} serves an unmanaged Chrome; stop it or choose another port. No profile was adopted.`);
  }
  if (!existing.ok && await isPortOpen(profile.port)) {
    throw new Error(
      `port ${profile.port} is already in use by another process (not a CDP endpoint). ` +
        "Change the profile's port in the harness config.",
    );
  }

  ensureDir(paths.dir);
  ensureDir(profile.userDataDir);
  ensureDir(profile.downloadDir);
  rotateLog(profile);

  const unit = serviceUnitPath();
  if (fs.existsSync(unit) && hasSystemctl()) {
    try {
      runSystemctl(["--user", "start", serviceInstance(profile.name)], {
        stdio: "pipe",
      });
    } catch (err) {
      throw new Error(
        `systemd could not start ${serviceInstance(profile.name)}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Check `systemctl --user status` or run without the service.",
      );
    }
  } else {
    const out = fs.openSync(paths.logFile, "a", 0o600);
    let child;
    try {
      child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), "run", profile.name, "--config", config.configPath],
        {
          detached: true,
          stdio: ["ignore", out, out],
          env: { ...process.env, PUBLIC_BROWSER_HARNESS_DETACHED: "1" },
        },
      );
    } finally {
      fs.closeSync(out);
    }
    child.once("error", (err) => {
      console.error(`could not start supervisor: ${err.message}`);
      process.exitCode = 1;
    });
    child.unref();
  }

  if (_options.noWait) return;
  const deadline = Date.now() + profile.startupTimeoutMs + 5_000;
  while (Date.now() < deadline) {
    const health = await readHealth(profile.port, 1000);
    if (health.ok) {
      console.log(
        `profile "${profile.name}" is up on http://127.0.0.1:${profile.port} ` +
          `(${health.version})`,
      );
      console.log(`  user-data-dir: ${profile.userDataDir}`);
      console.log(`  downloads:     ${profile.downloadDir}`);
      console.log(`  log:           ${paths.logFile}`);
      return;
    }
    const supervisorPid = readPid(paths.pidFile);
    if (!supervisorPid && !fs.existsSync(unit)) {
      // Detached supervisor may not have written its PID yet; keep polling
      // until the deadline rather than failing on a race.
    }
    await sleep(250);
  }

  const tail = tailFile(paths.logFile, 25);
  throw new Error(
    `profile "${profile.name}" did not come up within ` +
      `${profile.startupTimeoutMs + 5_000}ms. Last log lines:\n${tail || "(log is empty)"}`,
  );
}

async function down(config, profileName) {
  const profile = resolveProfile(config, profileName);
  const paths = statePaths(profile);
  const unit = serviceUnitPath();

  if (hasSystemctl() && fs.existsSync(unit)) {
    try {
      const active = runSystemctl(
        ["--user", "is-active", "--quiet", serviceInstance(profile.name)],
        { stdio: "ignore" },
      );
      void active;
      runSystemctl(["--user", "stop", serviceInstance(profile.name)], {
        stdio: "inherit",
      });
      console.log(`stopped systemd service ${serviceInstance(profile.name)}`);
      return;
    } catch {
      /* not active or systemd unavailable; fall through to PID handling */
    }
  }

  const supervisorPid = readPid(paths.pidFile);
  const chromePid = readPid(paths.chromePidFile);
  let stopped = false;

  if (supervisorPid && isPidAlive(supervisorPid)) {
    process.kill(supervisorPid, "SIGTERM");
    stopped = (await waitForPidGone(supervisorPid, 15_000)) || stopped;
    if (isPidAlive(supervisorPid)) {
      process.kill(supervisorPid, "SIGKILL");
      await waitForPidGone(supervisorPid, 5_000);
    }
  }

  if (chromePid && isPidAlive(chromePid)) {
    process.kill(chromePid, "SIGTERM");
    stopped = (await waitForPidGone(chromePid, 10_000)) || stopped;
    if (isPidAlive(chromePid)) {
      process.kill(chromePid, "SIGKILL");
      await waitForPidGone(chromePid, 5_000);
    }
  }

  fs.rmSync(paths.pidFile, { force: true });
  fs.rmSync(paths.chromePidFile, { force: true });
  fs.rmSync(paths.lockFile, { force: true });

  const health = await readHealth(profile.port, 800);
  if (health.ok && !stopped) {
    console.log(
      `warning: Chrome on port ${profile.port} is still reachable but is not managed ` +
        "by this harness (no matching PID file). It was left running.",
    );
    return;
  }
  console.log(stopped ? `profile "${profile.name}" stopped` : `profile "${profile.name}" was not running`);
}

async function status(config, options = {}) {
  const rows = [];
  for (const name of config.profileNames) {
    const profile = config.profiles[name];
    const paths = statePaths(profile);
    const supervisorPid = readPid(paths.pidFile);
    const supervisorAlive = isPidAlive(supervisorPid);
    const health = await readHealth(profile.port, 800);
    const portOpen = !health.ok && (await isPortOpen(profile.port));
    let state;
    if (health.ok && supervisorAlive) state = "running";
    else if (health.ok) state = "unmanaged";
    else if (supervisorAlive) state = "starting";
    else if (portOpen) state = "port-conflict";
    else state = "stopped";
    rows.push({
      profile: name,
      port: profile.port,
      state,
      pid: supervisorPid || "",
      version: health.ok ? health.version : "",
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      expectedProfileName: profile.expectedProfileName,
      downloadDir: profile.downloadDir,
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ defaultProfile: config.defaultProfile, profiles: rows }, null, 2));
    return;
  }

  const header = ["PROFILE", "PORT", "STATE", "PID", "CHROME", "USER-DATA-DIR"];
  const widths = header.map((h) => h.length);
  for (const row of rows) {
    const values = [row.profile, String(row.port), row.state, String(row.pid), row.version, row.userDataDir];
    values.forEach((value, index) => {
      widths[index] = Math.max(widths[index], value.length);
    });
  }
  const format = (values) =>
    values.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  console.log(format(header));
  for (const row of rows) {
    console.log(
      format([row.profile, String(row.port), row.state, String(row.pid), row.version, row.userDataDir]),
    );
  }
  console.log("");
  console.log(`default profile: ${config.defaultProfile}`);
}

function tailFile(file, lines = 40) {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.split(/\r?\n/).slice(-lines).join("\n").trimEnd();
  } catch {
    return "";
  }
}

function followFile(file, initialLines) {
  let offset = 0;
  try {
    const stat = fs.statSync(file);
    offset = stat.size;
  } catch {
    /* file may not exist yet */
  }
  const initial = tailFile(file, initialLines);
  if (initial) process.stdout.write(`${initial}\n`);

  setInterval(() => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    if (stat.size < offset) offset = 0; // truncated / rotated
    if (stat.size === offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      offset = stat.size;
      process.stdout.write(buffer);
    } finally {
      fs.closeSync(fd);
    }
  }, 500);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

function mcpName(profile) {
  return profile.name === "default" ? "public-browser" : `public-browser-${profile.name}`;
}

export function mcpSnippet(profile, client = "json", agentId) {
  const name = mcpName(profile);
  const command = process.execPath;
  const entry = path.resolve(HERE, "../build/index.js");
  const args = [entry, "--attach", "--host", "127.0.0.1", "--port", String(profile.port)];
  if (agentId !== undefined) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("--agent-id requires 1–128 letters, digits, underscores or hyphens.");
    args.push("--agent-id", agentId);
  }
  if (!profile.stealth) args.push("--no-stealth");
  const env = {
    // All agents write downloads to the same profile directory. The CDP
    // download behaviour is browser-wide, so differing dirs would make the
    // last agent win and the others report paths that do not exist.
    PUBLIC_BROWSER_DOWNLOAD_DIR: profile.downloadDir,
    PUBLIC_BROWSER_DOWNLOAD_NAMING: "suggested",
    // Attach mode owns the profile; a host-level profile setting must not
    // redirect this agent into a pipe-only Chrome.
    PUBLIC_BROWSER_PROFILE: "",
    SILBERCUE_CHROME_PROFILE: "",
  };

  if (client === "claude") {
    const envFlags = Object.entries(env)
      .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
      .join(" ");
    return (
      `claude mcp add --scope user ${name} ${envFlags} -- ` +
      `${shellQuote(command)} ${args.map(shellQuote).join(" ")}`
    );
  }

  if (client === "cursor" || client === "cline") {
    return JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command,
            args,
            env,
          },
        },
      },
      null,
      2,
    );
  }

  if (client === "opencode") {
    return JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          servers: {
            [name]: {
              type: "local",
              command: [command, ...args],
              environment: env,
            },
          },
        },
      },
      null,
      2,
    );
  }

  return JSON.stringify({ name, command, args, env }, null, 2);
}

function pathInfo(config, profileName) {
  const profile = resolveProfile(config, profileName);
  const paths = statePaths(profile);
  console.log(`profile:       ${profile.name}`);
  console.log(`port:          ${profile.port}`);
  console.log(`user-data-dir: ${profile.userDataDir}`);
  console.log(`downloads:     ${profile.downloadDir}`);
  console.log(`log:           ${paths.logFile}`);
  console.log(`config:        ${config.configPath}`);
}

function profiles(config) {
  for (const name of config.profileNames) {
    const profile = config.profiles[name];
    const marker = name === config.defaultProfile ? " (default)" : "";
    console.log(`${name}${marker}: port ${profile.port} -> ${profile.userDataDir}`);
  }
}

// ── systemd ────────────────────────────────────────────────────────────

function hasSystemctl() {
  return Boolean(findOnPath(["systemctl"]));
}

function runSystemctl(args, options = {}) {
  // Desktop sessions may export a private D-Bus address rather than the
  // lingering user manager's bus. Target the manager explicitly when present.
  const runtime = process.env.XDG_RUNTIME_DIR ||
    (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
  const bus = path.join(runtime, "bus");
  const env = runtime && fs.existsSync(bus)
    ? { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` }
    : process.env;
  return execFileSync("systemctl", args, { ...options, env });
}

function systemdUserDir() {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function serviceUnitPath() {
  return path.join(systemdUserDir(), "public-browser-harness@.service");
}

function serviceInstance(profileName) {
  return `public-browser-harness@${profileName}.service`;
}

export function buildSystemdUnit(config) {
  const node = process.execPath;
  const script = fileURLToPath(import.meta.url);
  const lines = [
    "[Unit]",
    "Description=Public Browser harness Chrome (%i)",
    `Documentation=file://${path.join(HERE, "README.md")}`,
    ...(config.ownerUid !== undefined ? [`ConditionUser=${config.ownerUid}`] : []),
    "After=network-online.target",
    "Wants=network-online.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${sdQuote(node)} ${sdQuote(script)} run %i --config ${sdQuote(config.configPath)}`,
    `WorkingDirectory=${path.dirname(HERE).replace(/%/g, "%%")}`,
    "Restart=always",
    "RestartSec=2",
    // Signal only the supervisor first so Chrome can flush profile databases.
    // On timeout systemd still kills the entire remaining process group.
    "KillMode=mixed",
    "TimeoutStopSec=20",
    "Environment=NODE_ENV=production",
    `Environment=${sdQuote(`PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`)}`,
  ];
  for (const key of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key]) lines.push(`Environment=${sdQuote(`${key}=${process.env[key]}`)}`);
  }
  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

function installService(config, profileNames) {
  if (process.platform !== "linux") {
    throw new Error("install-service currently supports Linux (systemd user units) only.");
  }
  if (!hasSystemctl()) {
    throw new Error("systemctl was not found; cannot install a systemd unit.");
  }

  const unitPath = serviceUnitPath();
  ensureDir(systemdUserDir());
  fs.writeFileSync(unitPath, buildSystemdUnit(config), { mode: 0o644 });
  console.log(`wrote ${unitPath}`);

  try {
    runSystemctl(["--user", "daemon-reload"], { stdio: "inherit" });
  } catch (err) {
    throw new Error(`systemctl --user daemon-reload failed: ${String(err)}. Start your user manager first.`);
  }

  let failures = 0;
  for (const name of profileNames) {
    const profile = resolveProfile(config, name);
    if (!profile.headless && !process.env.DISPLAY) {
      console.error(
        `warning: profile "${name}" is headed but DISPLAY is unset. ` +
          "Start a desktop session/Xvfb or set \"headless\": true in the harness config.",
      );
    }
    try {
      runSystemctl(["--user", "enable", "--now", serviceInstance(name)], {
        stdio: "inherit",
      });
      console.log(`enabled ${serviceInstance(name)}`);
    } catch (err) {
      failures += 1;
      console.error(`error: could not enable ${serviceInstance(name)}: ${String(err)}`);
    }
  }
  if (failures) throw new Error(`${failures} harness service(s) could not be enabled.`);

  try {
    const user = os.userInfo().username;
    execFileSync("loginctl", ["enable-linger", user], { stdio: "ignore" });
    console.log(`linger enabled for ${user} (services keep running after logout)`);
  } catch {
    console.log(
      "note: could not enable linger. Run `loginctl enable-linger $USER` once so the " +
        "browser starts at boot and survives logout.",
    );
  }
}

function uninstallService(config, profileNames) {
  if (process.platform !== "linux" || !hasSystemctl()) {
    throw new Error("uninstall-service currently supports Linux (systemd user units) only.");
  }
  for (const name of profileNames) {
    try {
      runSystemctl(["--user", "disable", "--now", serviceInstance(name)], {
        stdio: "inherit",
      });
      console.log(`disabled ${serviceInstance(name)}`);
    } catch {
      /* not installed */
    }
  }
  fs.rmSync(serviceUnitPath(), { force: true });
  try {
    runSystemctl(["--user", "daemon-reload"], { stdio: "inherit" });
  } catch {
    /* ignore */
  }
  console.log(`removed ${serviceUnitPath()}`);
}

// ── doctor ─────────────────────────────────────────────────────────────

async function doctor(config) {
  console.log(`Public Browser harness ${HARNESS_VERSION}`);
  console.log(`node:      ${process.version} (${process.platform}/${process.arch})`);
  console.log(`config:    ${config.configPath}`);
  console.log(`state dir: ${config.stateDir}`);
  console.log(`systemd:   ${process.platform === "linux" && hasSystemctl() ? "available" : "not available"}`);
  console.log(`DISPLAY:   ${process.env.DISPLAY || "(unset)"}`);
  console.log("");

  let failures = 0;
  for (const name of config.profileNames) {
    const profile = config.profiles[name];
    console.log(`profile "${name}"`);
    console.log(`  port:          ${profile.port}`);
    console.log(`  user-data-dir: ${profile.userDataDir}`);
    console.log(`  downloads:     ${profile.downloadDir}`);
    console.log(`  profile:       ${profile.profileDirectory} (${profile.expectedProfileName || "not pinned"})`);
    try {
      assertProfileIdentity(profile);
      console.log("  identity:      verified");
    } catch (err) {
      failures += 1;
      console.log(`  identity:      INVALID — ${err.message}`);
    }

    try {
      const chrome = findChromePath(config, profile);
      console.log(`  chrome:        ${chrome}`);
    } catch (err) {
      failures += 1;
      console.log(`  chrome:        MISSING — ${err instanceof Error ? err.message : String(err)}`);
    }

    if (isChromeDefaultUserDataDir(profile.userDataDir)) {
      failures += 1;
      console.log("  directory:     INVALID — Chrome refuses remote debugging on its default data dir");
    } else {
      try {
        ensureDir(profile.userDataDir);
        ensureDir(profile.downloadDir);
        const probe = path.join(profile.stateDir, ".write-test");
        fs.writeFileSync(probe, "ok");
        fs.rmSync(probe, { force: true });
        console.log("  directories:   writable");
      } catch (err) {
        failures += 1;
        console.log(`  directories:   NOT WRITABLE — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!profile.headless && !process.env.DISPLAY) {
      console.log("  display:       headed profile without DISPLAY (use Xvfb or headless: true)");
    }

    const health = await readHealth(profile.port, 800);
    if (health.ok) {
      console.log(`  status:        running (${health.version})`);
    } else if (await isPortOpen(profile.port)) {
      failures += 1;
      console.log("  status:        port is in use by a non-CDP process");
    } else {
      console.log("  status:        stopped");
    }

    if (fs.existsSync(serviceUnitPath())) {
      console.log(`  service:       ${serviceInstance(name)}`);
    }
    console.log("");
  }

  if (failures > 0) {
    console.log(`${failures} problem(s) found. Fix them before starting the harness.`);
    process.exitCode = 1;
  } else {
    console.log("No blocking problems found.");
    console.log("");
    console.log("Next:");
    console.log("  pb-harness start");
    console.log("  pb-harness mcp default --client claude");
  }
}

// ── CLI ────────────────────────────────────────────────────────────────

const COMMANDS = new Set([
  "up",
  "down",
  "restart",
  "status",
  "logs",
  "run",
  "mcp",
  "path",
  "profiles",
  "doctor",
  "install-service",
  "uninstall-service",
  "help",
  "version",
]);

export function parseCli(argv) {
  const args = argv.slice(2);
  const options = {
    command: null,
    profile: null,
    all: false,
    follow: false,
    lines: 40,
    client: "json",
    agentId: undefined,
    json: false,
    configPath: null,
    noWait: false,
    force: false,
    help: false,
    version: false,
  };
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config" || arg === "-c") {
      options.configPath = args[++i];
      if (!options.configPath) throw new Error(`${arg} requires a path.`);
    } else if (arg.startsWith("--config=")) {
      options.configPath = arg.slice("--config=".length);
    } else if (arg === "--client") {
      options.client = args[++i];
      if (!options.client) throw new Error("--client requires a value (claude|cursor|opencode|json).");
    } else if (arg.startsWith("--client=")) {
      options.client = arg.slice("--client=".length);
    } else if (arg === "--agent-id") {
      options.agentId = args[++i];
      if (!options.agentId) throw new Error("--agent-id requires a value.");
    } else if (arg.startsWith("--agent-id=")) {
      options.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--lines" || arg === "-n") {
      options.lines = Number(args[++i]);
      if (!Number.isInteger(options.lines) || options.lines < 1) {
        throw new Error("--lines requires a positive integer.");
      }
    } else if (arg.startsWith("--lines=")) {
      options.lines = Number(arg.slice("--lines=".length));
    } else if (arg === "--follow" || arg === "-f") {
      options.follow = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-wait") {
      options.noWait = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  const aliases = { start: "up", stop: "down", ps: "status", list: "profiles", enable: "install-service", disable: "uninstall-service" };
  if (positionals.length > 0) options.command = aliases[positionals[0]] || positionals[0];
  if (positionals.length > 1) options.profile = positionals[1];
  if (positionals.length > 2) {
    throw new Error(`unexpected argument ${JSON.stringify(positionals[2])}`);
  }
  if (options.command && !COMMANDS.has(options.command)) {
    throw new Error(
      `unknown command ${JSON.stringify(options.command)}. Run "harness help".`,
    );
  }
  return options;
}

function printHelp() {
  console.log(`Public Browser harness ${HARNESS_VERSION}

Keeps one always-on Chrome per profile, with a persistent user-data-dir and a
stable CDP port. Agents attach with:
  public-browser --attach --port <port>

Usage:
  pb-harness <command> [profile] [options]
  public-browser-harness <command> [profile] [options]

Aliases: start = up, stop = down, ps = status, list = profiles,
         enable = install-service, disable = uninstall-service

Commands:
  up [profile]              Start Chrome + supervisor (or the systemd unit)
  down [profile]            Stop Chrome + supervisor
  restart [profile]         Restart Chrome
  status                    Show every profile (state, PID, CDP version)
  logs <profile>            Print the profile's log (-f to follow)
  run <profile>             Foreground supervisor (used by systemd)
  mcp [profile]             Print the MCP config for an agent
  path [profile]            Print the profile's directories
  profiles                  List configured profiles
  doctor                    Check Chrome, ports, directories, display
  install-service [profile] Install + enable a systemd user unit
  uninstall-service [profile]
  version                   Show harness version
  help                      Show this help

Options:
  --config, -c <path>       Use another profiles.json
  --all                     Apply to every profile
  --client <name>           mcp: claude | cursor | cline | opencode | json
  --agent-id <id>           mcp: stable unique identity; retain tabs across reconnects
  --json                    status: machine-readable output
  --lines, -n <n>           logs: number of lines (default 40)
  --follow, -f              logs: keep following
  --no-wait                 up: return before health check
  --force                   reserved for destructive overrides

Environment:
  PUBLIC_BROWSER_HARNESS_CONFIG   Path to the harness config
  CHROME_PATH                     Chrome/Chromium binary
  PUBLIC_BROWSER_HARNESS_DETACHED Internal: set by "up" for the detached supervisor

Examples:
  node harness/harness.mjs up
  node harness/harness.mjs status
  node harness/harness.mjs mcp default --client claude
  node harness/harness.mjs install-service --all
`);
}

function selectedProfiles(config, options) {
  if (options.all) return config.profileNames;
  return [options.profile || config.defaultProfile];
}

async function main(argv = process.argv) {
  const options = parseCli(argv);
  if (options.version || options.command === "version") {
    console.log(`public-browser-harness ${HARNESS_VERSION}`);
    return;
  }
  if (options.help || !options.command || options.command === "help") {
    printHelp();
    return;
  }

  const config = loadConfig({ configPath: options.configPath });
  assertOwner(config);

  switch (options.command) {
    case "up": {
      for (const name of selectedProfiles(config, options)) {
        await up(config, name, options);
      }
      return;
    }
    case "down": {
      for (const name of selectedProfiles(config, options)) {
        await down(config, name);
      }
      return;
    }
    case "restart": {
      for (const name of selectedProfiles(config, options)) {
        const unit = serviceUnitPath();
        if (hasSystemctl() && fs.existsSync(unit)) {
          try {
            runSystemctl(["--user", "restart", serviceInstance(name)], {
              stdio: "inherit",
            });
            await waitForHealth(resolveProfile(config, name));
            console.log(`restarted ${serviceInstance(name)}`);
            continue;
          } catch {
            /* fall through to PID restart */
          }
        }
        await down(config, name);
        await up(config, name, options);
      }
      return;
    }
    case "status": {
      await status(config, options);
      return;
    }
    case "logs": {
      const profile = resolveProfile(config, options.profile);
      const paths = statePaths(profile);
      if (!fs.existsSync(paths.logFile)) {
        console.error(`no log yet at ${paths.logFile}`);
        return;
      }
      if (options.follow) {
        followFile(paths.logFile, options.lines);
      } else {
        const tail = tailFile(paths.logFile, options.lines);
        if (tail) console.log(tail);
      }
      return;
    }
    case "run": {
      if (!options.profile) {
        throw new Error("run requires a profile name (systemd passes %i).");
      }
      await runSupervisor(config, options.profile);
      return;
    }
    case "mcp": {
      const profile = resolveProfile(config, options.profile);
      console.log(mcpSnippet(profile, options.client, options.agentId));
      return;
    }
    case "path": {
      pathInfo(config, options.profile);
      return;
    }
    case "profiles": {
      profiles(config);
      return;
    }
    case "doctor": {
      await doctor(config);
      return;
    }
    case "install-service": {
      installService(config, selectedProfiles(config, options));
      return;
    }
    case "uninstall-service": {
      uninstallService(config, selectedProfiles(config, options));
      return;
    }
    default:
      throw new Error(`unknown command ${options.command}`);
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`harness: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
