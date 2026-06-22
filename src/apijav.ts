/**
 * apiJAV source — a JAV catalog + player exposed as a WordPress REST API
 * (`/wp-json/myvideo/v1`). Unlike the Zilean/TorBox path this is BOTH a search
 * source AND its own player: each post carries an embed page, and that embed
 * page holds the real HLS stream (base64 + XOR-obfuscated). So we:
 *   search  → GET /posts?search=&category=         → metadata cards
 *   resolve → GET /posts/{id} → fetch embed page   → deobfuscate → HLS .m3u8
 * which the client then plays directly (native HLS), exactly like any other
 * adult stream — no torrents, no debrid, no WebView.
 *
 * Categories (for the in-library dropdown) come from WP core taxonomy
 * (`/wp-json/wp/v2/categories`) and are cached so we don't re-fetch per search.
 *
 * Only the public API contract (paths + params, documented at apijav.com) is
 * used here; all code is ours.
 */
import { kvGet, kvSet } from "@vault/db";
import type { AdultSearchResult } from "./search";

export const APIJAV_DEFAULT_BASE = "https://server.apijav.com";

const CAT_NS = "apijav_categories";
const CAT_TTL = 24 * 60 * 60; // a day — categories barely change

const JAV_CODE = /\b([A-Z]{2,6})-?(\d{2,5})\b/;

interface ApijavOpts {
  apiKey?: string;
  signal?: AbortSignal;
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (apiKey) h["X-API-Key"] = apiKey;
  return h;
}

function base(url?: string): string {
  return (url || APIJAV_DEFAULT_BASE).replace(/\/+$/, "");
}

async function getJson(url: string, opts: ApijavOpts): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: authHeaders(opts.apiKey), signal: opts.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** "01:23:45" / "23:45" → seconds; "00:00:00" / unknown → null. */
function parseDuration(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const parts = d.split(":").map((p) => parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s > 0 ? s : null;
}

function mapPost(raw: any): AdultSearchResult | null {
  const id = raw?.id;
  const title = typeof raw?.title === "string" ? raw.title : "";
  if (id == null || !title) return null;
  const date = typeof raw?.date === "string" ? raw.date.slice(0, 10) : null;
  const year = date ? parseInt(date.slice(0, 4), 10) || null : null;
  const performers: string[] = Array.isArray(raw?.actors)
    ? raw.actors.filter((a: unknown): a is string => typeof a === "string")
    : [];
  const code = typeof raw?.code === "string" && raw.code ? raw.code : (title.match(JAV_CODE)?.[0] ?? null);
  return {
    id: `apijav:${id}`,
    kind: "jav",
    contentType: "jav",
    uuid: String(id),
    title,
    posterUrl: typeof raw?.thumbnail === "string" ? raw.thumbnail : null,
    backgroundUrl: null,
    date,
    year,
    performers,
    studio: typeof raw?.studio === "string" ? raw.studio : null,
    description: Array.isArray(raw?.categories) ? raw.categories.join(", ") : null,
    rating: null,
    durationSeconds: parseDuration(raw?.duration),
    source: "apijav",
    code,
  };
}

/**
 * Free-text + category catalog search. Either `query` or `category` (or both)
 * may be set; with neither we return the latest posts (category/browse mode).
 */
export async function apijavSearch(
  baseUrl: string | undefined,
  opts: { query?: string; category?: string; page?: number; perPage?: number } & ApijavOpts,
): Promise<AdultSearchResult[]> {
  const params = new URLSearchParams();
  // 60/page — the catalog has thousands of hits per term (a "SSIS" search
  // reports x-wp-total≈1300), so the old 30 felt sparse next to the website.
  params.set("per_page", String(opts.perPage ?? 60));
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.query?.trim()) params.set("search", opts.query.trim());
  if (opts.category?.trim()) params.set("category", opts.category.trim());
  const json = await getJson(`${base(baseUrl)}/wp-json/myvideo/v1/posts?${params.toString()}`, opts);
  if (!Array.isArray(json)) return [];
  return json.map(mapPost).filter((c): c is AdultSearchResult => c !== null);
}

export interface ApijavCategory {
  name: string;
  slug: string;
  count: number;
}

/** Top categories by usage (for the search dropdown), cached for a day. */
export async function apijavCategories(
  baseUrl: string | undefined,
  opts: ApijavOpts = {},
): Promise<ApijavCategory[]> {
  const b = base(baseUrl);
  const cached = await kvGet(b, CAT_NS).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached) as ApijavCategory[]; } catch { /* refetch */ }
  }
  const json = await getJson(
    `${b}/wp-json/wp/v2/categories?per_page=100&orderby=count&order=desc&_fields=name,slug,count`,
    opts,
  );
  if (!Array.isArray(json)) return [];
  const cats: ApijavCategory[] = json
    .map((c: any) => ({
      name: typeof c?.name === "string" ? c.name : "",
      slug: typeof c?.slug === "string" ? c.slug : "",
      count: typeof c?.count === "number" ? c.count : 0,
    }))
    .filter((c) => c.name && c.slug);
  if (cats.length) await kvSet(b, CAT_NS, JSON.stringify(cats), CAT_TTL).catch(() => {});
  return cats;
}

/** XOR-deobfuscate one base64 `obf` string with the page NONCE. */
function deobfuscate(obf: string, nonce: string): string {
  const bin = Buffer.from(obf, "base64").toString("binary");
  let out = "";
  for (let i = 0; i < bin.length; i++) {
    out += String.fromCharCode(bin.charCodeAt(i) ^ nonce.charCodeAt(i % nonce.length));
  }
  return out;
}

/** One playable variant decoded from the embed page's obfuscated SOURCES
 *  table. `height` is the resolution (0 for the adaptive "Auto"/master). */
export interface ApijavVariant {
  label: string;
  url: string;
  height: number;
}

/**
 * Decode EVERY HLS variant out of an embed page's obfuscated SOURCES table
 * (Auto/master + 1080p/720p/…). The CDN (playergo.top) is a CORS-enabled
 * (`Access-Control-Allow-Origin: *`) VOD HLS, so the client plays these
 * DIRECTLY — native seeking works and switching quality is just swapping the
 * variant URL. Sorted highest-resolution first; the adaptive "Auto" (height 0)
 * sorts last. Segments are decoy-named (.jpeg) but hls.js ignores the
 * extension, so direct playback is unaffected.
 */
function extractHlsVariants(html: string): ApijavVariant[] {
  const nonce = html.match(/NONCE\s*=\s*["']([^"']+)["']/)?.[1];
  const srcRaw = html.match(/SOURCES\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!nonce || !srcRaw) return [];
  let sources: Array<{ obf?: string; label?: string }>;
  try { sources = JSON.parse(srcRaw); } catch { return []; }
  const seen = new Set<string>();
  const out: ApijavVariant[] = [];
  for (const s of sources) {
    const url = s.obf ? deobfuscate(s.obf, nonce).trim() : "";
    if (!/^https?:\/\/\S+\.m3u8/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const label = (s.label ?? "").trim();
    const height = parseInt(/(\d{3,4})p/.exec(label)?.[1] ?? "0", 10);
    out.push({ label: label || (height ? `${height}p` : "Auto"), url, height });
  }
  out.sort((a, b) => b.height - a.height); // highest first; Auto (0) last
  return out;
}

/** One entry in the client's quality ladder (matches the yt-dlp video shape so
 *  the player's existing quality button works unchanged). */
export interface ApijavQuality {
  height: number;
  vcodec: string;
  videoUrl: string;
  label: string;
}

export interface ApijavPlayback {
  /** Primary URL the player loads first — the 1080p rendition when present,
   *  else the highest explicit variant. */
  url: string;
  /** Label of the primary URL ("Auto" / "1080p") — drives the quality button's
   *  current selection. */
  quality: string;
  /** Full ladder for the quality switcher. */
  qualities: ApijavQuality[];
  title: string;
  posterUrl: string | null;
  durationSeconds: number | null;
}

/**
 * Resolve an apiJAV post id to its playable HLS variants by reading the embed
 * page and deobfuscating the stream table. Returns null if the page shape
 * changed or no stream could be decoded.
 */
export async function apijavResolve(
  baseUrl: string | undefined,
  postId: string,
  opts: ApijavOpts = {},
): Promise<ApijavPlayback | null> {
  const b = base(baseUrl);
  const post = await getJson(`${b}/wp-json/myvideo/v1/posts/${encodeURIComponent(postId)}`, opts);
  // The API returns embed_url HTML-encoded (`&#038;`/`&amp;` for `&`). Fetching
  // it verbatim mangles the `token` query param → 404 + a Cloudflare page, so
  // decode the ampersand entities first.
  const embedUrl: string | null = typeof post?.embed_url === "string"
    ? post.embed_url.replace(/&#0*38;/g, "&").replace(/&amp;/g, "&")
    : null;
  if (!embedUrl) return null;
  let html = "";
  try {
    const res = await fetch(embedUrl, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: `${b}/`, ...authHeaders(opts.apiKey) },
      signal: opts.signal,
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  const variants = extractHlsVariants(html);
  if (!variants.length) return null;

  // Explicit renditions only — drop the adaptive master ("Auto", height 0) so
  // the player doesn't ABR-jump. Default to 1080p, falling back to the highest
  // available. Keeps 720p/1080p in the switcher ladder.
  const renditions = variants.filter((v) => v.height > 0 && !/auto|master/i.test(v.label));
  const ladder = renditions.length ? renditions : variants;
  const primary = ladder.find((v) => v.height === 1080) ?? ladder[0]!;

  return {
    url: primary.url,
    quality: primary.label,
    qualities: ladder.map((v) => ({ height: v.height, vcodec: "h264", videoUrl: v.url, label: v.label })),
    title: typeof post?.title === "string" ? post.title : "",
    posterUrl: typeof post?.thumbnail === "string" ? post.thumbnail : null,
    durationSeconds: parseDuration(post?.duration),
  };
}
