import { describe, expect, it } from "vitest";

import { isRelevant, type AdultTorrent } from "./search";
import type { TpdbResult } from "./tpdb";

// isRelevant is the guard that stops the resolver from playing the wrong — and
// worse, a mainstream — video for an opened adult item. These cases pin the two
// regressions that prompted the rewrite: a mainstream film matching a performer
// surname, and JAV exact-code matching.

function meta(partial: Partial<TpdbResult>): TpdbResult {
  return {
    uuid: "u",
    contentType: "scenes",
    title: "Untitled",
    description: null,
    date: null,
    durationSeconds: null,
    posterUrl: null,
    backgroundUrl: null,
    rating: null,
    studio: null,
    performers: [],
    tags: [],
    ...partial,
  };
}

function tor(rawTitle: string, adult: boolean): AdultTorrent {
  return { infoHash: "a".repeat(40), rawTitle, sizeBytes: 1_000_000_000, adult };
}

describe("isRelevant", () => {
  it("rejects a mainstream film that merely shares a performer surname", () => {
    const scene = meta({
      contentType: "scenes",
      title: "Tushy Service",
      studio: "Tushy",
      performers: ["Jessica Bangkok"],
    });
    // The exact false positive seen live: not adult-flagged, looks mainstream.
    expect(isRelevant(scene, tor("Bangkok Dangerous 2000 1080p BluRay H264 AAC-RARBG", false))).toBe(false);
  });

  it("accepts an adult-flagged scene matching a performer", () => {
    const scene = meta({
      contentType: "scenes",
      title: "Anal Threesome",
      studio: "Tushy",
      performers: ["Chanel Camryn"],
    });
    expect(isRelevant(scene, tor("Tushy 24 06 16 Chanel Camryn XXX 1080p MP4-P2P", true))).toBe(true);
  });

  it("requires BOTH studio and performer for an unflagged scene", () => {
    const scene = meta({
      contentType: "scenes",
      title: "Scene",
      studio: "Brazzers",
      performers: ["Angela White"],
    });
    // performer only, not adult-flagged → rejected
    expect(isRelevant(scene, tor("Angela White Documentary 720p WEBRip", false))).toBe(false);
    // studio + performer, not adult-flagged → accepted
    expect(isRelevant(scene, tor("Brazzers Angela White hardcore 1080p", false))).toBe(true);
  });

  it("matches JAV strictly on the exact code", () => {
    const jav = meta({ contentType: "jav", title: "SSIS-698" });
    expect(isRelevant(jav, tor("SSIS-698 FHD mp4", false))).toBe(true);
    expect(isRelevant(jav, tor("SSIS-804 FHD mp4", false))).toBe(false); // wrong code
    expect(isRelevant(jav, tor("Sissi 1955 GERMAN 1080p BluRay", false))).toBe(false);
  });
});
