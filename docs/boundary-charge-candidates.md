# Uncharged-boundary candidates

Four probe-derived rules that landed this session share one shape: **a quantity
Word declines to charge at a boundary, which we charge (or fail to charge)
differently.** They were adjacent identical paragraph borders, cell borders
inside exact-height rows, the break-only paragraph page-fit exception, and text
ascent on inline-image lines.

This is a sweep of `packages/core/src/layout/engine.ts` and `inline.ts` for the
OTHER per-element charges applied at a boundary. It is analysis only — nothing
here is fixed, and nothing here is measured against Word yet.

**#55 is why every entry below carries a provenance line.** That defect
pattern-matched this shape exactly — a line box consistently short by a fixed
amount — and turned out to be a STALE CALIBRATION artifact: a parser rounding
rule fitted against a reference PDF whose own Word build rounded raster
placement to whole points. The "Word charges something here that we do not"
reading was wrong; the reference was. A code comment citing a fixture
measurement is only as good as that reference's hint and build status, so each
candidate names the fixture behind the current behavior, classifies it, and gets
one of three flags.

---

## Provenance classes

| Class | Meaning |
|---|---|
| **A** | Purpose-built probe, measured 2026-08-05/06 against a fresh export on the current Word build. Generated fixtures carry no `w:lastRenderedPageBreak`. Strongest available. |
| **B** | Corpus fixture screened CLEAN by the #48 hint screen; reference exported in the 2026-07 era. Hints cleared, build vintage unscreened. |
| **C** | Hint-STALE fixture, but the calibrating PAGE falls inside the range the re-export left identical. |
| **D** | Hint-STALE fixture, calibrating page inside the range the re-export CHANGED. |
| **E** | Fixture carries zero hints (verified, so it was never in the #48 population); reference exported in the 2026-07 era. Build vintage unscreened. |
| **F** | Old-build export with a KNOWN behavioral difference from the current build (#55). |
| **G** | No fixture cited anywhere. The behavior was never measured against Word. |

Flags: **WORD-DIFFERS** (provenance sound — a genuine "what does Word charge"
question), **RE-VERIFY** (re-export the reference before designing the probe;
the probe may be chasing an artifact), **NEVER-MEASURED** (nothing to
re-verify — the probe is the first measurement).

### The hint screen does not cover build drift

#48 screened 15 hint-carriers and cleared 12. That axis is in good shape. A
SECOND axis is entirely unscreened: **which Word build exported the reference.**
Creation dates on the 128 reference PDFs in `parity/` fall into two eras —

    2026-07-02 .. 2026-07-22    111 references
    2026-08-05 .. 2026-08-06      9 references (the #43/#48 re-exports, the
                                  chart probes, the sectcontinuous probes)

— and #55 proved the two eras differ behaviourally: the current build places
rasters on quarter-points where `wild2-sci-ieee-2col`'s 2026-07-17 export places
them on whole points. Reading fractional parts of image boxes straight out of
the PDFs separates the known cases (`eq-as-images` and `phase23`, both
re-exported, show clean 0.25/0.5/0.75 steps; `ieee-2col` shows 4 of its 6 image
dimensions on integer points), but the signature is weak on fixtures with few
images and says nothing about text or rule placement.

So class B and class E are not "clean" — they are "clean on the one axis that
was screened". Anything flagged RE-VERIFY on build grounds is asking for the
cheap thing first: re-export the reference and see whether the number the
comment cites still holds.

### One citation cannot be resolved at all

Four comments (`engine.ts:3095`, `3106`, `3146`, `3239`) cite a bare
**`wild2-legal`**. Two fixtures match: `wild2-legal-ca-agreement` (hint-STALE,
and stale specifically at page 1) and `wild2-legal-nih-contract` (hint-screened
CLEAN). Every other reference to the NIH one in these files writes the name in
full, and the cited page numbers (p1, p3, p15/p23) fit ca-agreement's 22-23 page
span, so the bare name most likely means ca-agreement — the stale one. It cannot
be settled from the source. **Resolving that citation is a prerequisite for
candidate 10**, and the naming should be fixed wherever it appears.

---

Ranked roughly by how much a wrong answer would move a page.

---

## 1. The footnote separator reserve is a flat constant

**Code site:** `engine.ts:445-458` (`NOTE_SEP_H`, `NOTE_SEP_RESERVE`,
`MULTI_COL_NOTE_SEP_RESERVE`), spent in `noteSeparatorReserve`
(`engine.ts:2863`) and `footnoteReserve` (`engine.ts:2867`), and again in the
body-fill simulation at `engine.ts:4574`.

**What is charged:** 40px of body-fill room above a page's footnotes (26px per
column when the page has more than one), plus a separately painted 14px strip.

**At which boundary:** The bottom of a column, as soon as that column carries
its first footnote. Zero footnotes charge nothing; one charges the full 40px,
and the second charges no more.

**Provenance:** Split, and the halves differ.
- The 40px cites `wild-doerfp` p3 — **class B** (34 hints, screened clean;
  reference 2026-07-08).
- The 26px cites "IEEE's Word PDF" = `wild2-sci-ieee-2col` — **class F**. This
  is the exact reference #55 named as an older export that rounds where the
  current build does not. The constant was fitted to sub-pixel positions
  (separator at 573.75pt, final glyph at 559.58pt) read off that PDF.

**Flag:** **RE-VERIFY** the 26px; **WORD-DIFFERS** for the 40px.

**What Word might do differently:** Word's separator is a real paragraph
(`w:footnoteSeparator` in footnotes.xml), so its band should be that paragraph's
line height plus the first note's space-before — a document quantity, not a
constant. The comment already concedes 40 is fitted.

**Probe design:** One page of body text plus one footnote, in four variants
whose `w:footnoteSeparator` paragraph differs only in font size and
spacing-after; measure how many body lines Word fits above the separator in
each. Re-export `wild2-sci-ieee-2col` first and re-read the two positions the
26px was fitted to.

---

## 2. The last footnote's spacing-after lifts the whole note block

**Code site:** `emitFootnoteAreas`, `engine.ts:2944-2973` — the block is placed
at `page.bodyBottom - footnoteH[column] - separatorHeight` (`engine.ts:2955`),
and `footnoteH` accumulates each note's `laid.height` (`engine.ts:2940`), which
`layoutFrame` computes with the last paragraph's spacing-after included.

**What is charged:** The final footnote paragraph's `w:spacing w:after`, as
height below the last note line.

**At which boundary:** The bottom margin. Because the stack is anchored from the
bottom UP, that trailing space does not fall off the page — it pushes every
footnote line, and the separator rule above them, upward by that much.

**Provenance:** **Class G.** No comment at this site claims a measurement. The
block's bottom anchoring is asserted by `NOTE_SEP_GAP`'s comment ("their
bottom-anchored block already matches Word to the device row, parity2-notes p1
stays 0.00") — but `parity2-notes`' note style may simply carry `after=0`, in
which case that 0.00 says nothing about this charge either way.

**Flag:** **NEVER-MEASURED.**

**What Word might do differently:** This is the page-bottom twin of the
break-only paragraph exception. Word most likely rests the last footnote's
descent on the bottom margin and lets the trailing space-after fall off the
page, as it does for the last body paragraph.

**Probe design:** Two footnotes on one page whose note style carries
`after=240` (12pt), against a copy with `after=0`; measure whether the separator
rule and the first note line move 12pt between the two Word renders. Check
`parity2-notes`' note style first — if its after is already 0, that fixture
never exercised this path.

---

## 3. The header's last paragraph pushes the body down by its spacing-after

**Code site:** `measureHeaderFooter`, `engine.ts:6364-6413` (the height comes
straight out of `layoutFrame`), consumed as `bodyTop` at `engine.ts:2106-2118`.

**What is charged:** The trailing spacing-after of the last header paragraph,
inside `headerH`, which then competes with `sp.marginTop` for the body top.

**At which boundary:** The header/body boundary. It bites only when the header
outgrows the top margin (`page.headerGrown`) — which is exactly when the charge
decides the page's first baseline.

**Provenance:** **Class G** for this charge. The site carries one measured rule
(22.5pt of clearance under a complex header) with no fixture named, and nothing
at all about the trailing after. `headerH` is a `layoutFrame` height that
nobody appears to have decomposed against Word.

**Flag:** **NEVER-MEASURED.**

**What Word might do differently:** Word measures the header band from
`headerDistance` to the last header LINE, and the trailing space-after belongs
to the gap it already reserves down to the margin. If so, a header whose last
paragraph carries a big after should not move the body until its lines alone
pass the margin.

**Probe design:** A three-line header under a 0.5in top margin, in two variants
differing only in the last header paragraph's `w:after` (0 vs 24pt); measure the
first body baseline in each. The same probe should pin the unattributed 22.5pt
while it is there.

---

## 4. Header and footer first paragraphs charge their full space-before

**Code site:** `layoutFrame`'s block loop, `engine.ts:5609-5626` — `spacingBefore`
starts at the paragraph's own value and advances by
`Math.max(spacingBefore, framePrevAfter) - framePrevAfter` with `framePrevAfter`
initialised to 0.

**What is charged:** `w:spacing w:before` of the first paragraph in a header,
footer, cell, text box or footnote frame.

**At which boundary:** The top edge of every frame. Body page tops drop the
plain before (`engine.ts:4468`); no frame top does.

**Provenance:** **Class E, and it answers a different question.** The one comment
here cites the `coverletter-anon` RECIPIENT/TITLE/ADDRESS block (0 hints
verified; reference 2026-07-14), and it calibrates CONTEXTUAL SPACING inside a
frame, not the frame-top charge. The frame-top behavior itself is class G.

**Flag:** **NEVER-MEASURED.**

**What Word might do differently:** A header band's top is a page-top-like
boundary — Word may collapse the leading space against `headerDistance` the same
way it collapses against the top margin. A cell top is probably NOT the same
case (Word does honour space-before in a cell), so the rule may split by frame
kind, which is itself the finding.

**Probe design:** One document with the same `before=18pt` paragraph opening a
header, a footer, a table cell and a text box; measure each first baseline
against its container's top edge in Word's render.

---

## 5. Cell top and bottom margins both charge at a shared row boundary

**Code site:** `layoutRow`, `engine.ts:8457-8459` —
`cellHeight = height + m.top + effectiveBottomPad(m.bottom)`; summed per row in
`computeRowHeights`, `engine.ts:8329-8354`.

**What is charged:** Row *k*'s bottom cell margin and row *k+1*'s top cell
margin, in full, on both sides of the same interior boundary.

**At which boundary:** Every interior row boundary of a table. This is precisely
the shape of the two border rules already fixed: `rowBorderShare`
(`engine.ts:7330`) splits ONE painted rule half to each adjacent row rather than
charging a full width to both, and `exactRowCellBorderShare` charges a shared
`tcBorders` rule once per boundary. The cell MARGINS get no such treatment.

**Provenance:** **Class A for the neighbours, class G for this charge.** The
margins appear in `rowHeightFromTrHeight` (`engine.ts:7192-7234`) calibrated on
`probe-trheight` — purpose-built, though its reference dates to 2026-07-07 — and
the exact-row rule beside it on `probe-exactrow`, generated and measured
2026-08-06 on the current build (commit 72891da; the reference was read live and
not committed). Neither probe varied the margins at an INTERIOR boundary, which
is the question here.

**Flag:** **NEVER-MEASURED.**

**What Word might do differently:** Word's cell margins are per-cell insets and
probably do stack at an interior boundary — but the two border rules show Word
merging co-located quantities at a shared edge, and a `w:tblCellMar` of 0.1in
top and bottom would make a 20-row table 4in taller under stacking than under
merging.

**Probe design:** A 10-row single-column table with `tblCellMar`
top=bottom=144tw against a copy with top=288/bottom=0; equal total heights mean
the margins stack, a shorter second means they merge at the boundary. Extend
`generate-exactrow-probe.mjs`, which already builds this shape on the current
build.

---

## 6. A cell's last paragraph charges its spacing-after ON TOP of the bottom margin

**Code site:** The same `cellHeight` at `engine.ts:8457` — `height` comes from
`layoutFrame`, whose trailing `y += spacingAfter` (`engine.ts:4822` for the body
path, `engine.ts:5626`'s `framePrevAfter` chain for frames) has already added
the after; `m.bottom` then adds the cell inset below it.

**What is charged:** Paragraph spacing-after AND the cell's bottom margin, in
series, below the last line of a cell.

**At which boundary:** The bottom edge of every cell.

**Provenance:** **Class E, and it is load-bearing.** `rowBorderShare`'s comment
(`engine.ts:7320-7326`) decomposes `parity2-nestedtables`' 56.0pt rows as "3
lines + spacing-after + 4pt cell margins + 0.5pt of sz-4 borders" — that
arithmetic asserts the sum, and it is the only place anything does.
`parity2-nestedtables` carries 0 hints (verified) but its reference is a
2026-07-08 export, unscreened for build. A single fixture whose numbers happen to
add up is weak evidence for a rule this general.

**Flag:** **RE-VERIFY.** Re-export `parity2-nestedtables` and re-check that the
56.0pt decomposition still holds before treating the sum as Word's rule.

**What Word might do differently:** Word may collapse the two the way it
collapses adjacent paragraph spacing — max rather than sum — or drop the trailing
after at a cell bottom, the same exception the page bottom gets. Nearly every
corpus table carries a Normal style with `after=8pt`, so this charge is on almost
every row we lay out.

**Probe design:** A one-row one-cell table whose only paragraph has `after=24pt`
and whose cell has `bottom margin=24pt`, against three variants zeroing each in
turn; the four Word row heights separate sum, max, and after-dropped.

---

## 7. The outer half of a table's top and bottom rule is charged to the table

**Code site:** `rowBorderWidths`'s `boundary()`, `engine.ts:7312-7317`, halved
into each row by `rowBorderShare`, `engine.ts:7330-7333`.

**What is charged:** Half the width of the table's outer top rule to row 0, and
half the outer bottom rule to the last row.

**At which boundary:** The table's outer edges — where, unlike an interior
boundary, there is no second row to take the other half.

**Provenance:** **Class B + E, both on interior boundaries only.** The half-share
is calibrated on `parity2-nestedtables` (class E, 2026-07-08), `wild-doerfp`'s
roster tables (class B) and `wild-multicolumn` p30 (0 hints verified,
2026-07-08). Every cited measurement is an INTERIOR boundary or a whole-grid
drift over many rows; none isolates the outer edge.

**Flag:** **WORD-DIFFERS.** The provenance is adequate for what it covers, and
the outer edge is simply outside it.

**What Word might do differently:** An interior boundary splitting half-and-half
is measured and right. An outer boundary has only one side, so Word either
charges the whole rule to the row it borders, or none of it and paints the rule
in the paragraph gap outside the table. Half is the one answer that can only be
right by coincidence.

**Probe design:** A 3-row table with `tblBorders` top/bottom at sz=48 (6pt) and
insideH at sz=4; measure the paragraph-above to first-baseline distance and the
last-baseline to paragraph-below distance.

---

## 8. A top border reserve survives a page top that drops the plain space-before

**Code site:** `engine.ts:4354`, `engine.ts:4429` and `engine.ts:4468` — each
collapses `spacingBefore` to `borderPadTop` rather than to 0.

**What is charged:** The paragraph's top rule plus its `w:space`, at a page or
column top where the plain space-before is dropped.

**At which boundary:** The top of a page or column reached by soft overflow.

**Provenance:** **Class E for the page-top half, class D for the border half.**
The page-top drop is calibrated on `wild-multicolumn` p23/p39 and p30/p31 (0
hints verified, 2026-07-08) and on the `parity2-*` openings. The border reserve
that survives it comes from the merged-border work, whose measurement is
`wild2-legal-ca-agreement` p1 (`engine.ts:4090-4096`) — a hint-STALE fixture,
stale precisely at page 1: #38 proved the blank verso after page 1 exists only
when Word replays stored hints, and the knife-edge fit at the foot of page 1 is
where the difference lives.

**Flag:** **RE-VERIFY.** The merged-border rule itself was landed against a
re-checked page and is probably fine, but any NEW inference about border
reserves drawn from ca-agreement p1 needs the re-exported reference.

**What Word might do differently:** The merged-border rule established that Word
charges NO reserve where a rule does not paint, and the page-top rule that Word
drops leading space against the top margin. A boxed paragraph arriving at a page
top is both at once: Word may paint its top rule at the margin and charge nothing.

**Probe design:** A boxed paragraph (`pBdr` top sz=12 space=8) forced by overflow
to the top of page 2, against the same paragraph mid-page; measure margin-to-rule
and rule-to-first-baseline. Generate it — do not reuse ca-agreement.

---

## 9. An empty section-break paragraph exports its spacing-after across the break

**Code site:** `engine.ts:3082-3095` — the block takes no height, but its
`spacingAfter` is promoted into `lastParaSpacingAfter` when it exceeds what is
already there.

**What is charged:** The section-break paragraph's spacing-after, carried into
the collapse against the FIRST paragraph of the next section.

**At which boundary:** A section break. The carry is unconditional on the break
KIND — continuous and nextPage feed the chain identically, and a nextPage break
also starts a fresh page whose top would otherwise drop the before.

**Provenance:** **Class E + B.** `parity-colbalance` (0 hints verified, reference
2026-07-07) for the no-height half, `wild-doerfp` p27 (class B) for the carry.
Both are continuous-break cases; the nextPage case is uncited.

**Flag:** **WORD-DIFFERS.** Provenance covers the continuous break; the nextPage
break is genuinely unexamined rather than badly measured.

**What Word might do differently:** Across a nextPage break the next section's
first paragraph sits at a page top, where Word drops leading space; carrying an
after into that collapse can only push it down.

**Probe design:** Two sections whose break paragraph is empty with `after=18pt`,
in a nextPage variant and a continuous variant; measure section 2's first
baseline against its column top in both. `probe-sectcontinuous` (2026-08-06,
current build) is the natural place to add the nextPage arm.

---

## 10. The doubled opening empty paragraph charges its after before a paragraph, not before a table

**Code site:** `engine.ts:3095-3106` (the doubling) and `engine.ts:3139-3149`
(`if (!beforeTable) this.y += paraProps.spacingAfter ?? 0`).

**What is charged:** One extra mark-line height always, plus the paragraph's
spacing-after when the follower is a paragraph and not a table.

**At which boundary:** The document's opening empty paragraph, against whatever
follows it.

**Provenance:** **The worst on the list — one point per branch, and the branches
have opposite provenance.**
- Paragraph branch: `phase23`'s "2 × 19.4" at p1 — **class C**. `phase23` is
  hint-STALE, but the re-export changed only pages 69 and 70; pages 1-68 match,
  so the p1 measurement survives its fixture's staleness.
- Table branch: `wild2-legal`'s "2 × 13.8 exactly" — **class D, probably.** If
  the bare name means `wild2-legal-ca-agreement`, as the page numbers suggest,
  this is a page-1 measurement on the fixture whose page 1 #38 proved stale. If
  it means `nih-contract`, it is class B and fine. **The source cannot say
  which.**

**Flag:** **RE-VERIFY**, and resolve the citation first. A two-point split where
one point may be an artifact is not a rule.

**What Word might do differently:** The real rule may be about the header having
outgrown the top margin — the other condition in scope at that site — rather than
the follower's kind at all, in which case a table under a grown header would want
the after too.

**Probe design:** A generated document opening with one empty paragraph carrying
`after=12pt`, crossed two ways: follower is a table or a paragraph, header
outgrows the top margin or does not. The four first-content offsets separate the
two candidate rules and retire both wild-fixture citations.

---

## 11. A keepNext chain stops dead at the end of its section

**Code site:** `engine.ts:4270-4290` — the walk runs `while (siblings && idx <
siblings.length ...)`, where `siblings` is the current section's block array. A
chain reaching the last block of a section falls out with whatever `tail` it has.

**What is charged:** Nothing, for a keepNext paragraph whose successor lives in
the next section.

**At which boundary:** A section boundary. A continuous break puts the next
section's first block on the same page, so a keepNext binding across it is a live
question; a nextPage break makes the point moot.

**Provenance:** **Class B throughout.** Every citation in the keepNext machinery
is `wild2-legal-nih-contract` — p29/30, p34/35, p177, p416/417 — written in full
each time. 88 hints, screened clean over 419 pages with 0 diffs, the strongest
hint-screen result in the corpus. Reference 2026-07-09, build unscreened.

**Flag:** **WORD-DIFFERS.** The section boundary is simply outside the range the
fixture exercises.

**What Word might do differently:** Word's keepNext is a paragraph-to-paragraph
property with no section scoping, so it very likely binds across a continuous
break. We would leave a heading alone at a column bottom where Word moves it.

**Probe design:** A keepNext heading as the last block of a continuous-break
section, positioned so only the heading fits at the column bottom, with the next
section opening on a 3-line paragraph; see whether Word leaves or moves it.

---

## 12. The endnote separator gets an extra 4.4px lead that the footnote separator does not

**Code site:** `engine.ts:460-467` (`NOTE_SEP_GAP`), spent at `engine.ts:3022`
inside `placeEndnotes`.

**What is charged:** 4.4px between the endnote separator rule and the first
endnote line, and nothing equivalent at a footnote separator.

**At which boundary:** The separator/first-note boundary, charged for endnotes
and not for footnotes.

**Provenance:** **Class E, single fixture, both sides.** `parity2-notes` p2 for
the endnote gap and p1 for the footnote non-gap (0 hints verified; reference
2026-07-08). One document decides both halves of an asymmetry, and 4.4px is a
fitted residual ("~17pt where our strip left ~13.7pt") rather than a derived
quantity — the same fitted-constant shape as #55's rounding rule.

**Flag:** **RE-VERIFY.** Re-export `parity2-notes` before building on either
half.

**What Word might do differently:** The comment explains the asymmetry as the
first endnote's space-before. If that is the mechanism, the quantity is the note
style's `w:before` and should be read from the document — and the footnote side
should read it too, and usually get 0.

**Probe design:** One document with footnotes and endnotes whose note styles both
carry `before=6pt`, against a copy with `before=0`; measure both
rule-to-first-line gaps in each.

---

## 13. A numbering label sizes the line only when it is taller than the text

**Code site:** `inline.ts:2441-2456` — spans are filtered so a `numLabel` span
shorter than the tallest text span drops out of the line-height computation.

**What is charged:** The label's ascent and descent contribute nothing to a line
whose text is taller, including the label's descent.

**At which boundary:** The first line of every numbered or bulleted paragraph.

**Provenance:** **Mixed B / C / E, and this is #55's own neighbourhood.**
`wild2-legal-nih-contract` p342 (class B) for the Courier bullet that does not
register, `phase23` (class C — the Symbol/JhengHei case is not on pages 69-70)
for the bullets that do, `parity2-lists` (class E) for the label alone on its
line. Worth noting: #55 was a line-box defect in `inline.ts` measured the same
way, and its first diagnosis (#49, commit `3a2c1d2`) read a 10.41px step as a
missing text ascent when it was a 20.8px grid pitch halved by an extent rounding.
Line-box arithmetic in this file has already fooled one careful measurement.

**Flag:** **RE-VERIFY.** Not because a cited reference is known bad, but because
the failure mode #55 demonstrated — a per-line constant that fits several
fixtures and is still the wrong mechanism — applies directly here.

**What Word might do differently:** The rule rests on two cases (a Courier bullet
that does not register, a Symbol bullet alone that does). Untested is the middle:
a label whose ASCENT is shorter but whose DESCENT is deeper than the text's. We
drop it whole on a single line-height comparison, where Word may take ascent and
descent independently — the same split the inline-image ascent question needed.

**Probe design:** A list whose label font has a deep descent and a low ascent
(9pt Symbol among 11pt Calibri) against a plain-bullet control; measure the
first-line baseline and the following line's baseline in Word, on a fresh export.

---

## Summary

| # | Candidate | Class | Flag |
|---|---|---|---|
| 1 | Footnote separator reserve | B (40px) / **F** (26px) | RE-VERIFY (26px) |
| 2 | Last footnote's spacing-after | G | NEVER-MEASURED |
| 3 | Header's trailing spacing-after | G | NEVER-MEASURED |
| 4 | Frame-top space-before | G | NEVER-MEASURED |
| 5 | Cell margins at a row boundary | A (neighbours) / G | NEVER-MEASURED |
| 6 | Cell's last paragraph after + margin | E | RE-VERIFY |
| 7 | Outer half of a table's rule | B + E | WORD-DIFFERS |
| 8 | Border reserve at a page top | E / **D** | RE-VERIFY |
| 9 | Section-break paragraph's after | E + B | WORD-DIFFERS |
| 10 | Doubled opening empty paragraph | **C + D?** | RE-VERIFY (resolve citation) |
| 11 | keepNext across a section | B | WORD-DIFFERS |
| 12 | Endnote separator gap | E | RE-VERIFY |
| 13 | Numbering label line height | B + C + E | RE-VERIFY |

Three are safe to probe as stated. Five want a re-exported reference first. Four
were never measured at all, which makes them cheaper than they look: there is no
calibration to defend, so the probe is simply the first measurement.

**One task-shaped suggestion falls out of the provenance work.** The #48 screen
covered hints; nothing has screened the references for export-build drift, and
#55 shows the two eras differ. Re-exporting the 111 pre-2026-07-22 references and
diffing page counts is the same cheap screen #48 ran, on the axis it did not
cover.
