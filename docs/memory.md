# W3 — Memory and scale: thousands of pages

## The measured problem

- A ~500-page text document holds roughly **150x its own size in JS heap**
  (`scripts/bench-heap-bigdoc.mjs`). The layout page model dominates: one
  `TextItem` per word and per space, ~550 bytes each.
- Layout always produces a full-document `LayoutResult`; only the renderer
  virtualizes.
- The incremental-relayout eligibility gate excludes multi-section documents,
  footnotes/endnotes, multi-column, mirror margins, vertical text, line
  numbering, framePr, floating tables, and NUMPAGES — i.e., most serious
  documents fall back to full relayout on every edit.
- Cache eviction is clear-all (break cache 60k, width cache 20k); metrics
  caches are unbounded.
- Collab seeding is superlinear (1,200 paragraphs: 193s; 600: 48s).

## Targets (enforced in `@benchmark` e2e, per platform signature)

| Metric | Today (enforced) | Target |
| --- | --- | --- |
| Open + first paint, 5,000 pages | — | < 10s to interactive window |
| Keystroke p50/p99, 1,000 pages | 25ms budget at ~60 pages | 25ms at 1,000 pages |
| Peak heap, 5,000-page text doc | 700MB at ~218 pages | O(window), ≤ 1GB at 5,000 pages |
| Allocation rate while typing | 45MB/s | hold |
| Mounted pages | min(40, total) | hold |
| Collab seed, 1,200 paragraphs | 193s (recorded) | O(n), < 60s |

## Plan

### 3.1 Windowed layout model (the big lever)

Adopt and finish the `codex/memory-window` branch prototype ("Window
positioned page models", "Pin deterministic page rematerialization", heap
benchmark). Design intent:

- Keep full-fidelity `PageItem` models only for the render window ± overscan.
- For pages outside the window, retain a compact per-page summary: block
  range, height, break-state capture point (the engine's `IncrState` capture
  points already exist for exactly this resume purpose).
- Rematerialize a page deterministically from its capture point when the
  window reaches it. Determinism matters: caret positioning, hit testing, and
  parity must be identical whether a page was retained or rematerialized.
- The editor's caret/selection pages stay materialized (the renderer already
  pins them).

### 3.2 Compact hot structures

- `TextItem` diet: struct-of-arrays or typed-array packing for geometry
  fields, interned strings for repeated font keys. Measure with the heap
  benchmark before/after; target ≥ 3x reduction per item.
- LRU eviction for break/width caches instead of clear-all; bound the
  metrics/paintBox/inkBox caches.

### 3.3 Widen the incremental gate

Priority order by real-document frequency:

1. Footnotes/endnotes (per-line footnote reserve is the hard part; capture
   footnote state in `IncrState`).
2. Multi-section documents (resume at section boundaries).
3. Multi-column sections.
4. NUMPAGES/SECTIONPAGES (invalidate only the pages that paint the field, or
   defer the update to a background pass).

Each widening lands with a correctness proof: full-layout vs incremental
output equality across the parity corpus (the layout result is deterministic,
so byte-compare the `PageItem` stream).

### 3.4 Parse and load path

- Incremental/streaming parse is a later optimization; measure first — the
  audit shows heap, not parse time, is the binding constraint.
- `lazy-media-runtimes` (already merged) covers media decode laziness.

### 3.5 Collab seeding

Profile the superlinear per-paragraph seed cost (recorded: cost grows 2.4x
from first to last quarter). Likely a rescan-per-intent; fix to O(n) batch
seeding.

## Verification

- Extend `bench-heap-bigdoc.mjs` and the bigdoc e2e specs to 1k/5k-page
  fixtures (generate; the corpus's 419-page NIH contract is the largest real
  document).
- Determinism gate: window-scrolled-then-rematerialized layout equals
  full layout, byte-for-byte, across the corpus.
- Perf report history (`internal/perf/`) keeps the regression flagging;
  add the new metrics to `STRESS-METRIC` emission.
