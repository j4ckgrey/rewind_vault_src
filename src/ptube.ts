/**
 * ptube (ptube.ers.pw, "Porn Tube" by Rab1t) — a community Stremio addon whose
 * backend is a pre-built index of ~340k ThePornDB-MATCHED adult releases across
 * 1100+ sites. Every entry maps a TPDB id to real torrent info-hashes (the
 * "PRT" group's daily 1080p+720p HEVC re-encodes), so it's an exact-match hash
 * source with none of the fuzzy-text guesswork our Zilean/DMM harvest needs —
 * and it carries releases DMM doesn't have (DMM lags days and covers the
 * WRB[XC] group instead).
 *
 * The endpoints are public, unauthenticated Stremio JSON:
 *   GET /catalog/movie/tpdb_catalog/skip=N.json  → 36 newest metas/page
 *       (id "porndb:<numeric tpdb id>", name, poster, year, Cast links)
 *   GET /stream/movie/porndb:<id>.json           → [{ infoHash, title }]
 *       (title = "📁  303 MB  🖥️  1080p \r\n<release name>")
 *
 * We use it as an extra HARVEST source for the local adult catalog: page the
 * "new" catalog, fetch each unseen item's streams, and insert rows that arrive
 * FULLY ENRICHED (tpdb id + title + poster + performers) with the exact hash —
 * no ThePornDB parse pass needed. Best-effort: if the addon dies, the harvest
 * simply contributes nothing.
 */
import {
  adultCatalogHasTpdbId,
  updateAdultCatalogEnrichment,
  upsertAdultCatalog,
} from "@vault/db";
import { logger } from "@vault/log";

const PTUBE_BASE = "https://ptube.ers.pw";
const PAGE_SIZE = 36;
/** Politeness gap between per-item stream lookups — it's someone's free server. */
const STREAM_FETCH_GAP_MS = 250;

interface PtubeMeta {
  /** Numeric ThePornDB id (without the `porndb:` prefix). */
  tpdbId: string;
  name: string;
  posterUrl: string | null;
  year: number | null;
  performers: string[];
}

export interface PtubeStream {
  infoHash: string;
  /** The actual release name (second line of the stream title). */
  releaseName: string;
  sizeBytes: number | null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** One page of the "new" catalog (36 items, newest first). */
export async function ptubeCatalogPage(page: number, signal?: AbortSignal): Promise<PtubeMeta[]> {
  const skip = Math.max(0, page) * PAGE_SIZE;
  const path = skip > 0 ? `/catalog/movie/tpdb_catalog/skip=${skip}.json` : "/catalog/movie/tpdb_catalog.json";
  const json = await getJson<{ metas?: Array<Record<string, unknown>> }>(`${PTUBE_BASE}${path}`, signal);
  const out: PtubeMeta[] = [];
  for (const m of json?.metas ?? []) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id.startsWith("porndb:")) continue;
    const links = Array.isArray(m.links) ? (m.links as Array<{ name?: string; category?: string }>) : [];
    out.push({
      tpdbId: id.slice("porndb:".length),
      name: typeof m.name === "string" ? m.name : "",
      posterUrl: typeof m.poster === "string" ? m.poster : null,
      year: typeof m.year === "number" ? m.year : null,
      performers: links.filter((l) => l.category === "Cast" && l.name).map((l) => l.name!) ?? [],
    });
  }
  return out;
}

/** The torrent releases for one TPDB item, largest first. */
export async function ptubeStreams(tpdbId: string, signal?: AbortSignal): Promise<PtubeStream[]> {
  const json = await getJson<{ streams?: Array<Record<string, unknown>> }>(
    `${PTUBE_BASE}/stream/movie/porndb:${encodeURIComponent(tpdbId)}.json`,
    signal,
  );
  const out: PtubeStream[] = [];
  for (const s of json?.streams ?? []) {
    const infoHash = typeof s.infoHash === "string" ? s.infoHash.toLowerCase() : "";
    const title = typeof s.title === "string" ? s.title : "";
    if (!infoHash || !title) continue;
    const lines = title.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const releaseName = lines[lines.length - 1] ?? "";
    const size = /([\d.]+)\s*(GB|MB)/i.exec(lines[0] ?? "");
    const sizeBytes = size
      ? Math.round(parseFloat(size[1]!) * (size[2]!.toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2))
      : null;
    if (releaseName) out.push({ infoHash, releaseName, sizeBytes });
  }
  return out.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

/** "AllOver30.26.06.09.…" → { studio: "AllOver30", date: "2026-06-09" }. */
function parseReleaseName(name: string): { studio: string | null; date: string | null } {
  const m = /^(.+?)\.(\d{2})\.(\d{2})\.(\d{2})\./.exec(name);
  if (!m) return { studio: null, date: null };
  return {
    studio: m[1]!.replace(/\./g, " ").trim() || null,
    date: `20${m[2]}-${m[3]}-${m[4]}`,
  };
}

/**
 * Harvest the newest `pages` catalog pages into the local adult catalog. Items
 * we already carry (same TPDB id) are skipped without a stream lookup; new ones
 * insert ONE row (the largest/1080p release) that lands fully enriched, so it's
 * immediately searchable by title/performer with a poster. Returns rows added.
 */
export async function harvestPtube(opts: { pages?: number; signal?: AbortSignal } = {}): Promise<number> {
  const pages = opts.pages ?? 5;
  let added = 0;
  for (let page = 0; page < pages; page++) {
    if (opts.signal?.aborted) break;
    const metas = await ptubeCatalogPage(page, opts.signal);
    if (!metas.length) break;
    for (const meta of metas) {
      if (opts.signal?.aborted) break;
      if (!meta.tpdbId || !meta.name) continue;
      if (await adultCatalogHasTpdbId(meta.tpdbId)) continue;
      const streams = await ptubeStreams(meta.tpdbId, opts.signal);
      await new Promise((r) => setTimeout(r, STREAM_FETCH_GAP_MS));
      const best = streams[0];
      if (!best) continue;
      const { studio, date } = parseReleaseName(best.releaseName);
      const inserted = await upsertAdultCatalog([{
        infoHash: best.infoHash,
        rawTitle: best.releaseName,
        parsedTitle: meta.name,
        studio,
        sizeBytes: best.sizeBytes,
        year: meta.year,
        sourceTerm: "ptube",
      }]);
      if (!inserted) continue; // hash already present (e.g. via Zilean)
      await updateAdultCatalogEnrichment(best.infoHash, {
        title: meta.name,
        studio,
        performers: meta.performers,
        contentType: "scene",
        posterUrl: meta.posterUrl,
        date,
        year: meta.year ?? (date ? parseInt(date.slice(0, 4), 10) : null),
        tpdbId: meta.tpdbId,
        tpdbType: "scenes",
      });
      added++;
    }
  }
  if (added > 0) logger.info("adult", `catalog: +${added} fully-enriched releases from ptube`);
  return added;
}
