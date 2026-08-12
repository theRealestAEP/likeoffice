# Agent editing benchmark

Measures how fast the AI agent produces certain kinds of documents. The
harness is headless Node — no Electron. It drives the same agentic loop the
app's AI panel uses:

- `LocalDocumentSession` + `AgentDocument` from `@wordinweb/agent` (the repo's
  `node_modules` symlink to the local engine build).
- The real Anthropic Messages API via `fetch`. The request shape mirrors
  `apps/desktop/src/main/model.ts` (`max_tokens: 16000`, non-streaming).
- The loop, system prompt, `MAX_ROUNDS` (30), and `suggest: true` injection
  for edit/patch operations mirror `apps/desktop/src/renderer/src/AiPanel.tsx`.

## Run

```sh
nice -n 19 node bench/agent-bench.mjs                 # all tasks, claude-opus-5
nice -n 19 node bench/agent-bench.mjs --model=claude-sonnet-5
nice -n 19 node bench/agent-bench.mjs --task=memo,table-report
nice -n 19 node bench/agent-bench.mjs --task=object-insert --runs=4
```

`--runs=N` repeats every selected task N times. The summary then reports the
median and the range per task. Use it before you draw a conclusion from a
number: one run is one sample of a noisy process. `object-insert` alone ranges
from 3 to 14 rounds on an unchanged build. See "Run-to-run variance" below.

The API key comes from this repo's `.env` (`ANTHROPIC` or
`ANTHROPIC_API_KEY`). Real API spend occurs on every run. The harness never
prints the key.

Exit code is nonzero when any assertion fails.

## Tasks

Defined in `tasks.mjs`. Assertions run against the final saved bytes reloaded
through `DocxDocument`, and against an accept-all-revisions copy.

| Task | Start | Asks the agent to | Key assertions |
| --- | --- | --- | --- |
| `declaration-intro` | blank | Write the Declaration intro with a bold heading and two body paragraphs | >=3 paragraphs, heading present, known phrases present, tracked changes (`w:ins`) present, accept-all yields a clean doc |
| `memo` | blank | Titled memo with a 4-item bulleted list | Title text + >=4 paragraphs with numbering props |
| `table-report` | blank | 3-column, 4-row quarterly sales table with a header row | Exactly 1 table, 4 rows x 3 cells, header cells non-empty |
| `rewrite` | 3-paragraph filler | Rewrite the second paragraph to half its length | Paragraph count unchanged, second shorter, others text-identical (after accept-all) |
| `bulk-text` | 3-paragraph filler | Replace every "Contoso" with "Fabrikam" | Full replacement, zero drift in other text (after accept-all) |
| `footer-page-number` | filler + a three-column footer line holding a live PAGE field | "Add page numbers" | Exactly 1 PAGE field in the package, and the footer's two tab characters survive |
| `object-insert` | blank | Add a titled column chart, a text box, and a display equation | Exactly 1 chart part with categories/values/title, a `txbxContent` mentioning Draft, an `oMath` region |

The filler fixture is authored in-process from
`apps/desktop/resources/blank.docx` with the agent edit tools (no model). The
`footer-page-number` fixture adds the footer line the same way.

## Output

- Printed summary table: wall-clock ms, rounds, API calls, tokens, tool
  errors, and per-task failure detail. One row per task. With `--runs=N` each
  cell shows the median and the range, and the pass column shows how many runs
  passed.
- `results/<ISO-timestamp>.json`: full metrics per task — per-API-call ms and
  tokens, tool calls by name, tool errors, assertion failures, saved-bytes
  validity. Each API call also records `tools`: the tool names the model asked
  for that round, in order. A slow run is only diagnosable if that sequence
  survives in the JSON.
- `history.jsonl`: one line per task per run (`ts`, `task`, `model`, `ms`,
  `rounds`, tokens, `pass`) for trend tracking.

## Run-to-run variance

`object-insert` is the noisy task. On one unchanged build it takes 3 rounds and
10 s, or 14 rounds and 66 s. Treat any single number from it as one sample.

### The a9624c2 check (2026-08-12)

Commit a9624c2 projected header, footer, and note stories into the `<document>`
tag. `object-insert` then ran 11, 11, 3, and 14 rounds against a single
2026-08-07 sample of 3 rounds. The commit message called that "that task's own
variance, not this change".

**Correction to that commit message.** The conclusion holds, but the argument
it gave was incomplete. It argued only that `object-insert` starts from a blank
document, whose one story is the body, so the projection adds zero characters.
That is true and is beside the point: the same commit also added a sentence
about story blocks to `SYSTEM_PROMPT`, and the system prompt ships on every
request, including `object-insert`. The commit exonerated itself on half the
change. History is pushed, so the correction lives here.

An interleaved A/B experiment settled it. Arm A restored the pre-a9624c2
behaviour with a local edit: story projection suppressed and the new sentence
removed. Arm B was HEAD, unmodified. The arms ran A, B, A, B, so drift in
API-side conditions could not masquerade as an arm effect. All 8 runs passed.

| Run | Arm A (pre-a9624c2) | Arm B (HEAD) |
| --- | --- | --- |
| 1 | 5 rounds, 22.4 s, 164k in | 11 rounds, 41.4 s, 373k in |
| 2 | 7 rounds, 25.1 s, 232k in | 3 rounds, 14.7 s, 97k in |
| 3 | 4 rounds, 23.5 s, 131k in | 10 rounds, 47.0 s, 341k in |
| 4 | 12 rounds, 40.2 s, 405k in | 7 rounds, 26.5 s, 232k in |
| **median** | **6 rounds, 24.3 s, 198k** | **8.5 rounds, 33.9 s, 287k** |
| range | 4-12 rounds, 22.4-40.2 s | 3-11 rounds, 14.7-47.0 s |

The ranges overlap almost completely, and the slowest run of all 8 belongs to
Arm A, the control. The verdict is pre-existing task variance, which the sweep
surfaced. a9624c2 is not the cause. Arm C (blocks suppressed, sentence kept)
was unnecessary: on a blank fixture the story blocks are empty, so Arm C and
Arm B send byte-identical requests.

One real cost of a9624c2 stands, separate from the variance: the sentence adds
about 50 input tokens to every request on every task. The jump in per-round
input from 24k (2026-08-07) to 32k is the engine's tool schemas growing, not
this change.

### What the slow runs actually do

A 4-run batch at HEAD gave 3, 5, 14, and 3 rounds. The 14-round run **failed**
its assertion with 2 chart parts instead of 1. So the long runs are not only
slow. The same runaway path also corrupts the result. The per-round trace:

```
r1  inspect     r5  edit      r9   edit     r13 edit
r2  edit  (ERR) r6  edit      r10  inspect  r14 (text reply)
r3  project     r7  project   r11  edit
r4  edit        r8  inspect   r12  inspect
```

The fast runs are `inspect`, `edit`, reply. The slow runs all start the same
way and then thrash. Two things drive it, both confirmed by direct probes
against `@wordinweb/agent` (no model in the loop):

1. **A failed edit rolls the whole transaction back, but its error text implies
   otherwise.** An `insertChart` followed by a `splitParagraph` against the
   same run fails: the chart restructured the runs the split refers to. The
   engine then applies nothing — a probe confirms zero chart parts after the
   throw. The error says "Re-inspect and send the remaining operations in a new
   transaction", which reads as though the earlier operations landed. The model
   is told to resume from a state that does not exist.
2. **An inserted object is opaque in the projection the model re-reads.** The
   body projects in `mode: "text"`, where a chart is the single character
   U+FFFC. In `mode: "md"` the same chart reads `![chart](object:3:0)`. After a
   failed edit the model projects, sees one opaque atom, cannot tell which
   objects landed, and inserts again. That is where the second chart part comes
   from. The stale `word_document_patch` errors in the 04-4x runs — "Projection
   line 1 column 1 is not inside editable text" — are the same atom: the model
   tries to patch a paragraph break around an object and hits the object.

Point 2 repeats a lesson a9624c2 already learned for stories: it chose md mode
there because text mode renders a field as the opaque atom U+240E. The body
projection has the same problem whenever the document holds objects.

The two sections below take each candidate fix in turn. The first shipped. The
second did not, and the measurement that stopped it also corrects point 2
above.

### Point 1, shipped: a failed write now says the document is unchanged

The probe reproduces on `apps/desktop/resources/blank.docx` with no model in
the loop. One `word_document_edit` carrying `insertText`, `insertChart`, and a
`splitParagraph` against the offset the text held before the transaction throws
on the split. The document then has zero chart parts and an empty projection.
Nothing landed, including the two operations before the failing one.

`packages/agent` now says that. `edit`, `patch`, and `compose` each apply to a
trial clone and adopt it only after the whole request succeeds, so each names
that state in its caller's own terms:

| Path | Sentence appended to every error it throws |
| --- | --- |
| `word_document_edit` | NOTHING was applied. The transaction is all or nothing, so the document is unchanged and no earlier operation in this transaction landed either. Re-inspect the document, then send every operation again. |
| `word_document_patch` | NOTHING was applied. The patch is all or nothing, so the document is unchanged and no earlier hunk in this patch landed either. Re-project the story, then send every edit again. |
| `word_document_compose` | NOTHING was created. Compose is all or nothing, so the document is unchanged. Send the whole compose request again. |

Errors thrown before any operation runs — a stale revision, a malformed
operation — carry the same sentence. The rule is that an error describes the
document, not the request. `applyFailure` keeps its diagnosis and its
`splitParagraph` alternative; only the resolution sentence moved.

No successful request changes, so no A/B is owed. Four runs after the change:
3, 3, 9, and 12 rounds (median 6, range 3-12) against the recorded HEAD median
of 8.5, range 3-11. Both sit inside this task's variance. One of the four still
finished with 2 chart parts.

### Point 2, measured and not shipped: spelling objects out in text mode

**md mode was ruled out first, on line addressing.** The two modes number lines
differently as soon as a document holds a table. text mode gives every cell
paragraph its own line and every one of them is patchable. md mode writes a GFM
table, so a probe on a 3x2 table plus one paragraph reads:

| | text mode | md mode |
| --- | --- | --- |
| line 2 | `Q` | `` (blank line before the table) |
| line 4 | `Q1` | `\| --- \| --- \|` |
| patch line 4 | applies | throws "Projection line 4 is table content and cannot be patched" |

Projecting the body in md would therefore take the quick-edit patch path away
from every table cell. The alternative keeps line numbering identical: render
an object in text mode with the token md already uses, so a chart reads
`![chart](object:3:0)` instead of the opaque `￼`. That is a one-line change in
`renderContent` (`packages/agent/src/project.ts`) — drop `mode === "text"` from
the `object` helper's condition. It moves no line boundary, and md mode already
proves the anchor map and the patch path handle a multi-character opaque
segment.

**The A/B.** Arm A is the point-1 build. Arm B is arm A plus that one line. The
arms alternate A, B, A, B, so drift in API-side conditions cannot look like an
arm effect. Each invocation runs `rewrite` once and `object-insert` once.

| Run | object-insert A | object-insert B | rewrite A | rewrite B |
| --- | --- | --- | --- | --- |
| 1 | 10 rounds, 32.7 s | 3 rounds, 7.0 s | 2 rounds, 6.2 s | 2 rounds, 5.2 s |
| 2 | 3 rounds, 8.4 s | 12 rounds, 58.9 s | 2 rounds, 5.2 s | 2 rounds, 4.7 s |
| 3 | 10 rounds, 43.4 s | 3 rounds, 11.9 s | 2 rounds, 4.6 s | 2 rounds, 4.5 s |
| 4 | 3 rounds, 6.7 s | 10 rounds, 41.0 s **FAIL** | 2 rounds, 4.6 s | 2 rounds, 5.1 s |
| 5 | 3 rounds, 12.1 s | 11 rounds, 44.9 s | 2 rounds, 6.8 s | 2 rounds, 5.2 s |
| 6 | 3 rounds, 14.3 s | 3 rounds, 7.5 s | 2 rounds, 4.9 s | 2 rounds, 4.8 s |
| 7 | 3 rounds, 12.8 s | 3 rounds, 12.4 s | 2 rounds, 5.1 s | 2 rounds, 4.7 s |
| 8 | 12 rounds, 71.4 s | 7 rounds, 23.3 s | 2 rounds, 5.5 s | 2 rounds, 5.1 s |
| **median** | **3 rounds, 13.5 s** | **5 rounds, 17.9 s** | **2 rounds, 5.1 s** | **2 rounds, 4.9 s** |
| range | 3-12 rounds, 6.7-71.4 s | 3-12 rounds, 7.0-58.9 s | 2 rounds, 4.6-6.8 s | 2 rounds, 4.5-5.2 s |
| pass | 8/8 | 7/8 | 8/8 | 8/8 |

The result files hold the per-round traces. A results file records no arm, so
the mapping lives here: the run is one invocation per row above, arm A first,
and the files in `results/` sort into that order — `2026-08-12T05-31-40Z` is
run 1 arm A, `05-32-26Z` is run 1 arm B, through to `05-41-18Z`, run 8 arm B.
`2026-08-12T05-22-56Z` is the four-run point-1 verification, which precedes
them all.

**Verdict: not shipped.** `object-insert` does not improve. Arm B's median is
higher and it owns the only failing run. `rewrite` is untouched, which proves
nothing on its own: its filler fixture holds no object, so the two arms send
byte-identical requests on that task by construction.

**The reason the numbers say nothing, which is the real finding.** The arms are
byte-identical on `object-insert` too, in almost every run. The change alters
one thing: the text a projection returns for an object. `object-insert` starts
from a blank document, so the projection folded into the first user message is
empty in both arms. The model only meets the change if it calls
`word_document_project` again, or gets a projection back from a successful
`word_document_patch`. Across the 16 `object-insert` runs above, **3 called
either tool at all.** The other 13 sent the same bytes in both arms. The
experiment measured this task's variance a second time.

**Correction to point 2 of the section above.** The claim was that after a
failed edit "the model projects, sees one opaque atom, cannot tell which
objects landed, and inserts again". The traces do not support it. The model
re-reads with `word_document_inspect`, not `word_document_project`, and inspect
was never opaque: after one `insertChart` a `kind: "read"` returns

```
"components": [{ "ref": "object:3:0", "editRef": "object:3:0",
                 "type": "chart", "label": "Revenue" }]
```

and `kind: "overview"` reports `"objectCounts": { "chart": 1 }`. The arm B run
that failed with 2 chart parts had already called `read` twice. It could see
the chart it had made, name it, and address it, and it inserted a second one
anyway. Object opacity in the projection is real, but it is not what duplicates
the chart here.

Spelling the object out in text mode is still the right projection contract:
`￼` names neither what the object is nor how to reach it. It needs a task that
can see it. Either give `object-insert` a fixture that already holds an object,
so the change reaches the `<document>` tag of every request, or add a task
whose ask forces a re-projection. Until then the one-line change stays
unmerged, with these numbers as the record of why.

## Notes

- A task failing its assertions is data, not necessarily a harness bug — the
  point is to track agent editing capability and speed over time.
- Keep the mirrored constants (system prompt, `MAX_ROUNDS`, suggest
  injection, request shape) in sync with the app when it changes.
- The app also ships AI profiles: named prompt presets the user can select,
  appended to the system prompt as a content-only section (see
  `apps/desktop/src/renderer/src/AiProfiles.tsx`). The bench runs on the base
  prompt with no profile, so numbers stay comparable across runs. Add a
  profile here only as a deliberate, separately tracked experiment.
