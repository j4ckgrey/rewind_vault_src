/**
 * Vault host contract.
 *
 * The Vault's adult code is heavily coupled to rewind_server's DB (the
 * adult_catalog table, libraries, kv_cache, stream accounts), its ffprobe
 * helper, and its web-search helper. Rather than import any of those directly,
 * the Vault talks to this `VaultHost`, which the embedder registers once at
 * startup via `setVaultHost()`.
 *
 *   • In-process (current): rewind_server implements VaultHost against its own
 *     SQLite + scanner + searxng + logger (see lib/vaultHost.ts).
 *   • Out-of-process (Phase 5): the standalone Vault service implements it
 *     against its own storage.
 *
 * The delegating shim modules (@vault/db, @vault/log, @vault/scanner,
 * @vault/searxng) forward to the registered host, so the adult code's call sites
 * stay identical to when it lived in rewind_server.
 */
import type {
  AdultCatalogRow,
  AdultCatalogUpsert,
  AdultLibraryConfig,
  LibraryRow,
  ProbeInfo,
  ProbeOutput,
  StreamAccountRow,
  StreamPreferencesRow,
  StreamSourceRow,
  WebSearchResult,
} from "@vault/types";

export interface VaultLogger {
  info(category: string, message: string): void;
  success(category: string, message: string): void;
  warn(category: string, message: string): void;
  error(category: string, message: string, error?: unknown): void;
}

export interface VaultHost {
  // ── addon config + libraries ──
  getAddonConfig(): Promise<Record<string, string>>;
  getLibrary(id: string): Promise<LibraryRow | undefined>;
  parseAdultConfig(row: Pick<LibraryRow, "adult_config_json"> | null | undefined): AdultLibraryConfig;
  // ── stream accounts / sources (debrid + adult indexers) ──
  listStreamAccounts(kind?: "debrid" | "usenet"): Promise<StreamAccountRow[]>;
  getStreamAccount(id: string): Promise<StreamAccountRow | undefined>;
  getStreamPreferences(userId: string): Promise<StreamPreferencesRow>;
  listAdultStreamSources(): Promise<StreamSourceRow[]>;
  // ── adult_catalog table ──
  searchAdultCatalog(query: string, opts?: { limit?: number; matchedOnly?: boolean }): Promise<AdultCatalogRow[]>;
  getAdultCatalogEntry(infoHash: string): Promise<AdultCatalogRow | undefined>;
  listAdultCatalogByTpdbId(tpdbId: string, limit?: number): Promise<AdultCatalogRow[]>;
  listAdultCatalogForEnrich(limit?: number): Promise<AdultCatalogRow[]>;
  upsertAdultCatalog(entries: AdultCatalogUpsert[]): Promise<number>;
  updateAdultCatalogEnrichment(
    infoHash: string,
    m: {
      title?: string | null;
      studio?: string | null;
      performers?: string[] | null;
      contentType?: string | null;
      posterUrl?: string | null;
      date?: string | null;
      year?: number | null;
      tpdbId?: string | null;
      tpdbType?: string | null;
    },
  ): Promise<void>;
  updateAdultCatalogDuration(infoHash: string, seconds: number): Promise<void>;
  adultCatalogHasTpdbId(tpdbId: string): Promise<boolean>;
  adultCatalogStats(): Promise<{ total: number; matched: number; enriched: number }>;
  // ── kv cache ──
  kvGet(key: string, ns?: string): Promise<string | null>;
  kvSet(key: string, ns: string | undefined, value: string, ttlSeconds?: number): Promise<void>;
  // ── media probing + web search ──
  probeFile(filePath: string, httpHeaders?: Record<string, string>): Promise<ProbeOutput | null>;
  parseProbeInfo(probe: ProbeOutput): ProbeInfo;
  webSearch(query: string, opts?: { limit?: number; engines?: string[]; page?: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
  logger: VaultLogger;
}

let _host: VaultHost | null = null;

export function setVaultHost(host: VaultHost): void {
  _host = host;
}

export function getVaultHost(): VaultHost {
  if (!_host) {
    throw new Error("Vault host not configured — call setVaultHost() before using the adult code");
  }
  return _host;
}

export function hasVaultHost(): boolean {
  return _host !== null;
}
