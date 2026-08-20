import { createHash, createHmac } from "node:crypto";

/**
 * A minimal S3 client: SigV4 signing plus the four calls a folder sync needs.
 *
 * WHY NOT @aws-sdk/client-s3. electron-builder packs the main process's runtime
 * dependencies into the asar (see electron-builder.yml), and the AWS SDK is
 * tens of megabytes to gain list/get/put against an endpoint the user supplies.
 * SigV4 is a published algorithm and this is a few dozen lines of it. The risk
 * that buys is silent — a signing mistake does not throw, it produces a 403 that
 * looks like a mistyped key — so every signature this produces is pinned in
 * e2e/s3-signing-unit.spec.ts against values cross-checked with `aws4`, an
 * independent implementation.
 *
 * "S3-compatible" is the point: endpoint is always the user's, so this works
 * against AWS, Cloudflare R2, Backblaze B2, MinIO, Wasabi and anything else
 * speaking the same protocol.
 */

export interface S3Config {
  /** Full origin, e.g. https://s3.us-east-1.amazonaws.com or a MinIO host. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, "" for the root. */
  prefix: string;
}

export interface RemoteObject {
  key: string;
  size: number;
  /** The object's ETag with quotes stripped; an md5 for a single-part upload. */
  etag: string;
  lastModified: Date;
}

const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding. S3 wants every byte outside the unreserved set escaped,
 * which encodeURIComponent leaves alone for !'()* — a key containing one would
 * otherwise sign differently than it is sent. */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of value) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

/**
 * Sign a request with SigV4.
 *
 * `now` is injected rather than read from the clock so the test vector can pin
 * a timestamp; production always passes the real time.
 */
export function signRequest(
  config: S3Config,
  method: string,
  key: string,
  query: Record<string, string>,
  body: Uint8Array | undefined,
  now: Date,
  /** Sent AND signed when a body is present, so the object lands in the bucket
   * with its real type rather than as application/octet-stream. */
  contentType?: string,
): SignedRequest {
  const url = new URL(config.endpoint.replace(/\/+$/, ""));
  const path = `/${config.bucket}${key ? `/${uriEncode(key, false)}` : ""}`;
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  // A signature covers exactly the headers it sends. Anything added here must
  // therefore be sent verbatim by send() below, or the request is rejected.
  if (body) {
    headers["content-length"] = String(body.byteLength);
    if (contentType) headers["content-type"] = contentType;
  }

  // Canonical request: sorted query, sorted lower-cased headers, payload hash.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join("&");
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : "";
  return { url: `${url.origin}${path}${qs}`, method, headers, ...(body ? { body } : {}) };
}

async function send(signed: SignedRequest, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      // Node's fetch needs a real ArrayBuffer view, not a Uint8Array alias.
      ...(signed.body ? { body: Buffer.from(signed.body) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function failure(response: Response, what: string): Promise<string> {
  const text = (await response.text().catch(() => "")).slice(0, 400);
  // S3 errors are XML with a <Message>; surfacing that beats "403 Forbidden".
  const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1];
  return `${what}: ${response.status} ${response.statusText}${message ? ` — ${message}` : ""}`;
}

/** Every object under the configured prefix. Follows continuation tokens, so a
 * folder with more than a thousand documents is not silently truncated. */
/** XML entities in element text. S3 escapes keys, so an ordinary document named
 * "A & B.docx" arrives as "A &amp; B.docx" — and a sync comparing that against
 * the local filename would never match it, re-uploading forever, while a GET
 * signed for the escaped spelling is a NoSuchKey. */
function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // Ampersand LAST, or "&amp;lt;" would decode twice into "<".
    .replace(/&amp;/g, "&");
}

export async function listObjects(config: S3Config): Promise<RemoteObject[]> {
  const out: RemoteObject[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2" };
    if (config.prefix) query.prefix = config.prefix;
    if (token) query["continuation-token"] = token;
    const response = await send(signRequest(config, "GET", "", query, undefined, new Date()));
    if (!response.ok) throw new Error(await failure(response, "Listing the bucket failed"));
    const xml = await response.text();
    for (const block of xml.split("<Contents>").slice(1)) {
      const rawKey = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      if (!rawKey) continue;
      out.push({
        key: decodeXmlText(rawKey),
        size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
        etag: (/<ETag>([\s\S]*?)<\/ETag>/.exec(block)?.[1] ?? "").replace(/&quot;|"/g, ""),
        lastModified: new Date(/<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? 0),
      });
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token);
  return out;
}

/** The type a .docx should carry in a bucket; anything else gets the generic
 * one rather than a guess. */
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function putObject(config: S3Config, key: string, body: Uint8Array): Promise<string> {
  const type = key.endsWith(".docx") ? DOCX_TYPE : "application/octet-stream";
  const response = await send(signRequest(config, "PUT", key, {}, body, new Date(), type));
  if (!response.ok) throw new Error(await failure(response, `Uploading ${key} failed`));
  return (response.headers.get("etag") ?? "").replace(/"/g, "");
}

export async function getObject(config: S3Config, key: string): Promise<Uint8Array> {
  const response = await send(signRequest(config, "GET", key, {}, undefined, new Date()));
  if (!response.ok) throw new Error(await failure(response, `Downloading ${key} failed`));
  return new Uint8Array(await response.arrayBuffer());
}

/** A cheap credentials/endpoint check for the settings page's Test button. */
export async function testConnection(config: S3Config): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const objects = await listObjects(config);
    return { ok: true, count: objects.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
