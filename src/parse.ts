/**
 * Small release-name helpers shared by the adult card + stream-picker paths.
 * Kept in its own module so both catalog.ts and search.ts can use them without
 * an import cycle (catalog.ts ⇄ search.ts).
 */
import { parseReleaseName } from "@forge";

/** Parsed resolution label ("2160p" / "1080p" / …) or null when unknown. */
export function parseResolutionLabel(rawTitle: string): string | null {
  const r = parseReleaseName(rawTitle).resolution;
  return r && r !== "unknown" ? r : null;
}

// VR releases name themselves loudly: a standalone "VR" tag, a studio whose name
// ends in "VR" (WankzVR / BaDoinkVR / CzechVR …), or a stereoscopic-projection
// marker (180x180, MKX200, FISHEYE190, SBS, …). Any of those = treat as VR.
const VR_TOKEN = /\bvr\b/i;
const VR_STUDIO_SUFFIX = /[a-z]{2,}vr\b/i;
const VR_PROJECTION =
  /\b(?:180x180|180_180|360x180|mkx200|mkx220|mkx[0-9]{3}|fisheye190|fisheye|rf52|lr_?180|tb_?180|sbs|oculus|gearvr|smartphone_?vr|180°|360°)\b/i;

/** True when a release name looks like VR. */
export function detectVr(rawTitle: string): boolean {
  if (!rawTitle) return false;
  return VR_TOKEN.test(rawTitle) || VR_STUDIO_SUFFIX.test(rawTitle) || VR_PROJECTION.test(rawTitle);
}
