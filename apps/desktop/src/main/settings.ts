import { app, ipcMain, safeStorage } from "electron";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Every model source LikeOffice can talk to.
 *
 * The first five are API-key providers the app calls directly. The two
 * `*-subscription` entries drive an installed CLI instead (Claude Code, Codex)
 * and carry no key of their own — they are kept because they already work, not
 * because they are the recommended path.
 */
export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "ollama"
  | "custom"
  | "claude-subscription"
  | "codex-subscription";

/** "system" follows the OS locale; "off" disables spellcheck. */
export type SpellLanguage = "system" | "en-US" | "off";

/** Where the agent's web_search tool sends queries. "searxng" is the default
 * because it is the only one that needs no account: the user runs the instance.
 * The rest are hosted APIs that take a key. */
export type WebSearchBackend = "direct" | "searxng" | "brave" | "tavily" | "exa";

export interface WebSettings {
  backend: WebSearchBackend;
  /** Base URL of the SearXNG instance, e.g. http://localhost:8080. */
  searxngUrl: string;
  /** Key for the hosted backends. Never sent to the renderer. */
  apiKey: string;
  /** Whether the agent is offered the web tools at all. */
  enabled: boolean;
}

const WEB_BACKENDS: WebSearchBackend[] = ["direct", "searxng", "brave", "tavily", "exa"];

/**
 * Autosave and where documents live.
 *
 * Autosave has always existed as a RECOVERY copy in userData — invisible, and
 * only ever read after a crash. What it never did is write the user's own file,
 * so a document edited for an hour without Cmd+S was still stale on disk. These
 * settings turn it into the thing people mean by autosave, and leave the
 * recovery copy underneath it for the case it was written for.
 */
export interface StorageSettings {
  /** Write the document's own file on the interval. Off keeps recovery only. */
  autosave: boolean;
  /** Seconds between autosaves. Floor of 5 so a typo cannot make it a spinner. */
  autosaveSeconds: number;
  /** Where Save opens for a document that has no path yet. "" = the OS default. */
  projectsDir: string;
}

const DEFAULT_STORAGE: StorageSettings = { autosave: true, autosaveSeconds: 30, projectsDir: "" };

/** An S3-compatible bucket the projects folder mirrors to. Any provider: AWS,
 * Cloudflare R2, Backblaze B2, MinIO, Wasabi. */
export interface S3Settings {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  /** Sealed like the model keys; never crosses to the renderer. */
  secretAccessKey: string;
}

const DEFAULT_S3: S3Settings = {
  enabled: false,
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
};
const DEFAULT_WEB: WebSettings = {
  backend: "direct",
  searxngUrl: "http://localhost:8080",
  apiKey: "",
  enabled: true,
};

/** What one provider needs to be usable. Unused fields stay empty rather than
 * absent, so a provider the user has not configured still round-trips. */
export interface ProviderConfig {
  apiKey: string;
  /** Only for providers whose endpoint is not fixed (ollama, custom). */
  baseUrl: string;
  /** The model last chosen FOR THIS PROVIDER. Kept per provider so switching
   * back and forth does not silently point one provider at another's model. */
  model: string;
}

export interface Settings {
  provider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  spellLanguage: SpellLanguage;
  web: WebSettings;
  storage: StorageSettings;
  s3: S3Settings;
}

export const DEFAULT_MODEL = "claude-opus-5";

/** Per-provider defaults: the endpoint when it is fixed by the vendor, and a
 * sensible starting model. The model is only a starting point — the picker
 * lists what the provider actually reports. */
export const PROVIDER_DEFAULTS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: DEFAULT_MODEL, label: "Anthropic" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5", label: "OpenAI" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-opus-5", label: "OpenRouter" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "llama3.1", label: "Ollama (local)" },
  custom: { baseUrl: "", model: "", label: "Custom (OpenAI-compatible)" },
  "claude-subscription": { baseUrl: "", model: DEFAULT_MODEL, label: "Claude subscription (Claude Code)" },
  "codex-subscription": { baseUrl: "", model: "", label: "ChatGPT subscription (Codex)" },
  // `satisfies`, not an annotation: the exhaustiveness check stays and the
  // literal types survive for everything that reads a label or a default.
} satisfies Record<ProviderId, { baseUrl: string; model: string; label: string }>;

export const PROVIDER_IDS = Object.keys(PROVIDER_DEFAULTS) as ProviderId[];
/** A narrowing check, so callers stop asserting what they can test. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}
/** Providers the app calls itself, as opposed to driving a CLI. */
export const KEYED_PROVIDERS: ProviderId[] = ["anthropic", "openai", "openrouter", "ollama", "custom"];
/** Providers that speak the OpenAI chat-completions wire format. */
export const OPENAI_COMPATIBLE: ProviderId[] = ["openai", "openrouter", "ollama", "custom"];

const SPELL_LANGUAGES: SpellLanguage[] = ["system", "en-US", "off"];

/** Emits "changed" with the new Settings after every write. */
export const settingsEvents = new EventEmitter();

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** A key from the environment or a .env file near the app, so `ANTHROPIC=…`
 * or `ANTHROPIC_API_KEY=…` works without opening Settings. Settings wins. */
async function envApiKey(): Promise<string> {
  // An empty value is an explicit "no key": it stops the .env lookup so the
  // e2e no-key test stays hermetic when a developer keeps a key in .env.
  const fromEnv = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC;
  if (fromEnv !== undefined) return fromEnv;
  const roots = [app.getAppPath(), path.dirname(app.getAppPath()), path.dirname(path.dirname(app.getAppPath()))];
  for (const root of roots) {
    try {
      const text = await readFile(path.join(root, ".env"), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?(ANTHROPIC(?:_API_KEY)?)\s*=\s*"?([^"\s#]+)"?/);
        if (m) return m[2];
      }
    } catch {
      // no .env at this level
    }
  }
  return "";
}


/**
 * API keys at rest.
 *
 * Every provider key and the web-search key used to sit in settings.json as
 * plain JSON — readable by anything running as the user, and by anything that
 * later reads a synced or backed-up copy of that file. They are now sealed with
 * Electron's safeStorage, which is the OS keychain (Keychain on macOS, libsecret
 * or kwallet on Linux, DPAPI on Windows).
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO:
 *
 * It does not fail closed when the platform has no keyring. A Linux box without
 * libsecret would otherwise be unable to store a key at all; the value is kept
 * as it was and the app keeps working, which is the same exposure as before and
 * strictly better than refusing to run.
 *
 * It does not require a migration step. A key written by an older build is a
 * bare string and is read as one; it is sealed the next time settings are
 * saved. Nobody has to re-enter anything.
 */
const SEAL_PREFIX = "enc:v1:";

function sealSecret(value: string): string {
  if (value === "" || value.startsWith(SEAL_PREFIX)) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return SEAL_PREFIX + safeStorage.encryptString(value).toString("base64");
  } catch {
    return value;
  }
}

function openSecret(value: string): string {
  if (!value.startsWith(SEAL_PREFIX)) return value; // pre-safeStorage, or unsealed
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SEAL_PREFIX.length), "base64"));
  } catch {
    // A keychain entry the OS will not hand back (restored to another machine,
    // or a reset login keyring). Report it as absent so the settings page says
    // "no key" and the user can paste a new one, rather than sending gibberish
    // to a provider and showing them a 401.
    return "";
  }
}

function blankProviders(): Record<ProviderId, ProviderConfig> {
  const out = {} as Record<ProviderId, ProviderConfig>;
  for (const id of PROVIDER_IDS) {
    out[id] = { apiKey: "", baseUrl: PROVIDER_DEFAULTS[id].baseUrl, model: PROVIDER_DEFAULTS[id].model };
  }
  return out;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Read settings, accepting BOTH the current shape and the flat one that
 * shipped first ({provider: "anthropic-api", apiKey, model}).
 *
 * Migration is a read-time concern, not a one-shot upgrade step: the old file
 * stays readable, and it is only rewritten in the new shape when the user next
 * saves. Nobody loses their key by opening a build and closing it again.
 */
export async function readSettings(): Promise<Settings> {
  const providers = blankProviders();
  let provider: ProviderId = "anthropic";
  let spellLanguage: SpellLanguage = "system";
  let web: WebSettings = { ...DEFAULT_WEB };
  let storage: StorageSettings = { ...DEFAULT_STORAGE };
  let s3: S3Settings = { ...DEFAULT_S3 };
  try {
    const raw = JSON.parse(await readFile(settingsFile(), "utf8"));
    if (SPELL_LANGUAGES.includes(raw.spellLanguage)) spellLanguage = raw.spellLanguage;
    if (raw.storage && typeof raw.storage === "object") {
      storage = {
        autosave: typeof raw.storage.autosave === "boolean" ? raw.storage.autosave : DEFAULT_STORAGE.autosave,
        autosaveSeconds: Math.max(5, Number(raw.storage.autosaveSeconds) || DEFAULT_STORAGE.autosaveSeconds),
        projectsDir: str(raw.storage.projectsDir, ""),
      };
    }
    if (raw.s3 && typeof raw.s3 === "object") {
      s3 = {
        enabled: typeof raw.s3.enabled === "boolean" ? raw.s3.enabled : false,
        endpoint: str(raw.s3.endpoint, ""),
        region: str(raw.s3.region, DEFAULT_S3.region),
        bucket: str(raw.s3.bucket, ""),
        prefix: str(raw.s3.prefix, ""),
        accessKeyId: str(raw.s3.accessKeyId, ""),
        secretAccessKey: openSecret(str(raw.s3.secretAccessKey, "")),
      };
    }
    if (raw.web && typeof raw.web === "object") {
      web = {
        backend: WEB_BACKENDS.includes(raw.web.backend) ? raw.web.backend : DEFAULT_WEB.backend,
        searxngUrl: str(raw.web.searxngUrl, DEFAULT_WEB.searxngUrl),
        apiKey: openSecret(str(raw.web.apiKey, "")),
        enabled: typeof raw.web.enabled === "boolean" ? raw.web.enabled : DEFAULT_WEB.enabled,
      };
    }
    // Legacy name for what is now simply "anthropic".
    const named = raw.provider === "anthropic-api" ? "anthropic" : raw.provider;
    if (PROVIDER_IDS.includes(named)) provider = named;
    if (raw.providers && typeof raw.providers === "object") {
      for (const id of PROVIDER_IDS) {
        const entry = raw.providers[id];
        if (!entry || typeof entry !== "object") continue;
        providers[id] = {
          apiKey: openSecret(str(entry.apiKey, "")),
          baseUrl: str(entry.baseUrl, PROVIDER_DEFAULTS[id].baseUrl),
          model: str(entry.model, PROVIDER_DEFAULTS[id].model),
        };
      }
    } else {
      // The flat legacy shape: one key and one model, both Anthropic's. The
      // model also seeds claude-subscription, which is the same catalogue.
      const legacyKey = openSecret(str(raw.apiKey, ""));
      const legacyModel = str(raw.model, DEFAULT_MODEL);
      providers.anthropic = { ...providers.anthropic, apiKey: legacyKey, model: legacyModel };
      providers["claude-subscription"] = { ...providers["claude-subscription"], model: legacyModel };
    }
  } catch {
    // No settings yet: defaults, plus whatever the environment offers below.
  }
  if (!providers.anthropic.apiKey) providers.anthropic.apiKey = await envApiKey();
  return { provider, providers, spellLanguage, web, storage, s3 };
}

/** The active provider's configuration, with vendor defaults filled in for
 * anything the user left blank. */
export function activeConfig(settings: Settings): ProviderConfig & { id: ProviderId } {
  const config = settings.providers[settings.provider];
  const defaults = PROVIDER_DEFAULTS[settings.provider];
  return {
    id: settings.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || defaults.baseUrl,
    model: config.model || defaults.model,
  };
}

/**
 * What the renderer is allowed to see. KEYS NEVER CROSS: the settings page
 * learns only whether each provider has one, which is all it needs to render
 * "a key is saved" versus "add a key".
 */
export interface ProviderView {
  id: ProviderId;
  label: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  /** False for the CLI-driven providers, which take no key of their own. */
  keyed: boolean;
}

export interface WebSettingsView {
  backend: WebSearchBackend;
  searxngUrl: string;
  hasKey: boolean;
  enabled: boolean;
}

export interface SettingsView {
  provider: ProviderId;
  providers: ProviderView[];
  spellLanguage: SpellLanguage;
  web: WebSettingsView;
  storage: StorageSettings;
  s3: Omit<S3Settings, "secretAccessKey"> & { secretAccessKey: ""; hasSecret: boolean };
  /** The active provider's key state, kept flat for the callers that only ask
   * "can this app talk to a model right now?". */
  hasKey: boolean;
  model: string;
}

export function toView(settings: Settings): SettingsView {
  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label: PROVIDER_DEFAULTS[id].label,
    hasKey: settings.providers[id].apiKey !== "",
    baseUrl: settings.providers[id].baseUrl,
    model: settings.providers[id].model,
    keyed: KEYED_PROVIDERS.includes(id),
  }));
  return {
    provider: settings.provider,
    providers,
    spellLanguage: settings.spellLanguage,
    web: {
      backend: settings.web.backend,
      searxngUrl: settings.web.searxngUrl,
      hasKey: settings.web.apiKey !== "",
      enabled: settings.web.enabled,
    },
    // No secrets here, so the storage block crosses whole.
    storage: settings.storage,
    // The secret key does NOT cross; the renderer only learns whether one is set.
    s3: { ...settings.s3, secretAccessKey: "", hasSecret: settings.s3.secretAccessKey !== "" },
    hasKey: settings.providers[settings.provider].apiKey !== "",
    model: activeConfig(settings).model,
  };
}

ipcMain.handle("settings:get", async () => toView(await readSettings()));

/** Write settings and announce them. Several surfaces change settings (the
 * settings page, the AI drawer's model picker, the Tools > Spelling menu), so
 * the write lives in one place. */
export async function saveSettings(next: Settings): Promise<void> {
  // Sealed on the way out only. Everything in memory stays plaintext so callers
  // do not each have to know how a key is stored.
  const onDisk: Settings = {
    ...next,
    providers: Object.fromEntries(
      Object.entries(next.providers).map(([id, config]) => [
        id,
        { ...config, apiKey: sealSecret(config.apiKey) },
      ]),
    ) as Record<ProviderId, ProviderConfig>,
    web: { ...next.web, apiKey: sealSecret(next.web.apiKey) },
    s3: { ...next.s3, secretAccessKey: sealSecret(next.s3.secretAccessKey) },
  };
  await writeFile(settingsFile(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  settingsEvents.emit("changed", next);
}

/**
 * A partial update. Every field is optional, and an omitted API key means
 * "leave the stored one alone" — the renderer sends null for an untouched
 * field precisely because it never received the current value to send back.
 */
export interface SettingsPatch {
  provider?: ProviderId;
  spellLanguage?: SpellLanguage;
  providers?: Partial<Record<ProviderId, { apiKey?: string | null; baseUrl?: string; model?: string }>>;
  web?: { backend?: WebSearchBackend; searxngUrl?: string; apiKey?: string | null; enabled?: boolean };
  storage?: Partial<StorageSettings>;
  s3?: Partial<Omit<S3Settings, "secretAccessKey">> & { secretAccessKey?: string | null };
}

/** Seconds, coerced. A non-number here reached `Math.max(5, NaN)` = NaN, which
 * the renderer passed to setInterval — and setInterval(NaN) means ZERO delay, so
 * the app autosaved ~800 times a second, serializing the whole document each
 * time, until it was restarted. */
function seconds(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(5, n) : fallback;
}

/**
 * Apply a partial update.
 *
 * EVERY FIELD IS COERCED, not trusted. `patch: SettingsPatch` is a claim the
 * type system makes about a value that arrived over IPC; the read path already
 * parses settings.json defensively, and the write path has exactly the same
 * standing. The enum fields were checked before this; the free ones — numbers,
 * strings, URLs — were not.
 */
export async function applyPatch(patch: SettingsPatch): Promise<Settings> {
  const current = await readSettings();
  const next: Settings = {
    provider: isProviderId(patch.provider) ? patch.provider : current.provider,
    spellLanguage:
      patch.spellLanguage && SPELL_LANGUAGES.includes(patch.spellLanguage)
        ? patch.spellLanguage
        : current.spellLanguage,
    providers: { ...current.providers },
    web: {
      backend:
        typeof patch.web?.backend === "string" && WEB_BACKENDS.includes(patch.web.backend)
          ? patch.web.backend
          : current.web.backend,
      searxngUrl: str(patch.web?.searxngUrl, current.web.searxngUrl),
      apiKey: typeof patch.web?.apiKey === "string" ? patch.web.apiKey : current.web.apiKey,
      enabled: typeof patch.web?.enabled === "boolean" ? patch.web.enabled : current.web.enabled,
    },
    storage: {
      autosave:
        typeof patch.storage?.autosave === "boolean" ? patch.storage.autosave : current.storage.autosave,
      autosaveSeconds:
        patch.storage?.autosaveSeconds === undefined
          ? current.storage.autosaveSeconds
          : seconds(patch.storage.autosaveSeconds, current.storage.autosaveSeconds),
      projectsDir: str(patch.storage?.projectsDir, current.storage.projectsDir),
    },
    s3: {
      enabled: typeof patch.s3?.enabled === "boolean" ? patch.s3.enabled : current.s3.enabled,
      endpoint: str(patch.s3?.endpoint, current.s3.endpoint),
      region: str(patch.s3?.region, current.s3.region),
      bucket: str(patch.s3?.bucket, current.s3.bucket),
      prefix: str(patch.s3?.prefix, current.s3.prefix),
      accessKeyId: str(patch.s3?.accessKeyId, current.s3.accessKeyId),
      secretAccessKey:
        typeof patch.s3?.secretAccessKey === "string"
          ? patch.s3.secretAccessKey
          : current.s3.secretAccessKey,
    },
  };
  for (const [id, entry] of Object.entries(patch.providers ?? {})) {
    if (!isProviderId(id) || !entry || typeof entry !== "object") continue;
    // A non-string key would crash sealSecret's .startsWith on the way to disk.
    next.providers[id] = {
      apiKey: typeof entry.apiKey === "string" ? entry.apiKey : current.providers[id].apiKey,
      baseUrl: str(entry.baseUrl, current.providers[id].baseUrl),
      model: str(entry.model, current.providers[id].model),
    };
  }
  await saveSettings(next);
  return next;
}

ipcMain.handle("settings:set", async (_e, patch: SettingsPatch | null) => toView(await applyPatch(patch ?? {})));
