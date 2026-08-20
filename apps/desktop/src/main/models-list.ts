import { ipcMain } from "electron";
import { activeConfig, isProviderId, PROVIDER_DEFAULTS, readSettings, type ProviderId } from "./settings";

/**
 * What models a provider actually offers.
 *
 * ASKED, NOT ASSERTED, wherever the provider will say. A hardcoded list goes
 * stale the week after it ships and, worse, hides the models a user is paying
 * for — OpenRouter alone carries hundreds, and an Ollama install carries
 * exactly what that machine has pulled. The static lists below are only the
 * fallback for a provider that cannot be reached or has no key yet, so the
 * picker is never empty.
 */

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelCatalogue {
  models: ModelOption[];
  /** Set when the live list could not be fetched; the UI shows it as a hint
   * rather than pretending the fallback list is the provider's catalogue. */
  error?: string;
  /** True when these came from the provider rather than the fallback. */
  live: boolean;
}

/** Last-resort lists. Anthropic publishes a models endpoint, but it needs a
 * key, and the picker has to offer something before one is entered. */
const FALLBACK = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  openai: ["gpt-5", "gpt-5-mini", "o4-mini"],
  openrouter: ["anthropic/claude-opus-5", "openai/gpt-5", "meta-llama/llama-3.1-70b-instruct"],
  ollama: ["llama3.1", "mistral", "qwen2.5"],
  custom: [],
  "claude-subscription": ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  // Codex runs whatever the CLI is configured with; the app does not choose.
  "codex-subscription": [],
} satisfies Record<ProviderId, string[]>;

function fallbackFor(id: ProviderId, note?: string): ModelCatalogue {
  return {
    models: FALLBACK[id].map((m) => ({ id: m, label: m })),
    live: false,
    ...(note ? { error: note } : {}),
  };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  // A provider that never answers must not hang the picker open.
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI, OpenRouter and any compatible gateway all answer /models with
 * `{data: [{id}]}`. Ollama's OpenAI-compatible surface does too. */
async function openAiStyleModels(baseUrl: string, apiKey: string): Promise<ModelOption[]> {
  const headers: Record<string, string> = {};
  if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
  const body = (await fetchJson(`${baseUrl.replace(/\/+$/, "")}/models`, headers)) as {
    data?: unknown;
  };
  // SAFETY: the shape below is a CLAIM about someone else's JSON. Only the leaf
  // types were checked before; the array itself was not, so a gateway answering
  // {"data": {}} threw "map is not a function" and surfaced as a raw TypeError.
  const rows: { id?: unknown; name?: unknown }[] = Array.isArray(body.data) ? body.data : [];
  return rows
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      label: typeof entry.name === "string" ? entry.name : typeof entry.id === "string" ? entry.id : "",
    }))
    .filter((entry) => entry.id !== "")
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function anthropicModels(apiKey: string): Promise<ModelOption[]> {
  const body = (await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  })) as { data?: unknown };
  // SAFETY: as above — the array is checked, then each field.
  const rows: { id?: unknown; display_name?: unknown }[] = Array.isArray(body.data) ? body.data : [];
  return rows
    .map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : "",
      label: typeof entry.display_name === "string" ? entry.display_name : String(entry.id ?? ""),
    }))
    .filter((entry) => entry.id !== "");
}

export async function listModels(id: ProviderId): Promise<ModelCatalogue> {
  const settings = await readSettings();
  const config = settings.providers[id];
  const baseUrl = config.baseUrl || PROVIDER_DEFAULTS[id].baseUrl;
  try {
    if (id === "anthropic") {
      if (!config.apiKey) return fallbackFor(id, "Add a key to list the models on your account.");
      return { models: await anthropicModels(config.apiKey), live: true };
    }
    if (id === "openai" || id === "openrouter" || id === "custom") {
      if (!baseUrl) return fallbackFor(id, "Set a base URL first.");
      if (!config.apiKey && id !== "custom") {
        return fallbackFor(id, "Add a key to list the models on your account.");
      }
      return { models: await openAiStyleModels(baseUrl, config.apiKey), live: true };
    }
    if (id === "ollama") {
      // No key, and an unreachable server is the normal state when Ollama is
      // not running — reported as a hint, not an error the user must clear.
      return { models: await openAiStyleModels(baseUrl, ""), live: true };
    }
  } catch (error) {
    return fallbackFor(id, error instanceof Error ? error.message : String(error));
  }
  // The CLI-driven providers: the catalogue is whatever the CLI supports.
  return fallbackFor(id);
}

ipcMain.handle("models:list", async (_e, id?: unknown) => {
  // The argument is whatever the renderer sent. An unrecognised id used to
  // index straight into the provider map and TypeError on undefined.
  const target = isProviderId(id) ? id : activeConfig(await readSettings()).id;
  return listModels(target);
});
