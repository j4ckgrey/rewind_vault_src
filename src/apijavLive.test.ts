import { describe, expect, it } from "vitest";

import { apijavCategories, apijavResolve, apijavSearch } from "./apijav";

// Live integration against the real apiJAV instance. Skipped unless APIJAV_LIVE=1
// so it never runs in plain CI. Validates the full slice: search → resolve →
// deobfuscated HLS URL, plus the category list used by the in-library dropdown.
const LIVE = process.env.APIJAV_LIVE === "1";

describe.skipIf(!LIVE)("apiJAV live", () => {
  it("searches and returns apijav-tagged JAV cards", async () => {
    const results = await apijavSearch(undefined, { query: "SSIS", perPage: 5 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.source).toBe("apijav");
      expect(r.id.startsWith("apijav:")).toBe(true);
      expect(r.contentType).toBe("jav");
    }
  });

  it("resolves a post to a direct HLS url", async () => {
    const results = await apijavSearch(undefined, { query: "SSIS", perPage: 5 });
    const id = results[0]!.id.slice("apijav:".length);
    const pb = await apijavResolve(undefined, id);
    expect(pb).not.toBeNull();
    expect(pb!.url).toMatch(/\.m3u8(\?|$)/);
    // eslint-disable-next-line no-console
    console.log("APIJAV HLS:", pb!.url);
  });

  it("lists categories for the dropdown", async () => {
    const cats = await apijavCategories(undefined);
    expect(cats.length).toBeGreaterThan(0);
    expect(cats[0]).toHaveProperty("slug");
  });
});
