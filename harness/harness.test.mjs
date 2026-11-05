import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertOwner, assertProfileIdentity, parseCli, buildSystemdUnit, buildChromeArgs, loadConfig, mcpSnippet, validateConfig } from "./harness.mjs";

function config() {
  return validateConfig({ profiles: { default: { port: 9222, headless: true } } }, "/tmp/browser config %i.json");
}

test("generated user unit has restart and graceful Chrome shutdown policies", () => {
  const unit = buildSystemdUnit(config());
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=2$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^TimeoutStopSec=20$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
  assert.match(unit, / run %i --config "\/tmp\/browser config %%i.json"/);
  assert.ok(unit.includes(process.execPath));
});

test("bundled service template and generator share lifecycle policies", () => {
  const template = readFileSync(new URL("./systemd/public-browser-harness@.service.template", import.meta.url), "utf8");
  const unit = buildSystemdUnit(config());
  for (const line of ["Type=simple", "Restart=always", "RestartSec=2", "KillMode=mixed", "TimeoutStopSec=20", "WantedBy=default.target"]) {
    assert.ok(template.includes(line));
    assert.ok(unit.includes(line));
  }
});

test("MCP snippets support separate auto agent identities without launching Chrome", () => {
  const value = JSON.parse(mcpSnippet(config().profiles.default, "json", "auto"));
  assert.ok(value.args.includes("--attach"));
  const index = value.args.indexOf("--agent-id");
  assert.equal(value.args[index + 1], "auto");
  assert.equal(value.args[value.args.indexOf("--host") + 1], "127.0.0.1");
});

test("OpenCode v2 snippets use mcp.servers and independent auto IDs", () => {
  const value = JSON.parse(mcpSnippet(config().profiles.default, "opencode", "auto"));
  const server = value.mcp.servers["public-browser"];
  assert.equal(server.type, "local");
  assert.equal(server.command[0], process.execPath);
  assert.equal(server.command[server.command.indexOf("--agent-id") + 1], "auto");
  assert.equal(value.mcp["public-browser"], undefined);
});

test("Chrome service stays loopback-only with a persistent profile", () => {
  const args = buildChromeArgs(config().profiles.default);
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(args.includes("--remote-debugging-port=9222"));
  assert.ok(args.some(arg => arg.startsWith("--user-data-dir=")));
});

test("separate profiles cannot share ports or Chrome directories", () => {
  assert.throws(() => validateConfig({ profiles: { a: { port: 9222 }, b: { port: 9222 } } }), /both use port/);
  assert.throws(() => validateConfig({ profiles: {
    a: { port: 9222, userDataDir: "/tmp/shared-browser" },
    b: { port: 9333, userDataDir: "/tmp/shared-browser" },
  } }), /share userDataDir/);
});

test("loads explicit config and machine-local overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-harness-config-"));
  try {
    const path = join(dir, "profiles.json");
    writeFileSync(path, JSON.stringify({ profiles: { default: { port: 9222, headless: true } } }));
    writeFileSync(join(dir, "profiles.local.json"), JSON.stringify({ profiles: { default: { port: 9333 } } }));
    const loaded = loadConfig({ configPath: path });
    assert.equal(loaded.profiles.default.port, 9333);
    assert.equal(loaded.profiles.default.headless, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
