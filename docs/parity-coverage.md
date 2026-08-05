# W0 + W5 — The round-trip gate and corpus expansion (wordinweb-parity)

## W0: the edit round-trip gate (build first)

The audit's highest-risk finding: **no test verifies that an edited, saved
`.docx` re-opens faithfully in Word.** The download gate
(`word-download-parity.mjs`) proves the machinery — click Download, export the
result through desktop Word, compare rasters against cached references, hard
thresholds mean < 0.05% / worst < 2% — but it only covers an unedited
pass-through, and no run result is persisted.

Build `edit-roundtrip-parity.mjs` on the same machinery:

1. **Scenario scripts**: each scenario = fixture + a scripted edit sequence
   driven through `DocxViewApi` (or the agent edit path — both write the same
   XML). Start with ~10 scenarios covering today's write paths: typing,
   formatting, lists, table ops, image insert, comments, footnotes, tracked
   changes accept/reject, section/page layout, header/footer.
2. **Save → Word → compare**: export the edited save through desktop Word
   (existing AppleScript + staging-directory + SHA-cached PDF pipeline),
   rasterize, compare against a WordInWeb render of the same edited bytes.
   Same hard thresholds. Additionally require: Word opens the file with no
   repair dialog (detectable via AppleScript error), and a re-open→re-save in
   WordInWeb is byte-stable.
3. **Persist results** in-repo (JSONL history like `parity/history.jsonl`)
   so regressions are attributable to engine versions.
4. **Per-PR rule** (W2): every new OOXML write path adds a scenario before
   merge. Scenario runs are selectable so a PR runs only its own scenarios;
   the full matrix runs nightly on this Mac.

Also W0: normalize the repo link drift — the demo currently pins npm
`wordinweb@0.1.22` while `node_modules` symlinks a local 0.2.0 worktree.
Adopt an explicit link script so every recorded run states which build it
measured.

## W5: corpus expansion

Current corpus: 100 benchmark-live fixtures / 1,188 pages, mean severity
0.358%, 74.7% of pages at exactly 0.00. The fixture pipeline (generate or
hunt → validate → sanitize → audit → Word reference export → manifest) is
mature; expansion is content work, parallelizable across subagents.

Priority order, from the coverage audit:

| Priority | Area | Today | Work |
| --- | --- | --- | --- |
| 1 | Charts | **0 fixtures** | Blocked on/paired with the W2.7 chart track; add bar/line/pie/scatter/area, then combos, then chart-in-table |
| 1 | SmartArt | 3 fixtures, worst page in corpus (65.66%) | Diagnose the interop page; add layout-type coverage |
| 2 | Modern comments | 0 (`people.xml` absent) | Threaded/resolved/mention fixtures; pairs with W2.6 |
| 2 | Fields/TOC | thin | TOC depth variants, STYLEREF/SEQ, field-update scenarios; pairs with W2.3 |
| 2 | Tabs | 1 fixture / 2 pages | All five stop types × leaders × bidi |
| 2 | Math | 4 dedicated pages | Matrix/n-ary/accent/equation-array fixtures; pairs with W2.7 |
| 3 | Ink | 0 | InkML fixtures (editor feature already e2e-tested) |
| 3 | Embedded fonts | 1 | Font-embedding variants |
| 3 | OLE | 2 | More object types incl. placeholders |
| 3 | Deferred probes | — | `wp14:pctPosHOffset`, VML `v:textpath` watermarks (known engine gap) |
| 4 | Citations/bibliography, master documents, mail-merge sources | none | Pairs with W2.8; add when features land |
| 4 | `.doc`/RTF import, encrypted packages | none | Product decision first: convert-on-open vs out of scope |

Corpus-shape fix: realworld documents are 85% of compared pages, so the mean
mostly reflects a few long documents. Report per-category KPIs prominently
(the report already computes them) and hold each category — not just the
global mean — at ≤ 0.4% as new features land.

Also promote the two named diagnosis targets from the current run:
`wild-hamburg` (10 of the worst 25 pages; looks like one systematic layout
bug) and `probe-nih-rowheight` (row-split heights).

## CI reality

Parity requires desktop Word + Full Disk Access + poppler + Ghostscript +
LibreOffice + ImageMagick and therefore stays on this Mac (scheduled nightly
runs + pre-release full runs). Engine unit tests, agent fixture audit, and
Playwright e2e run in normal CI. The LikeOffice repo's CI covers the Electron
app (build, unit, Playwright-Electron smoke).
