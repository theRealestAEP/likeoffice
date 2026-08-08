/**
 * Spellcheck service (main process).
 *
 * The engine's editing surface is NOT contentEditable — it paints its own
 * caret and keeps keyboard focus on a hidden 1px textarea — so Chromium's
 * built-in spellchecker never sees the document text and its context-menu
 * params (misspelledWord / dictionarySuggestions) stay empty. The app checks
 * words itself instead: the renderer extracts visible words and asks this
 * module over IPC; the hunspell en-US dictionary is vendored under
 * resources/dictionaries and evaluated with nspell.
 *
 * The native right-click menu also lives here (spell:menu): the engine
 * preventDefaults contextmenu over text for its own DOM menu, so the renderer
 * intercepts right-clicks on misspelled words in the capture phase and asks
 * this module to pop up a native Electron menu with suggestions.
 */
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import nspell from "nspell";
import { readSettings, settingsEvents, type Settings } from "./settings";
import { buildSpellMenuTemplate, type SpellMenuAction } from "./spellmenu";

type Checker = ReturnType<typeof nspell>;

let checker: Checker | null = null;
let checkerLang: string | null = null;

function customWordsFile(): string {
  return path.join(app.getPath("userData"), "custom-dictionary.json");
}

async function readCustomWords(): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(customWordsFile(), "utf8"));
    return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

/** en-US is the only vendored dictionary; "system" resolves through the OS locale. */
function resolveLanguage(settings: Settings): string | null {
  if (settings.spellLanguage === "off") return null;
  if (settings.spellLanguage === "en-US") return "en-US";
  return app.getLocale().toLowerCase().startsWith("en") ? "en-US" : null;
}

async function getChecker(): Promise<Checker | null> {
  const lang = resolveLanguage(await readSettings());
  if (!lang) return null;
  if (checker && checkerLang === lang) return checker;
  const dir = path.join(app.getAppPath(), "resources/dictionaries");
  const [aff, dic] = await Promise.all([
    readFile(path.join(dir, `${lang}.aff`)),
    readFile(path.join(dir, `${lang}.dic`)),
  ]);
  const spell = nspell(aff, dic);
  for (const w of await readCustomWords()) spell.add(w);
  checker = spell;
  checkerLang = lang;
  return spell;
}

// A language change invalidates the loaded dictionary; the renderer re-scans.
settingsEvents.on("changed", () => {
  checker = null;
  checkerLang = null;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("spell:changed");
});

ipcMain.handle("spell:check", async (_e, words: string[]) => {
  const spell = await getChecker();
  if (!spell) return [];
  return words.filter((w) => !spell.correct(w));
});

ipcMain.handle("spell:suggest", async (_e, word: string) => {
  const spell = await getChecker();
  return spell ? spell.suggest(word).slice(0, 5) : [];
});

ipcMain.handle("spell:add-word", async (_e, word: string) => {
  const words = await readCustomWords();
  if (!words.includes(word)) {
    words.push(word);
    await writeFile(customWordsFile(), JSON.stringify(words, null, 2));
  }
  checker?.add(word);
});

ipcMain.handle(
  "spell:menu",
  (e, word: string, suggestions: string[], x: number, y: number): Promise<SpellMenuAction | null> | SpellMenuAction | null => {
    const template = buildSpellMenuTemplate(word, suggestions);
    // e2e seam: native menus need a human, so tests read the template from
    // here and script the pick through LIKEOFFICE_SPELL_MENU_AUTOPICK.
    (globalThis as { __lastSpellMenu?: unknown }).__lastSpellMenu = { word, suggestions, template };
    const autopick = process.env.LIKEOFFICE_SPELL_MENU_AUTOPICK;
    if (autopick) {
      if (autopick === "add-word") return { type: "add-word" };
      const replace = template.find((i) => i.action?.type === "replace");
      return replace?.action ?? null;
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return null;
    return new Promise((resolve) => {
      let chosen: SpellMenuAction | null = null;
      const items: MenuItemConstructorOptions[] = template.map((item) => {
        if (item.type === "separator") return { type: "separator" };
        if (item.role) return { role: item.role };
        return {
          label: item.label ?? "",
          enabled: item.enabled !== false,
          click: () => {
            chosen = item.action ?? null;
          },
        };
      });
      Menu.buildFromTemplate(items).popup({
        window: win,
        x: Math.round(x),
        y: Math.round(y),
        // The callback runs on close, after any click handler.
        callback: () => resolve(chosen),
      });
    });
  },
);
