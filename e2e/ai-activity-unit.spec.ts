import { test, expect } from "@playwright/test";
import { activityLabel } from "../apps/desktop/src/renderer/src/AiPanel";

/**
 * Unit tests for the line the AI panel shows while it works. The rule the
 * panel lives by: every label names something the panel actually saw — the
 * tool the model asked for, and for an edit the kind of its first operation.
 * A tool or a kind it does not know reads as plain work rather than a guess.
 */

test("each document tool names what it is doing", () => {
  expect(activityLabel("word_document_project", null)).toBe("Reading the document…");
  expect(activityLabel("word_document_inspect", { kind: "overview" })).toBe(
    "Reading the document…",
  );
  expect(activityLabel("word_document_patch", {})).toBe("Editing the text…");
  expect(activityLabel("word_document_compose", {})).toBe("Writing new content…");
  expect(activityLabel("word_document_asset", { ref: "asset:1" })).toBe("Looking at an image…");
});

test("an edit reads its first operation's kind", () => {
  const edit = (kind: string) => activityLabel("word_document_edit", { operations: [{ kind }] });
  expect(edit("insertChart")).toBe("Inserting a chart…");
  expect(edit("insertTable")).toBe("Inserting a table…");
  expect(edit("insertImage")).toBe("Inserting an image…");
  expect(edit("formatRun")).toBe("Formatting…");
  expect(edit("insertText")).toBe("Editing the text…");
});

test("an unknown tool or kind says only that work is happening", () => {
  expect(activityLabel("word_document_edit", { operations: [{ kind: "setDropCap" }] })).toBe(
    "Editing the document…",
  );
  expect(activityLabel("word_document_edit", {})).toBe("Editing the document…");
  expect(activityLabel("word_document_edit", null)).toBe("Editing the document…");
  expect(activityLabel("some_future_tool", {})).toBe("Working…");
});
