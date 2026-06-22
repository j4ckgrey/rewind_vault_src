/**
 * @vault/searxng — delegating shim for the web-search helper used by the
 * Rapidgator dork search. Forwards to the registered host.
 */
import { getVaultHost, type VaultHost } from "@vault/host";

export const webSearch: VaultHost["webSearch"] = (query, opts) =>
  getVaultHost().webSearch(query, opts);
