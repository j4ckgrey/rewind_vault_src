import { describe, expect, it } from "vitest";

import { getLibrary, listAdultStreamSources } from "@vault/db";
import { adultResolveItem, adultSearch } from "./search";
import { apijavResolve, apijavSearch } from "./apijav";

// End-to-end PLAYBACK validation against a copy of the real prod DB. Gated by
// RESOLVE_LIVE=1 and REWIND_DB_PATH pointing at the DB copy. Proves the actual
// resolve code returns a URL that streams real bytes — not just that results
// list. The adult library id is the prod one.
const LIVE = process.env.RESOLVE_LIVE === "1";
const LIB_ID = process.env.ADULT_LIB_ID || "7b8ac2fa-b706-465d-b09f-ddf53a2a6a40";

async function rangeProbe(url: string) {
  const r = await fetch(url, { headers: { Range: "bytes=0-131071", "User-Agent": "Mozilla/5.0" } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ok: r.ok, bytes: buf.length, ct: r.headers.get("content-type"), b0: buf[0] };
}

describe.skipIf(!LIVE)("adult resolve → real playback (prod DB copy)", () => {
  it("auto-seeded an adult Forge source from the library config", async () => {
    const srcs = await listAdultStreamSources();
    // eslint-disable-next-line no-console
    console.log("ADULT SOURCES:", srcs.map((s) => `${s.source_type} ${s.url}`));
    expect(srcs.length).toBeGreaterThan(0);
  });

  it("zilean/TPDB: resolves a scene to a streamable debrid URL", async () => {
    const lib = await getLibrary(LIB_ID);
    expect(lib).toBeTruthy();
    const results = await adultSearch(lib!, "Blacked", { types: ["scenes"] });
    expect(results.length).toBeGreaterThan(0);

    let played: string | null = null;
    for (const r of results.slice(0, 15)) {
      if (r.kind === "performer") continue;
      const pb = await adultResolveItem(lib!, r.id).catch(() => null);
      if (!pb || "queued" in pb) continue;
      const probe = await rangeProbe(pb.url).catch(() => null);
      // eslint-disable-next-line no-console
      console.log("RESOLVED:", r.title.slice(0, 40), "→", pb.url.slice(0, 70), probe);
      if (probe && probe.ok && probe.bytes > 10_000) { played = pb.url; break; }
    }
    expect(played, "no scene resolved to a streaming URL").not.toBeNull();
  }, 120_000);

  it("apiJAV: resolves to HLS whose segments actually download", async () => {
    const list = await apijavSearch(undefined, { query: "SSIS", perPage: 5 });
    expect(list.length).toBeGreaterThan(0);
    const pb = await apijavResolve(undefined, list[0]!.id.slice("apijav:".length));
    expect(pb?.url).toMatch(/\.m3u8(\?|$)/);

    const master = await (await fetch(pb!.url)).text();
    const variantRel = master.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    expect(variantRel).toBeTruthy();
    const variantUrl = new URL(variantRel!.trim(), pb!.url).toString();
    const variant = await (await fetch(variantUrl)).text();
    const segRel = variant.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    expect(segRel).toBeTruthy();
    const segUrl = new URL(segRel!.trim(), variantUrl).toString();
    const probe = await rangeProbe(segUrl);
    // eslint-disable-next-line no-console
    console.log("APIJAV SEGMENT:", segUrl.slice(0, 70), probe);
    expect(probe.bytes).toBeGreaterThan(10_000); // real media bytes
  }, 120_000);
});
