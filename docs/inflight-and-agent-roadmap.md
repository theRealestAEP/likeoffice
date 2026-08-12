# In-flight work and agent-empowerment roadmap

Updated 2026-08-12 (see the Resolved section at the end for what has since landed). Two sections: (1) work that was in flight or filed when the
API outage paused the pipeline, (2) the plan for the in-app LLM feedback from
the drawing-resize session.

## 1. In flight / needs work

### Interrupted mid-work (resume first)

**Line-numbering Word conformance** — worktree `wordinweb-linenum`, branch
`linenum-conformance` off 18bc0d7. User evidence: an AI-authored California
pleading numbers 1..48 down a page that should show the 28-line convention.
The arriving-Word pleading fixture scores 0.00, so the defect is in what
`setLineNumbering` authors, or in renderer attrs no fixture exercises.
Plan already briefed: probe-linenum (spacing × countBy × restart × empties ×
wrapped paragraph × table) with double Word exports, fix renderer divergences,
then fix the authoring defaults against real pleading fixtures' `w:lnNumType`.
Sentinels: caed-pleading, pleading-anon, us-courts; gate 17/17.
State: worktree clean at base; probe generator was being modeled on the
docgrid15b pair when the agent was clipped.

**Toolbar resize polish** — worktree `wordinweb-toolbarux`, branch
`toolbar-resize` off 18bc0d7. User verdict: "super clunky and wraps weirdly
as the screen resizes." Plan already briefed: 100px-step screenshot sweep
1600→700 and back (both tabs, collapsed/expanded, in-table context), then
hysteresis on tier transitions, atomic group folds with separators, stable
measurement basis so contextual tabs do not retrigger folding, pinned expand
chevron, cleaned ⋮ popover; judged on the full after-sweep.
State: sweep script was being placed into the app repo when clipped.

### Filed with evidence (build when prioritized)

- **Equation Function structures** — `m:func` does not round-trip the linear
  grammar; a Function palette button needs a contained grammar extension
  (six functions + parser syntax). Filed by wave 4.
- **Footnote/endnote gaps** — `numRestart="eachPage"` needs numbering folded
  into pagination; `pos` (beneath-text / section-end) round-trips but is not
  laid out. Filed by wave 4.
- **Advanced-find format search** — find by formatting (bold/style) remains
  absent; wildcards and special characters shipped.
- **Chart calibrations** — doughnut hole, stacked gapWidth/overlap, and
  scatter/area stroke defaults use Word's authored values but have no probe
  PDF re-measurement. Filed by wave 3 lane B.
- **zh/ko East-Asian snap metric** — ja is measured (1.296em); zh/ko faces
  keep the textSnap carve-out until probed.
- **Exact-row micro-behaviors** — Word splits a two-line row 1+1 where we
  reject one-line fragments; non-cantSplit exact-line rows keep a 1.78px
  overhang Word moves.
- **Shape tail** — connectors/freeform/edit-points beyond the 165-preset
  gallery.
- **Quick Parts scope note** — document-scoped blocks shipped; template-level
  (Building Blocks.dotx) galleries out of scope.
- **Security follow-up — RETIRED 2026-08-12, false alarm.** The flagged
  Cloudflare tunnel credential was never committed, never pushed, and appears
  in no repository's history: the `.gitignore` rule covering it was committed
  four hours before the file was created. The flag also had the path wrong —
  the file lives in the `wordinweb` clone, not `wordinweb-likeoffice`. Verified
  six ways locally plus GitHub's tree/contents API on both public branches;
  sibling sweep across all four repos found no tracked secrets. No rotation and
  no history rewrite needed. Evidence: scratchpad/secret-exposure.md.
  What IS worth doing, and is not remediation: **secret scanning is disabled on
  the wordinweb repo**. Enabling it with push protection on both public repos is
  a durable backstop for exactly the case the ignore rule caught here.

### Deliberate scope-outs (recorded in docs/tool-depth-matrix.md)

VBA/macros, compare/combine, IRM/protection, mail-merge execution,
index/TOA depth, master documents, online services, .doc/RTF import.

## 2. Agent-empowerment plan (from the in-app LLM's own feedback)

Session evidence: the model widened two drawings so text fits, and noted the
page number lives in the footer story but is invisible to it. Its three asks,
in build order (cheapest and highest-leverage first):

### 2a. Non-body story projections in the `<document>` tag

Today `projectionMessage` (AiPanel.tsx + bench/agent-bench.mjs) projects only
`story: "body"`. `word_document_project` already accepts other stories.

Plan:
- Project body first, then each existing header/footer story, each wrapped in
  its own tag: `<story kind="footer" ref="default">…numbered lines…</story>`
  inside the `<document>` tag, sharing the revision.
- Budget: body keeps 50k chars; headers/footers get a small per-story cap
  (2k) — they are short by nature.
- Patch targeting already carries a `story` field; the system prompt gains
  one sentence: patch non-body stories by passing their story key.
- Tests: bench regression — "add a page number" must not re-add one when the
  footer already holds it (the exact failure class from the session).

### 2b. Rendered-output feedback (text-fit per drawing)

The model resized drawings blind. The engine's layout knows every drawing's
box and its laid-out text extent.

Plan:
- Extend `word_document_inspect` with `kind: "fit"`: returns, per drawing on
  requested pages, `{objectRef, boxPx: {w,h}, textPx: {w,h}, overflow:
  boolean, clippedLines: number}` plus page-level `{page, contentBottomPx,
  pageBottomPx}` so the model can reason about page fill.
- Implementation: the layout pass already measures shape text (autofit work
  from the crop/watermark era); expose the measured extent beside the frame
  extent on the layout item, surface through the spatial-inspect plumbing
  (packages/agent/src/spatial.ts) which already walks pages.
- The system prompt advertises it in the formatting-work sentence: "after
  inserting or resizing a drawing, check kind:'fit'".

### 2c. Autofit / shape-text-size operation

Word's own answer to overflow: `bodyPr` autofit. Two DrawingML modes —
`a:spAutoFit` (grow the shape to the text) and `a:normAutofit` (shrink the
text, fontScale/lnSpcReduction).

Plan:
- New registered op `setDrawingTextFit {objectRef, mode: "none" |
  "resizeShape" | "shrinkText", fontScalePct?}` writing bodyPr per schema;
  layout honors both modes (resizeShape recomputes the frame from measured
  text; shrinkText applies fontScale to the shape's run measurement).
- Word-calibrate shrinkText's scale steps with a probe (Word quantizes
  fontScale; measure before hardcoding).
- Toolbar exposure: a small Autofit select in the drawing Format tab; agent
  capability row so the panel model can call it directly.
- Follow-up to 2b: `kind:"fit"` reports `autofit: mode` per drawing so the
  model knows whether overflow will self-resolve.

### Sequencing

1. 2a is renderer-side prompt work — one panel/bench change, immediate.
2. 2b is agent/inspect plumbing over existing layout data — no new layout.
3. 2c adds an op plus layout honoring and one probe — the only Word-
   calibration item; last.


---

## Resolved since this document was written

All three agent-empowerment items shipped, plus the two interrupted lanes and a
run of bugs the work surfaced.

**Agent empowerment (§2).** 2a story projections — non-body stories project in
md mode inside the `<document>` tag (text mode renders a field as an opaque
atom, so md was required); the real-API control proved the value is bigger than
de-duplication: without the footer block the model fired the page-number
gallery blind and REPLACED the whole footer. 2b `inspect kind:"fit"` reports box
vs measured text extent, overflow, clipped lines, autofit mode and page fill.
2c `setDrawingTextFit` writes `bodyPr` — and the probe overturned this
document's own spec: Word's file path never computes a fontScale (bare
normAutofit stays bare, authored caches unchanged, Word paints at the authored
size and clips); only `spAutoFit` acts, so shrinkText writes through and keeps
clipping to match Word.

**Interrupted lanes.** Line numbering: renderer was already correct on every
probed dimension; the one real divergence was `w:start` being an offset (Word
prints start+1 whenever the attribute exists), and the pleading failure was an
authoring gap — real CA templates bake digits into a header table rather than
using lnNumType, now stated in the skill guidance the model reads. Toolbar:
redesigned rather than patched — the ⋮ is deleted, the expand chevron is the
sole affordance and renders only when controls are actually folded, the fit
budget reserves the chevron's width (making folding monotone in width, which
retired the hysteresis), and a backfill pass removes the dead space.

**Bugs surfaced and fixed along the way.** The `NaN words` pill (two lanes
disagreed on the API shape; the test used a simulated stub). Duplicate charts in
AI runs — `removeDrawing` left the chart part, rels, content-type overrides and
embedded workbook orphaned, so insert→delete→insert put two charts in the
package with one in document.xml; released at save time. Rollback errors that
told the model to "send the remaining operations" after a full rollback.

**Two disciplined no-ships.** md-mode body projection (md emits a GFM table, so
a cell patchable at text line 4 becomes a separator row — it would remove the
quick-edit path from every table cell) and the line-preserving object-token
alternative (A/B'd n=8/arm; the arms were byte-identical in 13 of 16 runs, so
the numbers proved nothing — recorded rather than shipped).

**Process changes worth keeping.** The bench harness gained `--runs=N` with
median and range, per-round tool names, and full transcript recording, so
single-sample conclusions and unreplayable corruption bugs are both off the
table. Two weak tests that hid real defects were replaced with content
assertions (word count; exported-PDF text extraction plus a multi-page case).
Verification standard: sweep widths AND states — the earlier toolbar sweep
captured only the closed bar, which is why the broken panel survived it.

**Still open:** tool-schema payload (~60,856 chars every request, in progress),
the filed backlog in §1 above, and the Cloudflare credential rotation.
