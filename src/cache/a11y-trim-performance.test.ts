import { describe, expect, it } from "vitest";
import { a11yTree } from "./a11y-tree.js";

// Reference implementation of the previous algorithm, for byte-for-byte
// equivalence across Unicode, annotation preservation and budget boundaries.
function legacyTrim(lines: string[], budget: number): string[] {
  if (budget <= 0) return [];
  const estimate = (text: string) => Math.ceil(text.length / 3.5);
  const work = [...lines];
  const notes: string[] = [];
  while (work.length && (work.at(-1)!.trimStart().startsWith("Note:") || work.at(-1)!.startsWith("\nNote:"))) {
    notes.unshift(work.pop()!);
  }
  const marker = work.at(-1)?.startsWith("...") ? work.pop() : undefined;
  const suffix = [marker ?? "", ...notes].filter(Boolean).join("\n");
  const effective = Math.max(0, budget - (suffix ? estimate(suffix + "\n") : 0));
  const interactive = (line: string) => ["button", "link"].includes(line.match(/\[e\d+\]\s+(\S+)/)?.[1] ?? "");
  while (estimate(work.join("\n")) > effective && work.length) {
    let removed = false;
    for (let i = work.length - 1; i >= 0; i--) {
      if (!interactive(work[i])) { work.splice(i, 1); removed = true; break; }
    }
    if (!removed) work.pop();
  }
  if (marker !== undefined) work.push(marker);
  work.push(...notes);
  return work;
}

const trim = (lines: string[], budget: number) =>
  (a11yTree as unknown as { trimBodyToFit(lines: string[], budget: number): string[] }).trimBodyToFit(lines, budget);

describe("linear AX output trimming", () => {
  it("matches the old output for seeded mixed pages, Unicode and trailing hints", () => {
    let state = 123456789;
    const rand = () => { state = (1664525 * state + 1013904223) >>> 0; return state; };
    const roles = ["button", "link", "heading", "StaticText", "generic"];
    for (let sample = 0; sample < 150; sample++) {
      const lines = Array.from({ length: rand() % 100 }, (_, i) =>
        `  [e${i + 1}] ${roles[rand() % roles.length]} "${"long ☕ 漢字 🏔️".repeat(rand() % 8)}"`);
      if (sample % 2 === 0) lines.push("... (truncated, 7 omitted)");
      if (sample % 3 === 0) lines.push("\nNote: expand e99 for more", "Note: preserved recovery hint");
      const original = [...lines];
      for (const budget of [0, 1, 2, 7, 50, 100, 500, 10_000]) {
        expect(trim(lines, budget)).toEqual(legacyTrim(lines, budget));
      }
      expect(lines).toEqual(original);
    }
  });

  it("handles empty lines, embedded newlines, content-only and controls-only bodies", () => {
    for (const lines of [
      [], [""], ["", "", ""], ["foo\nbar", "", "baz"],
      ['[e1] link "one"', '[e2] button "two"'], ["text", "more text"],
    ]) {
      for (let budget = 0; budget < 30; budget++) expect(trim(lines, budget)).toEqual(legacyTrim(lines, budget));
    }
  });

  it("keeps controls before content without altering their order on a large page", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `[e${i}] ${i % 100 === 0 ? "button" : "StaticText"} "row ${i}"`);
    const result = trim(lines, 200);
    expect(Math.ceil(result.join("\n").length / 3.5)).toBeLessThanOrEqual(200);
    expect(result.every(line => line.includes("button"))).toBe(true);
    expect(result[0]).toBe('[e0] button "row 0"');
  });
});
