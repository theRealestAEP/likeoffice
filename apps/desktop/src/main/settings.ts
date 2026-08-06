import { app, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Settings {
  apiKey: string;
  model: string;
}

export const DEFAULT_MODEL = "claude-opus-5";

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** A key from the environment or a .env file near the app, so `ANTHROPIC=…`
 * or `ANTHROPIC_API_KEY=…` works without opening Settings. Settings wins. */
async function envApiKey(): Promise<string> {
  const fromEnv = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC;
  if (fromEnv) return fromEnv;
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
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      model: typeof raw.model === "string" ? raw.model : DEFAULT_MODEL,
    };
  } catch {
    settings = { apiKey: "", model: DEFAULT_MODEL };
  }
  if (!settings.apiKey) settings.apiKey = await envApiKey();
  return settings;
}

// The key never leaves the main process: the renderer only learns whether one
// is set, and sends null when the user leaves the field untouched.
ipcMain.handle("settings:get", async () => {
  const settings = await readSettings();
  return { hasKey: settings.apiKey !== "", model: settings.model };
});

ipcMain.handle("settings:set", async (_e, apiKey: string | null, model: string) => {
  const current = await readSettings();
  const next: Settings = { apiKey: apiKey ?? current.apiKey, model };
  await writeFile(settingsFile(), JSON.stringify(next, null, 2));
  return { hasKey: next.apiKey !== "", model: next.model };
});
