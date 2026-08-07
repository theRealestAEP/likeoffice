import { ipcMain } from "electron";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

export interface CliStatus {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
}

export interface ProviderStatus {
  claude: CliStatus;
  codex: CliStatus;
}

/** GUI apps launched from Finder get a minimal PATH; extend it with the
 * places the CLIs actually install to so detection works either way. */
export function cliEnv(): NodeJS.ProcessEnv {
  const extra = [
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return { ...process.env, PATH: [process.env.PATH ?? "", ...extra].join(path.delimiter) };
}

function run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { env: cliEnv(), timeout: 10000 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout ?? "").trim() });
    });
  });
}

async function claudeStatus(): Promise<CliStatus> {
  const version = await run("claude", ["--version"]);
  if (!version.ok) return { installed: false };
  // `claude auth status --json` is the CLI's documented auth check.
  const auth = await run("claude", ["auth", "status", "--json"]);
  let loggedIn = false;
  try {
    loggedIn = auth.ok && JSON.parse(auth.stdout).loggedIn === true;
  } catch {
    // Unparseable status counts as not logged in.
  }
  return { installed: true, version: version.stdout, loggedIn };
}

async function codexStatus(): Promise<CliStatus> {
  const version = await run("codex", ["--version"]);
  if (!version.ok) return { installed: false };
  // `codex login status` exits 0 when credentials are present.
  const auth = await run("codex", ["login", "status"]);
  return { installed: true, version: version.stdout, loggedIn: auth.ok };
}

export async function providerStatus(): Promise<ProviderStatus> {
  // The fake-model e2e suite needs a deterministic "not installed" state
  // regardless of what is on the developer's machine.
  if (process.env.LIKEOFFICE_FAKE_MODEL) {
    return { claude: { installed: false }, codex: { installed: false } };
  }
  const [claude, codex] = await Promise.all([claudeStatus(), codexStatus()]);
  return { claude, codex };
}

ipcMain.handle("providers:status", () => providerStatus());
