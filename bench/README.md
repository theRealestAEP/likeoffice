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
```

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

The filler fixture is authored in-process from
`apps/desktop/resources/blank.docx` with the agent edit tools (no model).

## Output

- Printed summary table: wall-clock ms, rounds, API calls, tokens, tool
  errors, and per-task failure detail.
- `results/<ISO-timestamp>.json`: full metrics per task — per-API-call ms and
  tokens, tool calls by name, tool errors, assertion failures, saved-bytes
  validity.
- `history.jsonl`: one line per task per run (`ts`, `task`, `model`, `ms`,
  `rounds`, tokens, `pass`) for trend tracking.

## Notes

- A task failing its assertions is data, not necessarily a harness bug — the
  point is to track agent editing capability and speed over time.
- Keep the mirrored constants (system prompt, `MAX_ROUNDS`, suggest
  injection, request shape) in sync with the app when it changes.
