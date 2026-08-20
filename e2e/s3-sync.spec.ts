import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readdir, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Folder sync, against an in-process stand-in for S3.
 *
 * A real bucket would make this a network test and need credentials nobody
 * should put in a repo. The stand-in speaks the three calls the sync uses —
 * list-v2, GET, PUT — which is enough to exercise the decisions that matter:
 * what gets uploaded, what gets pulled, and what happens when both sides moved.
 */
function fakeS3(objects: Map<string, { body: Buffer; modified: Date }>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // /bucket or /bucket/key…
    const parts = url.pathname.replace(/^\//, "").split("/");
    const key = decodeURIComponent(parts.slice(1).join("/"));

    if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
      const contents = [...objects.entries()]
        .map(
          ([k, o]) =>
            `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${o.body.length}</Size>` +
            `<ETag>&quot;${createHash("md5").update(o.body).digest("hex")}&quot;</ETag>` +
            `<LastModified>${o.modified.toISOString()}</LastModified></Contents>`,
        )
        .join("");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`);
      return;
    }
    if (req.method === "GET") {
      const object = objects.get(key);
      if (!object) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Message>NoSuchKey</Message></Error>");
        return;
      }
      res.writeHead(200);
      res.end(object.body);
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        objects.set(key, { body, modified: new Date() });
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        res.end();
      });
      return;
    }
    res.writeHead(400);
    res.end();
  });
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("sync uploads new work, pulls what it has not seen, and never overwrites a conflict", async () => {
  test.setTimeout(180000);
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const net = await fakeS3(objects);
  const projects = await mkdtemp(path.join(tmpdir(), "likeoffice-projects-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  // One file only this machine has, one only the bucket has, and one both
  // changed since they last agreed.
  await writeFile(path.join(projects, "local-only.docx"), "made here");
  objects.set("remote-only.docx", { body: Buffer.from("made elsewhere"), modified: new Date() });

  const older = new Date(Date.now() - 60_000);
  await writeFile(path.join(projects, "both.docx"), "my version");
  await utimes(path.join(projects, "both.docx"), older, older);
  // The bucket's copy is NEWER and different: the conflict case.
  objects.set("both.docx", { body: Buffer.from("their version"), modified: new Date() });

  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(
      ([origin, dir]) =>
        window.likeoffice.setSettings({
          storage: { projectsDir: dir },
          s3: {
            enabled: true,
            endpoint: origin,
            bucket: "docs",
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
          },
        }),
      [net.origin, projects],
    );

    const result = await win.evaluate(() => window.likeoffice.syncBucket());
    expect(result.skipped).toBeUndefined();
    expect(result.errors).toEqual([]);

    // Local-only went up; remote-only came down.
    expect(result.uploaded).toContain("local-only.docx");
    expect(objects.has("local-only.docx")).toBe(true);
    expect(result.downloaded).toContain("remote-only.docx");
    expect(await readFile(path.join(projects, "remote-only.docx"), "utf8")).toBe("made elsewhere");

    // THE CONFLICT. The newer copy wins the filename, and the losing copy is
    // kept beside it — never silently discarded.
    expect(result.conflicts.length).toBe(1);
    expect(await readFile(path.join(projects, "both.docx"), "utf8")).toBe("their version");
    const kept = (await readdir(projects)).find((f) => f.includes("(conflict "));
    expect(kept).toBeDefined();
    expect(await readFile(path.join(projects, kept as string), "utf8")).toBe("my version");

    // A second sync is quiet: everything already agrees, and the conflict copy
    // is evidence rather than new work to upload.
    const again = await win.evaluate(() => window.likeoffice.syncBucket());
    expect(again.uploaded).toEqual([]);
    expect(again.downloaded).toEqual([]);
    expect(again.conflicts).toEqual([]);
  } finally {
    await app.close();
    await net.close();
  }
});

test("sync says why it did nothing rather than failing silently", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-nosync-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    const off = await win.evaluate(() => window.likeoffice.syncBucket());
    expect(off.skipped).toContain("off");

    await win.evaluate(() => window.likeoffice.setSettings({ s3: { enabled: true } }));
    const unconfigured = await win.evaluate(() => window.likeoffice.syncBucket());
    expect(unconfigured.skipped).toBeTruthy();
  } finally {
    await app.close();
  }
});

/**
 * A bucket key is a string chosen by whoever can write to the bucket, and this
 * sync exists for SHARED buckets. Joining one to the projects folder and
 * writing it was a path traversal: the ".docx" guard only ever inspected the
 * BASENAME, so `a/../../../evil.docx` passed it and landed wherever the key
 * pointed — with mkdir creating the directory on the way.
 */
test("a bucket key that points outside the projects folder is refused", async () => {
  test.setTimeout(180000);
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const net = await fakeS3(objects);
  const projects = await mkdtemp(path.join(tmpdir(), "likeoffice-escape-"));
  const outside = await mkdtemp(path.join(tmpdir(), "likeoffice-outside-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  // Every spelling of "out of the folder" that reached the same place.
  const escape = path.relative(projects, path.join(outside, "pwned.docx"));
  objects.set(escape, { body: Buffer.from("owned"), modified: new Date() });
  objects.set("/etc/absolute.docx", { body: Buffer.from("owned"), modified: new Date() });
  // …and one legitimate file, so a refusal cannot pass by syncing nothing.
  objects.set("real.docx", { body: Buffer.from("fine"), modified: new Date() });

  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(
      ([origin, dir]) =>
        window.likeoffice.setSettings({
          storage: { projectsDir: dir },
          s3: {
            enabled: true,
            endpoint: origin,
            bucket: "docs",
            accessKeyId: "AKIAIOSFODNN7EXAMPLE",
            secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
          },
        }),
      [net.origin, projects],
    );

    const result = await win.evaluate(() => window.likeoffice.syncBucket());

    // Nothing was written outside the folder.
    expect(await readdir(outside)).toEqual([]);
    // The escape attempts are REPORTED, not silently dropped.
    expect(result.errors.join(" ")).toContain("outside the projects folder");
    // And the honest file still synced.
    expect(result.downloaded).toContain("real.docx");
    expect(await readFile(path.join(projects, "real.docx"), "utf8")).toBe("fine");
  } finally {
    await app.close();
    await net.close();
  }
});
