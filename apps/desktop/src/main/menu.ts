/**
 * The application menu.
 *
 * Two kinds of item live here. Window and file management (New, Open, Open
 * Recent, Close) runs in the main process. Everything that acts on the open
 * document sends an action string on the "menu" channel; the renderer routes it
 * (see renderer/src/menu-actions.ts). Action names are stable and grouped by a
 * prefix — "format:bold", "insert:table" — so the renderer owns all knowledge
 * of the engine and this file stays free of it.
 *
 * Accelerators: a menu accelerator wins over the renderer, so any key bound
 * here no longer reaches the engine's own keyboard handling. Every item that
 * binds a key the engine also handles routes to the same behaviour.
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { createDocumentWindow, focusedDocState, openDocument, openDocumentDialog } from "./index";
import { clearRecent, recentPaths } from "./recent";
import { readSettings, saveSettings, settingsEvents, type Settings, type SpellLanguage } from "./settings";
import { checkForUpdates } from "./updater";

/** The spellcheck language, cached so the menu can build synchronously. */
let spellLanguage: SpellLanguage = "system";

export async function loadMenuState(): Promise<void> {
  spellLanguage = (await readSettings()).spellLanguage;
}

settingsEvents.on("changed", (next: Settings) => {
  spellLanguage = next.spellLanguage;
  rebuildMenu();
});

export function rebuildMenu(): void {
  Menu.setApplicationMenu(buildMenu());
}

function sendToFocused(action: string): (menuItem: unknown, win?: unknown) => void {
  return (_item, win) => {
    const w = win as Electron.BrowserWindow | undefined;
    w?.webContents.send("menu", action);
  };
}

function send(label: string, action: string, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: sendToFocused(action) };
}

const separator: MenuItemConstructorOptions = { type: "separator" };

function recentSubmenu(): MenuItemConstructorOptions[] {
  const paths = recentPaths();
  if (paths.length === 0) {
    return [{ label: "No Recent Documents", enabled: false }];
  }
  return [
    ...paths.map((p) => ({
      label: path.basename(p),
      toolTip: p,
      click: () => void openDocument(p),
    })),
    separator,
    {
      label: "Clear Menu",
      click: () => {
        void clearRecent().then(rebuildMenu);
      },
    },
  ];
}

async function setSpellLanguage(next: SpellLanguage): Promise<void> {
  const current = await readSettings();
  await saveSettings({ ...current, spellLanguage: next });
}

function spellSubmenu(): MenuItemConstructorOptions[] {
  const on = spellLanguage !== "off";
  return [
    {
      label: "Check Spelling While Typing",
      type: "checkbox",
      checked: on,
      click: () => void setSpellLanguage(on ? "off" : "system"),
    },
    separator,
    {
      label: "System Language",
      type: "radio",
      checked: spellLanguage === "system",
      click: () => void setSpellLanguage("system"),
    },
    {
      label: "English (US)",
      type: "radio",
      checked: spellLanguage === "en-US",
      click: () => void setSpellLanguage("en-US"),
    },
  ];
}

export function buildMenu(): Menu {
  const isMac = process.platform === "darwin";
  const doc = focusedDocState();
  const settingsItem: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: sendToFocused("settings"),
  };
  // Updates come from GitHub Releases; only the packaged app can install them.
  const updateItems: MenuItemConstructorOptions[] = app.isPackaged
    ? [{ label: "Check for Updates…", click: () => void checkForUpdates() }, separator]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "LikeOffice",
            submenu: [
              { role: "about" },
              separator,
              ...updateItems,
              settingsItem,
              separator,
              { role: "hide" },
              { role: "hideOthers" },
              separator,
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Document",
          accelerator: "CmdOrCtrl+N",
          click: () => void createDocumentWindow(),
        },
        {
          label: "Open…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openDocumentDialog(),
        },
        { label: "Open Recent", submenu: recentSubmenu() },
        separator,
        send("Save", "save", "CmdOrCtrl+S"),
        send("Save As…", "save-as", "Shift+CmdOrCtrl+S"),
        send("Duplicate", "duplicate"),
        // Reverting throws away unsaved work, and there is nothing to revert to
        // without a file on disk.
        { ...send("Revert to Saved", "revert"), enabled: doc?.dirty === true && doc.path !== null },
        separator,
        send("Page Setup…", "page-setup", "Shift+CmdOrCtrl+P"),
        send("Print…", "print", "CmdOrCtrl+P"),
        separator,
        send("Export as PDF…", "export-pdf"),
        send("Export as DOCX Copy…", "export-docx"),
        separator,
        ...(isMac ? [] : [...updateItems, settingsItem, separator]),
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        send("Undo", "undo", "CmdOrCtrl+Z"),
        send("Redo", "redo", "Shift+CmdOrCtrl+Z"),
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { label: "Paste and Match Style", role: "pasteAndMatchStyle", accelerator: "Shift+CmdOrCtrl+V" },
        // No accelerator: binding the Delete key application-wide would take it
        // away from every text field in the app.
        send("Delete", "delete"),
        send("Select All", "select-all", "CmdOrCtrl+A"),
        separator,
        send("Find…", "find", "CmdOrCtrl+F"),
        send("Find and Replace…", "find-replace", "Shift+CmdOrCtrl+H"),
        send("Find Next", "find-next", "CmdOrCtrl+G"),
        send("Find Previous", "find-prev", "Shift+CmdOrCtrl+G"),
        send("Go To…", "go-to", "CmdOrCtrl+Alt+G"),
      ],
    },
    {
      label: "Format",
      submenu: [
        send("Bold", "format:bold", "CmdOrCtrl+B"),
        send("Italic", "format:italic", "CmdOrCtrl+I"),
        send("Underline", "format:underline", "CmdOrCtrl+U"),
        send("Strikethrough", "format:strike", "Shift+CmdOrCtrl+X"),
        separator,
        send("Superscript", "format:superscript", "Shift+CmdOrCtrl+="),
        send("Subscript", "format:subscript", "CmdOrCtrl+="),
        separator,
        {
          label: "Styles",
          submenu: [
            send("Normal", "style:normal", "CmdOrCtrl+Alt+0"),
            send("Heading 1", "style:Heading1", "CmdOrCtrl+Alt+1"),
            send("Heading 2", "style:Heading2", "CmdOrCtrl+Alt+2"),
            send("Heading 3", "style:Heading3", "CmdOrCtrl+Alt+3"),
            send("Title", "style:Title"),
          ],
        },
        {
          label: "Paragraph",
          submenu: [
            send("Align Left", "align:left", "CmdOrCtrl+L"),
            send("Center", "align:center", "CmdOrCtrl+E"),
            send("Align Right", "align:right", "CmdOrCtrl+R"),
            send("Justify", "align:justify", "CmdOrCtrl+J"),
            separator,
            send("Single Spacing", "spacing:1"),
            send("1.15 Spacing", "spacing:1.15"),
            send("1.5 Spacing", "spacing:1.5"),
            send("Double Spacing", "spacing:2"),
            separator,
            send("Increase Indent", "indent:in"),
            send("Decrease Indent", "indent:out"),
          ],
        },
        {
          label: "Lists",
          submenu: [
            send("Bulleted List", "list:bullet", "Shift+CmdOrCtrl+L"),
            send("Numbered List", "list:number", "Shift+CmdOrCtrl+7"),
            separator,
            send("Multilevel: 1. 1.1. 1.1.1.", "list-preset:decimalNested"),
            send("Multilevel: I. A. 1. a)", "list-preset:outline"),
            send("Multilevel: Article I / Section 1.01", "list-preset:articleSection"),
            send("Multilevel: Chapter 1", "list-preset:chapter"),
          ],
        },
        separator,
        send("Borders and Shading…", "borders"),
        send("Tabs…", "tabs"),
        send("Clear Formatting", "clear-format"),
      ],
    },
    {
      label: "Insert",
      submenu: [
        send("Page Break", "insert:page-break", "CmdOrCtrl+Enter"),
        {
          label: "Section Break",
          submenu: [
            send("Next Page", "insert:section-next-page"),
            send("Continuous", "insert:section-continuous"),
          ],
        },
        separator,
        send("Table…", "insert:table"),
        send("Picture…", "insert:picture"),
        send("Link…", "insert:link", "CmdOrCtrl+K"),
        separator,
        send("Comment", "insert:comment"),
        send("Footnote", "insert:footnote"),
        send("Endnote", "insert:endnote"),
        separator,
        send("Page Numbers…", "insert:page-numbers"),
        send("Header & Footer", "insert:header-footer"),
        separator,
        send("Equation", "insert:equation"),
        send("Symbol…", "insert:symbol"),
        send("Date & Time", "insert:date-time"),
        separator,
        send("Table of Contents", "insert:toc"),
        send("Caption…", "insert:caption"),
        send("Cross-reference…", "insert:cross-reference"),
        send("Bookmark…", "insert:bookmark"),
        send("Quick Parts", "insert:quick-parts"),
      ],
    },
    {
      label: "Tools",
      submenu: [
        send("Word Count…", "word-count"),
        { label: "Spelling", submenu: spellSubmenu() },
        separator,
        send("Track Changes", "track-changes", "Shift+CmdOrCtrl+E"),
        send("Accept All Changes", "accept-all"),
        send("Reject All Changes", "reject-all"),
        separator,
        send("AI Assistant", "toggle-ai"),
        send("AI Profiles…", "ai-profiles"),
      ],
    },
    {
      label: "View",
      submenu: [
        send("AI Assistant", "toggle-ai", "Shift+CmdOrCtrl+A"),
        separator,
        send("Zoom In", "zoom:in", "Alt+CmdOrCtrl+="),
        send("Zoom Out", "zoom:out", "Alt+CmdOrCtrl+-"),
        send("Actual Size", "zoom:reset", "CmdOrCtrl+0"),
        separator,
        // forceReload, not reload: reload's Cmd+R belongs to Format > Align Right.
        ...(app.isPackaged
          ? []
          : [
              { role: "forceReload" } satisfies MenuItemConstructorOptions,
              { role: "toggleDevTools" } satisfies MenuItemConstructorOptions,
              separator,
            ]),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  return Menu.buildFromTemplate(template);
}
