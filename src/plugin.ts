/**
 * The Vault — runtime plugin entry (SDK edition).
 *
 * `node build.mjs` bundles this file + all its imports + deps (including The
 * Forge's resolver/parser via the @forge alias) into a single self-contained
 * `dist/index.mjs`; `./publish.sh` commits ONLY that artifact (+ manifest.json)
 * to the dist-only `release` branch operators install from. The server imports
 * the bundle and calls `register(host)` once, handing over its DB / ffprobe /
 * web-search / logger as the VaultHost.
 *
 * Built with @rewind/addon-sdk `defineAddon`:
 *   • `api`      — the namespaces the server's adult handlers call directly
 *                  (catalog/search/apijav/rapidgator/playback + the HLS proxy).
 *   • `resources`— unified protocol handlers for type "adult", served at
 *                  /api/addons/adult/<resource>/adult/<id>.json. Handlers that
 *                  need the adult library take `extra.libraryId`.
 */
import { defineAddon, type AddonManifest, type ResourceRequest } from "@sdk";

import { setVaultHost, getVaultHost, type VaultHost } from "@vault/host";
import type { LibraryRow } from "@vault/types";
import * as catalog from "@vault/catalog";
import * as search from "@vault/search";
import * as apijav from "@vault/apijav";
import * as rapidgator from "@vault/rapidgator";
import * as playback from "@vault/playback";
import * as hls from "@vault/hls";

import manifestJson from "../manifest.json";

/** 40-hex = a torrent infoHash (catalog anchor); anything else is a TPDB id. */
const isInfoHash = (id: string) => /^[a-f0-9]{40}$/i.test(id);

async function libraryFromRequest({ extra }: ResourceRequest): Promise<LibraryRow> {
  const libraryId = typeof extra.libraryId === "string" ? extra.libraryId : "";
  const library = libraryId ? await getVaultHost().getLibrary(libraryId) : undefined;
  if (!library) throw new Error("extra.libraryId must name an adult library");
  return library;
}

export const addon = defineAddon({
  manifest: manifestJson as AddonManifest,
  setup(host: VaultHost) {
    setVaultHost(host);
    const api = { catalog, search, apijav, rapidgator, playback, hls };
    return {
      api,
      resources: {
        // search/adult/<query>.json?libraryId=… — TPDB-backed adult search.
        search: async (req) => ({
          metas: await search.adultSearch(await libraryFromRequest(req), req.id),
        }),
        // catalog/adult/<query>.json — the locally-harvested adult catalog.
        catalog: async (req) => ({
          metas: await catalog.searchCatalog(
            (req.extra.libraryId ? await libraryFromRequest(req) : ({} as LibraryRow)),
            req.id,
          ),
        }),
        // stream/adult/<id>.json?libraryId=… — release candidates for an item.
        stream: async (req) => ({
          streams: isInfoHash(req.id)
            ? await catalog.adultListCatalogStreams(req.id.toLowerCase())
            : await search.adultListStreams(await libraryFromRequest(req), req.id),
        }),
        // resolve/adult/<id>.json?libraryId=…&hash=… — resolve to playback.
        resolve: async (req) => ({
          playback: isInfoHash(req.id)
            ? await catalog.adultResolveCatalog(req.id.toLowerCase())
            : await search.adultResolveItem(await libraryFromRequest(req), req.id, undefined, {
                hash: typeof req.extra.hash === "string" ? req.extra.hash : undefined,
              }),
        }),
      },
    };
  },
});

export const manifest = addon.manifest;
export const register = addon.register;
