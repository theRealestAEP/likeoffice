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

interface SettingsView {
  hasKey: boolean;
  model: string;
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
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
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
  setSettings(apiKey: string | null, model: string): Promise<SettingsView>;
  sendModelMessage(request: ModelRequest): Promise<ModelReply>;
}

interface Window {
  likeoffice: LikeOfficeBridge;
}
