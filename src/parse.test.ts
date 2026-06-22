import { describe, expect, it } from "vitest";

import { detectVr, parseResolutionLabel } from "./parse";

describe("parseResolutionLabel", () => {
  it("reads the resolution from a release name", () => {
    expect(parseResolutionLabel("Studio 24 06 19 Performer Title XXX 2160p MP4-WRB")).toBe("2160p");
    expect(parseResolutionLabel("Blacked.Scene.1080p.WEB")).toBe("1080p");
    expect(parseResolutionLabel("Some.Scene.720p")).toBe("720p");
  });
  it("returns null when no resolution is present", () => {
    expect(parseResolutionLabel("Studio Performer Scene Title")).toBeNull();
  });
});

describe("detectVr", () => {
  it("flags VR releases (tag, studio suffix, projection)", () => {
    expect(detectVr("VRBangers.Scene.Title.8K.180x180")).toBe(true);
    expect(detectVr("WankzVR Performer Scene 1080p")).toBe(true);
    expect(detectVr("Studio Scene VR 2700p")).toBe(true);
    expect(detectVr("CzechVR 600 Scene MKX200")).toBe(true);
    expect(detectVr("Scene.Title.5K.FISHEYE190.SBS")).toBe(true);
  });
  it("does not flag normal flat releases", () => {
    expect(detectVr("Blacked.Scene.2160p.WEB.x265")).toBe(false);
    expect(detectVr("Brazzers Performer Title XXX 1080p MP4-KTR")).toBe(false);
  });
});
