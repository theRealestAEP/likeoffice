/**
 * The application menu's accelerators, shaped for the engine's shortcuts sheet.
 *
 * The sheet (HelpGuide) builds itself from the engine's own shortcut table, so
 * it can only describe keys the editor binds. A menu accelerator is consumed by
 * the menu before the renderer ever sees the keydown, so the engine cannot
 * discover ⌘F, ⌘S, ⌥⌘1 and the rest — half the keyboard was missing from the
 * sheet. HelpGuide takes the other half through its `hostShortcuts` prop, and
 * this module produces it by WALKING THE LIVE MENU. The menu stays the single
 * source of truth: a new accelerator in menu.ts appears in the sheet with no
 * second edit here.
 *
 * Pure and Electron-free, so the unit spec (e2e/menu-shortcuts-unit.spec.ts)
 * can drive it directly. menu.ts hands it `Menu.getApplicationMenu()`.
 */

/** One top-level menu's accelerators. Matches the engine's HostShortcutSection. */
export interface MenuShortcutSection {
  title: string;
  items: { label: string; keys: string }[];
}

/** As much of an Electron MenuItem as this file reads. */
export interface MenuItemLike {
  label: string;
  /** Electron 39 types this `Accelerator | null` — present but empty — where
   * older versions left it optional. Both shapes read the same to `if
   * (item.accelerator)` below; only the type had to widen. */
  accelerator?: string | null;
  submenu?: { items: MenuItemLike[] } | null;
}

/** Electron key names that are not what a shortcuts sheet should print. */
const KEY_LABELS: Record<string, string> = { Return: "Enter" };

/**
 * One Electron accelerator as the platform writes it: "⇧⌘S" on macOS,
 * "Ctrl+Shift+S" elsewhere. Modifier order matches the engine's own
 * `formatCombo`, so menu rows and editor rows in the sheet read alike.
 */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const parts = accelerator.split("+");
  const key = parts[parts.length - 1];
  const has = (...names: string[]) => parts.some((p) => names.includes(p));
  const mod = has("CommandOrControl", "CmdOrCtrl", "Command", "Cmd", "Super", "Meta");
  const control = has("Control", "Ctrl");
  const alt = has("Alt", "Option", "AltGr");
  const shift = has("Shift");
  const name = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    return `${control ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${mod ? "⌘" : ""}${name}`;
  }
  const written: string[] = [];
  if (control || mod) written.push("Ctrl");
  if (alt) written.push("Alt");
  if (shift) written.push("Shift");
  written.push(name);
  return written.join("+");
}

/** Every accelerator under one menu item, submenus included, in menu order. */
function collect(items: MenuItemLike[], mac: boolean): { label: string; keys: string }[] {
  const found: { label: string; keys: string }[] = [];
  for (const item of items) {
    if (item.accelerator) found.push({ label: item.label, keys: formatAccelerator(item.accelerator, mac) });
    if (item.submenu) found.push(...collect(item.submenu.items, mac));
  }
  return found;
}

/** The whole menu's accelerators, one section per top-level menu. */
export function menuShortcutSections(
  menu: { items: MenuItemLike[] } | null,
  mac: boolean,
): MenuShortcutSection[] {
  if (!menu) return [];
  return menu.items
    .map((top) => ({
      title: `${top.label} menu`,
      items: collect(top.submenu?.items ?? [], mac),
    }))
    .filter((section) => section.items.length > 0);
}
