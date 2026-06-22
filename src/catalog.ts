/**
 * Western adult catalog — a LOCAL, pre-built index of torrents (movies + scenes)
 * for the password-gated adult library.
 *
 * This inverts the old TPDB-first flow. Instead of "pick a ThePornDB scene, then
 * hunt for its torrent", we:
 *   1. HARVEST real torrents from Zilean (seed-term crawl + every live search),
 *      keyed by info_hash, storing the RTN-parsed title/studio/size.   (db)
 *   2. ENRICH each release with ThePornDB metadata via `/scenes?parse=` →
 *      proper title, poster, performers, studio.                       (tpdb)
 * Search queries the local table, so it only ever surfaces content that
 * actually exists as a torrent. Playback is ON-DEMAND, exactly like the normal
 * debrid pipeline: tapping a card hands the magnet to TorBox and plays whatever
 * it serves — no cached pre-check, no cached-only gating.
 *
 * JAV is intentionally NOT here — apiJAV serves it directly (HLS, no caching).
 */
import {
  getAddonConfig,
  listAdultStreamSources,
  listStreamAccounts,
  searchAdultCatalog,
  updateAdultCatalogEnrichment,
  upsertAdultCatalog,
  listAdultCatalogForEnrich,
  adultCatalogStats,
  getAdultCatalogEntry,
  listAdultCatalogByTpdbId,
  updateAdultCatalogDuration,
  type AdultCatalogRow,
  type LibraryRow,
} from "@vault/db";
import { logger } from "@vault/log";
import { probeFile } from "@vault/scanner";
import { TorBoxResolver } from "@forge";
import type { StreamCandidate } from "@forge";
import { adultCachedOnly, fileNameMatchesMeta, type AdultPlayback, type AdultQueuedResolve, type AdultSearchResult, type AdultStreamOption } from "./search";
import { detectVr, parseResolutionLabel } from "./parse";
import { createAdultPlaySession } from "./playback";
import { zileanFiltered, zileanSearch, type ZileanTorrent } from "./zilean";
import { tpdbBestMatch } from "./tpdb";

/**
 * Seed studios/networks for the background crawl — Western producers with a
 * strong torrent presence. Each is queried once against Zilean (≤200 hits/term,
 * no deep pagination), deduped by hash. Editing this list grows the catalog.
 */
export const SEED_STUDIOS: string[] = [
  "Brazzers", "Blacked", "BlackedRaw", "Vixen", "Tushy", "TushyRaw", "Deeper", "Slayed",
  "Naughty America", "Reality Kings", "Bangbros", "Digital Playground", "Evil Angel",
  "Wicked", "Mofos", "TeamSkeet", "Nubiles", "Nubile Films", "Pure Taboo", "MissaX",
  "FILF", "Sis Loves Me", "My Pervy Family", "Family Strokes", "Passion HD", "Babes",
  "Twistys", "Property Sex", "Fake Taxi", "Fake Hostel", "Public Agent", "Mom4K",
  "Exxxtra Small", "Cum4K", "Holed", "Tiny4K", "Dorcel", "Private", "New Sensations",
  "Sweetheart Video", "Girlsway", "Adult Time", "Sweet Sinner", "Hard X", "Dark X",
  "Zero Tolerance", "Jules Jordan", "DorcelClub", "LegalPorno", "GangBang", "Onlyfans",
];

const JAV_CODE = /\b[A-Z]{2,6}-?\d{2,5}\b/;
const alnum = (s: string | null | undefined) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Zilean returns JAV alongside Western when a seed term collides. Drop JAV — it
 *  has an RTN episode_code, or a bare CODE-### parsed title with no Latin words. */
function isJav(t: ZileanTorrent): boolean {
  if (t.episodeCode) return true;
  if (t.category && /jav|hentai|anime/i.test(t.category)) return true;
  const parsed = t.parsedTitle || "";
  // "SSIS-423" / "ABP 998" style with nothing else → JAV.
  return JAV_CODE.test(parsed) && parsed.replace(JAV_CODE, "").replace(/[^a-z]/gi, "").length < 3;
}

/** Does this release actually belong to the queried term? Zilean's fuzzy
 *  full-text search matches "Blacked" → "Black Mirror"; this keeps only hits
 *  that contain every query word (≥3 chars) somewhere in the name/studio, which
 *  drops the mainstream noise while keeping "BrazzersExxtra…" for "Brazzers". */
function matchesTerm(t: ZileanTorrent, term: string): boolean {
  const words = term.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return true;
  const hay = alnum(t.rawTitle) + " " + alnum(t.parsedTitle) + " " + alnum(t.site);
  return words.every((w) => hay.includes(w));
}

/** Any enabled Zilean adult source URL. */
async function zileanUrls(): Promise<string[]> {
  const sources = await listAdultStreamSources();
  return sources.filter((s) => s.source_type === "zilean" && s.url).map((s) => s.url!) as string[];
}

/** First enabled TorBox debrid, wrapped as a resolver — or null. */
async function getTorBox(): Promise<TorBoxResolver | null> {
  const debrids = await listStreamAccounts("debrid");
  const account = debrids.find((a) => a.provider === "torbox" && a.enabled === 1);
  return account ? new TorBoxResolver(account) : null;
}

/** Query BOTH Zilean endpoints for a term — and, for multi-word studios, also
 *  its CONCATENATED form. RTN normalises "Naughty America" → "naughtyamerica",
 *  so `/dmm/filtered?Query=NaughtyAmerica` finds 34 real releases where the
 *  spaced form finds 0; `/dmm/search` separately catches "BrazzersExxtra…".
 *  Results merge (deduped by hash); the on-term filter in `ingest` drops the
 *  mainstream noise the fuzzy `search` mixes in. */
async function harvestTerm(urls: string[], term: string, signal?: AbortSignal): Promise<ZileanTorrent[]> {
  const variants = Array.from(new Set([term, term.replace(/\s+/g, "")])).filter(Boolean);
  const merged = new Map<string, ZileanTorrent>();
  for (const url of urls) {
    for (const v of variants) {
      const [a, b] = await Promise.all([
        zileanFiltered(url, v, { signal, limit: 200 }).catch(() => []),
        zileanSearch(url, v, { signal, limit: 200 }).catch(() => []),
      ]);
      for (const t of [...a, ...b]) if (t.infoHash && !merged.has(t.infoHash)) merged.set(t.infoHash, t);
    }
  }
  return [...merged.values()];
}

/** Filter (Western + on-term) and upsert. Returns the count of NEW rows. */
async function ingest(torrents: ZileanTorrent[], term: string): Promise<number> {
  const kept = torrents.filter((t) => t.infoHash && t.rawTitle && !isJav(t) && matchesTerm(t, term));
  return upsertAdultCatalog(
    kept.map((t) => ({
      infoHash: t.infoHash,
      rawTitle: t.rawTitle,
      parsedTitle: t.parsedTitle,
      studio: t.site,
      sizeBytes: t.sizeBytes,
      year: t.year,
      sourceTerm: term,
    })),
  );
}

/**
 * Live half of the "both" strategy: harvest the user's search query into the
 * catalog so browsing grows organically. Best-effort.
 */
export async function liveHarvest(query: string, signal?: AbortSignal): Promise<number> {
  const q = query.trim();
  if (!q) return 0;
  const urls = await zileanUrls();
  if (!urls.length) return 0;
  const added = await ingest(await harvestTerm(urls, q, signal), q);
  if (added > 0) logger.info("adult", `catalog: +${added} from live search "${q}"`);
  return added;
}

/**
 * Background crawl: the Zilean seed-studio sweep plus the ptube "new" pages
 * (fresh TPDB-matched releases with exact hashes — see ptube.ts). Quiet
 * per-term, one summary line.
 */
export async function harvestCatalog(signal?: AbortSignal): Promise<number> {
  const urls = await zileanUrls();
  if (!urls.length) {
    logger.warn("adult", "catalog crawl skipped: no Zilean adult source configured");
    return 0;
  }
  let added = 0;
  for (const term of SEED_STUDIOS) {
    if (signal?.aborted) break;
    try {
      added += await ingest(await harvestTerm(urls, term, signal), term);
    } catch { /* a down indexer / one bad term shouldn't kill the crawl */ }
  }
  try {
    const { harvestPtube } = await import("./ptube");
    added += await harvestPtube({ pages: 10, signal });
  } catch { /* best-effort — ptube being down shouldn't kill the crawl */ }
  const stats = await adultCatalogStats();
  logger.success(
    "adult",
    `catalog crawl: +${added} new across ${SEED_STUDIOS.length} studios · total ${stats.total} (${stats.matched} matched, ${stats.enriched} enriched)`,
  );
  return added;
}

/** A confident-enough match? The scene parser is precise; the movie parser is
 *  fuzzy, so require the matched title to share a real word with the release. */
function matchIsTrustworthy(rawTitle: string, matchedTitle: string, type: "scenes" | "movies"): boolean {
  if (type === "scenes") return true;
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const a = words(rawTitle);
  const b = words(matchedTitle);
  for (const w of b) if (a.has(w)) return true;
  return false;
}

/**
 * Enrich specific rows with ThePornDB via `parse=`. Scene parser first (precise,
 * 1 call), then the movie parser (skippable for the fast/sync path). A match
 * fills title/poster/performers; a miss still stamps enriched_at so it isn't
 * retried forever. CRUCIAL: we do NOT pass `year` — Zilean's parsed year is
 * often the shoot-date year and TPDB's year filter then zeroes out real matches
 * (the BrazzersExxtra releases only matched once year was dropped).
 *
 * @returns how many rows got a TPDB match.
 */
async function enrichOne(row: AdultCatalogRow, token: string, scenesOnly: boolean): Promise<boolean> {
  const name = row.raw_title;
  const cleaned = cleanForParse(name);
  // Raw `parse=` first — it's precise and uses the studio/date structure the
  // parser keys on. If it misses, retry with the cleaned name: TPDB's parser
  // returns 0 hits when quality/codec junk trails the name ("…Khloe Kapri XXX
  // 720p MP4-XXX[XC]" misses while "…Khloe Kapri" matches — verified live), so
  // the retry cuts everything from the first quality-ish token. The retry only
  // fires on a miss, so well-formed names cost no extra call.
  //
  // `strict` + the failed flag: a thrown TpdbRequestError means the CALL
  // failed (429/network), NOT that TPDB has no match. In that case we must not
  // stamp the permanent miss below — the original enrich pass blew through the
  // 120 req/min limit and stamped 1.7k rate-limited rows as "no match", which
  // is why most search cards had no poster while the scenes were clearly on
  // ThePornDB.
  let requestFailed = false;
  const tryParse = async (ct: "scenes" | "movies") => {
    try {
      let h = await tpdbBestMatch(name, { token, contentType: ct, strict: true });
      if (!h && cleaned && cleaned.toLowerCase() !== name.toLowerCase()) {
        h = await tpdbBestMatch(cleaned, { token, contentType: ct, strict: true });
      }
      return h;
    } catch {
      requestFailed = true;
      return null;
    }
  };
  let hit = await tryParse("scenes");
  let type: "scenes" | "movies" = "scenes";
  if (!hit && !scenesOnly) {
    hit = await tryParse("movies");
    type = "movies";
  }
  if (hit && matchIsTrustworthy(name, hit.title, type)) {
    await updateAdultCatalogEnrichment(row.info_hash, {
      title: hit.title,
      studio: hit.studio,
      performers: hit.performers,
      contentType: type === "movies" ? "movie" : "scene",
      posterUrl: hit.posterUrl,
      date: hit.date,
      year: hit.date ? parseInt(hit.date.slice(0, 4), 10) || null : null,
      tpdbId: hit.uuid,
      tpdbType: type,
    });
    return true;
  }
  if (!scenesOnly && !requestFailed) {
    // Only stamp a permanent miss on the THOROUGH pass — the fast scenes-only
    // path leaves enriched_at null so the background pass still tries movies.
    // A failed request also leaves it null so the next pass retries.
    await updateAdultCatalogEnrichment(row.info_hash, {});
  }
  return false;
}

/** Sequential enrich — used by the background pass (200 rows). The inter-row
 *  delay is what actually keeps us under ThePornDB's 120 req/min limit: a
 *  thorough row is up to 4 parse calls, so 2.5s/row caps the worst case at
 *  ~96 req/min (the un-paced pass ran ~1 row/s ≈ 240 req/min and got most of
 *  its calls 429'd). */
async function enrichRows(rows: AdultCatalogRow[], token: string, opts: { scenesOnly?: boolean } = {}): Promise<number> {
  let matched = 0;
  for (const row of rows) {
    if (await enrichOne(row, token, opts.scenesOnly ?? false)) matched++;
    if (rows.length > 10) await new Promise((r) => setTimeout(r, 2500));
  }
  return matched;
}

/**
 * Background enrich pass — works through un-matched rows thoroughly (scenes then
 * movies). Run on a timer by the enrich automation.
 */
export async function enrichCatalogBatch(limit = 200): Promise<void> {
  const token = (await getAddonConfig()).theporndb_api_key;
  if (!token) {
    logger.warn("adult", "catalog enrich skipped: no ThePornDB token");
    return;
  }
  const rows = await listAdultCatalogForEnrich(limit);
  if (!rows.length) return;
  const matched = await enrichRows(rows, token);
  logger.info("adult", `catalog enrich: ${rows.length} processed, ${matched} matched to ThePornDB`);
}

// TV markers: S04E01 / S4.E1, a SEASON-only pack (S02), 1x05, or spelled
// "Season/Episode N". "Stuck in the Middle S02" is a season pack, so S## alone
// must count.
const TV_MARK = /\bS\d{1,2}[\s._-]?E\d{1,3}\b|\bS\d{2}\b|\b\d{1,2}x\d{2}\b|\b(?:season|episode)[\s._-]?\d{1,3}\b/i;
// A mainstream film/TV rip fingerprint: a 4-digit YEAR next to a scene-release
// source/codec tag. Adult releases use a shoot date ("24 06 19", not a year) and
// usually carry XXX, so this rarely fires on them.
const MAINSTREAM_RIP =
  /\b(19|20)\d{2}\b[\s\S]*\b(blu-?ray|web-?dl|web-?rip|hdrip|brrip|bdrip|dvdrip|hdtv|x264|x265|h\.?264|h\.?265|hevc|amzn|hmax|dsnp|atvp|rarbg|yts|yify)\b/i;
// Streaming-service source tags — adult releases NEVER carry these, so they mark
// a mainstream rip even with no year (year-less TV like the "DNSY" Disney rip).
const STREAMING_TAG = /\b(?:amzn|atvp|hmax|dsnp|dnsy|hulu|pcok|nf|nflx|max)\b/i;

/**
 * Should a CACHED row display? The job is to hide MAINSTREAM pollution a fuzzy
 * indexer query drags in (searching "stuck" harvests "Stuck (2007) BluRay YTS"
 * and "Stuck in the Middle S02"), NOT to demand a porn tag — that wrongly hid
 * real performer content named just "Molly Jane". So: a ThePornDB match or an
 * explicit `XXX` is decisive adult; otherwise ACCEPT unless it looks like a
 * mainstream TV show / film rip.
 */
function isAdultConfident(row: AdultCatalogRow): boolean {
  if (row.tpdb_id) return true; // TPDB-confirmed adult
  if (/\bXXX\b/i.test(row.raw_title)) return true; // explicit porn tag
  if (TV_MARK.test(row.raw_title)) return false; // TV episode / season pack
  if (MAINSTREAM_RIP.test(row.raw_title)) return false; // mainstream film rip
  if (STREAMING_TAG.test(row.raw_title)) return false; // year-less streaming rip
  return true; // a plain name (e.g. "Molly Jane") — keep it
}

// Tokens that derail TPDB's `parse=` parser on VR/4K releases. Stripped (as
// whole words) only for the cleaned RETRY query, never for display.
const PARSE_NOISE =
  /\b(?:\d{3,4}p|\d{1,2}k|vr|lr|sbs|tb|ou|mono|fisheye|mkx|180|360|3dh|uhd|hdr|xxx|xx|hevc|h\.?26[45]|x26[45]|aac|ac3|opus|web-?dl|web-?rip|bd-?rip|hd-?rip|dvdrip|multi|original|remux|mp4|mkv|wmv|avi|m4v|mov|webm)\b/gi;

// First quality-ish token → end of name. Release names put the scene title
// BEFORE the quality block ("Site YY MM DD Performer Title XXX 1080p …"), and
// TPDB's parser tolerates a clean prefix far better than stripped-but-present
// junk: "DadCrush 25 07 23 Erica Candfield XX 1080p MP4-WRB[XC]" parses to 0
// hits even with the tokens individually removed (the "WRB" group tag alone
// derails it), while cutting at "XX" → "DadCrush 25 07 23 Erica Candfield"
// matches (verified live). "XX" matters: WRB-group releases tag XX, not XXX.
const QUALITY_CUT =
  /\b(?:xxx|xx|\d{3,4}p|[48]k|uhd|hdr|hevc|h\.?26[45]|x26[45]|aac|ac3|opus|web-?dl|web-?rip|bd-?rip|hd-?rip|dvdrip|remux|mp4|mkv|wmv|avi|m4v|mov|webm|vr|sbs|fisheye|mkx)\b[\s\S]*$/i;

/** Normalise a raw release name for a TPDB `parse=` RETRY: separators → spaces,
 *  bracketed group tags dropped, then everything from the first quality/codec
 *  token onward cut off. Falls back to token-stripping when the cut leaves too
 *  little (a name that STARTS with a quality token). "PornCornVR" keeps its VR
 *  because `\bvr\b` won't match inside a word. */
function cleanForParse(raw: string): string {
  const base = raw
    .replace(/\.(mp4|mkv|wmv|avi|m4v|ts|mov|webm)$/i, "")
    .replace(/[._\-]+/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  const cut = base.replace(QUALITY_CUT, " ").replace(/\s{2,}/g, " ").trim();
  if (cut.split(/\s+/).length >= 2) return cut;
  return base.replace(PARSE_NOISE, " ").replace(/\s{2,}/g, " ").trim();
}

/** Turn an ugly release name into something readable for an un-matched (no
 *  ThePornDB poster) card: drop the extension, everything from the first
 *  quality/codec tag onward, and a leading "Studio 24 06 19" prefix. */
function cleanReleaseName(raw: string): string {
  let s = raw.replace(/\.(mp4|mkv|avi|wmv|mov|m4v|ts)$/i, "");
  s = s.replace(/\b(XXX|1080p|2160p|720p|480p|4k|uhd|hevc|x26[45]|h\.?26[45]|aac|web-?dl|web-?rip|bdrip|dvdrip|hdrip|mp4|wmv)\b[\s\S]*$/i, "");
  s = s.replace(/^[a-z0-9]+[\s._-]+\d{2}[\s._-]\d{2}[\s._-]\d{2}[\s._-]+/i, "");
  s = s.replace(/[._]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return s || raw;
}

/** Map a stored catalog row to a library search card. `cached` is set only when
 *  the caller freshly verified it (cached-only mode) — otherwise left undefined
 *  so the client shows no (potentially lying) badge. */
function toCard(row: AdultCatalogRow, cached?: boolean): AdultSearchResult {
  let performers: string[] = [];
  try { performers = JSON.parse(row.performers_json) as string[]; } catch { /* ignore */ }
  // TPDB title when matched; otherwise a cleaned-up release name (Zilean's
  // parsed_title is usually just the studio, so it's not useful here).
  const title = row.title || cleanReleaseName(row.raw_title);
  return {
    id: `catalog:${row.info_hash}`,
    kind: row.content_type === "movie" ? "movie" : "scene",
    contentType: row.content_type === "movie" ? "movies" : "scenes",
    uuid: row.info_hash,
    title,
    posterUrl: row.poster_url,
    backgroundUrl: null,
    date: row.date,
    year: row.year,
    performers,
    studio: row.studio,
    description: null,
    rating: null,
    durationSeconds: null,
    source: "catalog",
    code: null,
    sizeBytes: row.size_bytes,
    infoHash: row.info_hash,
    resolution: parseResolutionLabel(row.raw_title),
    isVr: detectVr(row.raw_title),
    cached,
  };
}

/** Dedup key for "the same scene, different release". TPDB id when matched
 *  (every release of a scene shares it); otherwise the cleaned title + studio.
 *  This collapses the "23 identical-title cards" a multi-resolution catalog
 *  produces down to one. */
function dedupKey(row: AdultCatalogRow): string {
  if (row.tpdb_id) return `id:${row.tpdb_id}`;
  const t = (row.title || cleanReleaseName(row.raw_title)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const s = (row.studio || "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return `tt:${t}|${s}`;
}

/** Collapse rows to one-per-scene, keeping the best release of each group while
 *  preserving the input order (matched-first, then newest). `prefer` picks the
 *  winner within a group: largest size, but a cached row always beats an
 *  uncached one when we know the cache state. */
function dedupRows(rows: AdultCatalogRow[], cachedSet: Set<string> | null): AdultCatalogRow[] {
  const groups = new Map<string, AdultCatalogRow>();
  const better = (a: AdultCatalogRow, b: AdultCatalogRow): AdultCatalogRow => {
    if (cachedSet) {
      const ca = cachedSet.has(a.info_hash), cb = cachedSet.has(b.info_hash);
      if (ca !== cb) return ca ? a : b;
    }
    return (a.size_bytes ?? 0) >= (b.size_bytes ?? 0) ? a : b;
  };
  for (const r of rows) {
    const k = dedupKey(r);
    const cur = groups.get(k);
    groups.set(k, cur ? better(cur, r) : r);
  }
  return [...groups.values()];
}

/** Fresh TorBox cached-check for a set of hashes (one batched call). Returns the
 *  subset of hashes confirmed cached RIGHT NOW — no stale persisted flag. */
async function freshCachedSet(hashes: string[], signal?: AbortSignal): Promise<Set<string>> {
  const out = new Set<string>();
  if (!hashes.length) return out;
  const resolver = await getTorBox();
  if (!resolver) return out;
  const candidates: StreamCandidate[] = hashes.map((h) => ({
    id: h, sourceType: "catalog", sourceId: "", name: "adult", description: "", rawTitle: "", infoHash: h,
  }));
  const map = await resolver.checkAvailability(candidates, signal ?? AbortSignal.timeout(30_000));
  for (const [h, isCached] of map) if (isCached) out.add(h);
  return out;
}

/**
 * Library search over the local catalog. Matched releases (TPDB poster + title)
 * sort first; un-matched ones still show with a cleaned-up name. Results are
 * DEDUPED to one card per scene (the catalog holds many release hashes per
 * title — see {@link dedupRows}).
 *
 * Honours the Forge "Cached on debrid only" toggle, exactly like the normal
 * pipeline:
 *   • ON  → a FRESH TorBox check; only releases cached right now are shown, the
 *           "Cached" badge is therefore always honest, and resolve never
 *           queues a download.
 *   • OFF → on-demand: show everything, no badge, uncached picks download when
 *           tapped (the queued-state UX).
 *
 * Bounded SYNCHRONOUS top-up so a fresh query isn't empty: harvest from Zilean
 * → lightly enrich the top un-matched rows (scenes parser) for posters → gate →
 * dedup. Heavy work (movie matches, the long tail) is left to the background pass.
 */
export async function searchCatalog(
  library: LibraryRow,
  query: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AdultSearchResult[]> {
  void library;
  const q = query.trim();
  const token = (await getAddonConfig()).theporndb_api_key;
  const cachedOnly = await adultCachedOnly();

  // 1. Grow the catalog from this query.
  if (q) await liveHarvest(q, opts.signal).catch(() => {});

  // 2. Matching rows, gated to adult-confident ones so a generic term can't
  //    surface mainstream films/TV the fuzzy harvest dragged in. Pull a wide
  //    slice (we dedup heavily). Enrich the first ~2 screens of un-matched
  //    cards so posters land on the cards the user sees (scenes-only + parallel
  //    to stay fast; movies and the long tail are filled by the background pass).
  let rows = await searchAdultCatalog(q, { matchedOnly: false, limit: 240 });
  let shown = rows.filter(isAdultConfident);
  if (token) {
    const unmatched = shown.filter((r) => r.tpdb_id == null).slice(0, 24);
    if (unmatched.length) {
      await Promise.all(unmatched.map((r) => enrichOne(r, token, true).catch(() => false)));
      rows = await searchAdultCatalog(q, { matchedOnly: false, limit: 240 });
      shown = rows.filter(isAdultConfident);
    }
  }

  // 3. Cached-only mode: one FRESH TorBox check across the candidate hashes,
  //    keep only those cached now (honest badge), then dedup preferring cached.
  if (cachedOnly) {
    const cachedSet = await freshCachedSet(shown.map((r) => r.info_hash).slice(0, 150), opts.signal).catch(() => new Set<string>());
    shown = shown.filter((r) => cachedSet.has(r.info_hash));
    return dedupRows(shown, cachedSet).map((r) => toCard(r, true));
  }

  // 4. On-demand mode: dedup by largest release, no badge.
  return dedupRows(shown, null).map((r) => toCard(r));
}

/**
 * List every release of a catalog scene for the stream picker. The library
 * search collapses a scene's many quality/group variants to one card (see
 * {@link dedupRows}); this re-expands them so the user can pick a specific
 * quality instead of always getting the largest. Largest first, each tagged
 * with its parsed resolution. Honours the adult cached-only rule exactly like
 * resolve: ON → only releases TorBox has cached right now are listed.
 */
export async function adultListCatalogStreams(
  infoHash: string,
  signal?: AbortSignal,
): Promise<AdultStreamOption[]> {
  const anchor = await getAdultCatalogEntry(infoHash);
  if (!anchor) return [];
  // Group by TPDB id when matched; an id-less row can't be grouped in SQL, so
  // it just lists itself.
  const rows = anchor.tpdb_id ? await listAdultCatalogByTpdbId(anchor.tpdb_id) : [anchor];
  if (!rows.some((r) => r.info_hash === anchor.info_hash)) rows.unshift(anchor);

  let pool = rows.slice().sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));

  if (await adultCachedOnly()) {
    const cachedSet = await freshCachedSet(pool.map((r) => r.info_hash).slice(0, 60), signal)
      .catch(() => new Set<string>());
    pool = pool.filter((r) => cachedSet.has(r.info_hash));
  }

  return pool.map((r) => ({
    infoHash: r.info_hash,
    rawTitle: r.raw_title,
    sizeBytes: r.size_bytes,
    resolution: parseResolutionLabel(r.raw_title),
    isVr: detectVr(r.raw_title),
  }));
}

/**
 * Resolve a catalog card (`catalog:<info_hash>`) to a playable stream. Unlike
 * the old flow we already KNOW the exact torrent, so this is a direct TorBox
 * resolve + the dirty-hash file-name guard, then a play session for the shared
 * transcode pipeline. An uncached torrent gets QUEUED on the debrid and we
 * return its downloading state so the client can say "try again shortly";
 * null only when TorBox can't serve it at all.
 */
export async function adultResolveCatalog(
  infoHash: string,
  signal?: AbortSignal,
): Promise<AdultPlayback | AdultQueuedResolve | null> {
  const row = await getAdultCatalogEntry(infoHash);
  if (!row) return null;
  const resolver = await getTorBox();
  if (!resolver) {
    logger.warn("adult", "catalog resolve skipped: no enabled TorBox debrid");
    return null;
  }
  const title = row.title || row.parsed_title || row.raw_title;
  const candidate: StreamCandidate = {
    id: row.info_hash, sourceType: "catalog", sourceId: "", name: "adult",
    description: row.raw_title, rawTitle: row.raw_title, infoHash: row.info_hash,
    sizeBytes: row.size_bytes ?? undefined,
  };
  // Cached-only mode (Forge toggle): verify the hash is cached RIGHT NOW before
  // touching createtorrent, so a stale card (cache evicted since the search)
  // never silently queues a download. Not cached → null, client says "try
  // another".
  if (await adultCachedOnly()) {
    const cachedSet = await freshCachedSet([row.info_hash], signal).catch(() => new Set<string>());
    if (!cachedSet.has(row.info_hash)) {
      logger.info("adult", `${title} — not cached now and cached-only is on; skipping (${row.info_hash.slice(0, 8)})`);
      return null;
    }
  }
  const detailed = await resolver.resolveDetailed(candidate, signal);
  if (detailed && "queued" in detailed) {
    logger.info("adult", `${title} — queued on TorBox (${detailed.state ?? "?"} ${detailed.progress ?? 0}%, ${detailed.seeds ?? "?"} seeds)`);
    return { queued: true, title, state: detailed.state, progress: detailed.progress };
  }
  if (!detailed?.url) {
    logger.warn("adult", `${title} — TorBox returned no URL for ${row.info_hash.slice(0, 8)}`);
    return null;
  }
  let performers: string[] = [];
  try { performers = JSON.parse(row.performers_json) as string[]; } catch { /* ignore */ }
  if (!fileNameMatchesMeta(
    { contentType: row.content_type === "movie" ? "movies" : "scenes", title, studio: row.studio, performers },
    detailed.name,
  )) {
    logger.warn("adult", `${title} — resolved file "${detailed.name}" looks unrelated (dirty hash ${row.info_hash.slice(0, 8)}); skipping`);
    return null;
  }

  // Real runtime drives the transcode VOD playlist. Without it the server used a
  // 4h default → the seek bar showed 4h and seeking past the real end made
  // ffmpeg restart from 0. Probe once, then cache it on the row.
  let durationSeconds = row.duration_seconds ?? 0;
  if (durationSeconds <= 0) {
    const probe = await probeFile(detailed.url).catch(() => null);
    const probed = Math.floor(Number(probe?.format?.duration ?? 0));
    if (probed > 0) {
      durationSeconds = probed;
      await updateAdultCatalogDuration(row.info_hash, probed).catch(() => {});
    }
  }

  const itemId = await createAdultPlaySession({
    url: detailed.url, durationSeconds, title, posterUrl: row.poster_url, infoHash: row.info_hash,
  });
  logger.success("adult", `catalog resolved ${row.info_hash.slice(0, 8)} (${title}) · ${durationSeconds ? Math.round(durationSeconds / 60) + "m" : "duration unknown"}`);
  return {
    url: detailed.url,
    itemId,
    durationTicks: Math.max(0, Math.round(durationSeconds * 10_000_000)),
    title,
    posterUrl: row.poster_url,
    infoHash: row.info_hash,
  };
}
