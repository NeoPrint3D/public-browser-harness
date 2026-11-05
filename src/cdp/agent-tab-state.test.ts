import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => home.path,
}));
import { AgentTabState } from "./agent-tab-state.js";

describe("AgentTabState identities", () => {
  const states: AgentTabState[] = [];
  beforeEach(() => { home.path = mkdtempSync(join(tmpdir(), "pb-agent-id-")); });
  afterEach(() => {
    for (const state of states.splice(0)) state.release();
    rmSync(home.path, { recursive: true, force: true });
  });
  const create = (id: string) => {
    const state = new AgentTabState(id, "127.0.0.1", 9222);
    states.push(state);
    return state;
  };

  it("gives concurrent auto connections distinct identities and leases", () => {
    const a = create("auto");
    const b = create("auto");
    expect(a.agentId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(a.agentId).not.toBe(b.agentId);
    const dir = join(home.path, ".public-browser", "agent-tabs");
    const locks = readdirSync(dir).filter(name => name.endsWith(".lock"));
    expect(locks).toHaveLength(2);
    const owners = locks.map(name => JSON.parse(readFileSync(join(dir, name, "owner.json"), "utf8")).agentId);
    expect(owners.sort()).toEqual([a.agentId, b.agentId].sort());
    a.release();
    expect(readdirSync(dir).filter(name => name.endsWith(".lock"))).toHaveLength(1);
  });

  it("keeps explicit IDs exclusive and resumes their saved tabs after release", () => {
    const a = create("stable");
    a.save(["tab-a"], "tab-a");
    expect(() => create("stable")).toThrow('Agent "stable" is already leased');
    a.release();
    const resumed = create("stable");
    expect(resumed.agentId).toBe("stable");
    expect(resumed.targets).toEqual(["tab-a"]);
    expect(resumed.active).toBe("tab-a");
  });
});
