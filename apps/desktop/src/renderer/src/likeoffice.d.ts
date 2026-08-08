interface InitialDocument {
  path: string | null;
  name: string;
  bytes: Uint8Array;
  recovered: boolean;
}

interface SaveResult {
  path: string;
  name: string;
}

type Provider = "anthropic-api" | "claude-subscription" | "codex-subscription";

interface SettingsView {
  provider: Provider;
  hasKey: boolean;
  model: string;
  spellLanguage: string;
}

type SpellMenuAction = { type: "replace"; text: string } | { type: "add-word" };

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
  setDirty(dirty: boolean): void;
  autosave(bytes: Uint8Array): void;
  exportPdf(html: string): Promise<{ path: string } | null>;
  onMenu(cb: (action: string) => void): () => void;
  getSettings(): Promise<SettingsView>;
  setSettings(
    apiKey: string | null,
    model: string,
    provider: Provider,
    spellLanguage: string,
  ): Promise<SettingsView>;
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
}

interface Window {
  likeoffice: LikeOfficeBridge;
}
