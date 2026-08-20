import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { loadMenuState, rebuildMenu } from "./menu";
import { addRecent, loadRecent } from "./recent";
import { readSettings } from "./settings";
import "./settings";
import "./profiles";
import "./spellcheck";
import "./model";
import "./models-list";
import "./web-tools";
import "./s3-sync";
import "./providers";
import "./agent";

interface DocState {
  path: string | null;
  dirty: boolean;
  pendingClose: boolean;
  autosaveFile: string;
  recovered: boolean;
  /** Bytes for a window that starts from content rather than a file (Duplicate). */
  seed: Uint8Array | null;
  /** File name to suggest when this document has no path yet. */
  suggestedName: string;
  /** mtime of the last write THIS app made, so its own saves are not reported
   * back to it as somebody else's change. */
  ownMtimeMs: number;
  /** Directory watcher for the open file; see watchDocument. */
  watcher: FSWatcher | null;
}

const docs = new Map<number, DocState>();

/**
 * The document window the menu describes. Menu items are enabled from it, and
 * `BrowserWindow.getFocusedWindow()` is null whenever the app is not frontmost
 * — including right after a window is created — so the last window to be
 * created or focused stands in.
 */
let activeDocId: number | null = null;

/**
 * The app is called LikeOffice, in development too.
 *
 * Unpackaged, Electron takes its name from the binary, so the Dock, the About
 * panel and the app menu's own Hide/Quit items all read "Electron" — the menu
 * bar says LikeOffice while everything beside it disagrees. `productName` in
 * electron-builder.yml only fixes the PACKAGED build.
 *
 * Set before anything reads it: app.name also decides the default userData
 * directory, which moves from ".../@likeoffice/desktop" to ".../LikeOffice" —
 * the same place a packaged build already uses, so this aligns development
 * with what ships rather than inventing a third location.
 */
app.setName("LikeOffice");

if (process.env.LIKEOFFICE_USER_DATA) {
  app.setPath("userData", process.env.LIKEOFFICE_USER_DATA);
}

const DOCX_FILTER = { name: "Word Document", extensions: ["docx"] };
/** Mail-merge data. Excel and Numbers both export .csv; European Excel writes
 * semicolons into one, and tab-separated exports keep a .txt or .tsv name. */
const CSV_FILTER = { name: "Data Source", extensions: ["csv", "tsv", "txt"] };

function autosaveDir(): string {
  return path.join(app.getPath("userData"), "autosave");
}

/**
 * Remember the mtime we just produced, so the watcher can tell our write from
 * someone else's.
 *
 * Pass the TEMP file, before the rename that publishes it. `rename` does not
 * touch the file's mtime, so the temp file's mtime IS the mtime the document
 * will have. Recording it after the rename is a race the app loses on Linux,
 * where inotify delivers the event before the next await resolves: the watcher
 * then compares against the PREVIOUS mtime and reports the app's own autosave
 * as somebody else's edit. macOS coalesces its events slowly enough to hide
 * this, which is why it only ever showed up on a Linux runner.
 */
async function noteOwnWrite(st: DocState, from = st.path): Promise<void> {
  if (!from) return;
  try {
    st.ownMtimeMs = (await stat(from)).mtimeMs;
  } catch {
    st.ownMtimeMs = 0;
  }
}

/**
 * Watch the open document for changes made outside this app.
 *
 * WATCHES THE DIRECTORY, not the file. Saving replaces the document by writing
 * a temp file and renaming it over the original — an atomic swap that leaves a
 * file watcher pointed at an inode nothing will write to again, so it would go
 * deaf after the first save. Word and every sync client save the same way.
 *
 * The app's own writes are filtered by mtime rather than by a flag, because a
 * save and an external change can land in the same moment and a flag would
 * swallow the one that mattered.
 */
function watchDocument(id: number, st: DocState): void {
  st.watcher?.close();
  st.watcher = null;
  if (!st.path) return;
  const dir = path.dirname(st.path);
  const base = path.basename(st.path);
  try {
    st.watcher = watch(dir, (_event, changed) => {
      if (changed !== null && changed !== base) return;
      void (async () => {
        const current = docs.get(id);
        if (!current?.path) return;
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(current.path)).mtimeMs;
        } catch {
          return; // deleted or mid-rename; the next event settles it
        }
        if (mtimeMs === current.ownMtimeMs) return; // our own save
        current.ownMtimeMs = mtimeMs; // report once per external write
        windowFor(id)?.webContents.send("document:external-change");
      })();
    });
  } catch {
    // An unwatchable location (a network mount, a removed volume) is not a
    // reason to refuse to open the document.
  }
}

async function removeAutosave(st: DocState): Promise<void> {
  await rm(st.autosaveFile, { force: true });
  await rm(`${st.autosaveFile}.json`, { force: true });
}

interface RecoveryEntry {
  autosaveFile: string;
  originalPath: string | null;
}

async function listRecoveries(): Promise<RecoveryEntry[]> {
  await mkdir(autosaveDir(), { recursive: true });
  const entries: RecoveryEntry[] = [];
  for (const f of await readdir(autosaveDir())) {
    if (!f.endsWith(".docx")) continue;
    const file = path.join(autosaveDir(), f);
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, "utf8"));
      entries.push({ autosaveFile: file, originalPath: meta.originalPath ?? null });
    } catch {
      entries.push({ autosaveFile: file, originalPath: null });
    }
  }
  return entries;
}

interface NewWindowOptions {
  filePath?: string;
  recovery?: RecoveryEntry;
  /** Start from these bytes instead of a file: File > Duplicate. */
  seed?: { bytes: Uint8Array; name: string };
}

export async function createDocumentWindow(options: NewWindowOptions = {}): Promise<void> {
  const { filePath, recovery, seed } = options;
  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });
  const id = win.webContents.id;
  docs.set(id, {
    path: recovery?.originalPath ?? filePath ?? null,
    // Duplicated content exists only in the new window, so it starts dirty and
    // closing it asks to save.
    dirty: seed != null,
    pendingClose: false,
    autosaveFile:
      recovery?.autosaveFile ?? path.join(autosaveDir(), `${Date.now()}-${id}.docx`),
    recovered: recovery != null,
    seed: seed?.bytes ?? null,
    suggestedName: seed?.name ?? "Untitled",
    ownMtimeMs: 0,
    watcher: null,
  });

  // Tests set LIKEOFFICE_HIDE_WINDOWS: Playwright drives windows over CDP,
  // which needs no OS-visible window, so suites run without popping windows.
  win.once("ready-to-show", () => {
    if (!process.env.LIKEOFFICE_HIDE_WINDOWS) win.show();
  });
  activeDocId = id;
  win.on("focus", () => {
    activeDocId = id;
    rebuildMenu();
  });
  win.on("closed", () => {
    const st = docs.get(id);
    st?.watcher?.close();
    if (st) void removeAutosave(st);
    docs.delete(id);
    if (activeDocId === id) activeDocId = null;
    rebuildMenu();
  });
  win.on("close", (e) => {
    const st = docs.get(id);
    if (!st?.dirty) return;
    e.preventDefault();
    const name = st.path ? path.basename(st.path) : st.suggestedName;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${name}?`,
      detail: "Your changes will be lost if you don't save them.",
    });
    if (choice === 0) {
      st.pendingClose = true;
      win.webContents.send("menu", "save");
    } else if (choice === 1) {
      win.destroy();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

/** The window already showing this file, if any. Compared by RESOLVED path so
 * the same document reached through a symlink or a differently-cased path is
 * still recognised as the same document. */
async function windowShowing(filePath: string): Promise<BrowserWindow | null> {
  let wanted: string;
  try {
    wanted = await realpath(filePath);
  } catch {
    wanted = path.resolve(filePath);
  }
  for (const [id, st] of docs) {
    if (!st.path) continue;
    let held: string;
    try {
      held = await realpath(st.path);
    } catch {
      held = path.resolve(st.path);
    }
    if (held === wanted) return windowFor(id);
  }
  return null;
}

/** Open a file in a window and record it in Open Recent. */
export async function openDocument(filePath: string): Promise<void> {
  // ONE WINDOW PER FILE. Two windows on one document each autosaved it on their
  // own timer, so whichever wrote last silently discarded the other's work —
  // and nothing on screen said a second copy was open. Opening it again focuses
  // the window that already has it.
  const existing = await windowShowing(filePath);
  if (existing) {
    existing.focus();
    await addRecent(filePath);
    rebuildMenu();
    return;
  }
  try {
    await readFile(filePath);
  } catch {
    // The file moved or was deleted since the menu was built. Drop it from the
    // list rather than opening a window onto nothing.
    await loadRecent();
    rebuildMenu();
    dialog.showErrorBox("Cannot open document", `${filePath} is no longer there.`);
    return;
  }
  await addRecent(filePath);
  rebuildMenu();
  await createDocumentWindow({ filePath });
}

// e2e seam: the duplicate-window test needs the real opener, not a re-implementation.
(globalThis as { __likeofficeOpen?: (p: string) => Promise<void> }).__likeofficeOpen = openDocument;

export async function openDocumentDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [DOCX_FILTER],
  });
  for (const p of result.filePaths) await openDocument(p);
}

/** Path and dirty state of the active document, for menu item enablement. */
export function focusedDocState(): { path: string | null; dirty: boolean } | null {
  const id = BrowserWindow.getFocusedWindow()?.webContents.id ?? activeDocId;
  const st = id != null ? docs.get(id) : undefined;
  return st ? { path: st.path, dirty: st.dirty } : null;
}

function windowFor(webContentsId: number): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId) ?? null
  );
}

ipcMain.handle("document:init", async (e) => {
  const st = docs.get(e.sender.id);
  if (st?.path) {
    await noteOwnWrite(st);
    watchDocument(e.sender.id, st);
  }
  if (st?.recovered) {
    const bytes = await readFile(st.autosaveFile);
    const name = st.path ? path.basename(st.path) : st.suggestedName;
    return { path: st.path, name, bytes, dirty: true };
  }
  if (st?.seed) {
    return { path: null, name: st.suggestedName, bytes: st.seed, dirty: true };
  }
  if (st?.path) {
    const bytes = await readFile(st.path);
    return { path: st.path, name: path.basename(st.path), bytes, dirty: false };
  }
  const blank = await readFile(path.join(app.getAppPath(), "resources/blank.docx"));
  return { path: null, name: st?.suggestedName ?? "Untitled", bytes: blank, dirty: false };
});

/** File > Duplicate: the current bytes, in a new unsaved window. */
ipcMain.handle("document:duplicate", async (e, bytes: Uint8Array) => {
  const st = docs.get(e.sender.id);
  const base = st?.path ? path.basename(st.path, ".docx") : (st?.suggestedName ?? "Untitled").replace(/\.docx$/, "");
  await createDocumentWindow({ seed: { bytes, name: `${base} copy.docx` } });
});

/** File > Revert to Saved. Returns the file's bytes, or null when the user
 * cancels — the confirmation is native, so it lives here. */
ipcMain.handle("document:revert", async (e) => {
  const st = docs.get(e.sender.id);
  const win = windowFor(e.sender.id);
  if (!st?.path || !win) return null;

  const choice = dialog.showMessageBoxSync(win, {
    type: "warning",
    buttons: ["Revert", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Revert to the last saved version of ${path.basename(st.path)}?`,
    detail: "Your unsaved changes will be lost.",
  });
  if (choice !== 0) return null;

  const bytes = await readFile(st.path);
  st.dirty = false;
  st.recovered = false;
  st.seed = null;
  win.setDocumentEdited(false);
  await removeAutosave(st);
  rebuildMenu();
  return { path: st.path, name: path.basename(st.path), bytes, dirty: false };
});

/** File > Export as DOCX Copy: write the bytes elsewhere without rebinding
 * this window to the new file. */
ipcMain.handle("document:save-copy", async (e, bytes: Uint8Array) => {
  const st = docs.get(e.sender.id);
  const win = windowFor(e.sender.id);
  if (!st || !win) return null;

  const base = st.path ? path.basename(st.path, ".docx") : st.suggestedName.replace(/\.docx$/, "");
  const result = await dialog.showSaveDialog(win, {
    defaultPath: `${base} copy.docx`,
    filters: [DOCX_FILTER],
  });
  if (result.canceled || !result.filePath) return null;
  const target = result.filePath.endsWith(".docx") ? result.filePath : `${result.filePath}.docx`;

  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
  return { path: target, name: path.basename(target) };
});

/**
 * Autosave, in two layers.
 *
 * The RECOVERY copy in userData is written every time, settings or not: it is
 * what reopens the document after a crash, and a user who turned autosave off
 * meant "do not touch my file", not "lose my work".
 *
 * Writing the DOCUMENT'S OWN FILE is the part people mean by autosave, and it
 * only happens when the setting is on and the document has a path. An untitled
 * window has no file to write and is deliberately left to the recovery copy —
 * inventing a filename for every scratch window would litter the disk.
 *
 * Returns the time it wrote the real file, or null, so the window can say
 * "Saved 12:04" rather than the renderer guessing that it worked.
 */
/**
 * Mail merge output: write one merged document per record.
 *
 * The renderer bakes each record (it owns the engine); main only chooses the
 * folder and writes. Names come from the record where a sensible column exists,
 * because "Letter 37.docx" is useless when you are looking for Dana's copy.
 */
ipcMain.handle(
  "merge:write",
  async (e, files: { name: string; bytes: Uint8Array }[]): Promise<{ dir: string; written: number } | null> => {
    const win = windowFor(e.sender.id);
    if (!win || !Array.isArray(files) || files.length === 0) return null;
    const { storage } = await readSettings();
    const chosen = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      message: `Where should the ${files.length} merged document${files.length === 1 ? "" : "s"} go?`,
      ...(storage.projectsDir ? { defaultPath: storage.projectsDir } : {}),
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const dir = chosen.filePaths[0];
    let written = 0;
    const used = new Set<string>();
    for (const file of files) {
      // Two records can share a name; a merge that silently overwrote the
      // first would lose a document with no error at all.
      let name = file.name;
      for (let n = 2; used.has(name.toLowerCase()); n++) {
        name = file.name.replace(/\.docx$/i, ` (${n}).docx`);
      }
      used.add(name.toLowerCase());
      await writeFile(path.join(dir, name), Buffer.from(file.bytes));
      written++;
    }
    return { dir, written };
  },
);

ipcMain.handle("storage:choose-projects-dir", async (e): Promise<string | null> => {
  const win = windowFor(e.sender.id);
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    properties: ["openDirectory", "createDirectory"],
    message: "Where should new documents be saved?",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("document:autosave", async (e, bytes: Uint8Array): Promise<string | null> => {
  const st = docs.get(e.sender.id);
  if (!st) return null;
  await mkdir(autosaveDir(), { recursive: true });
  await writeFile(st.autosaveFile, bytes);
  await writeFile(
    `${st.autosaveFile}.json`,
    JSON.stringify({ originalPath: st.path, savedAt: new Date().toISOString() }),
  );

  const { storage } = await readSettings();
  if (!storage.autosave || !st.path) return null;
  // Atomic: a crash mid-write must not leave a half-written .docx where the
  // user's document used to be. Same tmp+rename the explicit save uses.
  const tmp = `${st.path}.autosave-tmp`;
  await writeFile(tmp, bytes);
  await noteOwnWrite(st, tmp);
  await rename(tmp, st.path);
  st.dirty = false;
  rebuildMenu();
  return new Date().toISOString();
});

ipcMain.handle(
  "document:save",
  async (e, bytes: Uint8Array, saveAs: boolean) => {
    const st = docs.get(e.sender.id);
    const win = windowFor(e.sender.id);
    if (!st || !win) return null;

    let target = st.path;
    if (!target || saveAs) {
      // A document with no path opens in the projects folder when one is set:
      // that is the whole point of the setting — new work lands together.
      const { storage } = await readSettings();
      const suggested =
        st.path ??
        (storage.projectsDir ? path.join(storage.projectsDir, st.suggestedName) : st.suggestedName);
      const result = await dialog.showSaveDialog(win, {
        defaultPath: suggested,
        filters: [DOCX_FILTER],
      });
      if (result.canceled || !result.filePath) {
        st.pendingClose = false;
        return null;
      }
      target = result.filePath.endsWith(".docx")
        ? result.filePath
        : `${result.filePath}.docx`;
    }

    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, bytes);
    await noteOwnWrite(st, tmp);
    await rename(tmp, target);

    st.path = target;
    st.dirty = false;
    st.recovered = false;
    st.seed = null;
    // Save As points the window at a different file; the watch follows it.
    watchDocument(e.sender.id, st);
    win.setDocumentEdited(false);
    await addRecent(target);
    rebuildMenu();
    await removeAutosave(st);
    if (st.pendingClose) {
      win.destroy();
      return null;
    }
    return { path: target, name: path.basename(target) };
  },
);

ipcMain.handle("document:export-pdf", async (e, html: string) => {
  const st = docs.get(e.sender.id);
  const win = windowFor(e.sender.id);
  if (!st || !win) return null;

  const defaultName = st.path
    ? path.basename(st.path).replace(/\.docx$/, ".pdf")
    : "Untitled.pdf";
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const target = result.filePath.endsWith(".pdf")
    ? result.filePath
    : `${result.filePath}.pdf`;

  const htmlFile = path.join(app.getPath("temp"), `likeoffice-export-${e.sender.id}.html`);
  await writeFile(htmlFile, html);
  // The export HTML is BUILT FROM DOCUMENT CONTENT, so it must be rendered
  // with no privileges: a default window runs scripts in a file:// origin,
  // where anything that smuggled markup through the serializer could read the
  // user's disk and post it onward from a window they cannot see. Printing
  // needs none of that.
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      // Sandboxed and isolated, but scripts stay ON: the export page needs them
      // to lay itself out before printing, and turning them off produced a
      // blank PDF. What this removes is the privileged part — no node, no
      // preload, no reaching the app's own APIs from a file:// page.
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });
  try {
    await printWin.loadFile(htmlFile);
    await printWin.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
    const pdf = await printWin.webContents.printToPDF({
      preferCSSPageSize: true,
      printBackground: true,
    });
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, pdf);
    await rename(tmp, target);
    return { path: target };
  } finally {
    // close(), not destroy(): destroying a window in the same turn as the
    // quit that follows it segfaults Electron 34 on the way out (V8 builds
    // the destroy event with no context entered). Measured over 100 launches
    // each: destroy 26-49% crash rate, close 0. Fixed upstream in 40.9.0, so
    // this can revert once the electron pin moves — see docs/known-issues.md.
    printWin.close();
    await rm(htmlFile, { force: true });
  }
});

/**
 * Load a mail-merge data source.
 *
 * The parse happens HERE, in the host, and the renderer receives plain
 * strings. The engine never learns a path, so its "no external resources"
 * posture holds by construction rather than by discipline — the same reason it
 * refuses INCLUDETEXT and never writes w:mailMerge.
 *
 * papaparse does the work. CSV in the wild is not a split on commas: mail-merge
 * data is full of multi-line postal addresses (RFC 4180 quoting with embedded
 * newlines), Excel writes a UTF-8 BOM that would otherwise turn the first
 * column's name into "﻿FirstName" and match nothing, European Excel writes
 * semicolons, and exports arrive tab-separated. Header names are trimmed
 * because Excel exports carry trailing spaces.
 */
ipcMain.handle("mailmerge:open-data-source", async (e) => {
  const win = windowFor(e.sender.id);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [CSV_FILTER],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const file = result.filePaths[0];
  // "utf8" strips nothing; papaparse's own BOM handling does, and the decode
  // has to see the BOM for that to fire.
  const text = await readFile(file, "utf8");
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const headers = (parsed.meta.fields ?? []).filter((h) => h.length > 0);
  // A row is one record; a value papaparse did not fill (a short row) becomes
  // "" rather than undefined, so a column named by the header is always
  // PRESENT — which is what makes the engine's empty-column rendering (and its
  // \b / \f suppression) apply instead of the unbound-column placeholder.
  const records = parsed.data.map((row) => {
    const record: Record<string, string> = {};
    for (const h of headers) record[h] = row[h] ?? "";
    return record;
  });
  return { path: file, name: path.basename(file), headers, records };
});

ipcMain.on("document:set-dirty", (e, dirty: boolean) => {
  const st = docs.get(e.sender.id);
  const win = windowFor(e.sender.id);
  if (!st || !win) return;
  if (st.dirty === dirty) return;
  st.dirty = dirty;
  win.setDocumentEdited(dirty);
  // File > Revert to Saved is enabled only while there is something to revert.
  rebuildMenu();
});

let pendingOpenPaths: string[] = [];

app.on("open-file", (e, p) => {
  e.preventDefault();
  if (app.isReady()) {
    void openDocument(p);
  } else {
    pendingOpenPaths.push(p);
  }
});

app.whenReady().then(async () => {
  // A test run launches and exits the app dozens of times. Hidden windows are
  // not enough: every launch still bounces an icon into the Dock and steals
  // the space, which is unusable for anyone working at the machine. Leave the
  // Dock alone entirely while LIKEOFFICE_HIDE_WINDOWS is set.
  if (process.env.LIKEOFFICE_HIDE_WINDOWS) app.dock?.hide();
  // A packaged build gets its icon from the bundle; an unpackaged one shows
  // Electron's until it is told otherwise.
  if (!app.isPackaged && !process.env.LIKEOFFICE_HIDE_WINDOWS) {
    const icon = path.join(app.getAppPath(), "build/icon.png");
    try {
      app.dock?.setIcon(icon);
    } catch {
      // A missing icon is not a reason to fail startup.
    }
  }
  app.setAboutPanelOptions({
    applicationName: "LikeOffice",
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 LikeOffice contributors",
  });
  await Promise.all([loadRecent(), loadMenuState()]);
  rebuildMenu();
  const argPaths = process.argv.slice(1).filter((a) => a.endsWith(".docx"));
  const toOpen = [...pendingOpenPaths, ...argPaths];
  pendingOpenPaths = [];
  const recoveries = await listRecoveries();
  for (const r of recoveries) await createDocumentWindow({ recovery: r });
  if (toOpen.length > 0) {
    for (const p of toOpen) await openDocument(p);
  } else if (recoveries.length === 0) {
    await createDocumentWindow();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createDocumentWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
