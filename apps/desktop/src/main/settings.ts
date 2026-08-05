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

export async function readSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(settingsFile(), "utf8"));
    return {
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
      model: typeof raw.model === "string" ? raw.model : DEFAULT_MODEL,
    };
  } catch {
    return { apiKey: "", model: DEFAULT_MODEL };
  }
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
