import { app, ipcMain } from "electron";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type Provider = "anthropic-api" | "claude-subscription" | "codex-subscription";

/** "system" follows the OS locale; "off" disables spellcheck. */
export type SpellLanguage = "system" | "en-US" | "off";

export interface Settings {
  provider: Provider;
  apiKey: string;
  model: string;
  spellLanguage: SpellLanguage;
}

export const DEFAULT_MODEL = "claude-opus-5";

const PROVIDERS: Provider[] = ["anthropic-api", "claude-subscription", "codex-subscription"];
const SPELL_LANGUAGES: SpellLanguage[] = ["system", "en-US", "off"];

/** Emits "changed" with the new Settings after every settings:set. */
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

export async function readSettings(): Promise<Settings> {
  let settings: Settings;
  try {
    const raw = JSON.parse(await readFile(settingsFile(), "utf8"));
    settings = {
      provider: PROVIDERS.includes(raw.provider) ? raw.provider : "anthropic-api",
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      model: typeof raw.model === "string" ? raw.model : DEFAULT_MODEL,
      spellLanguage: SPELL_LANGUAGES.includes(raw.spellLanguage) ? raw.spellLanguage : "system",
    };
  } catch {
    settings = { provider: "anthropic-api", apiKey: "", model: DEFAULT_MODEL, spellLanguage: "system" };
  }
  if (!settings.apiKey) settings.apiKey = await envApiKey();
  return settings;
}

// The key never leaves the main process: the renderer only learns whether one
// is set, and sends null when the user leaves the field untouched.
ipcMain.handle("settings:get", async () => {
  const settings = await readSettings();
  return {
    provider: settings.provider,
    hasKey: settings.apiKey !== "",
    model: settings.model,
    spellLanguage: settings.spellLanguage,
  };
});

/** Write settings and announce them. The Settings dialog and the Tools >
 * Spelling menu both change settings, so the write lives in one place. */
export async function saveSettings(next: Settings): Promise<void> {
  await writeFile(settingsFile(), JSON.stringify(next, null, 2));
  settingsEvents.emit("changed", next);
}

ipcMain.handle(
  "settings:set",
  async (_e, apiKey: string | null, model: string, provider: Provider, spellLanguage: SpellLanguage) => {
    const current = await readSettings();
    const next: Settings = {
      provider: PROVIDERS.includes(provider) ? provider : current.provider,
      apiKey: apiKey ?? current.apiKey,
      model,
      spellLanguage: SPELL_LANGUAGES.includes(spellLanguage) ? spellLanguage : current.spellLanguage,
    };
    await saveSettings(next);
    return {
      provider: next.provider,
      hasKey: next.apiKey !== "",
      model: next.model,
      spellLanguage: next.spellLanguage,
    };
  },
);
