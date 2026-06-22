/**
 * Rapidgator adult source.
 *
 * Rapidgator is a file host with no public content search, so we discover files
 * the way people do by hand: a `site:rapidgator.net <query>` web dork (run
 * through the bundled SearXNG) surfaces the public file pages, whose URLs look
 * like https://rapidgator.net/file/<hash>/<release>.mp4.html and whose titles
 * ARE the release name. We turn each into a search card.
 *
 * Playback: Real-Debrid is a Rapidgator premium-link host, so resolving is a
 * single POST /unrestrict/link → a direct, range-seekable CDN URL. That URL is
 * stashed as an `adult~<token>` play session so it gets the exact same
 * direct-play-then-transcode path every other adult source uses.
 *
 * This plugs into the EXISTING adult search/resolve handlers as another
 * provider (id prefix `rapidgator:`), mirroring apiJAV — no new endpoints.
 */
import type { AdultSearchResult } from "./search";
import type { AdultPlayback } from "./search";
import { webSearch } from "@vault/searxng";
import { createAdultPlaySession, probeAdultStream } from "./playback";
import { tpdbBestMatch, type TpdbResult } from "./tpdb";
import { logger } from "@vault/log";

const RD_HOST = "https://api.real-debrid.com/rest/1.0";

// Dead Rapidgator links (RD unrestrict returned 404 unavailable / 451
// infringing) — keyed by file hash so a future search drops them instead of
// offering the same broken card again. TTL'd because hosts occasionally
// re-list, and resolve is on-demand anyway.
const DEAD_NS = "rapidgator_dead";
const DEAD_TTL = 7 * 24 * 3600;

async function markDeadLink(fileUrl: string): Promise<void> {
  const parsed = parseRapidgatorUrl(fileUrl);
  if (!parsed) return;
  try {
    const { kvSet } = await import("@vault/db");
    await kvSet(parsed.hash, DEAD_NS, "1", DEAD_TTL);
  } catch {
    /* best-effort */
  }
}

/** Return the subset of file hashes currently flagged dead. */
async function deadHashes(hashes: string[]): Promise<Set<string>> {
  const dead = new Set<string>();
  if (hashes.length === 0) return dead;
  try {
    const { kvGet } = await import("@vault/db");
    await Promise.all(
      hashes.map(async (h) => {
        if (await kvGet(h, DEAD_NS).catch(() => null)) dead.add(h);
      }),
    );
  } catch {
    /* best-effort */
  }
  return dead;
}

/** Extensions we can actually stream (RD hands back the raw file). Split
 *  archives (.rar/.zip/.7z/.001/.part…) can't be played without extraction, so
 *  they're dropped from results. */
const VIDEO_EXT = /\.(mp4|mkv|avi|wmv|mov|m4v|ts|webm|mpg|mpeg|flv)$/i;
const ARCHIVE_EXT = /\.(rar|zip|7z|tar|gz|part\d*|r\d{2}|\d{3}|z\d{2})$/i;
const RES_RE = /\b(2160p|1440p|1080p|720p|480p|360p|4k|uhd)\b/i;
const VR_RE = /\b(vr|180x180|360x180|3dh|sbs|fisheye|mkx200|tb180|180_180)\b/i;
// Adult scene date stamps: "24.06.19", "2024.06.19", "24 06 19".
const DATE_RE = /\b((?:20)?\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})\b/;

interface ParsedFile {
  hash: string;
  /** Best filename we could recover (URL segment preferred, else result title). */
  filename: string;
}

/** Pull the file hash + filename out of a rapidgator file URL. Returns null for
 *  folder pages or anything that isn't a /file/ link. */
export function parseRapidgatorUrl(rawUrl: string): ParsedFile | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)rapidgator\.net$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/file\/([a-f0-9]{16,})(?:\/(.*))?$/i);
  if (!m) return null;
  const hash = m[1];
  let filename = "";
  if (m[2]) {
    try {
      filename = decodeURIComponent(m[2]);
    } catch {
      filename = m[2];
    }
    filename = filename.replace(/\.html?$/i, "").replace(/\/+$/, "").trim();
  }
  return { hash, filename };
}

/** Clean the "Download file X - Rapidgator" result title down to the release
 *  name, used only when the URL had no filename segment. */
function titleToFilename(title: string): string {
  return title
    .replace(/^download file\s*/i, "")
    .replace(/\s*[-–]\s*rapidgator.*$/i, "")
    .replace(/…|\.\.\./g, "") // drop the "…" truncation marker
    .trim();
}

interface ReleaseMeta {
  title: string;
  studio: string | null;
  date: string | null;
  resolution: string | null;
  isVr: boolean;
}

/** Parse a release filename into display title + badges. */
export function parseReleaseName(rawName: string): ReleaseMeta {
  const name = rawName.replace(VIDEO_EXT, "").trim();
  const resM = name.match(RES_RE);
  let resolution = resM ? resM[1].toLowerCase() : null;
  if (resolution === "4k" || resolution === "uhd") resolution = "2160p";
  const isVr = VR_RE.test(name);
  const dateM = name.match(DATE_RE);
  let date: string | null = null;
  if (dateM) {
    let [, y, mo, d] = dateM;
    if (y.length === 2) y = `20${y}`;
    date = `${y}-${mo}-${d}`;
  }
  // Studio guess: the leading dotted/spaced token(s) before the date stamp.
  let studio: string | null = null;
  const beforeDate = dateM ? name.slice(0, dateM.index ?? 0) : name;
  const lead = beforeDate.split(/[.\s_]+/).filter(Boolean)[0];
  if (lead && /^[A-Za-z][A-Za-z0-9&]+$/.test(lead)) studio = lead;
  // Human title: dots/underscores → spaces, strip codec/quality noise.
  const title = name
    .replace(/[._]+/g, " ")
    .replace(/\b(x264|x265|h264|h265|hevc|aac|mp4|web|dl|webrip|hd|sd|kvr|oculus|smartphone)\b/gi, "")
    .replace(RES_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*-\s*$/, "")
    .trim();
  return { title: title || rawName, studio, date, resolution, isVr };
}

function encodeId(url: string): string {
  return `rapidgator:${Buffer.from(url, "utf8").toString("base64url")}`;
}

export function decodeRapidgatorId(id: string): string | null {
  if (!id.startsWith("rapidgator:")) return null;
  try {
    const url = Buffer.from(id.slice("rapidgator:".length), "base64url").toString("utf8");
    return /^https?:\/\/(?:[a-z0-9-]+\.)?rapidgator\.net\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Whether the Rapidgator source should be offered. Gated on a Real-Debrid
 *  account (the only thing that can unrestrict the links); SearXNG is bundled,
 *  so we don't pay a live health probe on the hot search path — if it's down,
 *  the search just returns [] and logs. Use webSearchAvailable() for an explicit
 *  backend health check elsewhere. */
export async function rapidgatorAvailable(): Promise<boolean> {
  try {
    const { listStreamAccounts } = await import("@vault/db");
    return (await listStreamAccounts("debrid")).some(
      (a) => a.provider === "realdebrid" && !!a.api_key,
    );
  } catch {
    return false;
  }
}

/** Generic file-host page strings SearXNG sometimes returns as a result title
 *  (the file URL had no name segment, and the snippet head leaked in). These are
 *  NOT release names — without this guard they became junk cards titled
 *  "File size", "Downloading", "File", etc. */
const JUNK_TITLE_RE =
  /^(file|file ?size|filesize|download(ing)?|free download|copy to my files|rapidgator|folder|premium|fast,? safe)\b/i;

/** True when a recovered name plausibly IS a release (vs. a generic page
 *  fragment). Needs real length, must not be a known junk string, and must carry
 *  at least two alphanumeric tokens (a real release has studio + scene/date). */
function isPlausibleRelease(name: string): boolean {
  const n = name.trim();
  if (n.length < 6) return false;
  if (JUNK_TITLE_RE.test(n)) return false;
  const tokens = n.split(/[.\s_\-]+/).filter((t) => /[a-z0-9]/i.test(t));
  return tokens.length >= 2;
}

/** Bounded-concurrency map — keeps the per-search TPDB enrichment from firing
 *  dozens of requests at once (and tripping the 429 limiter). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

const TPDB_NS = "rapidgator_tpdb";
const TPDB_HIT_TTL = 7 * 24 * 3600; // posters rarely change once matched
const TPDB_MISS_TTL = 24 * 3600; // re-try misses daily (TPDB gains scenes)

/** Look the release name up on ThePornDB (`parse=`) for a poster + real
 *  metadata, with a kv_cache layer so repeat searches and re-opens don't re-hit
 *  the API. Returns the card unchanged when there's no token or no match. */
async function enrichWithTpdb(
  card: AdultSearchResult,
  releaseName: string,
  token: string,
  signal?: AbortSignal,
): Promise<AdultSearchResult> {
  if (!token) return card;
  const key = releaseName.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
  if (!key) return card;

  let match: TpdbResult | null = null;
  try {
    const { kvGet, kvSet } = await import("@vault/db");
    const cached = await kvGet(key, TPDB_NS).catch(() => null);
    if (cached != null) {
      match = cached === "" ? null : (JSON.parse(cached) as TpdbResult);
    } else {
      // NO year param — it over-narrows adult scene matches (see the catalog
      // enrich note), dropping the correct scene. Try scenes first (most
      // releases), then fall back to movies — some Rapidgator releases are full
      // features TPDB only indexes under /movies, so a scenes-only lookup left
      // them poster-less.
      match = await tpdbBestMatch(releaseName, { token, contentType: "scenes", signal }).catch(() => null);
      if (!match) {
        match = await tpdbBestMatch(releaseName, { token, contentType: "movies", signal }).catch(() => null);
      }
      await kvSet(key, TPDB_NS, match ? JSON.stringify(match) : "", match ? TPDB_HIT_TTL : TPDB_MISS_TTL).catch(() => {});
    }
  } catch {
    return card;
  }
  if (!match) return card;

  return {
    ...card,
    // Keep the rapidgator: id (resolve unrestricts THAT file) — only the display
    // metadata comes from TPDB.
    title: match.title || card.title,
    posterUrl: match.posterUrl ?? card.posterUrl,
    backgroundUrl: match.backgroundUrl ?? card.backgroundUrl,
    date: match.date ?? card.date,
    year: match.date ? Number(match.date.slice(0, 4)) : card.year,
    performers: match.performers.length ? match.performers : card.performers,
    studio: match.studio ?? card.studio,
    description: match.description ?? card.description,
    rating: match.rating ?? card.rating,
    durationSeconds: match.durationSeconds ?? card.durationSeconds,
    contentType: match.contentType ?? card.contentType,
  };
}

/**
 * Search Rapidgator via the `site:rapidgator.net` dork. Returns playable-file
 * cards (archives + folder pages + generic non-release pages filtered out),
 * deduped by file hash, then enriched with ThePornDB metadata (poster,
 * performers, studio, …) when a token is configured.
 */
export async function rapidgatorSearch(
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AdultSearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  // Pull several pages in parallel — a single SearXNG page only returns ~10–30
  // hits (far fewer than a manual Google `site:` dork shows), and most are
  // folder pages / dup hashes that filter out, so one page left us with a
  // handful of cards. 3 pages widens the net without serial latency.
  const dork = `site:rapidgator.net ${q}`;
  const pages = await Promise.all(
    [1, 2, 3].map((page) =>
      webSearch(dork, { limit: 40, page, signal: opts.signal }).catch(() => []),
    ),
  );
  const results = pages.flat();

  const raw: { url: string; hash: string; filename: string }[] = [];
  const seen = new Set<string>();
  const seenUrls = new Set<string>();
  for (const r of results) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    const parsed = parseRapidgatorUrl(r.url);
    if (!parsed) continue; // folder page or non-file link
    if (seen.has(parsed.hash)) continue;
    const filename = parsed.filename || titleToFilename(r.title);
    if (!filename || !isPlausibleRelease(filename)) continue; // junk fragment
    // Keep only streamable single files: an explicit video extension, OR no
    // extension at all (the page often omits it). Drop archives outright.
    const hasExt = /\.[a-z0-9]{2,4}$/i.test(filename);
    if (ARCHIVE_EXT.test(filename)) continue;
    if (hasExt && !VIDEO_EXT.test(filename)) continue;
    seen.add(parsed.hash);
    raw.push({ url: r.url, hash: parsed.hash, filename });
  }

  // Drop links we already know are dead (RD returned 404/451 on a prior
  // resolve) so the user never sees the same broken card twice.
  const dead = await deadHashes(raw.map((r) => r.hash));
  const live = dead.size ? raw.filter((r) => !dead.has(r.hash)) : raw;

  // Token for the TPDB enrichment pass (poster + metadata). Missing token just
  // yields un-enriched cards (text only), never an error.
  let token = "";
  try {
    const { getAddonConfig } = await import("@vault/db");
    token = (await getAddonConfig()).theporndb_api_key || "";
  } catch {
    /* db not ready — enrich is skipped */
  }

  const cards = await mapLimit(live, 6, async ({ url, hash, filename }) => {
    const meta = parseReleaseName(filename);
    const base: AdultSearchResult = {
      id: encodeId(url),
      kind: "scene",
      contentType: null,
      uuid: hash,
      title: meta.title,
      posterUrl: null,
      backgroundUrl: null,
      date: meta.date,
      year: meta.date ? Number(meta.date.slice(0, 4)) : null,
      performers: [],
      studio: meta.studio,
      description: null,
      rating: null,
      durationSeconds: null,
      source: "rapidgator",
      resolution: meta.resolution,
      isVr: meta.isVr,
    };
    return enrichWithTpdb(base, filename, token, opts.signal);
  });

  // SearXNG scrapes Google/Bing/DDG, which throttle datacenter IPs — so the
  // same query swings between ~9 and ~23 cards run-to-run (page 3 often comes
  // back empty). Union this run with a short-lived per-query cache so a good
  // run's coverage STICKS and a subsequently throttled run can't drop the user
  // back to a handful of cards. Merge by file hash, preferring whichever copy
  // carries a TPDB poster; fresh wins ties. Capped + TTL'd so dead links age
  // out (resolve is on-demand anyway).
  const CARDS_NS = "rapidgator_cards";
  const CARDS_TTL = 90 * 60; // 90 min
  const CARDS_CAP = 60;
  let merged = cards;
  try {
    const { kvGet, kvSet } = await import("@vault/db");
    const cacheKey = q.toLowerCase().replace(/\s+/g, " ").trim();
    const prevRaw = await kvGet(cacheKey, CARDS_NS).catch(() => null);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw) as AdultSearchResult[];
      const byHash = new Map<string, AdultSearchResult>();
      // Seed with cached, then overlay fresh — fresh wins ties, but a poster
      // (from either run) is never lost.
      for (const c of [...prev, ...cards]) {
        const ex = byHash.get(c.uuid);
        if (!ex || (!ex.posterUrl && c.posterUrl)) byHash.set(c.uuid, c);
      }
      merged = Array.from(byHash.values()).slice(0, CARDS_CAP);
    }
    // Cached cards can include links that have since gone dead — drop them so a
    // stale cache can't resurface a broken result.
    if (dead.size) merged = merged.filter((c) => !dead.has(c.uuid));
    await kvSet(cacheKey, CARDS_NS, JSON.stringify(merged), CARDS_TTL).catch(() => {});
  } catch {
    /* cache best-effort — fall back to this run's cards */
  }

  const enriched = merged.filter((c) => !!c.posterUrl).length;
  logger.info(
    "adult",
    `Rapidgator search "${q}": ${results.length} hits → ${cards.length} fresh / ${merged.length} merged cards (${enriched} with TPDB poster)`,
  );
  return merged;
}

interface RdUnrestrict {
  download?: string;
  filename?: string;
  filesize?: number;
  mimeType?: string;
}

/**
 * Resolve a `rapidgator:<…>` card id to a playable handle: RD-unrestrict the
 * file URL, then stash it as an adult play session for the direct-play +
 * transcode-fallback path. Returns null when the link is dead/unsupported.
 */
export async function rapidgatorResolve(id: string): Promise<AdultPlayback | null> {
  const url = decodeRapidgatorId(id);
  if (!url) return null;

  const { listStreamAccounts } = await import("@vault/db");
  const accounts = await listStreamAccounts("debrid");
  const rd =
    accounts.find((a) => a.provider === "realdebrid" && a.enabled === 1 && !!a.api_key) ??
    accounts.find((a) => a.provider === "realdebrid" && !!a.api_key);
  if (!rd?.api_key) {
    logger.warn("adult", "Rapidgator resolve: no Real-Debrid account configured");
    return null;
  }

  let data: RdUnrestrict | null = null;
  try {
    const res = await fetch(`${RD_HOST}/unrestrict/link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rd.api_key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ link: url }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn("adult", `Rapidgator unrestrict → HTTP ${res.status}: ${body.slice(0, 120)}`);
      // 404 unavailable_file / 451 infringing_file = the link is permanently
      // dead — remember it so it stops coming back in search results.
      if (res.status === 404 || res.status === 451) await markDeadLink(url);
      return null;
    }
    data = (await res.json()) as RdUnrestrict;
  } catch (e) {
    logger.warn("adult", `Rapidgator unrestrict errored: ${(e as Error)?.message ?? e}`);
    return null;
  }
  if (!data?.download) return null;

  // RD reveals the REAL filename here — the page/search card often hid the
  // extension, so this is where we first learn a "result" is actually a split
  // archive (…part1.rar). Those can't be streamed (ffmpeg: "Invalid data found
  // when processing input"), so reject before handing the player a dead URL.
  const filename = data.filename ?? parseRapidgatorUrl(url)?.filename ?? "";
  if (ARCHIVE_EXT.test(filename)) {
    logger.warn("adult", `Rapidgator resolve skipped archive file: ${filename}`);
    return null;
  }

  // Probe the unrestricted URL for the real duration (kills the 4h placeholder
  // that shrank while seeking) + a stream summary for the media-info chip. A
  // successful probe with NO video stream means it isn't a playable video
  // (hidden-extension archive / audio-only / corrupt) → reject. A failed/timed-
  // out probe is inconclusive, so we still allow playback (transcode fallback).
  const probe = await probeAdultStream(data.download);
  if (probe && !probe.hasVideo) {
    logger.warn("adult", `Rapidgator resolve skipped non-video file: ${filename}`);
    return null;
  }
  const durationSeconds = probe?.durationSeconds ?? 0;
  const streamInfo = probe?.streamInfo ?? null;

  const meta = parseReleaseName(filename);
  const itemId = await createAdultPlaySession({
    url: data.download,
    durationSeconds, // real probed runtime (0 only when the probe was inconclusive)
    title: meta.title,
    posterUrl: null,
    infoHash: null,
    streamInfo,
  });

  return {
    url: data.download,
    itemId,
    durationTicks: Math.max(0, Math.round(durationSeconds * 10_000_000)),
    title: meta.title || filename,
    posterUrl: null,
    infoHash: null,
    streamInfo,
  };
}
