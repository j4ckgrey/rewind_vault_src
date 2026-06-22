/**
 * Zilean DMM search client.
 *
 * Zilean indexes DebridMediaManager hashlists and runs every torrent name
 * through RTN (rank-torrent-name), exposing a TEXT search at
 * `POST {base}/dmm/search {"queryText":"…"}`. Each hit carries a parsed title,
 * an `info_hash` (→ debrid cached-check + resolve), a size, and an RTN `adult`
 * flag — which is exactly what an adult library needs (text in, hashes out).
 *
 * Verified live: querying "SSIS" returns JAV (SSIS-804/369) and XXX releases
 * whose hashes come back cached on TorBox.
 */

const SEARCH_PATH = "/dmm/search";
const FILTERED_PATH = "/dmm/filtered";

export interface ZileanTorrent {
  rawTitle: string;
  parsedTitle: string;
  infoHash: string;
  sizeBytes: number | null;
  /** RTN's adult/XXX detection. Unreliable on some instances (often false even
   *  for porn), so callers shouldn't gate on it alone. */
  adult: boolean;
  category: string | null;
  year: number | null;
  /** RTN's parsed studio/site name, when present (e.g. "Brazzers"). */
  site: string | null;
  /** RTN's parsed studio/product code (e.g. "SSIS-423") — its presence marks a
   *  JAV release, which the Western catalog excludes (JAV is served by apiJAV). */
  episodeCode: string | null;
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function normalize(raw: any): ZileanTorrent | null {
  const infoHash = typeof raw?.info_hash === "string" ? raw.info_hash.toLowerCase() : "";
  const rawTitle = typeof raw?.raw_title === "string" ? raw.raw_title : "";
  if (!infoHash || !rawTitle) return null;
  return {
    rawTitle,
    parsedTitle: typeof raw?.parsed_title === "string" && raw.parsed_title ? raw.parsed_title : rawTitle,
    infoHash,
    sizeBytes: toNumber(raw?.size),
    adult: raw?.adult === true || raw?.adult === "True" || raw?.adult === "true",
    category: typeof raw?.category === "string" ? raw.category : null,
    year: toNumber(raw?.year),
    site: typeof raw?.site === "string" && raw.site ? raw.site : null,
    episodeCode: typeof raw?.episode_code === "string" && raw.episode_code ? raw.episode_code : null,
  };
}

/**
 * Text-search a Zilean instance. Returns RTN-parsed torrents (deduped by hash).
 * Best-effort: a down/blocked indexer yields an empty list rather than throwing.
 */
export async function zileanSearch(
  baseUrl: string,
  query: string,
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<ZileanTorrent[]> {
  const q = query.trim();
  if (!baseUrl || !q) return [];
  const url = `${baseUrl.replace(/\/+$/, "")}${SEARCH_PATH}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ queryText: q }),
      signal: opts.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
    const seen = new Set<string>();
    const out: ZileanTorrent[] = [];
    for (const item of list) {
      const t = normalize(item);
      if (!t || seen.has(t.infoHash)) continue;
      seen.add(t.infoHash);
      out.push(t);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The OTHER Zilean query mode — `GET /dmm/filtered?Query=`. It matches the
 * RTN-normalised title rather than the full raw text, so for studios whose
 * releases ARE named after the studio (Blacked, Tushy, Vixen…) it returns clean
 * on-target results where `/dmm/search` returns mainstream fuzzy noise
 * ("Blacked" → "Black Mirror"). The two are complementary; the crawl runs both
 * and dedupes. Caps at ~200, no deep pagination. Best-effort.
 */
export async function zileanFiltered(
  baseUrl: string,
  query: string,
  opts: { signal?: AbortSignal; limit?: number } = {},
): Promise<ZileanTorrent[]> {
  const q = query.trim();
  if (!baseUrl || !q) return [];
  const url = `${baseUrl.replace(/\/+$/, "")}${FILTERED_PATH}?Query=${encodeURIComponent(q)}&Page=1&PageSize=${opts.limit ?? 200}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: opts.signal });
    if (!res.ok) return [];
    const data = await res.json();
    const list: any[] = Array.isArray(data) ? data : (data?.results ?? data?.data ?? []);
    const seen = new Set<string>();
    const out: ZileanTorrent[] = [];
    for (const item of list) {
      const t = normalize(item);
      if (!t || seen.has(t.infoHash)) continue;
      seen.add(t.infoHash);
      out.push(t);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
