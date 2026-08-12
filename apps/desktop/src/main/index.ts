import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadMenuState, rebuildMenu } from "./menu";
import { addRecent, loadRecent } from "./recent";
import "./settings";
import "./profiles";
import "./spellcheck";
import "./model";
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
}

const docs = new Map<number, DocState>();

/**
 * The document window the menu describes. Menu items are enabled from it, and
 * `BrowserWindow.getFocusedWindow()` is null whenever the app is not frontmost
 * — including right after a window is created — so the last window to be
 * created or focused stands in.
 */
let activeDocId: number | null = null;

if (process.env.LIKEOFFICE_USER_DATA) {
  app.setPath("userData", process.env.LIKEOFFICE_USER_DATA);
}

const DOCX_FILTER = { name: "Word Document", extensions: ["docx"] };

function autosaveDir(): string {
  return path.join(app.getPath("userData"), "autosave");
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

/** Open a file in a window and record it in Open Recent. */
export async function openDocument(filePath: string): Promise<void> {
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

ipcMain.on("document:autosave", async (e, bytes: Uint8Array) => {
  const st = docs.get(e.sender.id);
  if (!st) return;
  await mkdir(autosaveDir(), { recursive: true });
  await writeFile(st.autosaveFile, bytes);
  await writeFile(
    `${st.autosaveFile}.json`,
    JSON.stringify({ originalPath: st.path, savedAt: new Date().toISOString() }),
  );
});

ipcMain.handle(
  "document:save",
  async (e, bytes: Uint8Array, saveAs: boolean) => {
    const st = docs.get(e.sender.id);
    const win = windowFor(e.sender.id);
    if (!st || !win) return null;

    let target = st.path;
    if (!target || saveAs) {
      const result = await dialog.showSaveDialog(win, {
        defaultPath: st.path ?? st.suggestedName,
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
    await rename(tmp, target);

    st.path = target;
    st.dirty = false;
    st.recovered = false;
    st.seed = null;
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
  const printWin = new BrowserWindow({ show: false });
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
    printWin.destroy();
    await rm(htmlFile, { force: true });
  }
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
