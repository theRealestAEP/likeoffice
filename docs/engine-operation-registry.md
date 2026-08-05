# The operation registry

One declaration per edit operation, read by every surface that used to keep
its own hand-written copy.

## The problem it solves

Adding one edit operation used to cost four to six coordinated edits:

| # | Where | What |
|---|---|---|
| 1 | `packages/core/src/edit/*.ts` | the XML mutation, a plain function |
| 2 | `packages/core/src/edit/editor.ts` or `packages/react/src/index.tsx` | the dispatch, plus the intent literal and its carried-id count |
| 3 | `packages/core/src/edit/editor.ts` `EditorIntent` | a variant mirroring the wire shape |
| 4 | `packages/collab/src/intents.ts` | the same wire shape again, plus a `INTENT_KIND_MAP` row |
| 5 | `packages/collab/src/{apply,validate,transform}.ts` | an apply case, a validate case, two transform cases |
| 6 | `packages/agent/src/{capabilities,edit}.ts` | a capability row, and the carried-id budget a second time |

Every one of those is guarded by a compile-time exhaustiveness gate, so
nothing could go missing silently. The cost was the coordination, not the
risk — and the duplication was real: the wire payload was typed twice (core
and collab), and the carried-id budget for `insertTable` was written twice
(`rows * cols * 2 + 8` in the React host and again in the agent compiler),
with nothing keeping the two equal.

## The declaration

`packages/core/src/edit/registry.ts`. Core is the only package that collab,
the agent, and the React host all depend on, so it is the only place a single
declaration can reach all of them.

```ts
const insertTableOperation = defineOperation<{
  runId: StableId;
  rows: number;
  cols: number;
  nodeIds: StableId[];
}>()({
  kind: "insertTable",
  address: "run",
  category: "insert",
  description: "Insert a table.",
  fields: [{ name: "rows" }, { name: "cols" }],
  nodeIds: ({ rows, cols }) => /* … */,
  validate: ({ rows, cols }) => /* … */,
  apply: ({ doc, target, payload }) =>
    target.t ? insertTableAfter(doc, target.t, payload.rows, payload.cols) : false,
});
```

The type parameter is the **wire payload**. It is written once, here, and the
collab `Intent` union intersects it with the transport bookkeeping — so the
payload type is declared once and every consumer's type follows.

Field by field:

- **`kind`** — the operation name, on the wire and in the agent tool schema.
- **`address`** — `"run"`, `"block"`, or `"cell"`. This is the whole of the
  operation's collaborative *honest no-op* predicate. It names the wire field
  the stable id travels in (`runId` / `blockId` / `cellParagraphId`), the
  agent-facing reference field (`runRef` / `blockRef` / `cellRef`), and the
  resolver that turns the id into a document target. When the id does not
  resolve, the operation applies as a clean rejection on every replica rather
  than mutating anything locally.
- **`category`**, **`description`**, **`fields`** — the agent capability row.
  `required` is the address reference followed by the non-optional fields, in
  declaration order.
- **`nodeIds`** — how many fresh stable ids the mutation needs for the
  id-tracked nodes it creates. One arithmetic expression, read by the editor,
  the React host, and the agent compiler.
- **`validate`** — payload bounds, checked before sequencing. A pure function
  of the payload, because it runs on both sides of the wire.
- **`apply`** — the XML mutation, headless, from a resolved target. `false`
  means a clean no-op.

## Undo and transform classification

The registry does not carry per-operation undo or transform fields. Instead
those classifications are **preconditions of registration**, stated once in
the module comment. A registered operation must be:

1. **Addressed by stable id** — a run, a paragraph, or a cell paragraph.
2. **Position-stable** — it moves no run's text, so its transform is identity
   and no concurrent intent's offsets need remapping.
3. **Without a wire inverse** — collaborative undo skips it, which is the
   status quo for every intent except the four in `collab/src/invert.ts`. The
   local path still takes a history checkpoint.

A one-valued field is not a classification. Sixty-something of the sixty-nine
intents share these three properties; the eight that do not (`insertText`,
`deleteText`, `splitParagraph`, `formatRange`, `moveMath`, and friends) each
carry bespoke transform logic and are deliberately not registry candidates.
When one of them needs to be registered, that is the moment to add the field —
with two real values in it.

## Adding a new operation

Three files, one of them optional.

1. **Write the mutation** in the appropriate `packages/core/src/edit/*.ts`
   module, as a plain function over the XML tree. Unchanged from before.
2. **Register it** in `packages/core/src/edit/registry.ts`: add a
   `defineOperation<Payload>()({ … })` block and append it to the `OPERATIONS`
   array. This produces, with no further edits: the wire payload type, the
   collab `Intent` variant, the `INTENT_KINDS` entry, the apply dispatch, the
   validation, both transform cases, the core `EditorIntent` variant, the
   agent capability row, the agent JSON schema, and the agent's carried-id
   budget.
3. **Call it** from the editor or the React host —
   `operationBody(kind, addressId, args, alloc)` builds the wire body, or
   `collabRunOperation(kind, args)` in `packages/react/src/index.tsx` submits
   it directly. The local (non-collaborative) mutation still calls the core
   function from step 1 at the call site; see below.

Two supporting edits remain, and both are enforced by an existing test rather
than by discipline:

- If the payload introduces a **field name the agent schema has not seen**,
  add its shape to `schemaForField` (or `ENUMS` / `NESTED_SCHEMAS`) in
  `packages/agent/src/capabilities.ts`. Field names that already exist
  (`rows`, `text`, `color`, `start`, …) need nothing.
- Add the operation's row to the catalog table in
  `skills/wordinweb-documents/references/interface.md`.
  `packages/agent/test/skill.test.ts` fails until the row's fields match the
  capability exactly.

## What the gates look like now

None were relaxed. Each was rewritten so it covers the operations that are
still hand-written, with the registry supplying the rest — and each stays
*total*, because the hand-written set is computed as
`Exclude<Intent["kind"], RegisteredOperationKind>` rather than listed.

| Gate | Before | Now |
|---|---|---|
| `INTENT_KIND_MAP` | `Record<Intent["kind"], true>` | `Record<Exclude<Intent["kind"], RegisteredOperationKind>, true>`, merged with the registry's kinds |
| `applyIntentInner` | `default: const exhaustive: never = intent` | same gate, after `if (isRegisteredIntent(intent)) return applyRegistered(…)` narrows it away |
| `validateIntent` | `default: const exhaustive: never = intent` | same, narrowed the same way |
| `runEditsOf` / `transformIntent` | exhaustive by return type under `strictNullChecks` | same, narrowed the same way |
| `AGENT_EDIT_CAPABILITIES` | `Record<Intent["kind"], AgentEditCapability>` | hand-written half is `Record<Exclude<…>, …>`; the exported map spreads the registry's rows over it |
| skill-doc catalog table | `skill.test.ts` equality with the capability map | unchanged — it now compares against a map the registry partly builds |

`isRegisteredIntent` is a type predicate, so TypeScript removes the registered
variants from the switch in the false branch. That is what lets the `never`
gates keep their full force over a shrinking hand-written set.

## Migrated operations

Three, chosen to be three different shapes rather than three easy ones:

| Operation | Address | Category | Why it was chosen |
|---|---|---|---|
| `setListType` | block (paragraph) | paragraph | Block-addressed, multi-target at the call site, and emitted from *both* the core editor (Enter on an empty list item) and the React host (`toggleList`). |
| `insertTable` | run | insert | Carries ids. Its id budget was the one formula duplicated between the React host and the agent compiler. |
| `resizeTableRow` | cell paragraph | table | The third addressing mode, and the only one of the three driven from a drag interaction inside `DocxEditor` rather than from the API surface. |

Between them they exercise all three address kinds, both id-carrying and
not, both validated and not, and all three producers (core editor, React
host, agent compiler).

## Deliberately not unified yet

- **The local optimistic mutation.** In a collaborative room every command
  routes through `applyIntent`, so the registry's `apply` is what runs. Outside
  one, the call site mutates directly — and *how it finds its target is view
  state*, which the three migrated operations disagree about completely:
  `insertTable` uses the caret, `setListType` uses every paragraph the
  selection touches, `resizeTableRow` uses the row grip being dragged. Modelling
  that would mean putting selection semantics in core. The registry owns the
  headless path; the call site keeps the local one.
- **Wire inverses.** `collab/src/invert.ts` still owns the four invertible
  intents. See the classification section above.
- **The agent's JSON field schemas.** `schemaForField` maps field *names* to
  shapes and is shared across operations, so `rows` means the same thing
  everywhere. Moving those into per-operation declarations would duplicate
  them, not consolidate them.
- **The skill-doc catalog table.** It is prose for an external agent to read,
  not generated output. The test keeps it honest.
- **The 66 unmigrated operations.** The registry is additive by design and
  coexists with them. A bulk migration would be one unreviewable diff across
  four packages; the point of the pattern is that the next operation is cheap,
  not that the previous ones get rewritten.

## Observable difference

One, and it is not a wire format: `INTENT_KINDS` now enumerates the
hand-written kinds first and the registered kinds last, so the three migrated
operations moved to the end of the list. Every individual agent JSON schema,
every capability row, and the set of kinds are byte-identical — verified by
dumping both against the pre-change build. The order affects only the
presentation order of `agentCapabilities()` and the order of the `anyOf`
branches in the `word_document_edit` tool schema, both of which are
order-insensitive.

Preserving the old order would mean keeping a second hand-maintained list of
all sixty-nine kinds in their canonical sequence — which is exactly the
duplication the registry exists to remove.
