/**
 * The Vault — domain types.
 *
 * Copied from rewind_server's DB layer so this repo type-checks on its own. The
 * host (rewind_server today; a standalone DB in Phase 5) returns/accepts these
 * exact shapes. `StreamAccountRow` / `StreamSourceRow` / `StreamCandidate` come
 * from The Forge (the Vault resolves adult streams through the Forge resolvers).
 */
export type { StreamAccountRow, StreamSourceRow, StreamPreferencesRow, StreamCandidate } from "@forge";

export type LibraryRow = {
  id: string;
  name: string;
  kind: string;
  path: string;
  metadata_sources_json: string;
  created_at: string;
  item_count?: number;
  description: string;
  descriptions_json: string;
  image_path: string | null;
  hide_card_label: number;
  password_hash: string | null;
  password: string | null;
  adult_config_json: string;
};

/** Per-adult-library configuration stored in `adult_config_json`. */
export type AdultLibraryConfig = {
  sources?: string[];
  contentTypes?: Array<"scenes" | "movies" | "jav">;
  tpdbToken?: string;
  zileanUrl?: string;
};

/** A row in the local adult torrent index. */
export type AdultCatalogRow = {
  info_hash: string;
  raw_title: string;
  parsed_title: string | null;
  title: string | null;
  studio: string | null;
  performers_json: string;
  content_type: string | null;
  poster_url: string | null;
  date: string | null;
  year: number | null;
  size_bytes: number | null;
  tpdb_id: string | null;
  tpdb_type: string | null;
  enriched_at: number | null;
  source_term: string | null;
  duration_seconds: number | null;
  added_at: number;
};

/** One harvested torrent to add/update (enrich fields filled later). */
export type AdultCatalogUpsert = {
  infoHash: string;
  rawTitle: string;
  parsedTitle?: string | null;
  studio?: string | null;
  sizeBytes?: number | null;
  year?: number | null;
  sourceTerm?: string | null;
};

/** Minimal ffprobe output shape the Vault reads (full shape lives in the host). */
export type ProbeOutput = { format?: { duration?: number | string | null } } & Record<string, unknown>;

/** Parsed probe info the Vault reads for the stream-info chip + duration. */
export type ProbeInfo = {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  framerate: number | null;
  runtimeSeconds: number | null;
};

/** A web-search hit (Serper/SearXNG) used by the Rapidgator dork search. */
export type WebSearchResult = { url: string; title: string };
