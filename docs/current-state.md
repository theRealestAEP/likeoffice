# Current state of the foundation (audit, 2026-08-05)

This document records what exists today in `wordinweb` and `wordinweb-parity`.
It is the shared context for every LikeOffice workstream. Paths are relative to
each repo root.

## 1. wordinweb architecture

Five npm workspace packages: `core`, `react` (published as `wordinweb`,
v0.2.5), `collab` (v0.2.3), `server` (v0.2.3), `agent`. Node 22, tsup builds,
vitest units, Playwright e2e.

### The load-bearing design fact

The XML tree is the source of truth. The typed model (`core/src/model.ts`) is
a derived view; every model node keeps a `src` back-reference to its
`XmlElement`. Edits mutate XML in place, then the model re-derives — whole
document (`doc.refresh()`), one paragraph (`reparseBodyParagraph`), or a
direct run patch (`syncTextModel`, zero re-parse). Untouched XML ships
byte-for-byte on save. A save journal reverts save-time fixups so the live
tree is byte-identical before and after a save. Every expansion must preserve
this property.

### core (~43k lines)

- **Model** covers WordprocessingML deeply: four font channels, framePr,
  kashida, bidi, docGrid, all 13 conditional table formats, typed OMML math,
  DrawingML shapes/WordArt/warp geometry, ruby, charts and SmartArt as typed
  data. Fields and content controls stay opaque and round-trip untouched.
- **Layout** (`layout/engine.ts`, 8.6k lines): greedy line breaker with real
  canvas metrics (measured at 3x and scaled), UAX#9 bidi, Word-parity
  pagination (widow/orphan cascade, keepNext chains, same-y row splits,
  footnote reserve). Incremental relayout works at top-level-block granularity
  with resumable capture points, but the eligibility gate excludes
  multi-section, multi-column, footnotes/endnotes, mirror margins, vertical
  text, line numbering, framePr, floating tables, and NUMPAGES. Layout always
  produces a full-document result; there is no page-range laziness.
- **Editing** (`edit/editor.ts`, 7.1k lines): plain exported functions mutate
  XML; `DocxEditor` handles input. There is no command abstraction — each new
  operation costs ~4 coordinated edits (edit fn, editor method, `EditorIntent`
  variant, React host wiring). Undo keeps one shadow clone with cheap
  text-only entries (fixes a 12MB-per-keystroke problem at 500 pages).
  Tracked changes write real `w:ins`/`w:del` for text only.
- **Renderer** (`render/dom.ts`): absolutely-positioned DOM per `PageItem`.
  Page virtualization (mount window ± 2 pages, shells always mounted, caret
  pages pinned) plus page-DOM adoption across renders. The editor's only
  renderer contract is `RenderHandle.bindingsByText`.

### react (published `wordinweb`)

`DocxView` (2.4k lines) + `DocxToolbar` (4.2k lines, self-contained ribbon
with contextual tabs) + `DocxViewApi` (~90 imperative methods — the definition
of what the editor supports). Above 50 pages, global relayouts move to an
aborting background async job; a mid-flight tree change repairs the result
instead of discarding it. `useCollab` / `CollabEditor` in a separate entry.

### collab

Server-ordered op log + "OT-lite" (transform only for same-run character
offsets). 68 intent kinds with compile-time exhaustiveness. One-in-flight
per client is the shipped concurrency contract; multi-pending rebase is
specified but unimplemented — the largest open architectural debt. Offline
tail capped at 2,000 intents; diverged tails replay as tracked changes (≤50)
or become a draft. E2EE: key in the URL fragment, HKDF per-epoch keys,
AAD-bound ciphertexts, PBKDF2-600k share codes, blind-sequencer server.
`DocBundle` (confirmed bytes + stable-id sidecar + pending + offline tail) is
the durable client-side save unit. Two clean seams for Electron:
`ClientTransport` (2 methods, `collab/src/connection.ts:19`) and
`BundleStore` (4 methods, `collab/src/bundle.ts:151`).

### server

`CollabHub` is embeddable: construct it directly and drive `hub.handle(conn,
msg)` from any transport; the hub owns no timers (embedder calls the sweep
methods). Avoid `startZeroCustodyServer` in-process — it installs a
`process.exit(1)` uncaughtException handler. `StorageDriver` has exactly one
implementation (in-memory); disk persistence is greenfield.
`MAX_ROOM_CLIENTS` reads env at class-definition time and cannot be injected.

### agent

Six portable tools (`capabilities`, `compose`, `inspect`, `edit`, `asset`,
`save`), 67 edit operations with synthesized closed JSON Schemas, stable-ID
refs (`block:N`, `run:N`, `object:R:I`) that survive edits elsewhere.
Six inspect modes (`overview`, `context`, `read`, `search`, `object`,
`spatial`). Fingerprint-based staleness guard for collaborative edits (scope =
enclosing paragraph/table, 8 revisions retained). A detached CLI bridge with
an encrypted invite flow and a wake loop drives resident Codex/Claude turns.
Quality gates: a fixture audit (every component in >100 corpus docs must be
reachable and inspectable) and a real-Codex authoring eval scored through the
public API with up to 22 assertion families.

Known agent-surface gaps:

- Two offset spaces: `search`/context offsets are rendered text; edits consume
  wire offsets (fields/breaks/tabs count as 1 unit). They diverge on any run
  with a field, tab, break, or equation. Reconciliation is left to the model.
- `context` drops all inline formatting and all table cell content.
- `compose` is creation-only and single-shot; the only bulk-content path for
  an existing document is raw-OOXML `pasteBlocks`. Bulk restructure is absent.
- No markdown or text-only IR exists anywhere in the repo. Closest pieces:
  `paragraphText()`/`runText()` (module-private), the round-tripping linear
  math serializer (`mathText`), and `overview.outline`.

## 2. Editing gaps vs Word (from `internal/LIMITATIONS.md` + code)

The viewer is mature; the editor is newer. Missing or partial today:

- Charts: `internal/LIMITATIONS.md` says `c:chartSpace` has no render path,
  while the README documents `insertChart`/`updateSelectedChart` as native
  editable ChartML. **Verify which is current before scoping** (the
  LIMITATIONS doc is stale in at least one other place — see clipboard).
- Clipboard: HTML copy/paste has landed in code (`edit/clipboard.ts`) even
  though LIMITATIONS still says plain-text-only. There is no native OOXML
  clipboard flavor; internal round-trip rides a `data-dxw-fragment` JSON
  attribute.
- Endnote insertion (footnotes only).
- Structured equation editing: matrices, n-ary, accents, equation arrays open
  read-only; editing is linear-string re-emission. A second equation in the
  same paragraph is deliberately unaddressable.
- Suggesting mode tracks text only — formatting, tables, lists, styles,
  images mutate directly with no `rPrChange`/`pPrChange`/`tblPrChange`.
- Fields: only page-number fields can be inserted; TOC/DATE/REF render from
  cached results but cannot be inserted or updated.
- Image cropping, per-edge cell borders, table style application, numeric
  column widths, WordArt-from-scratch watermarks.
- Toolbar depth: 5 of ~15 highlight colors, blue-only page borders, preset-
  only margins/sizes/columns/spacing, fixed 35-family font list.
- Collab "honest no-ops": 3D rotation, ink arrange, VML carriers, watermark
  removal, drawing deletion, below-content click, suggesting-mode paste.
  Clipboard emits no intents at all (silent gap).

## 3. Memory and performance today

- Renderer virtualization is the main lever and is enforced by e2e tests
  (mounted pages bounded; keystroke p50/p99 < 25ms on a 60+ page doc; heap
  < 700MB and allocation < 45MB/s on a ~218-page doc).
- `scripts/bench-heap-bigdoc.mjs` records the core constraint: a ~500-page
  text document holds roughly **150x its own size in JS heap**, dominated by
  the layout page model (one `TextItem` per word/space at ~550 bytes).
- Break cache and width cache clear entirely on overflow (60k / 20k entries);
  metrics caches are unbounded.
- Collab seeding is superlinear: 1,200 paragraphs take 193s to submit vs 48s
  for 600.
- Unmerged branch `codex/memory-window` prototypes windowed page models,
  deterministic page rematerialization, and a heap benchmark. Branches
  `agent-bigdoc-memory` and `lazy-media-runtimes` are already merged.

## 4. wordinweb-parity

- Ground truth: AppleScript drives desktop Word to export fixture PDFs;
  poppler rasterizes at 192 DPI; Playwright captures each rendered page;
  a structural-residual metric (`severityPct`, ink-dilate-line-v5) scores
  every page. DATE/TIME fields are clock-pinned to the reference PDF.
- Current accepted full run (2026-07-30): 100 fixtures, 1,188 pages, all
  matched. Mean severity 0.358%, median 0.000%, 74.7% of pages at exactly
  0.00. Worst: SmartArt interop page at 65.66%; `wild-hamburg` contributes 10
  of the worst 25 pages; NIH row heights.
- The only hard pass/fail gate is the saved-DOCX round trip
  (`word-download-parity.mjs`): mean < 0.05%, worst < 2%. **No persisted run
  result exists in the repo.** An automated *edit* round-trip harness is
  unbuilt — the highest-risk gap for any expansion that writes new OOXML.
- Corpus gaps: charts (zero fixtures), ink, VBA/macros, signatures,
  `people.xml`/modern comment threading (zero); SmartArt, OLE, embedded
  fonts, tabs, math (thin: 1–4 fixtures). Realworld category is 85% of all
  compared pages. Mail merge, citations, master documents, .doc/RTF, and
  encrypted packages have no coverage signal at all.
- Everything runs locally on this Mac (Word + Full Disk Access + poppler +
  Ghostscript + LibreOffice + ImageMagick). There is no CI in the parity repo.
- Operational drift to fix: `apps/demo/node_modules/wordinweb` currently
  symlinks to a local worktree at v0.2.0 while package.json pins npm 0.1.22.
  The 0.358% result was measured against the local 0.2.0 build.

## 5. Electron-relevant seams (from the reference app `examples/anon-share`)

- File I/O is fully host-owned: hidden `<input type=file>` for open, Blob +
  `<a download>` for save at five duplicated call sites (consolidate first).
  Four file inputs live inside the toolbar (picture, SVG, GLB, OLE).
- Clipboard: native events emit `text/plain` + `text/html`; the context menu
  path uses permission-gated `navigator.clipboard` and needs Electron's
  clipboard module.
- Print: hidden-iframe `document.write` + `win.print()` → replace with
  `webContents.print()`/`printToPDF`.
- Fonts: layout uses metric substitutes (Carlito/Caladea); paint uses whatever
  the OS has. Desktop can load real locally-installed Office fonts, which
  closes the Thai 3.95% / Tamil 1.30% fidelity floors that licensing blocks
  on the web.
- Storage: `IndexedDbBundleStore` is replaceable via the 4-method
  `BundleStore` interface. `navigator.storage.estimate()` drives retention
  decisions in three places with wrong-for-desktop fallbacks. Per-tab
  `clientId` lives in sessionStorage; each `BrowserWindow` must mint its own.
  `wordinweb-room-<docId>` in localStorage stores the share link **including
  the `#k=` encryption key**.
- Lifecycle: autosave flush hangs off `pagehide`/`visibilitychange`; Electron
  needs `before-quit`/`close`. `history.replaceState` + `?doc=`/`#k=` is the
  whole router; a custom protocol must be registered secure for
  `crypto.subtle` to exist.
- An IPC `ClientTransport` must answer `ping` with a nonce-echoing `pong`, or
  `LivenessMonitor` declares the link dead. `onMessage` holds exactly one
  handler.
- Known open bugs (`internal/collab-plan/BUGS.md`): demoted editor sees its
  own refused edit until reload; click far below the last paragraph creates
  phantom runs; owner read-only browser e2e is `test.fixme`.

## 6. Security flags found during audit

- `examples/anon-share/.env` in wordinweb contains a live committed Cloudflare
  tunnel credential. Rotate and remove it.
- `apps/demo/public/fonts-local/` in wordinweb-parity holds licensed Microsoft
  fonts (gitignored, demo-only). Never bundle these into LikeOffice releases.
