# LikeOffice master plan

Read [current-state.md](current-state.md) first. It records what the
foundation already does and where the real gaps are.
[known-issues.md](known-issues.md) records the problems that are understood
and deliberately not fixed here, so nobody investigates them twice.

## Vision

LikeOffice is an MIT-licensed desktop word processor with three pillars:

1. **Word parity.** Open, edit, and save `.docx` with page-accurate fidelity
   and a full-depth editing surface.
2. **Scale.** Thousands of pages with bounded memory and sub-25ms keystrokes.
3. **AI-native.** Agents are first-class editors with a Cursor-grade review
   experience and a text-only IR for fast bulk edits.

## Where the work lives

| Repo | Role | Branch strategy |
| --- | --- | --- |
| `likeoffice` (this repo) | Electron shell, app UX, AI panel | `main` + feature branches |
| `wordinweb` | Engine: core, react, collab, server, agent | All engine work on branch `likeoffice`, checked out at `../wordinweb-likeoffice`. Merge to `main` in small reviewed increments — the repo convention (one clone per feature branch) already exists. |
| `wordinweb-parity` | Fidelity corpus + gates | `main`; new fixtures and the edit round-trip harness land here |

During development, LikeOffice links the engine packages from the
`wordinweb-likeoffice` checkout (`file:` deps). Releases pin published npm
versions. The parity repo's current worktree symlink drift (pinned 0.1.22,
linked 0.2.0) gets normalized to the same convention.

## Workstreams

Five workstreams. A through D are parallelizable across subagent teams after
W0 lands. Each has a detail doc.

### W0 — Safety net first (blocks everything that writes OOXML)

The single highest-risk fact in the audit: **an edited document has never been
verified to re-open faithfully in Word.** Before we greatly expand what the
editor writes, we build the gate that catches corruption.

- Edit round-trip harness in wordinweb-parity: scripted edit scenarios →
  save → desktop Word export → pixel + structural compare. Reuses the
  existing `word-download-parity.mjs` machinery (hard thresholds: mean
  < 0.05%, worst < 2%). Detail: [parity-coverage.md](parity-coverage.md).
- Persist gate results in-repo so regressions are visible over time.
- Fix the parity repo's package-link drift so results are attributable.

### W1 — Electron shell ([architecture.md](architecture.md))

A working desktop editor fast, on today's engine. Native file dialogs, native
menus, window-per-document, filesystem bundle store with autosave + versioning
+ crash recovery, real print, system font loading (closes the licensed-font
fidelity floors), packaging. The engine seams are already clean:
`ClientTransport` (2 methods) and `BundleStore` (4 methods).

### W2 — Editing parity ([wordinweb-expansion.md](wordinweb-expansion.md))

Close the gap to the full Word ribbon inside wordinweb. Ordered by leverage:

1. **Operation layer** — an operation registry that collapses today's
   4-place-per-feature tax (edit fn + editor method + intent variant + agent
   capability) into one registration. Pays for every feature after it.
2. **Clipboard** — native OOXML flavor, rich paste from Word, Electron
   clipboard integration, clipboard intents for collab.
3. **Fields engine** — insert + update for TOC, DATE, REF, STYLEREF, SEQ;
   a field-update pass; NUMPAGES already renders.
4. **Tables depth** — per-edge borders, table styles, numeric widths, autofit
   controls, sort.
5. **Styles** — create/modify/manage styles, style gallery, multilevel list
   editing.
6. **Review completeness** — suggesting mode for formatting/tables/styles
   (`rPrChange`/`pPrChange`/`tblPrChange`), modern comment threading
   (`people.xml`, resolution state).
7. **Objects** — chart render+edit (verify actual status first — docs
   conflict), image crop, endnote authoring, structured equation editing,
   watermark authoring.
8. **Long tail** — full color pickers, all highlight colors, custom
   margins/sizes everywhere, symbols, hyphenation, content controls,
   citations/bibliography, mail merge (last).

### W3 — Memory and scale ([memory.md](memory.md))

The measured constraint: layout holds ~150x document size in heap; the
incremental-relayout gate excludes exactly the serious documents. Plan:
adopt and finish the `codex/memory-window` windowed-page-model prototype,
widen the incremental eligibility gate (multi-section, footnotes,
multi-column), compact the `TextItem` representation, LRU the caches, fix
superlinear collab seeding. Budgets enforced by extended benchmarks at 1k and
5k pages.

### W4 — AI-native editing ([agent-ir.md](agent-ir.md))

- **DocMD**: a deterministic text/markdown projection of the document with a
  sidecar anchor map (line → block/run refs + wire offsets). Agents read a
  clean text file and edit by unified diff; the engine translates hunks into
  intents. This solves the two-offset-space hazard, table opacity, and the
  missing bulk-restructure path in one design.
- **Cursor-grade UX in LikeOffice**: side panel chat, selection-scoped edits
  (Cmd+K), every agent edit lands as tracked changes with per-hunk
  accept/reject. Depends on W2 item 6 (format-aware suggesting) for full
  reviewability.
- Agent-surface fixes: table cells + optional formatting in `context`,
  chart data validation, patch-based bulk editing for existing documents.

### W5 — Coverage expansion ([parity-coverage.md](parity-coverage.md))

Grow the corpus where it is thin or empty: charts, SmartArt (and fix the
65.66% page), ink, modern comments, embedded fonts, tabs, math, fields/TOC,
then citations, master documents, .doc/RTF import. Add fixtures for every W2
feature as it lands — a feature is done when its fixture passes both parity
and the W0 round-trip gate.

## Milestones

| Milestone | Contents | Exit criteria |
| --- | --- | --- |
| **M0** | W0 harness + W1 scaffold | Round-trip gate runs on 10 scripted edit scenarios; Electron app opens/edits/saves a docx with native dialogs |
| **M1** | W1 complete; W2 items 1–2 | Installable app (mac first); operation registry merged; Word-copy paste preserves formatting; gate green |
| **M2** | W2 items 3–6; W5 fixtures for each | Fields/TOC, tables depth, styles, review completeness shipped and fixture-covered |
| **M3** | W3 | 5,000-page doc opens; keystroke p50 < 25ms at 1,000 pages; heap bounded by window, enforced in e2e |
| **M4** | W4 | DocMD + patch tools shipped; agent panel with per-hunk review; agent evals extended and passing |
| **M5** | W2 items 7–8; W5 expansion | Charts render/edit; corpus covers every shipped feature; mean severity holds ≤ 0.4% as corpus grows |
| **M6** | Polish | Windows/Linux packages, auto-update, accessibility pass, i18n |

Milestones overlap; the ordering constraint is only W0 → (W2, W4-edit-paths)
and W2.1 → the rest of W2.

## How we execute with subagents

- One team per workstream; each team works in its own worktree of the
  `likeoffice` branch clone.
- Every engine PR must keep the existing exhaustiveness gates green (intent
  coverage map, agent capability/schema tests, skill-doc test) — these force
  the agent surface and docs to move with every new operation.
- Every OOXML-writing PR must add a round-trip scenario (W0 gate).
- Parity runs stay on this Mac (desktop Word required); the app and engine
  unit/e2e suites run in CI.

## Success metrics

- Parity: mean severity ≤ 0.4% as the corpus doubles; round-trip gate green.
- Scale: budgets above, enforced by `@benchmark` e2e.
- Agent: authoring evals extended per feature; a bulk-edit eval (DocMD patch)
  with token-cost budget vs the structured path.
- Coverage: ribbon-feature checklist vs Word tracked in this repo.

## Top risks

| Risk | Mitigation |
| --- | --- |
| OOXML corruption from new write paths | W0 gate before W2; scenario per PR |
| Memory rework destabilizes the 8.6k-line engine | Window at the LayoutResult level (prototype exists); deterministic rematerialization keeps layout code untouched; budgets in e2e |
| DocMD patch translation vs one-in-flight collab limit | Apply patches as a single sequenced transaction per hunk-batch in headless/solo; collab bulk edits go through the existing per-intent path |
| Chart engine scope (ChartML renderer is a mini-project) | Verify current status first; phase render (common types) before edit |
| Licensed fonts | Load from the user's OS only; never bundle |
| LIMITATIONS.md is stale in places | Trust code over docs; verification tasks noted per workstream |
