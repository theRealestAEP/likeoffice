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

/** A parsed mail-merge data source. Plain strings: the renderer and the engine
 * never see the file path as anything but a label. */
export interface MergeDataSource {
  path: string;
  name: string;
  /** Column names from the header row, trimmed, in file order. */
  headers: string[];
  /** One entry per data row, every header present (empty where the row is). */
  records: Record<string, string>[];
}

export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "custom"
  | "claude-subscription"
  | "codex-subscription";

export interface ProviderView {
  id: ProviderId;
  label: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  keyed: boolean;
}

export type WebSearchBackend = "direct" | "searxng" | "brave" | "tavily" | "exa";

export interface WebSettingsView {
  backend: WebSearchBackend;
  searxngUrl: string;
  hasKey: boolean;
  enabled: boolean;
}

export interface StorageSettings {
  autosave: boolean;
  autosaveSeconds: number;
  projectsDir: string;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  /** Files kept beside a newer copy rather than overwritten. */
  conflicts: string[];
  errors: string[];
  /** Set when sync is off or not configured; not an error. */
  skipped?: string;
}

export interface S3SettingsView {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: "";
  hasSecret: boolean;
}

export interface SettingsView {
  provider: ProviderId;
  providers: ProviderView[];
  spellLanguage: string;
  web: WebSettingsView;
  storage: StorageSettings;
  s3: S3SettingsView;
  hasKey: boolean;
  model: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A partial settings write. A null apiKey means "leave the stored one alone",
 * which is what an untouched password field sends — the renderer never
 * received the current key, so it has none to send back. */
export interface SettingsPatch {
  provider?: ProviderId;
  spellLanguage?: string;
  providers?: Partial<Record<ProviderId, { apiKey?: string | null; baseUrl?: string; model?: string }>>;
  web?: { backend?: WebSearchBackend; searxngUrl?: string; apiKey?: string | null; enabled?: boolean };
  storage?: Partial<StorageSettings>;
  s3?: Partial<Omit<S3SettingsView, "secretAccessKey" | "hasSecret">> & { secretAccessKey?: string | null };
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelCatalogue {
  models: ModelOption[];
  error?: string;
  live: boolean;
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

export interface ExtraProfile {
  id: string;
  name: string;
  emoji: string;
  description: string;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: string;
  extras: ExtraProfile[];
}

const api = {
  getSettings: (): Promise<SettingsView> => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: SettingsPatch): Promise<SettingsView> =>
    ipcRenderer.invoke("settings:set", patch),
  listModels: (provider?: ProviderId): Promise<ModelCatalogue> =>
    ipcRenderer.invoke("models:list", provider),
  webSearch: (query: string): Promise<{ results: WebSearchResult[] } | { error: string }> =>
    ipcRenderer.invoke("web:search", query),
  webFetch: (
    url: string,
  ): Promise<{ url: string; title: string; text: string; truncated: boolean } | { error: string }> =>
    ipcRenderer.invoke("web:fetch", url),
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
  addExtraProfile: (id: string): Promise<ProfilesState> =>
    ipcRenderer.invoke("profiles:add-extra", id),
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
  autosave: (bytes: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke("document:autosave", bytes),
  chooseProjectsDir: (): Promise<string | null> =>
    ipcRenderer.invoke("storage:choose-projects-dir"),
  syncBucket: (): Promise<SyncResult> => ipcRenderer.invoke("s3:sync"),
  writeMergedDocuments: (
    files: { name: string; bytes: Uint8Array }[],
  ): Promise<{ dir: string; written: number } | null> => ipcRenderer.invoke("merge:write", files),
  onExternalChange: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("document:external-change", listener);
    return () => {
      ipcRenderer.removeListener("document:external-change", listener);
    };
  },
  exportPdf: (html: string): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("document:export-pdf", html),
  openMergeDataSource: (): Promise<MergeDataSource | null> =>
    ipcRenderer.invoke("mailmerge:open-data-source"),
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
