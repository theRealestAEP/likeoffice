interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
  /** Recovered or duplicated content that is not on disk yet. */
  dirty: boolean;
}

interface SaveResult {
  path: string;
  name: string;
}

/** A parsed mail-merge data source (the host parses the CSV; see main/index.ts). */
interface MergeDataSource {
  path: string;
  name: string;
  /** Column names from the header row, trimmed, in file order. */
  headers: string[];
  /** One entry per data row, every header present (empty where the row is). */
  records: Record<string, string>[];
}

type Provider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "custom"
  | "claude-subscription"
  | "codex-subscription";

interface ProviderView {
  id: Provider;
  label: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  /** False for the CLI-driven providers, which take no key of their own. */
  keyed: boolean;
}

type WebSearchBackend = "direct" | "searxng" | "brave" | "tavily" | "exa";

interface WebSettingsView {
  backend: WebSearchBackend;
  searxngUrl: string;
  hasKey: boolean;
  enabled: boolean;
}

interface StorageSettings {
  autosave: boolean;
  autosaveSeconds: number;
  projectsDir: string;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  /** Files kept beside a newer copy rather than overwritten. */
  conflicts: string[];
  errors: string[];
  /** Set when sync is off or not configured; not an error. */
  skipped?: string;
}

interface S3SettingsView {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: "";
  hasSecret: boolean;
}

interface SettingsView {
  provider: Provider;
  providers: ProviderView[];
  spellLanguage: string;
  web: WebSettingsView;
  storage: StorageSettings;
  s3: S3SettingsView;
  /** The ACTIVE provider's key state and model, flat for callers that only ask
   * "can this app talk to a model right now?". */
  hasKey: boolean;
  model: string;
}

/** A partial settings write. A null apiKey means "leave the stored one alone". */
interface SettingsPatch {
  provider?: Provider;
  spellLanguage?: string;
  providers?: Partial<Record<Provider, { apiKey?: string | null; baseUrl?: string; model?: string }>>;
  web?: { backend?: WebSearchBackend; searxngUrl?: string; apiKey?: string | null; enabled?: boolean };
  storage?: Partial<StorageSettings>;
  s3?: Partial<Omit<S3SettingsView, "secretAccessKey" | "hasSecret">> & { secretAccessKey?: string | null };
}

interface ModelOption {
  id: string;
  label: string;
}

interface ModelCatalogue {
  models: ModelOption[];
  /** Why the live list could not be fetched; the fallback is showing. */
  error?: string;
  live: boolean;
}

type SpellMenuAction = { type: "replace"; text: string } | { type: "add-word" };

/** One application menu's accelerators, for the engine's shortcuts sheet. */
interface MenuShortcutSection {
  title: string;
  items: { label: string; keys: string }[];
}

interface Profile {
  id: string;
  name: string;
  emoji: string;
  /** One line for the picker. */
  description: string;
  /** The manage dialog's note on the source a built-in applies, and on the
   * app's lack of affiliation with it. "" where it names nobody. */
  disclaimer: string;
  instructions: string;
  createdAt: string;
  updatedAt: string;
  builtIn: boolean;
}

/** A profile the app ships but keeps off the picker until the user adds it. */
interface ExtraProfile {
  id: string;
  name: string;
  emoji: string;
  description: string;
}

interface ProfilesState {
  profiles: Profile[];
  /** "" means no profile: the base system prompt alone. */
  activeId: string;
  /** The shipped extras the user has not added yet. */
  extras: ExtraProfile[];
}

interface CliStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
}

interface ProviderStatus {
  claude: CliStatus;
  codex: CliStatus;
}

interface AgentRunRequest {
  sessionId: string;
  system: string;
  prompt: string;
  tools: ModelToolDefinition[];
}

interface AgentEvent {
  sessionId: string;
  type: "delta" | "assistant";
  text?: string;
}

interface AgentToolCall {
  sessionId: string;
  callId: string;
  name: string;
  input: unknown;
}

interface ModelToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ModelText {
  type: "text";
  text: string;
}

type ModelContentBlock = ModelToolUse | ModelText | { type: string };

interface ModelToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelContentBlock[] | ModelToolResult[];
}

interface ModelToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ModelRequest {
  requestId: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
}

interface ModelDelta {
  requestId: string;
  text: string;
}

type ModelReply =
  | { content: ModelContentBlock[]; stopReason: string | null; error?: undefined }
  | { error: string; content?: undefined };

interface LikeOfficeBridge {
  getInitialDocument(): Promise<InitialDocument>;
  saveDocument(bytes: Uint8Array, saveAs: boolean): Promise<SaveResult | null>;
  duplicateDocument(bytes: Uint8Array): Promise<void>;
  revertDocument(): Promise<InitialDocument | null>;
  saveCopy(bytes: Uint8Array): Promise<SaveResult | null>;
  setDirty(dirty: boolean): void;
  /** Write the recovery copy, and the document's own file when autosave is on.
   * Resolves with the time the real file was written, or null. */
  autosave(bytes: Uint8Array): Promise<string | null>;
  chooseProjectsDir(): Promise<string | null>;
  /** Write one merged document per record; asks for a folder. Null if cancelled. */
  writeMergedDocuments(
    files: { name: string; bytes: Uint8Array }[],
  ): Promise<{ dir: string; written: number } | null>;
  /** Mirror the projects folder to the configured bucket, once. */
  syncBucket(): Promise<SyncResult>;
  /** Fires when the open file is modified outside this app. */
  onExternalChange(cb: () => void): () => void;
  exportPdf(html: string): Promise<{ path: string } | null>;
  getMenuShortcuts(): Promise<MenuShortcutSection[]>;
  onMenu(cb: (action: string) => void): () => void;
  getSettings(): Promise<SettingsView>;
  setSettings(patch: SettingsPatch): Promise<SettingsView>;
  /** The models a provider actually offers, asked of the provider itself.
   * Defaults to the active one. */
  listModels(provider?: Provider): Promise<ModelCatalogue>;
  /** Agent web tools. Both run in the main process — see main/web-tools.ts. */
  webSearch(query: string): Promise<{ results: WebSearchResult[] } | { error: string }>;
  webFetch(
    url: string,
  ): Promise<{ url: string; title: string; text: string; truncated: boolean } | { error: string }>;
  getProfiles(): Promise<ProfilesState>;
  createProfile(name: string, emoji: string, instructions: string): Promise<ProfilesState>;
  updateProfile(
    id: string,
    name: string,
    emoji: string,
    instructions: string,
  ): Promise<ProfilesState>;
  addExtraProfile(id: string): Promise<ProfilesState>;
  deleteProfile(id: string): Promise<ProfilesState>;
  duplicateProfile(id: string): Promise<ProfilesState>;
  setActiveProfile(id: string): Promise<ProfilesState>;
  restoreBuiltInProfiles(): Promise<ProfilesState>;
  onProfilesChanged(cb: () => void): () => void;
  spellCheck(words: string[]): Promise<string[]>;
  spellSuggest(word: string): Promise<string[]>;
  spellAddWord(word: string): Promise<void>;
  spellMenu(
    word: string,
    suggestions: string[],
    x: number,
    y: number,
  ): Promise<SpellMenuAction | null>;
  onSpellChanged(cb: () => void): () => void;
  getProviderStatus(): Promise<ProviderStatus>;
  sendModelMessage(request: ModelRequest): Promise<ModelReply>;
  onModelDelta(cb: (delta: ModelDelta) => void): () => void;
  runAgent(request: AgentRunRequest): Promise<{ error?: string }>;
  cancelAgent(): void;
  sendAgentToolResult(result: { callId: string; content: string; isError: boolean }): void;
  onAgentEvent(cb: (event: AgentEvent) => void): () => void;
  onAgentToolCall(cb: (call: AgentToolCall) => void): () => void;
  openMergeDataSource(): Promise<MergeDataSource | null>;
}

interface Window {
  likeoffice: LikeOfficeBridge;
}
