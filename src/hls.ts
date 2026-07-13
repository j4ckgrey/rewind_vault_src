/**
 * apiJAV HLS reverse-proxy — the Vault side of /api/adult-hls.
 *
 * apiJAV resolves to a direct HLS stream on a rotating third-party CDN
 * (`m2cdn.playergo*.top`). The Rewind SERVER can reach that CDN fine, but the
 * BROWSER often can't — the domain is on adult/ad blocklists, so a pihole (or
 * any upstream DNS filter) NXDOMAINs it and the web player dies with
 * `ERR_NAME_NOT_RESOLVED` before a single segment loads. Geo-blocks and
 * missing CORS bite the same way.
 *
 * The fix: never hand the raw CDN URL to the client. We mint a same-origin
 * proxy URL (`/api/adult-hls/<name>?u=…&sig=…`) that streams the playlist and
 * segments through the server. The browser only ever talks to Rewind; the
 * server does the CDN fetch (with a browser UA + Referer) and rewrites every
 * child URI in the m3u8 to point back through the proxy.
 *
 * Every proxied URL is HMAC-signed with a per-install secret so this can't be
 * abused as an open proxy — only URLs the server itself minted are honored.
 *
 * This whole module lives in the Vault (it is adult-only plumbing); the
 * embedder's route is a thin shim that hands the raw Request + its public
 * origin to {@link handleHlsProxyRequest}. The signing secret persists via the
 * host kv store.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { kvGet, kvSet } from "@vault/db";

const SECRET_NS = "adult_hls";
const SECRET_KEY = "sign_secret";

let cachedSecret: string | null = null;

/** Get (or lazily create) the per-install HMAC secret used to sign proxy URLs. */
export async function getAdultHlsSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const existing = await kvGet(SECRET_KEY, SECRET_NS);
  if (existing) {
    cachedSecret = existing;
    return existing;
  }
  const fresh = randomBytes(32).toString("hex");
  await kvSet(SECRET_KEY, SECRET_NS, fresh, 0); // no TTL — stable for the install
  cachedSecret = fresh;
  return fresh;
}

function sign(target: string, secret: string): string {
  return createHmac("sha256", secret).update(target).digest("hex");
}

/** Constant-time signature check for an incoming proxy request. */
export function verifyAdultHlsSig(target: string, sig: string, secret: string): boolean {
  const expected = sign(target, secret);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Derive a safe URL filename from the target so the proxy URL keeps the
 * target's extension (`video.m3u8`, `seg123.ts`). This matters because the web
 * player picks hls.js vs the native <video> element purely by testing the URL
 * against `/\.m3u8(\?|$)/` — a query-only proxy URL would be treated as a plain
 * file and fail to demux. Falls back to a generic name for extension-less URLs.
 */
function targetFilename(target: string): string {
  try {
    const base = new URL(target).pathname.split("/").pop() ?? "";
    const clean = base.replace(/[^a-zA-Z0-9._-]/g, "");
    return clean || "s";
  } catch {
    return "s";
  }
}

/**
 * Build an absolute, signed proxy URL for a CDN target.
 * `origin` is the browser-facing Rewind origin (the embedder's public origin),
 * so remote web clients on a different host than the API still resolve it.
 */
export function buildAdultHlsProxyUrl(origin: string, target: string, secret: string): string {
  const u = Buffer.from(target, "utf8").toString("base64url");
  const sig = sign(target, secret);
  const name = encodeURIComponent(targetFilename(target));
  return `${origin.replace(/\/$/, "")}/api/adult-hls/${name}?u=${u}&sig=${sig}`;
}

/**
 * Rewrite every URI in an HLS playlist so each child (variant playlist, segment,
 * key, init map) points back through the signed same-origin proxy. Child URIs
 * are pinned to the parent playlist's host — relative segment URIs resolve to
 * the same host, so this only refuses to proxy a hostile *absolute* URI (SSRF
 * guard). `baseUrl` is the playlist's own (post-redirect) URL, used to resolve
 * relative URIs.
 */
export function rewritePlaylist(
  text: string,
  baseUrl: string,
  origin: string,
  secret: string,
): string {
  let parentHost = "";
  try {
    parentHost = new URL(baseUrl).host;
  } catch {
    return text;
  }
  const proxify = (rawUri: string): string => {
    let abs: URL;
    try {
      abs = new URL(rawUri, baseUrl);
    } catch {
      return rawUri;
    }
    if (abs.host !== parentHost || isBlockedProxyHost(abs.hostname)) return rawUri;
    return buildAdultHlsProxyUrl(origin, abs.href, secret);
  };
  return text
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (l === "") return line;
      if (l.startsWith("#")) {
        // EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP / EXT-X-I-FRAME-STREAM-INF carry
        // a URI="…" attribute that must be proxied too.
        return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${proxify(uri)}"`);
      }
      return proxify(l);
    })
    .join("\n");
}

/**
 * Reject internal / link-local / private targets so a hostile playlist can't
 * turn the proxy into an SSRF pivot. Child URIs are additionally pinned to the
 * parent playlist's host by the request handler, so this is defense-in-depth
 * for the initial mint.
 */
export function isBlockedProxyHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare container/service names
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local (cloud metadata)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^127\./.test(h)) return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 link-local / ULA
  return false;
}

// ─── The proxy request handler (the embedder route delegates here) ───────────

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const CONNECT_TIMEOUT_MS = 20_000;

function cors(headers: Headers): Headers {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range,Content-Type");
  headers.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  return headers;
}

function isPlaylistTarget(target: string, contentType: string | null): boolean {
  const path = (target.split("?")[0] ?? "").toLowerCase();
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return true;
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("mpegurl");
}

/** CORS preflight response for the proxy route. */
export function hlsProxyOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: cors(new Headers()) });
}

/**
 * Serve one proxy request: verify the signature, fetch the CDN target
 * (streaming, with Range support), and — for playlists — rewrite every child
 * URI back through the proxy. `origin` is the browser-facing Rewind origin the
 * rewritten URIs should point at.
 */
export async function handleHlsProxyRequest(
  request: Request,
  origin: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  const url = new URL(request.url);
  const u = url.searchParams.get("u");
  const sig = url.searchParams.get("sig");
  if (!u || !sig) return new Response("bad request", { status: 400, headers: cors(new Headers()) });

  let target: string;
  try {
    target = Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return new Response("bad u", { status: 400, headers: cors(new Headers()) });
  }

  const secret = await getAdultHlsSecret();
  if (!verifyAdultHlsSig(target, sig, secret)) {
    return new Response("bad signature", { status: 403, headers: cors(new Headers()) });
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response("bad target", { status: 400, headers: cors(new Headers()) });
  }
  if (!/^https?:$/.test(targetUrl.protocol) || isBlockedProxyHost(targetUrl.hostname)) {
    return new Response("blocked host", { status: 403, headers: cors(new Headers()) });
  }

  const upstreamHeaders: Record<string, string> = {
    "User-Agent": UA,
    Referer: `${targetUrl.origin}/`,
    Accept: "*/*",
  };
  const range = request.headers.get("range");
  if (range) upstreamHeaders.Range = range;

  const ac = new AbortController();
  // Abort upstream if the client goes away mid-stream.
  request.signal.addEventListener("abort", () => ac.abort(), { once: true });
  const connectTimer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers: upstreamHeaders,
      redirect: "follow",
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(connectTimer);
    return new Response(`upstream fetch failed: ${(e as Error).message}`, {
      status: 502,
      headers: cors(new Headers()),
    });
  }

  if (isPlaylistTarget(res.url || target, res.headers.get("content-type"))) {
    clearTimeout(connectTimer);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return new Response(text || `upstream ${res.status}`, {
        status: res.status,
        headers: cors(new Headers()),
      });
    }
    const rewritten = rewritePlaylist(text, res.url || target, origin, secret);
    const h = cors(new Headers());
    h.set("Content-Type", "application/vnd.apple.mpegurl");
    h.set("Cache-Control", "no-store");
    return new Response(method === "HEAD" ? null : rewritten, { status: 200, headers: h });
  }

  // Segment / key / init byte-stream — pass through with Range semantics intact.
  const h = cors(new Headers());
  for (const k of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ]) {
    const v = res.headers.get(k);
    if (v) h.set(k, v);
  }
  if (!h.has("accept-ranges")) h.set("accept-ranges", "bytes");
  // The body may stream for a while; the connect timeout no longer applies.
  clearTimeout(connectTimer);
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, headers: h });
}
