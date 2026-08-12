import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
  /** Recovered or duplicated content that is not on disk yet. */
  dirty: boolean;
}

export interface SaveResult {
  path: string;
  name: string;
}

export interface SettingsView {
  provider: string;
  hasKey: boolean;
  model: string;
  spellLanguage: string;
}

export type SpellMenuAction = { type: "replace"; text: string } | { type: "add-word" };

/** One application menu's accelerators, for the engine's shortcuts sheet. */
export interface MenuShortcutSection {
  title: string;
  items: { label: string; keys: string }[];
}

export interface Profile {
  id: string;
  name: string;
  emoji: string;
  description: string;
  disclaimer: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
  builtIn: boolean;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: string;
}

const api = {
  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke("settings:get"),
  setSettings: (
    apiKey: string | null,
    model: string,
    provider: string,
    spellLanguage: string,
  ): Promise<SettingsView> =>
    ipcRenderer.invoke("settings:set", apiKey, model, provider, spellLanguage),
  getProfiles: (): Promise<ProfilesState> => ipcRenderer.invoke("profiles:list"),
  createProfile: (name: string, emoji: string, instructions: string): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:create", name, emoji, instructions),
  updateProfile: (
    id: string,
    name: string,
    emoji: string,
    instructions: string,
  ): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:update", id, name, emoji, instructions),
  deleteProfile: (id: string): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:delete", id),
  duplicateProfile: (id: string): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:duplicate", id),
  setActiveProfile: (id: string): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:set-active", id),
  restoreBuiltInProfiles: (): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:restore-built-ins"),
  onProfilesChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("profiles:changed", listener);
    return () => {
      ipcRenderer.removeListener("profiles:changed", listener);
    };
  },
  spellCheck: (words: string[]): Promise<string[]> => ipcRenderer.invoke("spell:check", words),
  spellSuggest: (word: string): Promise<string[]> => ipcRenderer.invoke("spell:suggest", word),
  spellAddWord: (word: string): Promise<void> => ipcRenderer.invoke("spell:add-word", word),
  spellMenu: (
    word: string,
    suggestions: string[],
    x: number,
    y: number,
  ): Promise<SpellMenuAction | null> => ipcRenderer.invoke("spell:menu", word, suggestions, x, y),
  onSpellChanged: (cb: () => void): (() => void) => {
    const listener = () => cb();
    ipcRenderer.on("spell:changed", listener);
    return () => {
      ipcRenderer.removeListener("spell:changed", listener);
    };
  },
  getProviderStatus: (): Promise<unknown> => ipcRenderer.invoke("providers:status"),
  runAgent: (request: unknown): Promise<unknown> => ipcRenderer.invoke("agent:run", request),
  cancelAgent: (): void => {
    ipcRenderer.send("agent:cancel");
  },
  sendAgentToolResult: (result: {
    callId: string;
    content: string;
    isError: boolean;
  }): void => {
    ipcRenderer.send("agent:tool-result", result);
  },
  onAgentEvent: (
    cb: (event: { sessionId: string; type: string; text?: string }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      event: { sessionId: string; type: string; text?: string },
    ) => cb(event);
    ipcRenderer.on("agent:event", listener);
    return () => {
      ipcRenderer.removeListener("agent:event", listener);
    };
  },
  onAgentToolCall: (
    cb: (call: { sessionId: string; callId: string; name: string; input: unknown }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      call: { sessionId: string; callId: string; name: string; input: unknown },
    ) => cb(call);
    ipcRenderer.on("agent:tool-call", listener);
    return () => {
      ipcRenderer.removeListener("agent:tool-call", listener);
    };
  },
  sendModelMessage: (request: unknown): Promise<unknown> =>
    ipcRenderer.invoke("model:message", request),
  onModelDelta: (cb: (delta: { requestId: string; text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, delta: { requestId: string; text: string }) =>
      cb(delta);
    ipcRenderer.on("model:delta", listener);
    return () => {
      ipcRenderer.removeListener("model:delta", listener);
    };
  },
  getInitialDocument: (): Promise<InitialDocument> =>
    ipcRenderer.invoke("document:init"),
  saveDocument: (bytes: Uint8Array, saveAs: boolean): Promise<SaveResult | null> =>
    ipcRenderer.invoke("document:save", bytes, saveAs),
  duplicateDocument: (bytes: Uint8Array): Promise<void> =>
    ipcRenderer.invoke("document:duplicate", bytes),
  revertDocument: (): Promise<InitialDocument | null> =>
    ipcRenderer.invoke("document:revert"),
  saveCopy: (bytes: Uint8Array): Promise<SaveResult | null> =>
    ipcRenderer.invoke("document:save-copy", bytes),
  setDirty: (dirty: boolean): void => {
    ipcRenderer.send("document:set-dirty", dirty);
  },
  autosave: (bytes: Uint8Array): void => {
    ipcRenderer.send("document:autosave", bytes);
  },
  exportPdf: (html: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("document:export-pdf", html),
  getMenuShortcuts: (): Promise<MenuShortcutSection[]> => ipcRenderer.invoke("menu:shortcuts"),
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
