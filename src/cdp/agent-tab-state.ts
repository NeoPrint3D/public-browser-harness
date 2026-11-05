import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface TabState {
  targets: string[];
  active?: string;
}

/** Durable, opt-in tab ownership. Never infer ownership from the foreground tab. */
export class AgentTabState {
  readonly agentId: string;
  readonly targets: string[];
  readonly active: string | undefined;
  private readonly path: string;
  private readonly lock: string;
  private released = false;
  private readonly onExit = (): void => this.release();

  constructor(agentId: string, host: string, port: number) {
    // Per-connection identities must not compete for a hard-coded lease.
    // Explicit IDs retain durable ownership and exclusive-lease protection.
    if (agentId === "auto") agentId = `agent-${randomUUID()}`;
    this.agentId = agentId;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) {
      throw new Error("--agent-id must contain 1–128 letters, digits, underscores or hyphens");
    }
    const directory = join(homedir(), ".public-browser", "agent-tabs");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const endpoint = createHash("sha256").update(`${host}:${port}`).digest("hex").slice(0, 16);
    this.path = join(directory, `${endpoint}-${agentId}.json`);
    this.lock = `${this.path}.lock`;
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Fail closed. Automatically deleting stale-looking locks can race a
      // newly started owner, allowing two processes to control the same tabs.
      throw new Error(`Agent "${agentId}" is already leased. Use a different --agent-id for another agent. If its process crashed, verify it is stopped before removing ${this.lock}`);
    }
    try {
      writeFileSync(join(this.lock, "owner.json"), JSON.stringify({ pid: process.pid, agentId }), { mode: 0o600 });
      let state: TabState = { targets: [] };
      try {
        const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
        if (!value || typeof value !== "object" || !("targets" in value)
          || !Array.isArray(value.targets) || !value.targets.every(t => typeof t === "string")) {
          throw new Error(`Invalid agent tab state: ${this.path}`);
        }
        state = value as TabState;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.targets = state.targets;
      this.active = typeof state.active === "string" ? state.active : undefined;
      process.once("exit", this.onExit);
    } catch (error) {
      rmSync(this.lock, { recursive: true, force: true });
      throw error;
    }
  }

  save(targets: Iterable<string>, active?: string): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ targets: [...targets], active }), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    process.removeListener("exit", this.onExit);
    rmSync(this.lock, { recursive: true, force: true });
  }
}
