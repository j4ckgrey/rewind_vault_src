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
(e.g. `https://raw.githubusercontent.com/j4ckgrey/rewind_vault/main/manifest.json`), and press **Install**.

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

## How it's consumed (runtime plugin — NOT part of the server build)

The server ships clean; every adult endpoint 404s until this addon is installed.
`src/plugin.ts` exports `register(host)` (calls `setVaultHost`, returns the
namespaces the server's thin `handleAdult*` shells call). Install flow:
`npm run build` → publish `dist/index.mjs` → paste this repo's `manifest.json`
URL in **Integrations → Addons** → the server downloads the bundle into
`data/addons/adult/index.mjs` and loads it with its DB/ffprobe/web-search host.
The build bundles The Forge's resolver/parser (via `@forge`) so the Vault
resolves adult streams through the debrid resolvers without a separate install.

## Develop

```sh
npm install
npm run typecheck
npm test
npm run build      # → dist/index.mjs
```
