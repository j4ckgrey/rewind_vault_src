import { describe, expect, it } from "vitest";

import { TorBoxResolver } from "@forge";
import type { StreamAccountRow } from "@vault/db";
import { zileanSearch } from "./zilean";

// Live integration: exercises the REAL zilean client + TorBox cached-check.
// Skipped unless ZILEAN_TEST_TBKEY is provided (so it never runs in plain CI).
const TBKEY = process.env.ZILEAN_TEST_TBKEY;
const ZURL = process.env.ZILEAN_TEST_URL ?? "https://zileanfortheweebs.midnightignite.me";

describe.skipIf(!TBKEY)("adult search pipeline (live Zilean + TorBox)", () => {
  it("returns cached adult torrents for a JAV query", async () => {
    const torrents = await zileanSearch(ZURL, "SSIS", { limit: 60 });
    expect(torrents.length).toBeGreaterThan(0);

    const account = { id: "test", provider: "torbox", api_key: TBKEY } as StreamAccountRow;
    const resolver = new TorBoxResolver(account);
    const candidates = torrents.slice(0, 30).map((t) => ({
      id: t.infoHash,
      sourceType: "zilean",
      sourceId: "test",
      name: "zilean",
      description: t.rawTitle,
      rawTitle: t.rawTitle,
      infoHash: t.infoHash,
    }));
    const cachedMap = await resolver.checkAvailability(candidates);
    const cachedTitles = torrents.filter((t) => cachedMap.get(t.infoHash)).map((t) => t.rawTitle);

    // eslint-disable-next-line no-console
    console.log("CACHED:", cachedTitles.slice(0, 8));
    expect(cachedTitles.length).toBeGreaterThan(0);
  });
});
