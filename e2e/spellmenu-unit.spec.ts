import { test, expect } from "@playwright/test";
import { buildSpellMenuTemplate, MAX_SUGGESTIONS } from "../apps/desktop/src/main/spellmenu";

/**
 * Unit tests for the pure menu-template builder. The native popup itself
 * cannot run under the test harness (it blocks on a human), so the e2e spec
 * asserts the stashed template and these tests pin the builder's shape.
 */

test("suggestions become replace items, capped at the limit", () => {
  const template = buildSpellMenuTemplate("teh", ["the", "ten", "tea", "toe", "tee", "tie", "tee2"]);
  const replaces = template.filter((i) => i.action?.type === "replace");
  expect(replaces.length).toBe(MAX_SUGGESTIONS);
  expect(replaces[0].label).toBe("the");
  expect(replaces[0].action).toEqual({ type: "replace", text: "the" });
  // No placeholder when there are suggestions.
  expect(template.some((i) => i.label === "No suggestions")).toBe(false);
});

test("no suggestions shows a disabled placeholder", () => {
  const template = buildSpellMenuTemplate("qqqq", []);
  const placeholder = template.find((i) => i.label === "No suggestions");
  expect(placeholder).toBeDefined();
  expect(placeholder!.enabled).toBe(false);
  expect(template.some((i) => i.action?.type === "replace")).toBe(false);
});

test("always offers Add to Dictionary and the standard clipboard items", () => {
  const template = buildSpellMenuTemplate("Zorbling", ["Zorb"]);
  const add = template.find((i) => i.action?.type === "add-word");
  expect(add).toBeDefined();
  expect(add!.label).toContain("Zorbling");
  expect(add!.label).toContain("Dictionary");
  const roles = template.filter((i) => i.role).map((i) => i.role);
  expect(roles).toEqual(["cut", "copy", "paste"]);
  // Sections are separated: suggestions | add | clipboard.
  expect(template.filter((i) => i.type === "separator").length).toBe(2);
});
