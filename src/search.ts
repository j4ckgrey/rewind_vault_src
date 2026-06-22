/**
 * Adult library search & resolve.
 *
 * SEARCH is metadata-first, exactly like every other library: the query goes
 * straight to ThePornDB (`q=`) and we return the scene / movie / JAV / performer
 * cards TPDB gives back. No torrents involved — so the results look like the
 * ThePornDB site, not "whatever happens to be cached".
 *
 * RESOLVE happens lazily when the user opens a card: we take the TPDB record
 * (title / studio / performers / JAV code) and go hunting for a playable stream
 *   TPDB item → build queries → Zilean DMM search → keep adult hits
 *             → resolve on TorBox on-demand (largest first) → playback session
 * and hand the client a synthetic `adult~<token>` item id it can transcode.
 *
 * Everything is best-effort: a missing key / indexer / dead release just
 * yields an empty result rather than an error.
 */
import {
  getAddonConfig,
  getStreamAccount,
  listAdultStreamSources,
  listStreamAccounts,
  parseAdultConfig,
  type LibraryRow,
  type StreamAccountRow,
  type StreamSourceRow,
} from "@vault/db";
import { logger } from "@vault/log";
import { TorBoxResolver } from "@forge";
import type { StreamCandidate } from "@forge";
import { detectVr, parseResolutionLabel } from "./parse";
import { createAdultPlaySession } from "./playback";
import {
  tpdbGetById,
  tpdbSearchPerformers,
  tpdbSearchText,
  type TpdbContentType,
  type TpdbResult,
} from "./tpdb";
import { zileanSearch } from "./zilean";

export type AdultResultKind = "scene" | "movie" | "jav" | "performer";

/** One card in the library search grid — TPDB metadata, no stream yet. */
export interface AdultSearchResult {
  /** Stable id the client echoes back to resolve: `tpdb:<ct>:<uuid>` (or
   *  `performer:<uuid>`). */
  id: string;
  kind: AdultResultKind;
  /** TPDB content type for resolve; null for performer cards. */
  contentType: TpdbContentType | null;
  uuid: string;
  title: string;
  posterUrl: string | null;
  backgroundUrl: string | null;
  date: string | null;
  year: number | null;
  performers: string[];
  studio: string | null;
  description: string | null;
  rating: number | null;
  durationSeconds: number | null;
  /** Which provider produced this card — drives the resolve path and the card
   *  badge. Defaults to "tpdb" when absent (back-compat). "catalog" = a local
   *  Western catalog entry (a specific torrent we already know exists). */
  source?: "tpdb" | "apijav" | "catalog" | "rapidgator";
  /** Parsed studio/product code (e.g. "SSIS-698"), when known. */
  code?: string | null;
  /** Catalog cards only: the torrent the card resolves to. */
  sizeBytes?: number | null;
  infoHash?: string | null;
  /** Parsed resolution of the (default) release, e.g. "2160p" / "1080p".
   *  Drives the quality badge on catalog cards. null when unparseable. */
  resolution?: string | null;
  /** True when the release looks like VR (studio/tag/projection markers in the
   *  release name). Drives the VR badge. */
  isVr?: boolean;
  /** Catalog cards only, and ONLY when the Forge "cached only" pref is on:
   *  TorBox confirmed THIS hash is cached in a FRESH check at search time
   *  (drives an honest "Cached" badge). Absent when cached-only is off — then
   *  resolve is on-demand and the badge would be a lie. */
  cached?: boolean;
}

/** What AdultResolve returns: a playable handle for the client's player. */
export interface AdultPlayback {
  /** Direct debrid URL — try this first (fast path for MP4/H264/AAC). */
  url: string;
  /** Synthetic item id for the transcode fallback (`adult~<token>`). */
  itemId: string;
  durationTicks: number;
  title: string;
  posterUrl: string | null;
  infoHash: string | null;
  /** Probed stream summary (resolution/codecs) for the media-info chip. */
  streamInfo?: import("./playback").AdultStreamInfo | null;
}

/** The debrid accepted the torrent but it isn't downloaded yet (on-demand
 *  resolve of an uncached release). Surfaced to the client as "downloading —
 *  try again shortly" instead of a dead 404. */
export interface AdultQueuedResolve {
  queued: true;
  title: string;
  /** Debrid state ("downloading", "checking", …) when known. */
  state: string | null;
  /** Download progress 0–100, when known. */
  progress: number | null;
}

const JAV_CODE = /\b([A-Z]{2,6})-?(\d{2,5})\b/;

/**
 * Whether "cached on debrid only" mode is on for the adult library.
 *
 * By default the adult library INHERITS the Forge "Cached on debrid only"
 * toggle (`stream_preferences.exclude_uncached`). But the adult integration
 * card has its own independent override: when `adult_cached_override` is set,
 * `adult_cached_only` wins regardless of the Forge value — so you can run the
 * adult library cached-only (or on-demand) without changing your main pipeline.
 *
 * ON  → only show/play releases TorBox has cached right now (no on-demand
 *       downloads); OFF → on-demand (show everything, queue uncached).
 */
export async function adultCachedOnly(): Promise<boolean> {
  try {
    const { getAddonConfig, getStreamPreferences } = await import("@vault/db");
    const cfg = await getAddonConfig();
    if (cfg.adult_cached_override === "1") {
      return cfg.adult_cached_only === "1";
    }
    const { DEFAULT_USER_ID } = await import("@forge");
    const prefs = await getStreamPreferences(DEFAULT_USER_ID);
    return prefs.exclude_uncached === 1;
  } catch {
    return false;
  }
}

function debridAccountId(sources?: string[]): string | null {
  for (const s of sources ?? []) if (s.startsWith("debrid:")) return s.slice("debrid:".length);
  return null;
}

/** Uppercase alphanumerics only — for code/title matching that ignores spaces,
 *  dots, dashes and case ("SSIS-423" ≡ "ssis.423" ≡ "SSIS423"). */
function alnum(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
}

/** One torrent candidate from an adult backend (Zilean / Torznab). `adult` is
 *  RTN's XXX detection (Zilean) or implied true for an XXX-configured Torznab. */
export interface AdultTorrent {
  infoHash: string;
  rawTitle: string;
  sizeBytes: number | null;
  adult: boolean;
}

// A mainstream release fingerprint: a 4-digit year next to a scene-group/source
// tag. Real adult scenes don't look like this (they're dated "24 06 16", carry
// no year, or are flagged adult by RTN). Used to reject films that merely share
// a performer surname — e.g. "Bangkok Dangerous 2000 1080p BluRay" for the
// performer "Jessica Bangkok".
const MAINSTREAM_FINGERPRINT =
  /\b(19|20)\d{2}\b[\s\S]*\b(blu-?ray|web-?dl|web-?rip|hdrip|brrip|bdrip|dvdrip|hdtv|x264|x265|h\.?264|h\.?265|hevc|amzn|hmax|dsnp|nf|atvp|rarbg|yts|yify)\b/i;

/**
 * Decide whether a torrent name actually IS the opened TPDB item. The backends
 * are fuzzy (querying "SSIS-423" returns SSIS-804/369; "Jessica Bangkok" returns
 * "Bangkok Dangerous"), so this is the guard that stops us resolving to the
 * wrong — and worse, mainstream — video:
 *   • JAV   — strict exact-code match (RTN often misses the adult flag on JAV).
 *   • scenes/movies — must carry a REAL adult signal: RTN's adult flag, OR (when
 *     unflagged) it must not look like a mainstream release AND must match both
 *     a studio AND a performer token (one alone is a coincidence magnet).
 */
export function isRelevant(meta: TpdbResult, t: AdultTorrent): boolean {
  const hay = t.rawTitle;
  if (meta.contentType === "jav") {
    const m = JAV_CODE.exec(meta.title);
    if (!m) return false;
    const code = alnum(`${m[1]}${m[2]}`); // e.g. SSIS423
    return alnum(hay).includes(code);
  }

  // Without an adult signal, reject anything that smells like a mainstream rip.
  if (!t.adult && MAINSTREAM_FINGERPRINT.test(hay)) return false;

  const hayWords = new Set(words(hay));
  const studioHit = !!(meta.studio && words(meta.studio).some((w) => hayWords.has(w)));
  const performerHit = meta.performers.some((p) => words(p).some((w) => hayWords.has(w)));

  if (meta.contentType === "movies") {
    const titleWords = words(meta.title);
    const coverage = titleWords.length
      ? titleWords.filter((w) => hayWords.has(w)).length / titleWords.length
      : (alnum(hay).includes(alnum(meta.title)) ? 1 : 0);
    if (coverage < 0.6) return false;
    // Title matched; require adult corroboration (flag or studio) so a same-named
    // mainstream film can't slip through.
    return t.adult || studioHit;
  }

  // scenes — the opened performer must appear in the release (matching the
  // studio alone would accept ANY scene from that studio), plus an adult signal
  // (RTN's flag or the studio name). When TPDB lists no performers we can't pin
  // the performer, so fall back to adult-flag AND studio.
  if (!meta.performers.length) return t.adult && studioHit;
  return performerHit && (t.adult || studioHit);
}

// TV-series episode tags that mark a resolved file as a mainstream show rather
// than an adult title (the "I clicked a stream and got a Netflix episode" case).
// Checked ONLY when there's no performer/studio/title hit, so adult content that
// happens to be episodic (Hotel Vixen — which always carries its performer/studio)
// isn't caught. Covers: S04E01 / S4.E1, 1x05, and the spelled "Season N" /
// "Episode N" / "complete series" forms. We deliberately avoid the year+codec
// `MAINSTREAM_FINGERPRINT` here — adult parody films legitimately share it.
const TV_EPISODE_MARKER =
  /\bS\d{1,2}[\s._-]?E\d{1,3}\b|\b\d{1,2}x\d{2}\b|\b(?:season|episode)[\s._-]?\d{1,3}\b|\bcomplete[\s._-](?:series|season)\b/i;

/**
 * After a torrent resolves, sanity-check the ACTUAL file name against the item.
 * DMM hashlists occasionally map a release name onto a hash whose cached debrid
 * content is unrelated (a mainstream TV show), which slips past `isRelevant`
 * (that only sees the release name). This is the last line of defence and is
 * deliberately LENIENT — it must not block legit movies/scenes/JAV:
 *   • Any positive signal (JAV code / performer / studio / title-word hit) →
 *     accept outright.
 *   • Otherwise accept too, UNLESS the name carries a TV-episode marker — the
 *     one pattern adult content never uses, so it's the safe thing to reject.
 */
export function fileNameMatchesMeta(
  meta: Pick<TpdbResult, "contentType" | "title" | "studio" | "performers">,
  fileName: string,
): boolean {
  if (!fileName.trim()) return true; // nothing to check → don't block
  const hayWords = new Set(words(fileName));
  const studioHit = !!(meta.studio && words(meta.studio).some((w) => hayWords.has(w)));
  const performerHit = meta.performers.some((p) => words(p).some((w) => hayWords.has(w)));

  if (meta.contentType === "jav") {
    const m = JAV_CODE.exec(meta.title);
    if (m && alnum(fileName).includes(alnum(`${m[1]}${m[2]}`))) return true;
  } else {
    const titleWords = words(meta.title);
    const titleHit =
      titleWords.length > 0 &&
      titleWords.filter((w) => hayWords.has(w)).length / titleWords.length >= 0.5;
    if (performerHit || studioHit || titleHit) return true;
  }

  // No positive signal — block only the unambiguous mainstream-TV case.
  return !TV_EPISODE_MARKER.test(fileName);
}

function yearOf(meta: TpdbResult): number | null {
  return meta.date ? parseInt(meta.date.slice(0, 4), 10) || null : null;
}

function toCard(meta: TpdbResult): AdultSearchResult {
  return {
    id: `tpdb:${meta.contentType}:${meta.uuid}`,
    kind: meta.contentType === "movies" ? "movie" : meta.contentType === "jav" ? "jav" : "scene",
    contentType: meta.contentType,
    uuid: meta.uuid,
    title: meta.title,
    posterUrl: meta.posterUrl,
    backgroundUrl: meta.backgroundUrl,
    date: meta.date,
    year: yearOf(meta),
    performers: meta.performers,
    studio: meta.studio,
    description: meta.description,
    rating: meta.rating,
    durationSeconds: meta.durationSeconds,
  };
}

/**
 * Library search — TPDB free-text catalog search across the configured content
 * types, plus matching performers. Returns metadata cards exactly as ThePornDB
 * orders them.
 */
export async function adultSearch(
  library: LibraryRow,
  query: string,
  opts: { types?: TpdbContentType[]; signal?: AbortSignal } = {},
): Promise<AdultSearchResult[]> {
  const { types, signal } = opts;
  const cfg = parseAdultConfig(library);
  const appCfg = await getAddonConfig();
  const token = appCfg.theporndb_api_key || cfg.tpdbToken;
  if (!token || !query.trim()) return [];

  // The caller's checked subset wins; otherwise everything the library has.
  const contentTypes: TpdbContentType[] = (types?.length
    ? types
    : cfg.contentTypes?.length
      ? cfg.contentTypes
      : ["scenes", "movies", "jav"]) as TpdbContentType[];

  // Fan out: two catalog pages per content type (TPDB returns 20/page — a single
  // page felt sparse) + a performer search, all in parallel. Each is best-effort
  // (a failure just contributes nothing).
  const [perTypeLists, performers] = await Promise.all([
    Promise.all(
      contentTypes.map(async (ct) => {
        const [p1, p2] = await Promise.all([
          tpdbSearchText(query, { token, contentType: ct, signal }),
          tpdbSearchText(query, { token, contentType: ct, page: 2, signal }),
        ]);
        return [...p1, ...p2];
      }),
    ),
    tpdbSearchPerformers(query, { token, signal }),
  ]);

  const cards: AdultSearchResult[] = [];

  // Performer cards lead — typing a name should surface the performer first.
  for (const p of performers.slice(0, 8)) {
    cards.push({
      id: `performer:${p.uuid}`,
      kind: "performer",
      contentType: null,
      uuid: p.uuid,
      title: p.name,
      posterUrl: p.imageUrl,
      backgroundUrl: null,
      date: null,
      year: null,
      performers: [],
      studio: null,
      description: p.details,
      rating: null,
      durationSeconds: null,
    });
  }

  // Interleave content types so one type doesn't dominate the top of the grid.
  const seen = new Set<string>();
  let idx = 0;
  let added = true;
  while (added) {
    added = false;
    for (const list of perTypeLists) {
      const meta = list[idx];
      if (!meta) continue;
      added = true;
      const card = toCard(meta);
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      cards.push(card);
    }
    idx++;
  }

  return cards;
}

/** Build a small, ordered list of Zilean queries to find a stream for a TPDB
 *  record. Most-specific first so we stop at the first cached hit. */
function buildResolveQueries(meta: TpdbResult): string[] {
  const out: string[] = [];
  const push = (q: string | null | undefined) => {
    const v = (q ?? "").replace(/\s{2,}/g, " ").trim();
    if (v && !out.some((e) => e.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  if (meta.contentType === "jav") {
    // JAV titles are usually the code itself ("SSIS-423"); the code is the
    // single most reliable torrent query.
    const code = meta.title.match(JAV_CODE)?.[0];
    push(code);
    push(meta.title);
  } else if (meta.contentType === "movies") {
    push(meta.title);
    if (meta.studio) push(`${meta.title} ${meta.studio}`);
  } else {
    // Scenes are individual clips — studio + performer is the strongest signal,
    // then performer pairs, then the scene title.
    const p0 = meta.performers[0];
    const p1 = meta.performers[1];
    if (meta.studio && p0) push(`${meta.studio} ${p0}`);
    if (p0 && p1) push(`${p0} ${p1}`);
    push(meta.title);
    if (p0) push(`${p0} ${meta.title}`);
  }
  return out.slice(0, 4);
}

/**
 * Search the configured Adult Forge backends for a query and return deduped
 * torrent candidates. Zilean is the primary text-search backend; a Torznab
 * (Prowlarr/Jackett) adult source is queried too when present, its hits treated
 * as adult-by-configuration. The library's legacy `zileanUrl` is used as a
 * fallback when no Forge adult source is configured (back-compat).
 *
 * NOTE: we intentionally never read the global `addon_config.zilean_url` here —
 * that belongs to the normal pipeline and was historically pointed at a Comet
 * manifest, which broke adult resolve entirely.
 */
async function searchAdultBackends(
  sources: StreamSourceRow[],
  fallbackZileanUrl: string | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<AdultTorrent[]> {
  const out: AdultTorrent[] = [];
  const seen = new Set<string>();
  const push = (infoHash: string, rawTitle: string, sizeBytes: number | null, adult: boolean) => {
    const h = (infoHash || "").toLowerCase();
    if (!h || !rawTitle || seen.has(h)) return;
    seen.add(h);
    out.push({ infoHash: h, rawTitle, sizeBytes, adult });
  };

  const zileanUrls = sources
    .filter((s) => s.source_type === "zilean" && s.url)
    .map((s) => s.url!) as string[];
  if (!zileanUrls.length && fallbackZileanUrl) zileanUrls.push(fallbackZileanUrl);
  for (const url of zileanUrls) {
    const z = await zileanSearch(url, query, { signal, limit: 80 });
    for (const t of z) push(t.infoHash, t.rawTitle, t.sizeBytes, t.adult);
  }

  // Torznab/Jackett adult sources (XXX categories). Reuse the generic Torznab
  // adapter with a free-text query; flag every hit adult (the source is XXX).
  const torznab = sources.filter((s) => s.source_type === "torznab" && s.url);
  if (torznab.length) {
    const { TorznabSource } = await import("@forge");
    for (const s of torznab) {
      try {
        const cands = await new TorznabSource(s).search({ kind: "movie", title: query }, signal);
        for (const c of cands) if (c.infoHash) push(c.infoHash, c.rawTitle, c.sizeBytes ?? null, true);
      } catch { /* best-effort — a down indexer contributes nothing */ }
    }
  }

  return out;
}

/** Pick a usable TorBox debrid resolver: the library's own debrid account if it
 *  is TorBox, else any enabled TorBox debrid account in the Forge. */
async function pickTorBox(
  cfg: ReturnType<typeof parseAdultConfig>,
  signal?: AbortSignal,
): Promise<{ resolver: TorBoxResolver; accId: string } | null> {
  void signal;
  let accId = debridAccountId(cfg.sources);
  let account: StreamAccountRow | null = (accId ? await getStreamAccount(accId) : null) ?? null;
  if (!account || account.provider !== "torbox") {
    const debrids = await listStreamAccounts("debrid");
    account = debrids.find((a) => a.provider === "torbox" && a.enabled === 1) ?? null;
    accId = account?.id ?? null;
  }
  if (!account || account.provider !== "torbox" || !accId) return null;
  return { resolver: new TorBoxResolver(account), accId };
}

/** One stream option for an adult item — surfaced to the client so the user
 *  can pick a release instead of us blindly auto-resolving a single
 *  (possibly broken) pick. Resolution happens on-demand when picked. */
export interface AdultStreamOption {
  infoHash: string;
  rawTitle: string;
  sizeBytes: number | null;
  /** Parsed resolution ("2160p" / "1080p" / …) for the picker, when known. */
  resolution?: string | null;
  /** True when the release name looks like VR. */
  isVr?: boolean;
}

/** Wrap an adult torrent as a generic StreamCandidate for the TorBox resolver.
 *  `sourceId`/`name` are cosmetic — the resolver only ever reads `infoHash`. */
function toStreamCandidate(
  t: { infoHash: string; rawTitle: string; sizeBytes: number | null },
  accId: string,
): StreamCandidate {
  return {
    id: t.infoHash,
    sourceType: "zilean",
    sourceId: accId,
    name: "adult",
    description: t.rawTitle,
    rawTitle: t.rawTitle,
    infoHash: t.infoHash,
    sizeBytes: t.sizeBytes ?? undefined,
  };
}

interface AdultResolveContext {
  meta: TpdbResult;
  adultSources: StreamSourceRow[];
  cfg: ReturnType<typeof parseAdultConfig>;
  resolver: TorBoxResolver;
  accId: string;
}

/** Shared prerequisites for both listing and resolving an adult item: a TPDB
 *  token + record, at least one adult backend, and a usable TorBox debrid.
 *  Returns null (best-effort) when any of those is missing. */
async function adultResolveContext(
  library: LibraryRow,
  itemId: string,
  signal?: AbortSignal,
): Promise<AdultResolveContext | null> {
  const m = /^tpdb:(scenes|movies|jav):(.+)$/.exec(itemId);
  if (!m) return null;
  const contentType = m[1] as TpdbContentType;
  const uuid = m[2]!;

  const cfg = parseAdultConfig(library);
  const appCfg = await getAddonConfig();
  const token = appCfg.theporndb_api_key || cfg.tpdbToken;
  if (!token) {
    logger.warn("adult", "resolve skipped: no ThePornDB token configured");
    return null;
  }

  // Torrent backends: the Adult Forge sources, falling back to the library's own
  // legacy zileanUrl. Nothing to search → nothing to resolve.
  const adultSources = await listAdultStreamSources();
  if (!adultSources.length && !cfg.zileanUrl) {
    logger.warn("adult", "resolve skipped: no adult stream sources configured (add a Zilean/Torznab source under Streams → Adult)");
    return null;
  }

  const meta = await tpdbGetById(uuid, { token, contentType, signal });
  if (!meta) {
    logger.warn("adult", `resolve skipped: ThePornDB had no record for ${itemId}`);
    return null;
  }

  const torbox = await pickTorBox(cfg, signal);
  if (!torbox) {
    logger.warn("adult", `${meta.title} — resolve skipped: no enabled TorBox debrid found`);
    return null;
  }
  return { meta, adultSources, cfg, resolver: torbox.resolver, accId: torbox.accId };
}

/**
 * Find every relevant release for a TPDB item — largest first.
 *
 * Runs the ordered queries, keeps only relevant hits (the backends are fuzzy)
 * and dedupes. When the Forge "cached only" toggle is on, a single batched
 * TorBox check then keeps ONLY cached releases (so resolve plays instantly and
 * never queues a download); otherwise resolution is on-demand, exactly like the
 * normal debrid pipeline.
 */
async function gatherCandidates(
  ctx: AdultResolveContext,
  signal?: AbortSignal,
): Promise<AdultStreamOption[]> {
  const { meta, adultSources, cfg, resolver, accId } = ctx;
  const queries = buildResolveQueries(meta);

  // Union the relevant hits across every query (deduped by hash). The old code
  // stopped at the first query with a hit, which threw away better releases
  // surfaced by a more specific query.
  const relevant = new Map<string, AdultTorrent>();
  for (const q of queries) {
    const torrents = await searchAdultBackends(adultSources, cfg.zileanUrl, q, signal);
    for (const t of torrents) {
      if (!relevant.has(t.infoHash) && isRelevant(meta, t)) relevant.set(t.infoHash, t);
    }
    if (relevant.size >= 40) break; // plenty to pick from — stop hammering
  }

  let pool = [...relevant.values()]
    .slice(0, 60)
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  if (!pool.length) {
    logger.warn("adult", `${meta.title} — 0 relevant torrents from ${queries.length} quer${queries.length === 1 ? "y" : "ies"} [${queries.join(" | ")}]`);
    return [];
  }

  if (await adultCachedOnly()) {
    const map = await resolver.checkAvailability(pool.map((t) => toStreamCandidate(t, accId)), signal);
    pool = pool.filter((t) => map.get(t.infoHash) === true);
    logger[pool.length ? "info" : "warn"]("adult", `${meta.title} — ${pool.length} cached (cached-only mode)`);
    if (!pool.length) return [];
  } else {
    logger.info("adult", `${meta.title} — ${pool.length} relevant release(s)`);
  }
  return pool.map((t) => ({
    infoHash: t.infoHash,
    rawTitle: t.rawTitle,
    sizeBytes: t.sizeBytes,
    resolution: parseResolutionLabel(t.rawTitle),
    isVr: detectVr(t.rawTitle),
  }));
}

/**
 * List all streams for a TPDB item id (`tpdb:<ct>:<uuid>`). Returns an empty
 * list when nothing relevant can be found. No URL is resolved here — the
 * client resolves the one it picks via {@link adultResolveItem}.
 */
export async function adultListStreams(
  library: LibraryRow,
  itemId: string,
  signal?: AbortSignal,
): Promise<AdultStreamOption[]> {
  const ctx = await adultResolveContext(library, itemId, signal);
  if (!ctx) return [];
  return gatherCandidates(ctx, signal);
}

/**
 * Resolve a TPDB item id (`tpdb:<ct>:<uuid>`) to a playable stream and create a
 * playback session. Returns null when nothing can be played.
 *
 * `opts.hash` resolves a SPECIFIC release the user picked from the stream list;
 * otherwise we walk every relevant release (largest first) and play the first
 * that yields a working URL — so one dud pick no longer dead-ends the whole
 * title the way the old single-"best" pick did.
 */
export async function adultResolveItem(
  library: LibraryRow,
  itemId: string,
  signal?: AbortSignal,
  opts?: { hash?: string },
): Promise<AdultPlayback | AdultQueuedResolve | null> {
  const ctx = await adultResolveContext(library, itemId, signal);
  if (!ctx) return null;
  const { meta, resolver, accId } = ctx;

  const order: AdultStreamOption[] = opts?.hash
    ? [{ infoHash: opts.hash.toLowerCase(), rawTitle: meta.title, sizeBytes: null }]
    : await gatherCandidates(ctx, signal);
  if (!order.length) return null;

  // Every attempt ADDS the torrent to the debrid account (that's how on-demand
  // works), so cap the auto-walk — we don't want one tap to queue 60 downloads.
  let queued: AdultQueuedResolve | null = null;
  for (const opt of order.slice(0, 5)) {
    const ref = opt.infoHash.slice(0, 8);
    const detailed = await resolver.resolveDetailed(toStreamCandidate(opt, accId), signal);
    if (detailed && "queued" in detailed) {
      // Downloading on the debrid — remember the first (largest) one and keep
      // looking for an already-complete release.
      logger.info("adult", `${meta.title} — ${ref} queued on TorBox (${detailed.state ?? "?"} ${detailed.progress ?? 0}%, ${detailed.seeds ?? "?"} seeds)`);
      queued ??= { queued: true, title: meta.title, state: detailed.state, progress: detailed.progress };
      continue;
    }
    if (!detailed?.url) {
      logger.warn("adult", `${meta.title} — TorBox returned no URL for ${ref} (${opt.rawTitle}); trying next`);
      continue;
    }
    // Guard against dirty DMM hashlist entries: the release NAME matched our
    // item (isRelevant) but the cached TorBox file is something else entirely
    // (the "I clicked a stream and got a Netflix show" report). If the resolved
    // file name looks like an unrelated mainstream rip, skip it.
    if (!fileNameMatchesMeta(meta, detailed.name)) {
      logger.warn("adult", `${meta.title} — resolved file "${detailed.name}" doesn't match the item (dirty hash ${ref}); skipping`);
      continue;
    }
    const url = detailed.url;
    const itemHandle = await createAdultPlaySession({
      url,
      durationSeconds: meta.durationSeconds ?? 0,
      title: meta.title,
      posterUrl: meta.posterUrl,
      infoHash: opt.infoHash,
    });
    logger.success("adult", `${meta.title} — resolved ${ref} (${opt.rawTitle})`);
    return {
      url,
      itemId: itemHandle,
      durationTicks: Math.max(0, Math.round((meta.durationSeconds ?? 0) * 10_000_000)),
      title: meta.title,
      posterUrl: meta.posterUrl,
      infoHash: opt.infoHash,
    };
  }

  if (queued) {
    logger.info("adult", `${meta.title} — nothing ready yet; reporting "downloading" (${queued.progress ?? 0}%)`);
    return queued;
  }
  logger.warn("adult", `${meta.title} — ${order.length} release(s) but none resolved to a URL`);
  return null;
}
