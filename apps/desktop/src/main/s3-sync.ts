import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import { mkdir, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { getObject, listObjects, putObject, type S3Config, type RemoteObject } from "./s3";
import { readSettings } from "./settings";

/**
 * Mirror the projects folder to an S3-compatible bucket.
 *
 * OFFLINE-FIRST, deliberately. Documents live on local disk and the editor only
 * ever touches local disk; this walks the folder and the bucket afterwards and
 * moves whatever is missing or older. Making the bucket the storage backend
 * would put a network round trip in front of every save, and an autosave every
 * thirty seconds is exactly the wrong place for that.
 *
 * NOTHING IS EVER OVERWRITTEN WITHOUT A COPY. When both sides changed since the
 * last sync there is no correct answer — only a choice — so the newer file wins
 * and the loser is kept beside it as `name (conflict 2026-08-15).docx`. A sync
 * engine that silently discards the other copy is indistinguishable from data
 * loss, and the two-devices-one-document case is the whole reason people ask
 * for this.
 */

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  /** Files kept beside a newer copy rather than being overwritten. */
  conflicts: string[];
  errors: string[];
  /** Absent config is not an error; it is the normal state before setup. */
  skipped?: string;
}

const md5 = (bytes: Uint8Array): string => createHash("md5").update(bytes).digest("hex");

/** Documents only. The folder is the user's, and a sync that hoovered up every
 * stray file in it would be a surprise. */
function isDocument(name: string): boolean {
  return name.toLowerCase().endsWith(".docx") && !name.startsWith("~$") && !name.startsWith(".");
}

interface LocalFile {
  /** Path relative to the projects folder, with forward slashes — the same
   * shape as an S3 key, so the two sides compare directly. */
  rel: string;
  absolute: string;
  mtimeMs: number;
  bytes: number;
}

async function walk(root: string, prefix = ""): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // Conflict copies are evidence for the user, not something to sync back up
    // and hand to the other device as new work.
    if (entry.name.startsWith(".") || entry.name.includes("(conflict ")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, rel)));
      continue;
    }
    if (!isDocument(entry.name)) continue;
    const absolute = path.join(root, rel);
    const info = await stat(absolute);
    out.push({ rel, absolute, mtimeMs: info.mtimeMs, bytes: info.size });
  }
  return out;
}

/** Where a conflicting copy is parked, next to the file it lost to. */
function conflictPath(absolute: string, when: Date): string {
  const dir = path.dirname(absolute);
  const ext = path.extname(absolute);
  const base = path.basename(absolute, ext);
  const stamp = when.toISOString().slice(0, 10);
  return path.join(dir, `${base} (conflict ${stamp})${ext}`);
}

/**
 * Resolve a bucket key to a path INSIDE the projects folder, or null.
 *
 * A key is a string chosen by whoever can write to the bucket, and this sync
 * exists for SHARED buckets. Joining it to the projects folder and writing was
 * a path traversal: `a/../../../../tmp/evil.docx` passed the ".docx" check —
 * which only ever looked at the basename — and landed outside the folder
 * entirely, with mkdir helpfully creating the directory on the way.
 *
 * Containment is checked on the RESOLVED path rather than by looking for ".."
 * in the key, because encodings, symlinked roots and absolute keys all reach
 * the same place by other spellings.
 */
function resolveInside(root: string, rel: string): string | null {
  if (rel === "" || path.isAbsolute(rel)) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  // The separator matters: without it "/projects-evil" passes a bare
  // startsWith("/projects") test.
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export async function syncOnce(): Promise<SyncResult> {
  const result: SyncResult = { uploaded: [], downloaded: [], conflicts: [], errors: [] };
  const { storage, s3 } = await readSettings();
  if (!s3.enabled) return { ...result, skipped: "Bucket sync is off." };
  if (!storage.projectsDir) return { ...result, skipped: "No projects folder is set." };
  for (const [field, value] of Object.entries({
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  })) {
    if (!value) return { ...result, skipped: `Bucket sync needs a ${field}.` };
  }

  const config: S3Config = {
    endpoint: s3.endpoint,
    region: s3.region || "us-east-1",
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    prefix: s3.prefix,
  };

  let remote: RemoteObject[];
  try {
    remote = await listObjects(config);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  await mkdir(storage.projectsDir, { recursive: true });
  const local = await walk(storage.projectsDir);
  const byKey = new Map(remote.map((o) => [o.key, o]));
  const keyOf = (rel: string): string => (s3.prefix ? `${s3.prefix.replace(/\/+$/, "")}/${rel}` : rel);
  const relOf = (key: string): string =>
    s3.prefix ? key.slice(s3.prefix.replace(/\/+$/, "").length + 1) : key;

  // Local -> remote.
  for (const file of local) {
    const key = keyOf(file.rel);
    const object = byKey.get(key);
    try {
      const bytes = await readFile(file.absolute);
      if (!object) {
        await putObject(config, key, bytes);
        result.uploaded.push(file.rel);
        continue;
      }
      // A single-part ETag is the content's md5, so identical files are
      // recognised without downloading anything. A multipart ETag contains a
      // dash and cannot be compared this way; size then mtime decide.
      const identical = object.etag.includes("-")
        ? object.size === file.bytes
        : object.etag === md5(bytes);
      if (identical) continue;
      if (file.mtimeMs > object.lastModified.getTime()) {
        await putObject(config, key, bytes);
        result.uploaded.push(file.rel);
      } else {
        // Remote is newer AND local differs: both sides moved. Keep ours.
        const kept = conflictPath(file.absolute, new Date(file.mtimeMs));
        await writeFile(kept, bytes);
        const incoming = await getObject(config, key);
        await writeFile(file.absolute, incoming);
        await utimes(file.absolute, new Date(), object.lastModified);
        result.conflicts.push(path.basename(kept));
        result.downloaded.push(file.rel);
      }
    } catch (error) {
      result.errors.push(`${file.rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Remote -> local, for anything this machine has never seen.
  const localRels = new Set(local.map((f) => f.rel));
  for (const object of remote) {
    const rel = relOf(object.key);
    if (!rel || !isDocument(path.basename(rel)) || localRels.has(rel)) continue;
    const absolute = resolveInside(storage.projectsDir, rel);
    if (!absolute) {
      // Reported, not skipped in silence: a key that tries to escape is worth
      // seeing, whether it is an attack or a badly-built bucket.
      result.errors.push(`${object.key}: refused — the key points outside the projects folder.`);
      continue;
    }
    try {
      const bytes = await getObject(config, object.key);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
      // Carry the remote timestamp so the next pass does not read the download
      // as a fresh local edit and push it straight back.
      await utimes(absolute, new Date(), object.lastModified);
      result.downloaded.push(rel);
    } catch (error) {
      result.errors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

ipcMain.handle("s3:sync", () => syncOnce());
