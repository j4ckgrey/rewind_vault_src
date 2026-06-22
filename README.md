# The Vault — Rewind Addon (adult)

The Vault is the **adult content** integration for Rewind. It is the
highest-risk piece and is therefore shipped **separately from the core Rewind
server** and from The Forge — the server carries no adult catalog, scraper, or
search code, and nothing adult exists until you install The Vault.

When installed, The Vault:

- enables the **Adult** (password-locked) library kind in *Add Library*;
- reveals the **Adult** sources section in the Forge tab (Zilean / Torznab /
  apiJAV backends used **only** by adult libraries);
- reveals the **ThePornDB** metadata credential in the API Keys tab;
- activates the adult endpoints (search / streams / resolve), all password-gated.

While The Vault is **not** installed, every adult endpoint returns 404 even for a
pre-existing adult library — the content is completely inert.

## Installing

In the Rewind dashboard go to **Integrations → Addons**, paste the manifest URL
(e.g. `https://github.com/j4ckgrey/rewind_vault/blob/main/manifest.json`), and press **Install**.

## Layout

```
rewind_vault/
  manifest.json     Rewind addon manifest (the install URL points at this)
  src/
    index.ts        namespaced public API
    host.ts         VaultHost contract — everything the Vault needs from its host
    db.ts log.ts scanner.ts searxng.ts   delegating shims → the host
    types.ts        domain types (AdultCatalogRow, LibraryRow, …)
    search.ts catalog.ts           TPDB search + local adult torrent index
    zilean.ts ptube.ts             catalog harvest feeds
    tpdb.ts                        ThePornDB metadata client
    apijav.ts                      JAV (direct HLS) source
    rapidgator.ts                  Rapidgator web-dork source
    playback.ts                    adult play sessions + ffprobe stream info
```

The Vault is heavily coupled to rewind_server's DB (the `adult_catalog` table,
libraries, kv cache, stream accounts), its ffprobe helper, and its web-search
helper — so it talks to all of them through the `VaultHost` contract in
`host.ts`, registered once via `setVaultHost()`. It also depends on **The Forge**
(`@forge`) to resolve adult streams through the debrid resolvers.

## Consuming it

- **In-process (current):** rewind_server source-imports submodules granularly
  via the `@vault/*` path alias (tsconfig `paths` + Next `experimental.externalDir`)
  from its thin `handleAdult*` shells in `src/lib/handlers/libraries.ts`, and
  registers a `VaultHost` backed by its own SQLite/scanner/searxng (see
  `rewind_server/src/lib/vaultHost.ts`). Every adult endpoint 404s until the
  `addon_vault_installed` flag is set. The Docker build context must include this
  dir; for dev, `rewind_vault/node_modules` is symlinked to rewind_server's
  install.
- **Standalone (Phase 5):** wrap the submodules in an HTTP service and run as its
  own container.

## Develop

```sh
npm install
npm run typecheck
npm test
```
