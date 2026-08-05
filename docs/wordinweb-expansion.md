# W2 — Editing parity expansion (wordinweb `likeoffice` branch)

Goal: the editing surface reaches full-depth Word ribbon coverage. All work
happens on the `likeoffice` branch of wordinweb and merges to `main` in small
increments. Every OOXML-writing change ships with a W0 round-trip scenario
and, where visual, a parity fixture (W5).

## 2.1 Operation layer (first — it pays for everything else)

Today each new operation costs four coordinated edits: an `edit/*.ts`
function, a private `DocxEditor` method, an `EditorIntent` variant, and React
host wiring — plus an agent capability entry and skill-doc row. Build a
single operation registry that declares, in one place per operation:

- the XML mutation function and its target addressing (stable ids),
- the intent wire shape (feeds the collab `INTENT_KIND_MAP`),
- the agent capability row (feeds `AGENT_EDIT_CAPABILITIES` and schema
  synthesis),
- undo classification (text-diff vs full-snapshot),
- the "honest no-op" predicate for collab rooms.

Constraints: preserve the XML-as-truth model, the existing compile-time
exhaustiveness gates (they are the safety rails), and byte-stable round-trip
for untouched content. Migrate existing operations opportunistically, new
operations mandatorily.

## 2.2 Clipboard

- Native OOXML clipboard flavor (the format Word itself uses) for copy/cut;
  full-fidelity paste from desktop Word. The HTML path already landed
  (LIMITATIONS.md is stale here); extend it as the cross-app fallback.
- Run `validatePastedOoxml` on external OOXML (the validator exists and is
  currently bypassed).
- Clipboard intents: copy/paste currently emits no intents in collab rooms —
  a silent divergence gap. Route paste through the intent path.
- Electron: register Word's native clipboard format names.

## 2.3 Fields engine

- Insert: TOC, DATE/TIME, REF/PAGEREF (exists), STYLEREF, SEQ, NUMPAGES,
  FILENAME, AUTHOR.
- A field-update pass (recompute cached results from the model; TOC rebuild
  from outline + PAGEREF resolution against layout).
- Update-before-print and update-all commands.

## 2.4 Tables depth

Per-edge cell borders, table style application (the 13 conditional formats
already parse and render), numeric column widths, autofit modes, row height
rules UI, cell margins, repeat-header-row toggle, table sort, quick styles
gallery.

## 2.5 Styles and lists

Style create/modify/delete with live cascade re-resolution, style gallery,
style inspector, multilevel list definition editing, list restart/continue
controls, format painter.

## 2.6 Review completeness

- Suggesting mode for formatting, paragraphs, tables, styles:
  `rPrChange`/`pPrChange`/`tblPrChange`/`sectPrChange` write + render +
  accept/reject. This is a prerequisite for the W4 agent review UX — every
  agent edit must be reviewable.
- Suggesting-mode paste (currently an honest no-op).
- Modern comments: `people.xml`, threading/resolution state
  (`commentsExtended`), mentions.

## 2.7 Objects

- **Charts** — first verify actual status: LIMITATIONS.md says `c:chartSpace`
  has no render path; the README documents `insertChart`/
  `updateSelectedChart` as native editable ChartML; parity has zero chart
  fixtures. Then: render the common types (bar, line, pie, scatter, area),
  then editing depth, then the long tail. This is a mini-project; scope it as
  its own track.
- Image crop (model parses crop already; add handles + write path).
- Endnote authoring (`insertEndnote`, mirroring footnotes).
- Structured equation editing: make matrices, n-ary, accents, and equation
  arrays editable inline; make a second equation per paragraph addressable.
- WordArt/watermark authoring from scratch (VML `v:textpath` watermarks are a
  known engine gap); watermark removal intent.
- Ink arrange/group operations' collab intents (currently honest no-ops).

## 2.8 Long tail

Full color pickers (page borders are hardcoded blue today), all ~15 highlight
colors, custom margins/page sizes/columns everywhere presets exist, symbol
gallery, hyphenation, drop-cap depth, content-control editing (checkbox exists;
add dropdown, date, text), citations/bibliography, master documents, mail
merge (last — verify demand first).

## Sequencing

2.1 blocks nothing but discounts everything — land it first. 2.2–2.6 are
independent of each other and parallelizable. 2.7's chart track is
independent and long. Known open bugs to fold in early: phantom empty runs on
below-content click; demoted-editor optimistic edit visible until reload.

## Definition of done, per feature

1. Operation registered once in the 2.1 layer (editor + intent + agent
   capability + docs move together; exhaustiveness gates stay green).
2. Round-trip scenario in the W0 gate.
3. Parity fixture when the feature is visual (W5).
4. Toolbar/ribbon control + native menu item in LikeOffice.
5. Works in suggesting mode or has an explicit, tested honest no-op.
