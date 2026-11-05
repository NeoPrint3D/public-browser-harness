import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { navigateHandler } from "./navigate.js";
import { readPageHandler } from "./read-page.js";
import { updateOverlayStatus } from "../overlay/session-overlay.js";
import { setStealthEnabled } from "../cdp/stealth.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function client(send: ReturnType<typeof vi.fn>): CdpClient {
  return { send, on: vi.fn(), off: vi.fn() } as unknown as CdpClient;
}

const emptyTree = {
  text: "Page: Example", refCount: 1, depth: 3, tokenCount: 4,
  pageUrl: "https://example.com", hiddenContentCount: 0,
};

describe("tool hot-path latency regressions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setStealthEnabled(true);
    vi.spyOn(a11yTree, "getPageType").mockReturnValue("unknown");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("issues navigation mask, URL, and title reads before any of them completes", async () => {
    const mask = deferred<unknown>();
    const url = deferred<unknown>();
    const title = deferred<unknown>();
    const send = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "Page.navigate") return Promise.resolve({ frameId: "f1" });
      if (params?.expression === "document.URL") return url.promise;
      if (params?.expression === "document.title") return title.promise;
      return mask.promise;
    });
    const result = navigateHandler({ action: "goto", url: "https://example.com", settle_ms: 0 }, client(send), "s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(3);
    // A title failure must not erase an independently successful URL read.
    title.reject(new Error("context disappeared"));
    url.resolve({ result: { value: "https://example.com/final" } });
    mask.resolve({});
    expect((await result).content[0].text).toContain("Navigated to https://example.com/final");
  });

  it("retains the title when URL retrieval fails independently", async () => {
    const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.navigate") return { frameId: "f1" };
      if (params?.expression === "document.URL") throw new Error("URL unavailable");
      if (params?.expression === "document.title") return { result: { value: "Loaded page" } };
      return {};
    });
    const pending = navigateHandler({ action: "goto", url: "https://example.com", settle_ms: 0 }, client(send), "s1");
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending).content[0].text).toContain("Navigated to unknown — Loaded page");
  });

  it("collects hidden controls while the fresh AX fetch is still in flight", async () => {
    const tree = deferred<typeof emptyTree>();
    const hidden = deferred<unknown>();
    const getTree = vi.spyOn(a11yTree, "getTree").mockReturnValue(tree.promise);
    const send = vi.fn(() => hidden.promise);
    const pending = readPageHandler({ depth: 3, filter: "interactive" }, client(send), "s1");
    expect(getTree).toHaveBeenCalledWith(expect.anything(), "s1", expect.objectContaining({ fresh: true }), undefined);
    expect(send).toHaveBeenCalledTimes(1);
    tree.resolve(emptyTree);
    hidden.resolve({ result: { value: 12 } });
    expect((await pending).content[0].text).toContain("12 interactive elements are hidden");
  });

  it("a failed advisory probe does not fail a successful page read", async () => {
    vi.spyOn(a11yTree, "getTree").mockResolvedValue(emptyTree);
    const send = vi.fn().mockRejectedValue(new Error("context disappeared"));
    const result = await readPageHandler({ depth: 3, filter: "interactive" }, client(send), "s1");
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("Page: Example");
  });

  it("parallelizes URL/document checks without skipping the fresh AX request", async () => {
    a11yTree.reset();
    const url = deferred<unknown>();
    const doc = deferred<unknown>();
    const send = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return url.promise;
      if (method === "Page.getFrameTree") return doc.promise;
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      return {};
    });
    const pending = a11yTree.getTree(client(send), "s1", { fresh: true });
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate", "Page.getFrameTree"]);
    expect(send).not.toHaveBeenCalledWith("Accessibility.getFullAXTree", expect.anything(), "s1");
    url.resolve({ result: { value: "https://example.com" } });
    doc.resolve({ frameTree: { frame: { loaderId: "doc1" } } });
    await pending;
    expect(send).toHaveBeenCalledWith("Accessibility.getFullAXTree", {}, "s1");
  });

  it("updates an existing overlay using one CDP request", async () => {
    const send = vi.fn().mockResolvedValue({ result: { value: true } });
    await updateOverlayStatus(client(send), "s1", "Reading page");
    expect(send).toHaveBeenCalledTimes(1);
    const params = send.mock.calls[0][1];
    const textArea = { innerHTML: "" };
    const logo = { classList: { add: vi.fn(), remove: vi.fn() } };
    const document = {
      getElementById: () => ({ shadowRoot: {
        querySelector: () => logo,
        getElementById: () => textArea,
      } }),
    };
    expect(new Function("document", `return ${params.expression}`)(document)).toBe(true);
    expect(textArea.innerHTML).toContain("Reading page");
  });

  it("repairs a missing overlay and reapplies status in three requests", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ result: { value: false } })
      .mockResolvedValue({ result: { value: true } });
    await updateOverlayStatus(client(send), "s1", "Reading page");
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][1].expression).toContain("backgroundImage");
    expect(send.mock.calls[2][1].expression).toBe(send.mock.calls[0][1].expression);
  });

  it("a missing overlay returns false so repair is requested", async () => {
    const send = vi.fn().mockResolvedValue({ result: { value: true } });
    await updateOverlayStatus(client(send), "s1", "");
    const script = send.mock.calls[0][1].expression;
    expect(new Function("document", `return ${script}`)({ getElementById: () => null })).toBe(false);
  });

  it("overlay errors remain non-fatal", async () => {
    const send = vi.fn().mockRejectedValue(new Error("context disappeared"));
    await expect(updateOverlayStatus(client(send), "s1", "Reading page")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
