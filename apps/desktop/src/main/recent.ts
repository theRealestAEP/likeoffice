/**
 * Open Recent (the MRU list).
 *
 * The list lives in userData/recent.json — most recent first, capped at ten.
 * The application menu is rebuilt synchronously, so the list is kept in memory
 * and the file is only touched when it changes. Entries whose file is gone are
 * pruned on load and on every add, which is when a stale entry would otherwise
 * become visible.
 */
import { app } from "electron";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_ENTRIES = 10;

let entries: string[] = [];

function recentFile(): string {
  return path.join(app.getPath("userData"), "recent.json");
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function prune(list: string[]): Promise<string[]> {
  const keep = await Promise.all(list.map(exists));
  return list.filter((_, i) => keep[i]);
}

/**
 * Write to a temporary file and rename over the target, the same way the
 * document and PDF writers do (main/index.ts).
 *
 * `writeFile` truncates before it writes, so anything reading the file in
 * between sees zero bytes — and both readers here are `JSON.parse`, which
 * answers a truncated read with "Unexpected end of JSON input" rather than an
 * empty list. `rename` is atomic within a filesystem, so a reader sees either
 * the old list or the new one and never a half-written file. It also means a
 * crash mid-write cannot leave the MRU corrupt.
 */
async function persist(): Promise<void> {
  const target = recentFile();
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(entries, null, 2));
  await rename(tmp, target);
}

/** The list as the menu should show it. Synchronous: the menu builds from it. */
export function recentPaths(): string[] {
  return entries;
}

/** Read the stored list and drop entries whose file no longer exists. */
export async function loadRecent(): Promise<void> {
  let stored: string[] = [];
  try {
    const raw = JSON.parse(await readFile(recentFile(), "utf8"));
    if (Array.isArray(raw)) stored = raw.filter((p): p is string => typeof p === "string");
  } catch {
    stored = [];
  }
  entries = await prune(stored.slice(0, MAX_ENTRIES));
  if (entries.length !== stored.length) await persist();
}

/** Put a path at the front of the list. */
export async function addRecent(filePath: string): Promise<void> {
  app.addRecentDocument(filePath);
  const next = [filePath, ...entries.filter((p) => p !== filePath)].slice(0, MAX_ENTRIES);
  entries = await prune(next);
  await persist();
}

/** The "Clear Menu" item. Deliberately not async: the list is empty the
 * moment this returns, so a caller can rebuild the menu immediately and let
 * the returned promise carry the disk write. Awaiting it before rebuilding
 * leaves the cleared entries on screen until the file lands. */
export function clearRecent(): Promise<void> {
  app.clearRecentDocuments();
  entries = [];
  return persist();
}
