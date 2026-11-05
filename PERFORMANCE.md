# Tool hot-path performance

This patch removes unnecessary work without weakening agent isolation, fresh
accessibility reads, stale-ref checks, or normal navigation settling.

## Changes

| Path | Previous work | New work |
| --- | --- | --- |
| Overlay status | Existence check, then update: 2 serial CDP requests | Atomic check/update: 1 request; missing overlay repairs in 3 requests |
| Navigate post-load | Mask webdriver, read URL, read title sequentially | Issue all 3 independent operations together; retain independent failure fallbacks |
| Fresh AX read | Read URL, then document identity | Issue both probes together; await both before changing refs/cache |
| `view_page` | Fetch/render AX, then count hidden controls | Overlap advisory hidden-control count with fresh AX fetching; count failure remains non-fatal |
| Empty DOM-diff retry | Settle delay, then another full AX-change timeout | Observe AX changes during the same settle window; retain the minimum delay and final refresh |
| Output trimming | Repeated whole-body joins, scans and splices (quadratic) | Maintain exact UTF-16 character count, remove content before controls, filter once (linear) |

The retry change removes **up to 500 ms** with default settings on an unchanged
page. It does not remove the settle window or claim that a page is ready sooner.

## Reproduce the microbenchmark

```sh
npm run build
node scripts/benchmark-hot-paths.mjs 20 10
```

The arguments are simulated CDP response latency in milliseconds and iteration
count. This benchmark **does not touch Chrome**. The CDP cases compare the prior
serial request sequence with the optimized production handlers under simulated
latency; the CPU case compares the prior trimming algorithm with the optimized
production implementation and checks identical surviving lines first.

Example medians from this machine (10 iterations, simulated 20 ms CDP latency):

| Microbenchmark | Before | After |
| --- | ---: | ---: |
| Navigation post-load, plus zero-settle mock navigation | 61.92 ms | 21.63 ms |
| Overlay status update | 40.46 ms | 20.27 ms |
| Fresh empty AX read | 60.67 ms | 40.60 ms |
| AX read + hidden-control hint | 40.45 ms | 20.38 ms |
| CPU: trim 5,000-line AX body | 748.25 ms | 1.39 ms |

**These are not end-to-end page-load speedups.** Localhost CDP latency is normally
much lower than 20 ms. Real results depend on page loading, renderer contention,
AX tree size, metadata enrichment, MCP transport and model latency. The CPU
improvement applies when an oversized response actually needs this trimming path,
not to every page read. The CDP case percentages must not be added together.

## Validation

New regression tests check:

- Concurrent request issuance before any independent request completes.
- Independent URL/title failure behavior.
- Continued fresh AX reads and identity checks.
- One-request overlay updates, repair and non-fatal errors.
- Exactly one retry window, minimum settle time, absent AX watcher and aborts.
- Byte-for-byte trim equivalence with the previous algorithm over seeded mixed
  pages, Unicode, embedded newlines, controls, empty lines and trailing hints.
- A 20,000-line page keeps control priority and respects the token budget.

The full suite after this patch reported **2,692 passed / 20 failed** (99 files).
The same 20 failing tests reproduce in a temporary baseline copy with the
pre-performance versions of all five implementation files restored. They concern
existing ownership/discovery expectations, instruction/schema budgets, and a
read-only-directory test running as root. They are not new performance regressions.
TypeScript build and targeted ESLint checks pass.

## Remaining opportunities (not implemented here)

- Metadata enrichment can fan out to hundreds of `DOM.describeNode` calls plus
  event-listener probes per read. Profile representative pages before replacing
  these with a batched snapshot; iframe ownership and clickability must survive.
- A navigation listener registered after `Page.navigate` may miss early lifecycle
  events. A pre-navigation, loader-scoped collector could remove false timeouts;
  it needs redirect, reload and cross-session tests.
- Add an explicit opt-in readiness policy for callers who need DOM readiness
  rather than network idle. Do not silently shorten the default settle policy.
- Measure end-to-end page workflows with per-phase CDP counts and timings. Fast
  successful navigation/click verification matters more than merely returning
  `Clicked` quickly; reported clicks that do not navigate still require diagnosis.

## Activation

Build output is updated by `npm run build`. Already-running MCP processes keep
the modules loaded in memory: reconnect the public-browser MCP server to use it.
With the configured `--agent-id auto`, a new connection has a new identity; old
tabs remain shared and are not implicitly adopted or closed.
