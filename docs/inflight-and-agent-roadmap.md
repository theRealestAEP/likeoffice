# In-flight work and agent-empowerment roadmap

Records what is NOT done. Reconciled against the repos on 2026-08-12; every
entry below was re-checked against the engine, the parity corpus and the app
rather than carried forward on trust. Two sections: (1) work still open,
(2) the agent-empowerment plan, which has now fully shipped and is kept for the
record.

**How to read a status here.** "Open" means verified still absent in code.
"Unverified" means settling it costs a probe or a run nobody has done — the
entry says what would settle it. Anything resolved moves to the Resolved
section at the end rather than being deleted; the record of what was once open
is worth keeping.

## 1. Still open

### Filed with evidence (build when prioritized)

- **Equation Function structures** — `m:func` is rendered (layout/math.ts kerns
  the function name) but is NOT in the linear grammar: edit/math.ts models sup,
  sub, frac, rad, nary, acc and lim, and `isLinearSafe` refuses arriving
  `m:func` equations. A Function palette button needs the grammar extended
  across tagOf/buildOmml/the parser — six functions plus syntax. Filed by wave
  4. **Verified open** (edit/math.ts has no `func` case).
- **Footnote/endnote gaps** — two halves, and only one is still open.
  `numRestart="eachSect"` now lays out; `numRestart="eachPage"` round-trips but
  is not laid out, and `pos` (beneath-text / section-end) round-trips but is
  not laid out either. **Verified open** (model.ts:1054 says so in as many
  words; `footnotePos` appears nowhere in layout/engine.ts).
- **Advanced-find format search** — find by formatting (bold/style) remains
  absent. Wildcards, whole-word and special characters shipped.
  **Verified open** (`FindOptions` carries only matchCase, wholeWord,
  wildcards).
- **Chart calibrations** — doughnut hole (`holeSize=75`), stacked
  gapWidth/overlap, and scatter/area stroke defaults use Word's authored values
  and are declared as filings rather than guess-calibrated. **Open,
  unverified against Word**: settled by a probe PDF re-measurement of each,
  which nobody has run.
- **zh/ko East-Asian snap metric** — ja is measured (1.296em hiragino profiles);
  zh/ko faces keep the textSnap carve-out until probed. **Verified open** (the
  carve-out is still in layout/inline.ts and measure.ts). Settled by a probe
  against zh/ko faces.
- **Exact-row micro-behaviours** — Word splits a splittable two-line row 1+1
  where we reject one-line fragments; non-cantSplit rows of exact-rule lines
  keep a 1.78px overhang Word moves. **Verified open** — both are recorded in
  the parity repo as the two #108a side-filings that the exact-row
  decomposition did not reach (scripts/README.md).
- **Shape tail** — the gap has narrowed but is real: the preset gallery and the
  nine bent/curved/straight connector presets ship (the connectors render as
  lines), and `a:custGeom` is parsed for arriving freeform art. Remaining:
  elbow/curved connectors as connectors, freeform/scribble AUTHORING, and edit
  points. **Verified open** (the only custGeom we author is the ink path).
- **Word's Insert > Text Box autofit default** (task #137, filed 2026-08-12) —
  `insertShapeAt` writes `<a:noAutofit/>` for the textBox preset, so a text box
  inserted from our own gallery clips as soon as it is full. Raised on a
  recollection that Word ships `a:spAutoFit` there. **Corpus evidence points
  the other way**: of the three real-world Word-authored fixtures in the parity
  corpus that contain true text boxes (wild-gatech, Word 16 Windows;
  wild2-med-phase23-protocol, Word 15 Windows; wild2-math-omml-dense, Word 15
  Mac), all 91 boxes carry `a:noAutofit` and none carries `spAutoFit`. So our
  default matches real documents and the case for changing it is weak. It stays
  open only because resizing a box in Word clears "Resize shape to fit text",
  which biases a wild corpus toward noAutofit and cannot tell us what the
  gallery writes at the moment of insert. Settled by authoring one text box in
  desktop Word and reading its `bodyPr`. Do not change the authoring default
  before that.
- **Demo "Start with" template reload hang** (task #138, filed 2026-08-12) —
  reloading the Résumé template from the demo's "Start with" select hung twice
  on "Loading Résumé… Preparing pages for editing", including after a full page
  reload, with nothing in the console. It then did NOT reproduce on the same
  build minutes later. **Unexplained, not fixed.** No reproduction, so nothing
  to file beyond the observation; if it recurs, capture the console and the
  network tab before reloading.

### Security posture (not remediation)

The 2026-08-12 Cloudflare tunnel credential flag was a **false alarm and is
retired**: the credential was never committed, never pushed, and appears in no
repository's history — the `.gitignore` rule covering it was committed four
hours before the file was created — and the flag also had the path wrong (the
file lives in the `wordinweb` clone, not `wordinweb-likeoffice`). Verified six
ways locally plus GitHub's tree/contents API on both public branches; a sibling
sweep across all four repos found no tracked secrets. **No rotation and no
history rewrite are needed** — an earlier revision of this document listed a
"Cloudflare credential rotation" as still open, which was wrong and is struck.
Evidence: scratchpad/secret-exposure.md.

What IS worth doing, and is the one open item here: **secret scanning is still
disabled on the public `wordinweb` repo.** Checked via the GitHub API on
2026-08-12 — `theRealestAEP/wordinweb` (public) reports secret scanning
`disabled` and push protection `disabled`, while `theRealestAEP/likeoffice`
(public) has both `enabled`. Enabling them on wordinweb is a durable backstop
for exactly the case the ignore rule caught here.

### Deliberate scope-outs (recorded in docs/tool-depth-matrix.md)

VBA/macros, compare/combine, IRM/protection, mail-merge execution,
index/TOA depth, master documents, online services, .doc/RTF import.

Also deliberate, and recorded so nobody re-audits them: the engine's local
editor fast paths that decline in a collab room (ink erase and ink-group
delete/arrange/nudge, watermark text/opacity/rotation, body-WordArt removal,
the three click-and-type paragraph extensions, and the accept/reject
wire-index refusal). Each declines rather than diverging — no mutation, so no
state to disagree about — and each carries a comment in edit/editor.ts saying
why.

## 2. Agent-empowerment plan — SHIPPED

All three items from the in-app LLM's own feedback are done. Kept as the record
of what was asked for and what it turned into, since two of them changed shape
on contact with measurement.

**2a. Non-body story projections.** Non-body stories project inside the
`<document>` tag as `<story>` blocks (AiPanel.tsx `storyBlocks`, mirrored in
bench/agent-bench.mjs). Md mode was required — text mode renders a field as an
opaque atom. The real-API control showed the value is bigger than
de-duplication: without the footer block the model fired the page-number
gallery blind and REPLACED the whole footer.

**2b. Rendered-output feedback.** `word_document_inspect` gained
`kind: "fit"` (5895f72, agent/src/document.ts), reporting box versus measured
text extent, overflow, clipped lines, autofit mode and page fill;
`TextItem.textFit` carries the measurement out of layout.

**2c. Autofit / shape-text-size operation.** `setDrawingTextFit` is a
registered op writing `bodyPr`. The probe **overturned this document's own
spec**: Word's file path never computes a fontScale — bare `normAutofit` stays
bare, authored caches are left unchanged, and Word paints at the authored size
and clips. Only `spAutoFit` acts, so shrinkText writes through and keeps
clipping, to match Word.

---

## Resolved since this document was written

### Both "interrupted mid-work" lanes — finished, not paused

An earlier revision of this document opened with a "resume first" section
naming these two. Both branches are merged into `likeoffice`; the section is
struck.

**Line-numbering Word conformance** — branch `linenum-conformance`, merged at
34a2c87 ("core: fix w:lnNumType's w:start off-by-one"). The renderer was
already correct on every probed dimension; the one real divergence was `w:start`
being an offset (Word prints start+1 whenever the attribute exists). The
pleading failure was an authoring gap, not a renderer one — real CA templates
bake digits into a header table rather than using `lnNumType` — now stated in
the skill guidance the model reads. probe-linenum, -2a and -2b are in the
certified corpus at 15 pages, all 0.00%.

**Toolbar resize polish** — branch `toolbar-resize`, merged at 8819ace, and
then superseded twice. The tier table the old entry described no longer exists:
e69f87b fits controls to the window by measurement instead of guessing, 394a8dc
makes the expand chevron always worth its line, and efae321 (2026-08-12) made
expanding add rows below and move nothing. The old plan's specifics are all
obsolete — the ⋮ popover is deleted, the chevron is the sole affordance and
renders only when controls are actually folded, and reserving the chevron's
width made folding monotone in width, which retired the hysteresis the entry
asked for.

### Tool-schema payload — landed

An earlier revision listed this as "~60,856 chars every request, in progress".
It shipped as `lean-schemas-v2` (7b2282c, merged): 61,343 → 54,191 payload
chars and 31,508 → 28,039 tokens, 74% of the byte win and 77% of the token win
available. The full `$defs` hoist was measured and NOT shipped — it cost
object-insert 1.8 extra rounds (mean 6.7 → 8.5, p ≈ 0.015 over 40 runs an arm)
because behind `$ref`s the model composed smaller first transactions. Addressing
shapes (`at`, `blockRef`, `runRef`, `objectRef`, …) are now left inline for that
reason. Full tables: bench/README.md.

### Bugs surfaced and fixed along the way

The `NaN words` pill (two lanes disagreed on the API shape; the test used a
simulated stub). Duplicate charts in AI runs — `removeDrawing` left the chart
part, rels, content-type overrides and embedded workbook orphaned, so
insert→delete→insert put two charts in the package with one in document.xml;
released at save time. Rollback errors that told the model to "send the
remaining operations" after a full rollback.

From the 2026-08-12 caret session: a caret pushed past a fixed text box's
bottom edge was left detached from the document rather than repositioned
(engine 32d53da), and Enter at a paragraph start handed the caret to the blank
paragraph inserted ABOVE it, so the caret did not follow — every Enter after
the first appeared to do nothing (engine bb8bd58, the user's "when I hit enter
the cursor doesnt follow"). The sweep that followed found exactly one local
fast path of that class in edit/editor.ts and left a standing local-versus-
collab oracle behind it.

### Two disciplined no-ships

Md-mode body projection (md emits a GFM table, so a cell patchable at text line
4 becomes a separator row — it would remove the quick-edit path from every
table cell) and the line-preserving object-token alternative (A/B'd n=8/arm;
the arms were byte-identical in 13 of 16 runs, so the numbers proved nothing —
recorded rather than shipped).

### Process changes worth keeping

The bench harness gained `--runs=N` with median and range, per-round tool
names, and full transcript recording, so single-sample conclusions and
unreplayable corruption bugs are both off the table. Two weak tests that hid
real defects were replaced with content assertions (word count; exported-PDF
text extraction plus a multi-page case). Verification standard: sweep widths
AND states — the earlier toolbar sweep captured only the closed bar, which is
why the broken panel survived it. And from the caret session: unit suites do
not measure pixels, so anything touching `packages/core/src/{layout,render,
parse}` re-runs the parity corpus and is compared PER PAGE, not on the mean.
