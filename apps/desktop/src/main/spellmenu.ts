/**
 * The spellcheck context-menu template, as plain data.
 *
 * Pure and Electron-free so tests can assert on the menu without a native
 * popup: spellcheck.ts maps these entries onto Electron MenuItems, and the
 * unit spec (e2e/spellmenu-unit.spec.ts) imports this module directly.
 */

export type SpellMenuAction = { type: "replace"; text: string } | { type: "add-word" };

export interface SpellMenuItem {
  type?: "separator";
  label?: string;
  /** Standard clipboard roles Electron implements natively. */
  role?: "cut" | "copy" | "paste";
  enabled?: boolean;
  /** What the renderer should do when this item is picked. */
  action?: SpellMenuAction;
}

export const MAX_SUGGESTIONS = 5;

export function buildSpellMenuTemplate(word: string, suggestions: string[]): SpellMenuItem[] {
  const items: SpellMenuItem[] = [];
  const top = suggestions.slice(0, MAX_SUGGESTIONS);
  if (top.length === 0) {
    items.push({ label: "No suggestions", enabled: false });
  }
  for (const s of top) {
    items.push({ label: s, action: { type: "replace", text: s } });
  }
  items.push({ type: "separator" });
  items.push({ label: `Add “${word}” to Dictionary`, action: { type: "add-word" } });
  items.push({ type: "separator" });
  items.push({ role: "cut", label: "Cut" });
  items.push({ role: "copy", label: "Copy" });
  items.push({ role: "paste", label: "Paste" });
  return items;
}
