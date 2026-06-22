/**
 * ThePornDB (TPDB) metadata client — the adult-content equivalent of our TMDB
 * enrichment AND its catalog/search source. `api.theporndb.net` is a metadata
 * service (like TMDB): it has no streams, just rich scene/movie/JAV/performer
 * records (posters, performers, studio/site, tags, duration). The global Bearer
 * token lives in addon_config (`theporndb_api_key`).
 *
 * Two query modes, used for two different jobs:
 *   • `q=<text>`   — free-text catalog search. This is what the LIBRARY search
 *                    uses, so results look exactly like ThePornDB's site.
 *   • `parse=<rel>`— release-name parser. Used only when matching a torrent
 *                    file name back to a scene during stream resolution.
 *
 * Only the API *contract* (endpoint paths + params, which are public facts) is
 * reused here; all code is ours.
 */

const TPDB_API = "https://api.theporndb.net";

export type TpdbContentType = "scenes" | "movies" | "jav";

/** Normalised metadata we hand to the rest of the app (provider-agnostic). */
export interface TpdbResult {
  /** TPDB uuid — stable external id for this scene/movie. */
  uuid: string;
  contentType: TpdbContentType;
  title: string;
  description: string | null;
  /** Release date as `YYYY-MM-DD` when known. */
  date: string | null;
  durationSeconds: number | null;
  posterUrl: string | null;
  backgroundUrl: string | null;
  /** 0–10 community rating when present. */
  rating: number | null;
  /** Studio / site name (e.g. the producing site or its parent network). */
  studio: string | null;
  performers: string[];
  tags: string[];
}

/** A performer card (search by name → drill into their scenes). */
export interface TpdbPerformer {
  uuid: string;
  name: string;
  imageUrl: string | null;
  /** Free-text bits TPDB exposes (gender, nationality…) for the subtitle line. */
  details: string | null;
}

interface TpdbSearchOpts {
  token: string;
  contentType?: TpdbContentType;
  /** oshash of the file, when known — pins an exact match (parse mode). */
  hash?: string;
  /** Release year hint, narrows the match. */
  year?: number;
  /** Throw TpdbRequestError on HTTP/network failure instead of returning [].
   *  Default false keeps the old swallow-errors behaviour for UI callers. */
  strict?: boolean;
  signal?: AbortSignal;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function pickString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function pickNumber(...vals: unknown[]): number | null {
  for (const v of vals) {
    const n = typeof v === "string" ? parseFloat(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return null;
}

/** TPDB returns images as either a bare URL string OR a `{full,large,medium,…}`
 *  object (posters/background). Pull the best URL out of whichever shape. */
function pickImage(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const url = pickString(o.full, o.large, o.medium, o.small, o.url);
      if (url) return url;
    }
  }
  return null;
}

/** Map one raw TPDB item (scene/movie/jav share the same shape) to TpdbResult.
 *  Written defensively — the API has grown several alias fields over time, so we
 *  probe a few candidate keys for each value rather than assume one. */
function normalize(raw: any, contentType: TpdbContentType): TpdbResult | null {
  if (!raw || typeof raw !== "object") return null;
  const uuid = pickString(raw.uuid, raw._id, raw.id != null ? String(raw.id) : undefined);
  const title = pickString(raw.title, raw.name);
  if (!uuid || !title) return null;

  const site = raw.site && typeof raw.site === "object" ? raw.site : null;
  const studio =
    pickString(site?.name) ??
    pickString(site?.network?.name) ??
    pickString(site?.parent?.name) ??
    pickString(raw.studio?.name, raw.studio);

  const performers: string[] = Array.isArray(raw.performers)
    ? raw.performers
        .map((p: any) => pickString(p?.name, p?.parent?.name, typeof p === "string" ? p : undefined))
        .filter((n: string | null): n is string => !!n)
    : [];

  const tags: string[] = Array.isArray(raw.tags)
    ? raw.tags
        .map((t: any) => pickString(t?.name, typeof t === "string" ? t : undefined))
        .filter((n: string | null): n is string => !!n)
    : [];

  // Date may arrive as a full timestamp; keep the date part only.
  const dateRaw = pickString(raw.date, raw.released, raw.release_date);
  const date = dateRaw ? dateRaw.slice(0, 10) : null;

  const rating = pickNumber(raw.rating, raw.rating_value, raw.average_rating);

  return {
    uuid,
    contentType,
    title,
    description: pickString(raw.description, raw.overview, raw.synopsis),
    date,
    durationSeconds: pickNumber(raw.duration, raw.length, raw.runtime),
    // Prefer the explicit poster, then the posters object, then the raw
    // site image / cover (movies often only carry `posters.large`).
    posterUrl: pickImage(raw.poster, raw.posters, raw.poster_image, raw.image, raw.cover),
    backgroundUrl: pickImage(raw.background, raw.backgrounds, raw.back_image, raw.background_back),
    rating: rating != null ? Math.max(0, Math.min(10, rating)) : null,
    studio,
    performers,
    tags,
  };
}

function normalizePerformer(raw: any): TpdbPerformer | null {
  if (!raw || typeof raw !== "object") return null;
  const uuid = pickString(raw.uuid, raw._id, raw.id != null ? String(raw.id) : undefined);
  const name = pickString(raw.name, raw.title);
  if (!uuid || !name) return null;
  const extras = raw.extras && typeof raw.extras === "object" ? raw.extras : null;
  const details = pickString(extras?.nationality, extras?.gender, raw.bio?.slice?.(0, 80));
  return {
    uuid,
    name,
    imageUrl: pickImage(raw.image, raw.posters, raw.poster, raw.face, raw.thumbnail),
    details,
  };
}

/** A TPDB request that did not produce a usable answer (HTTP error / network).
 *  Lets callers tell "the API said there is no match" (a real empty result)
 *  apart from "the call itself failed" — the catalog enrich pass MUST make that
 *  distinction, because it stamps permanent don't-retry misses. */
export class TpdbRequestError extends Error {
  constructor(public status: number, url: string) {
    super(`TPDB request failed (${status || "network"}): ${url.split("?")[0]}`);
  }
}

async function getJson(url: string, token: string, signal?: AbortSignal): Promise<any | null> {
  try {
    return await getJsonStrict(url, token, signal);
  } catch {
    return null;
  }
}

/** Like getJson but THROWS TpdbRequestError on failure instead of returning
 *  null. Retries once on 429, honouring Retry-After (capped) — the enrich
 *  passes run in bulk and occasionally clip TPDB's per-minute limit. */
async function getJsonStrict(url: string, token: string, signal?: AbortSignal): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: authHeaders(token), signal });
    } catch {
      throw new TpdbRequestError(0, url);
    }
    if (res.ok) return await res.json().catch(() => { throw new TpdbRequestError(res.status, url); });
    if (res.status === 429 && attempt === 0) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000, 15_000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new TpdbRequestError(res.status, url);
  }
}

/**
 * Free-text catalog search — the one the in-library search box uses. Returns
 * scene/movie/JAV records exactly as ThePornDB orders them, so the cards look
 * like the site. `parse=` is intentionally NOT used here; this is `q=`.
 */
export async function tpdbSearchText(
  query: string,
  opts: { token: string; contentType: TpdbContentType; page?: number; signal?: AbortSignal },
): Promise<TpdbResult[]> {
  if (!opts.token || !query.trim()) return [];
  const params = new URLSearchParams({ q: query.trim() });
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  const json = await getJson(
    `${TPDB_API}/${opts.contentType}?${params.toString()}`,
    opts.token,
    opts.signal,
  );
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => normalize(d, opts.contentType))
    .filter((r): r is TpdbResult => r !== null);
}

/** Free-text performer search. */
export async function tpdbSearchPerformers(
  query: string,
  opts: { token: string; signal?: AbortSignal },
): Promise<TpdbPerformer[]> {
  if (!opts.token || !query.trim()) return [];
  const params = new URLSearchParams({ q: query.trim() });
  const json = await getJson(`${TPDB_API}/performers?${params.toString()}`, opts.token, opts.signal);
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data.map(normalizePerformer).filter((p): p is TpdbPerformer => p !== null);
}

/**
 * Search TPDB for a release by its raw name (the `parse=` parser does the work).
 * Used by stream resolution to map a torrent file name → scene metadata.
 */
export async function tpdbSearch(rawName: string, opts: TpdbSearchOpts): Promise<TpdbResult[]> {
  if (!opts.token || !rawName.trim()) return [];
  const contentType = opts.contentType ?? "scenes";
  const params = new URLSearchParams({ parse: rawName });
  if (opts.hash) params.set("hash", opts.hash);
  if (opts.year) params.set("year", String(opts.year));

  const url = `${TPDB_API}/${contentType}?${params.toString()}`;
  const json = opts.strict
    ? await getJsonStrict(url, opts.token, opts.signal)
    : await getJson(url, opts.token, opts.signal);
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((d) => normalize(d, contentType))
    .filter((r): r is TpdbResult => r !== null);
}

/** The single best match for a release name, or null. */
export async function tpdbBestMatch(rawName: string, opts: TpdbSearchOpts): Promise<TpdbResult | null> {
  const results = await tpdbSearch(rawName, opts);
  return results[0] ?? null;
}

/** Fetch full metadata for a known TPDB uuid. */
export async function tpdbGetById(
  uuid: string,
  opts: { token: string; contentType?: TpdbContentType; signal?: AbortSignal },
): Promise<TpdbResult | null> {
  if (!opts.token || !uuid) return null;
  const contentType = opts.contentType ?? "scenes";
  const json = await getJson(`${TPDB_API}/${contentType}/${encodeURIComponent(uuid)}`, opts.token, opts.signal);
  const data = json?.data;
  return data ? normalize(data, contentType) : null;
}

/** Fetch a performer + their scene credits (for the performer drill-down). */
export async function tpdbGetPerformer(
  uuid: string,
  opts: { token: string; signal?: AbortSignal },
): Promise<TpdbPerformer | null> {
  if (!opts.token || !uuid) return null;
  const json = await getJson(`${TPDB_API}/performers/${encodeURIComponent(uuid)}`, opts.token, opts.signal);
  const data = json?.data;
  return data ? normalizePerformer(data) : null;
}

/** Cheap token sanity-check — a 200 from a tiny query means the token is valid. */
export async function tpdbTokenValid(token: string, signal?: AbortSignal): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`${TPDB_API}/scenes?parse=test`, { headers: authHeaders(token), signal });
    return res.status === 200;
  } catch {
    return false;
  }
}
