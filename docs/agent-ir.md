# W4 — AI-native editing: DocMD and the Cursor-grade UX

## What exists

The agent package already provides: six portable tools, 67 schema-enforced
operations, stable-ID addressing that survives concurrent edits, six inspect
modes, fingerprint staleness guards, four session modes (headless, solo
browser, live collab, offline), a detached CLI bridge with a wake loop, a
fixture audit, and a real-Codex authoring eval. LikeOffice builds on this
rather than replacing it.

The audit found four structural gaps the structured surface cannot cheaply
fix, and one design answers all four:

1. **Two offset spaces.** Inspect offsets are rendered text; edit offsets are
   wire units (a field = 1 unit). Agents must reconcile them today.
2. **`context` is lossy.** All inline formatting and all table cell content
   are dropped from the compact mode.
3. **Bulk restructure is missing.** `compose` is creation-only/single-shot;
   the only bulk input is raw OOXML.
4. **Token cost.** Structured JSON with refs is verbose for what is mostly
   "change this text".

## DocMD: a deterministic text projection with an anchor sidecar

A new inspect/edit pair in `@wordinweb/agent`:

### `word_document_project` → the projection

Renders the document (or a story/block range) as clean text, in one of three
modes, plus a **sidecar anchor map** the agent never needs to read but the
engine uses to translate edits back:

- `text` — paragraph text only. What the user asked for: "the docx as a text
  file". Zero formatting exposure.
- `md` — structural markdown: `#`-headings from outline levels, `-`/`1.`
  lists from numbering, GFM tables **with cell content** (closing gap 2's
  table half), footnote references, link targets. Inline emphasis is emitted
  only in `md+inline` submode (bold/italic/strike spans), because emphasis
  markers change offsets and most bulk edits are text-only.
- `outline` — headings only (exists today as `overview.outline`; unify).

Projection contract:

- **Deterministic**: same revision → byte-identical projection. The
  round-tripping linear math serializer (`mathText`) is the in-repo precedent
  and becomes the equation rendering inside projections.
- **Line-addressed**: the sidecar maps every projection line (and intra-line
  span) to `(blockRef, runRef, wire-offset range)`. The sidecar is produced
  in the same pass as the text, so it is the single authority that owns the
  rendered→wire translation. Gap 1 disappears for agents: they only ever see
  rendered text; the engine does the offset math.
- **Atom placeholders**: non-text inline atoms (fields, images, equations in
  `text` mode) render as stable single-character placeholders (e.g. `⟦f⟧`)
  so wire and projected offsets stay alignable; `md` mode renders richer
  forms (`{{PAGE}}`, `![alt](asset:3)`, `$...$`).
- **Windowed**: same cursor/budget discipline as `read`, so a 5,000-page
  document projects in bounded chunks. `revision` stamps every window.

### `word_document_patch` → the edit path

Input: the `revision` the projection came from, plus edits in one of two
forms:

- a **unified diff** against the projection (what coding agents already emit
  naturally), or
- an **edit list** (`{line-range, newText}` hunks) for schema-strict callers.

The engine maps each hunk through the sidecar into the existing intent
vocabulary — `insertText`, `deleteText`, `splitParagraph`, `mergeParagraph`,
and (in `md` mode) `setParagraphStyle`/list toggles when the hunk changes
structural markers. Properties:

- **Transactional per call** with the existing 1–100 operation bound;
  all-or-nothing via the clone-first apply the edit path already uses.
- **Staleness-guarded**: hunks reuse the existing fingerprint mechanism —
  only the blocks a hunk touches must be unchanged; concurrent edits
  elsewhere proceed. Extend the guard's headless path so local sessions get
  the same partial-staleness tolerance collab targets have today.
- **Formatting-preserving**: a text hunk inside a styled run edits `w:t`
  content only; a hunk spanning runs preserves each run's properties by
  splitting at run boundaries. Formatting is invisible to the agent and
  untouched by the engine unless the hunk crosses it — then the result keeps
  each segment's original formatting.
- **Reviewable**: an optional `suggest: true` applies the whole patch as
  tracked changes (rides the existing suggest path; full reviewability of
  format changes needs W2.6).
- Result: applied-operation list + fresh revision + the updated projection
  window for the touched region, so the agent re-anchors without a second
  call.

This is also the missing bulk-restructure path (gap 3): "rewrite section 4"
is one projection window + one diff, instead of dozens of structured calls
(gap 4's token cost).

### Also in W4 (structured-surface fixes)

- `context` gains table cell text + refs, and an opt-in compact formatting
  channel.
- Enforce `chart.series[].values` length = `categories` length (documented,
  unvalidated today).
- Make `object:block:*` fallback refs editable where safe, or provide a
  promotion call.

## The Cursor-grade UX in LikeOffice

- **Side panel**: chat with the document in context. The panel drives a local
  agent session against the in-process document (`LocalDocumentSession` —
  server-free), with model access via the user's configured provider or the
  existing encrypted CLI-bridge for external CLI agents (Claude Code /
  Codex), whose wake-loop and suggest/edit mode switch already work.
- **Selection edits (Cmd+K)**: the selection maps to a projection window;
  the instruction + window go to the model; the returned diff applies via
  `word_document_patch` with `suggest: true`.
- **Per-hunk review**: agent patches land as tracked changes; the review rail
  shows Cursor-style hunks with accept/reject per hunk (`acceptRevision`/
  `rejectRevision` already exist; group revisions by patch transaction id).
- **Multi-agent ready**: the collab layer already sequences agents and humans
  in one room with presence and fingerprint guards; the desktop app exposes
  invite links through the existing encrypted invite flow.

## Evaluation

- Extend the authoring eval with **bulk-edit fixtures**: load a corpus
  document, natural-language revision request, score via the existing
  public-API assertion families plus a projection-diff check.
- Add a token-cost benchmark: same task via structured calls vs DocMD patch;
  the patch path should win by ≥ 3x on text-dominant tasks.
- The fixture audit gains a projection invariant: every corpus document
  projects deterministically, and `project → patch(identity) → project` is a
  fixed point.
