#!/usr/bin/env node
/**
 * Deterministic synthetic CDP-latency benchmark; does not launch/touch Chrome.
 * Run after npm run build: node scripts/benchmark-hot-paths.mjs [latency-ms] [iterations]
 * "Before" models the previous serial wire sequences, NOT an end-to-end browser.
 * Real pages add network, renderer, AX processing, and MCP/LLM overhead.
 */
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { navigateHandler } from "../build/tools/navigate.js";
import { readPageHandler } from "../build/tools/read-page.js";
import { a11yTree } from "../build/cache/a11y-tree.js";
import { updateOverlayStatus } from "../build/overlay/session-overlay.js";
import { applyWebdriverMask } from "../build/cdp/stealth.js";

const latency = Number(process.argv[2] ?? 20);
const iterations = Number(process.argv[3] ?? 10);
if (!Number.isFinite(latency) || latency < 0 || !Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("Usage: benchmark-hot-paths.mjs [non-negative latency-ms] [positive iterations]");
}

function mockClient() {
  let calls = 0;
  return {
    get calls() { return calls; },
    on() {}, off() {},
    async send(method, params) {
      calls++;
      // Same-document navigation eliminates real loading/settling in this microbenchmark.
      if (method === "Page.navigate") return { frameId: "f1" };
      await delay(latency);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "doc1" } } };
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      if (params?.expression === "document.URL") return { result: { value: "https://example.com" } };
      if (params?.expression === "document.title") return { result: { value: "Example" } };
      if (params?.expression?.includes("querySelectorAll")) return { result: { value: 12 } };
      return { result: { value: true } };
    },
  };
}

async function measure(fn) {
  const samples = [];
  let totalCalls = 0;
  for (let i = 0; i < iterations; i++) {
    const cdp = mockClient();
    const start = performance.now();
    await fn(cdp);
    samples.push(performance.now() - start);
    totalCalls += cdp.calls;
  }
  samples.sort((a, b) => a - b);
  return { median_ms: +samples[Math.floor(samples.length / 2)].toFixed(2), cdp_calls: totalCalls / iterations };
}

const rows = [];
async function compare(name, before, after) {
  const baseline = await measure(before);
  const optimized = await measure(after);
  rows.push({ name, before_ms: baseline.median_ms, after_ms: optimized.median_ms,
    before_cdp_calls: baseline.cdp_calls, after_cdp_calls: optimized.cdp_calls,
    reduction_pct: +((1 - optimized.median_ms / baseline.median_ms) * 100).toFixed(1) });
}

await compare("navigation post-load", async cdp => {
  await cdp.send("Page.navigate", { url: "https://example.com" }, "s1");
  await delay(0);
  await applyWebdriverMask(cdp, "s1", { newDocument: false });
  await cdp.send("Runtime.evaluate", { expression: "document.URL" }, "s1");
  await cdp.send("Runtime.evaluate", { expression: "document.title" }, "s1");
}, cdp => navigateHandler({ action: "goto", url: "https://example.com", settle_ms: 0 }, cdp, "s1"));

await compare("overlay status update", async cdp => {
  await cdp.send("Runtime.evaluate", { expression: "overlay exists" }, "s1");
  await cdp.send("Runtime.evaluate", { expression: "update overlay" }, "s1");
}, cdp => updateOverlayStatus(cdp, "s1", "Reading page"));

await compare("fresh empty AX read", async cdp => {
  await cdp.send("Runtime.evaluate", { expression: "document.URL" }, "s1");
  await cdp.send("Page.getFrameTree", {}, "s1");
  await cdp.send("Accessibility.getFullAXTree", {}, "s1");
}, cdp => { a11yTree.reset(); return a11yTree.getTree(cdp, "s1", { fresh: true }); });

const originalGetTree = a11yTree.getTree;
try {
  const tree = async cdp => {
    await cdp.send("Accessibility.getFullAXTree", {}, "s1");
    return { text: "Page: Example", refCount: 1, depth: 3, tokenCount: 4, pageUrl: "https://example.com" };
  };
  a11yTree.getTree = tree;
  await compare("AX read + hidden-control hint", async cdp => {
    await tree(cdp);
    await cdp.send("Runtime.evaluate", { expression: "querySelectorAll hidden controls" }, "s1");
  }, cdp => readPageHandler({ depth: 3, filter: "interactive" }, cdp, "s1"));
} finally {
  a11yTree.getTree = originalGetTree;
}
// CPU-only case: same 5,000-line body/budget and identical survivors.
const largeBody = Array.from({ length: 5_000 }, (_, i) => `[e${i}] ${i % 10 === 0 ? "button" : "StaticText"} "row ${i} with a longer label"`);
const budget = 200;
function legacyTrimBody() {
  const result = [...largeBody];
  while (Math.ceil(result.join("\n").length / 3.5) > budget && result.length) {
    let removed = false;
    for (let i = result.length - 1; i >= 0; i--) {
      if (!result[i].includes("] button ")) {
        result.splice(i, 1); removed = true; break;
      }
    }
    if (!removed) result.pop();
  }
  return result;
}
const expectedBody = legacyTrimBody();
const actualBody = a11yTree.trimBodyToFit(largeBody, budget);
if (JSON.stringify(expectedBody) !== JSON.stringify(actualBody)) throw new Error("Trim output changed");
await compare("CPU: trim 5,000-line AX body", () => legacyTrimBody(), () => a11yTree.trimBodyToFit(largeBody, budget));
console.log(JSON.stringify({ kind: "synthetic CDP latency + CPU fixture, not end-to-end", latency_ms: latency, iterations, results: rows }, null, 2));
