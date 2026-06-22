/**
 * The Vault — public API.
 *
 * The host contract (`setVaultHost`) must be satisfied once at startup before
 * any adult code runs. rewind_server imports the submodules granularly via
 * `@vault/<module>`; these namespaced re-exports are the clean entry point for
 * standalone use.
 */
export * from "@vault/host";
export * as catalog from "@vault/catalog";
export * as search from "@vault/search";
export * as apijav from "@vault/apijav";
export * as rapidgator from "@vault/rapidgator";
export * as playback from "@vault/playback";
