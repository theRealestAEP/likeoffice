import { ipcMain } from "electron";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { readSettings, type WebSearchBackend } from "./settings";

/**
 * The agent's two web tools, run in the MAIN process.
 *
 * They live here rather than in the renderer for one reason: the renderer is a
 * document window with a content security policy, and giving it arbitrary
 * cross-origin fetch to serve a tool call would widen that for every page the
 * app ever loads. Main already talks to model providers; one more outbound
 * fetch is the same trust boundary.
 *
 * NEITHER NEEDS AN ACCOUNT. Fetch is a plain HTTP GET. Search defaults to
 * asking DuckDuckGo's HTML endpoint directly and reading the results, which
 * works with nothing installed and nothing signed up for — the thing a person
 * doing their own research actually wants. A self-hosted SearXNG and the
 * hosted APIs are there for people who want them; the difference is
 * robustness, not permission. Result markup is not a contract, so the direct
 * reader is written to degrade to "no results" rather than to wrong ones, and
 * heavy use can be rate-limited.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const SEARCH_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_MS = 20000;
/** Enough of a page for a model to quote and cite, without burning a context
 * window on one article. */
const FETCH_MAX_CHARS = 40000;
const MAX_RESULTS = 8;

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** SearXNG: `format=json` on any instance, no key. The instance must have JSON
 * enabled in its settings.yml — many public ones do not, which is why the
 * error below says so rather than reporting a bare parse failure. */
async function searxng(url: string, query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
  // APPENDED, not resolved: `new URL("/search", base)` discards base's path, so
  // an instance hosted at example.com/searx would be searched at example.com.
  const endpoint = new URL(`${url.replace(/\/+$/, "")}/search`);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${endpoint.origin}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    throw new Error(
      `${endpoint.origin} answered HTML, not JSON. Add "json" to the formats list under search: in its settings.yml.`,
    );
  }
  const body = (await response.json()) as { results?: unknown };
  // SAFETY: the array is CHECKED, then each field. Only the leaves were guarded
  // before, so an instance answering {"results": "none"} threw "slice is not a
  // function" and reached the model as a raw TypeError.
  const rows: { title?: unknown; url?: unknown; content?: unknown }[] = Array.isArray(body.results)
    ? body.results
    : [];
  return rows.slice(0, MAX_RESULTS).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.content === "string" ? r.content : "",
  }));
}

async function brave(key: string, query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", String(MAX_RESULTS));
  const response = await fetch(endpoint, {
    signal,
    headers: { accept: "application/json", "x-subscription-token": key },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from Brave Search`);
  const body = (await response.json()) as { web?: { results?: unknown } };
  // SAFETY: array checked, then each field.
  const rows: { title?: unknown; url?: unknown; description?: unknown }[] = Array.isArray(
    body.web?.results,
  )
    ? body.web.results
    : [];
  return rows.slice(0, MAX_RESULTS).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.description === "string" ? r.description : "",
  }));
}

async function tavily(key: string, query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: MAX_RESULTS }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from Tavily`);
  const body = (await response.json()) as { results?: unknown };
  // SAFETY: array checked, then each field.
  const rows: { title?: unknown; url?: unknown; content?: unknown }[] = Array.isArray(body.results)
    ? body.results
    : [];
  return rows.slice(0, MAX_RESULTS).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.content === "string" ? r.content : "",
  }));
}

/** The handful of entities that actually turn up in prose and in hrefs. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/**
 * DuckDuckGo's HTML endpoint, read directly.
 *
 * The markup is not an API and will change; every field is therefore optional
 * and a shape this does not recognise yields NO result rather than a mangled
 * one. Redirect-wrapped hrefs (/l/?uddg=…) are unwrapped so the model gets the
 * real URL to fetch.
 */
function parseDuckDuckGo(html: string): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  // One block per result; the anchor carries the title, the snippet follows.
  const blocks = html.split(/<div class="result[ "]/).slice(1);
  for (const block of blocks) {
    const href = /<a[^>]+class="result__a"[^>]*href="([^"]+)"/.exec(block)?.[1];
    const title = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1];
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1]
      ?? /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
    if (!href || !title) continue;
    let url = decodeEntities(href);
    // DuckDuckGo wraps outbound links; the real target is the uddg parameter.
    const wrapped = /[?&]uddg=([^&]+)/.exec(url)?.[1];
    if (wrapped) url = decodeURIComponent(wrapped);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:/.test(url)) continue;
    out.push({
      title: htmlToText(title),
      url,
      snippet: snippet ? htmlToText(snippet) : "",
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function duckduckgo(query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
  // Overridable so the test suite can point at a local stand-in and stay
  // offline; unset in every real run.
  const endpoint = new URL(process.env.LIKEOFFICE_DDG_ENDPOINT ?? "https://html.duckduckgo.com/html/");
  endpoint.searchParams.set("q", query);
  const response = await fetch(endpoint, {
    signal,
    headers: {
      // A real UA string: the endpoint serves a stripped page to unknown
      // clients. This identifies the app rather than impersonating a browser.
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LikeOffice/1.0",
      accept: "text/html",
    },
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText} from DuckDuckGo. Direct search can be rate-limited; a self-hosted SearXNG or an API key in Settings > Web is steadier.`,
    );
  }
  return parseDuckDuckGo(await response.text());
}

async function exa(key: string, query: string, signal: AbortSignal): Promise<WebSearchResult[]> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ query, numResults: MAX_RESULTS, contents: { text: { maxCharacters: 600 } } }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from Exa`);
  const body = (await response.json()) as { results?: unknown };
  // SAFETY: array checked, then each field.
  const rows: { title?: unknown; url?: unknown; text?: unknown }[] = Array.isArray(body.results)
    ? body.results
    : [];
  return rows.slice(0, MAX_RESULTS).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    snippet: typeof r.text === "string" ? r.text.slice(0, 600) : "",
  }));
}

export async function webSearch(query: string): Promise<{ results: WebSearchResult[] } | { error: string }> {
  const { web } = await readSettings();
  const backend: WebSearchBackend = web.backend;
  try {
    const results = await withTimeout(SEARCH_TIMEOUT_MS, (signal) => {
      if (backend === "direct") return duckduckgo(query, signal);
      if (backend === "searxng") {
        if (!web.searxngUrl) {
          throw new Error(
            "No SearXNG address set. Run one locally (docker run -p 8080:8080 searxng/searxng) and put its URL in Settings > Web.",
          );
        }
        return searxng(web.searxngUrl, query, signal);
      }
      if (!web.apiKey) throw new Error(`No API key set for ${backend}. Add one in Settings > Web.`);
      if (backend === "brave") return brave(web.apiKey, query, signal);
      if (backend === "tavily") return tavily(web.apiKey, query, signal);
      return exa(web.apiKey, query, signal);
    });
    return { results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.includes("abort") ? "The search timed out." : message };
  }
}

/** HTML to something a model can read. Not a renderer: script, style and markup
 * come out, entities are decoded, whitespace collapses. That is the whole job —
 * the model wants the prose, not the page. */
export function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const spaced = withoutHead
    // Block-level tags become line breaks so paragraphs survive as paragraphs.
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(spaced);
  return decoded
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether an address belongs to the machine or its private network.
 *
 * web_fetch exists to read the PUBLIC web on the model's behalf. Without this
 * check, text inside a document or a fetched page could steer the model into
 * fetching http://localhost:8080 or a 192.168.x.x router page and handing the
 * response back — the model reading the user's LAN through a tool meant for
 * research. Checked against the RESOLVED address, because a public hostname is
 * free to resolve to 127.0.0.1.
 */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224 // multicast and reserved
    );
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  // IPv4 mapped into IPv6 carries the same rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/** Resolve a URL's host and refuse anything that is not on the public internet. */
async function assertPublicHost(url: URL): Promise<string | null> {
  // Test seam: the suite serves a stand-in for the internet on 127.0.0.1, and
  // has to be able to fetch it. Never set in a real run.
  if (process.env.LIKEOFFICE_ALLOW_PRIVATE_FETCH) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? `${host} is not a public address.` : null;
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) return `${host} did not resolve.`;
    // ALL of them: a name that resolves to one public and one private address
    // must not be fetchable by getting lucky on ordering.
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    return bad ? `${host} resolves to ${bad.address}, which is not a public address.` : null;
  } catch {
    return `${host} did not resolve.`;
  }
}

export async function webFetch(
  url: string,
): Promise<{ url: string; title: string; text: string; truncated: boolean } | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Not a URL: ${url}` };
  }
  // http(s) only. A file:// or data: fetch here would let a model read the
  // user's disk through a tool meant for the public web.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `Only http and https URLs can be fetched (got ${parsed.protocol}).` };
  }
  try {
    return await withTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      // REDIRECTS ARE FOLLOWED BY HAND. Letting fetch follow them would check
      // the first hop and then quietly fetch wherever it was sent, which is the
      // same hole with one extra step.
      let target = parsed;
      let response: Response | undefined;
      for (let hop = 0; hop < 5; hop++) {
        const blocked = await assertPublicHost(target);
        if (blocked) return { error: blocked };
        response = await fetch(target, {
          signal,
          redirect: "manual",
          headers: { "user-agent": "LikeOffice/1.0 (+document assistant)", accept: "text/html,text/plain,*/*" },
        });
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;
        target = new URL(location, target);
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          return { error: `Refused a redirect to ${target.protocol}` };
        }
      }
      if (!response) return { error: "Too many redirects." };
      if (!response.ok) return { error: `${response.status} ${response.statusText} from ${target.host}` };
      const type = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const text = type.includes("html") ? htmlToText(body) : body;
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? target.host;
      return {
        url: target.toString(),
        title: htmlToText(title),
        text: text.slice(0, FETCH_MAX_CHARS),
        truncated: text.length > FETCH_MAX_CHARS,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.includes("abort") ? "The page took too long to load." : message };
  }
}

ipcMain.handle("web:search", (_e, query: string) => webSearch(String(query ?? "")));
ipcMain.handle("web:fetch", (_e, url: string) => webFetch(String(url ?? "")));
