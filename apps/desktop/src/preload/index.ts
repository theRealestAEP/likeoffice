import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
  recovered: boolean;
}

export interface SaveResult {
  path: string;
  name: string;
}

const api = {
  getInitialDocument: (): Promise<InitialDocument> =>
    ipcRenderer.invoke("document:init"),
  saveDocument: (bytes: Uint8Array, saveAs: boolean): Promise<SaveResult | null> =>
    ipcRenderer.invoke("document:save", bytes, saveAs),
  setDirty: (dirty: boolean): void => {
    ipcRenderer.send("document:set-dirty", dirty);
  },
  autosave: (bytes: Uint8Array): void => {
    ipcRenderer.send("document:autosave", bytes);
  },
  exportPdf: (html: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("document:export-pdf", html),
  onMenu: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: string) => cb(action);
    ipcRenderer.on("menu", listener);
    return () => {
      ipcRenderer.removeListener("menu", listener);
    };
  },
};

export type LikeOfficeBridge = typeof api;

contextBridge.exposeInMainWorld("likeoffice", api);
