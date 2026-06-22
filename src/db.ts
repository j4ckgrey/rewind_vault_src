/**
 * @vault/db — delegating shim.
 *
 * Re-exports the rewind_server DB functions the adult code uses, each forwarding
 * to the registered VaultHost. The adult files import from here exactly as they
 * used to import from "@vault/db", so their call sites are unchanged. Domain types
 * are re-exported from @vault/types.
 */
import { getVaultHost, type VaultHost } from "@vault/host";

export type {
  AdultCatalogRow,
  AdultCatalogUpsert,
  AdultLibraryConfig,
  LibraryRow,
  StreamAccountRow,
  StreamSourceRow,
} from "@vault/types";

export const getAddonConfig: VaultHost["getAddonConfig"] = () => getVaultHost().getAddonConfig();
export const getLibrary: VaultHost["getLibrary"] = (id) => getVaultHost().getLibrary(id);
export const parseAdultConfig: VaultHost["parseAdultConfig"] = (row) => getVaultHost().parseAdultConfig(row);
export const listStreamAccounts: VaultHost["listStreamAccounts"] = (kind) => getVaultHost().listStreamAccounts(kind);
export const getStreamAccount: VaultHost["getStreamAccount"] = (id) => getVaultHost().getStreamAccount(id);
export const getStreamPreferences: VaultHost["getStreamPreferences"] = (userId) => getVaultHost().getStreamPreferences(userId);
export const listAdultStreamSources: VaultHost["listAdultStreamSources"] = () => getVaultHost().listAdultStreamSources();
export const searchAdultCatalog: VaultHost["searchAdultCatalog"] = (q, opts) => getVaultHost().searchAdultCatalog(q, opts);
export const getAdultCatalogEntry: VaultHost["getAdultCatalogEntry"] = (h) => getVaultHost().getAdultCatalogEntry(h);
export const listAdultCatalogByTpdbId: VaultHost["listAdultCatalogByTpdbId"] = (id, limit) => getVaultHost().listAdultCatalogByTpdbId(id, limit);
export const listAdultCatalogForEnrich: VaultHost["listAdultCatalogForEnrich"] = (limit) => getVaultHost().listAdultCatalogForEnrich(limit);
export const upsertAdultCatalog: VaultHost["upsertAdultCatalog"] = (entries) => getVaultHost().upsertAdultCatalog(entries);
export const updateAdultCatalogEnrichment: VaultHost["updateAdultCatalogEnrichment"] = (h, m) => getVaultHost().updateAdultCatalogEnrichment(h, m);
export const updateAdultCatalogDuration: VaultHost["updateAdultCatalogDuration"] = (h, s) => getVaultHost().updateAdultCatalogDuration(h, s);
export const adultCatalogHasTpdbId: VaultHost["adultCatalogHasTpdbId"] = (id) => getVaultHost().adultCatalogHasTpdbId(id);
export const adultCatalogStats: VaultHost["adultCatalogStats"] = () => getVaultHost().adultCatalogStats();
export const kvGet: VaultHost["kvGet"] = (key, ns) => getVaultHost().kvGet(key, ns);
export const kvSet: VaultHost["kvSet"] = (key, ns, value, ttl) => getVaultHost().kvSet(key, ns, value, ttl);
