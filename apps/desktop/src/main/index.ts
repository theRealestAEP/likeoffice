import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMenu } from "./menu";

interface DocState {
  path: string | null;
  dirty: boolean;
  pendingClose: boolean;
}

const docs = new Map<number, DocState>();

const DOCX_FILTER = { name: "Word Document", extensions: ["docx"] };

export async function createDocumentWindow(filePath?: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
    },
  });
  const id = win.webContents.id;
  docs.set(id, { path: filePath ?? null, dirty: false, pendingClose: false });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => docs.delete(id));
  win.on("close", (e) => {
    const st = docs.get(id);
    if (!st?.dirty) return;
    e.preventDefault();
    const name = st.path ? path.basename(st.path) : "Untitled";
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

export async function openDocumentDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [DOCX_FILTER],
  });
  for (const p of result.filePaths) {
    app.addRecentDocument(p);
    await createDocumentWindow(p);
  }
}

function windowFor(webContentsId: number): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((w) => w.webContents.id === webContentsId) ?? null
  );
}

ipcMain.handle("document:init", async (e) => {
  const st = docs.get(e.sender.id);
  if (st?.path) {
    const bytes = await readFile(st.path);
    return { path: st.path, name: path.basename(st.path), bytes };
  }
  const blank = await readFile(path.join(app.getAppPath(), "resources/blank.docx"));
  return { path: null, name: "Untitled", bytes: blank };
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
        defaultPath: st.path ?? "Untitled.docx",
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
    win.setDocumentEdited(false);
    app.addRecentDocument(target);
    if (st.pendingClose) {
      win.destroy();
      return null;
    }
    return { path: target, name: path.basename(target) };
  },
);

ipcMain.on("document:set-dirty", (e, dirty: boolean) => {
  const st = docs.get(e.sender.id);
  const win = windowFor(e.sender.id);
  if (!st || !win) return;
  st.dirty = dirty;
  win.setDocumentEdited(dirty);
});

let pendingOpenPaths: string[] = [];

app.on("open-file", (e, p) => {
  e.preventDefault();
  if (app.isReady()) {
    void createDocumentWindow(p);
  } else {
    pendingOpenPaths.push(p);
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());
  const argPaths = process.argv.slice(1).filter((a) => a.endsWith(".docx"));
  const toOpen = [...pendingOpenPaths, ...argPaths];
  pendingOpenPaths = [];
  if (toOpen.length > 0) {
    for (const p of toOpen) await createDocumentWindow(p);
  } else {
    await createDocumentWindow();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createDocumentWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
