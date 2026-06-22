/**
 * Adult playback sessions.
 *
 * An adult title has no media_meta row (it's a TPDB metadata record + a debrid
 * URL resolved on demand), so it can't flow through the normal item-keyed
 * playback handlers. Instead, `AdultResolve` stashes the resolved stream here
 * under a short opaque token and hands the client a synthetic item id
 * `adult~<token>`. The transcode HLS handler recognises that prefix (exactly
 * like the Google-Drive branch) and feeds the stored URL straight into the
 * shared remote-transcode pipeline — so audio transmux / video copy / HLS
 * segmenting are all the same code paths every other source uses.
 */
import { kvGet, kvSet } from "@vault/db";
import { probeFile, parseProbeInfo } from "@vault/scanner";
import { logger } from "@vault/log";

const NS = "adultplay";
const TTL_SECONDS = 6 * 60 * 60; // 6h — covers a long viewing session.

/** Compact probed stream summary — drives the player's media-info chip
 *  (resolution / codecs / bitrate) for adult items, which have no media_meta
 *  row and so no MediaStreams of their own. */
export interface AdultStreamInfo {
  container?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  /** "WxH" so the client's formatResolution() can label it (1080p/4K/…). */
  resolution?: string | null;
  bitrate?: number | null;
  videoFrameRate?: number | null;
  audioChannels?: number | null;
}

export interface AdultPlaySession {
  /** Resolved debrid stream URL (a direct https link to the file). */
  url: string;
  /** Source duration in seconds, when known (probe/TPDB metadata) — drives the
   *  VOD HLS playlist length. 0 means "unknown, let the probe decide". */
  durationSeconds: number;
  title: string;
  posterUrl: string | null;
  /** The torrent info hash this came from (diagnostics / re-resolve). */
  infoHash: string | null;
  /** Probed stream summary (resolution/codecs) for the media-info chip. */
  streamInfo?: AdultStreamInfo | null;
}

const PREFIX = "adult~";

export function isAdultItemId(itemId: string): boolean {
  return typeof itemId === "string" && itemId.startsWith(PREFIX);
}

/** Random url-safe token — no DB dependency, good enough for a play handle. */
function randomToken(): string {
  return Array.from({ length: 24 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)],
  ).join("");
}

/** Store a resolved stream and return the synthetic `adult~<token>` item id. */
export async function createAdultPlaySession(session: AdultPlaySession): Promise<string> {
  const token = randomToken();
  await kvSet(token, NS, JSON.stringify(session), TTL_SECONDS);
  return `${PREFIX}${token}`;
}

export interface AdultProbeResult {
  /** Real source duration from the container header (0 when unknown). */
  durationSeconds: number;
  streamInfo: AdultStreamInfo;
  /** True only when the file actually carries a video stream — archives,
   *  audio-only, and corrupt files come back false so callers can reject them
   *  instead of handing the player a 4-hour placeholder it can never fill. */
  hasVideo: boolean;
}

/**
 * ffprobe a resolved adult stream URL (bounded) → real duration + a compact
 * stream summary for the player's media-info chip. Returns null on probe
 * failure/timeout — the caller decides whether to proceed without it. This is
 * what stops the "4h duration that shrinks while seeking" (no probed runtime →
 * the HLS path fell back to a 4h placeholder) and the blank stream-info chip
 * (adult items have no media_meta row, so the probe is their only source of
 * resolution/codec data).
 */
export async function probeAdultStream(
  url: string,
  timeoutMs = 12_000,
): Promise<AdultProbeResult | null> {
  try {
    const probe = await Promise.race([
      probeFile(url),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!probe) return null;
    const info = parseProbeInfo(probe);
    const hasVideo = !!info.videoCodec && (info.width ?? 0) > 0;
    const streamInfo: AdultStreamInfo = {
      container: info.container,
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec,
      resolution: info.width && info.height ? `${info.width}x${info.height}` : null,
      bitrate: info.bitrate,
      videoFrameRate: info.framerate ?? null,
      audioChannels: info.audioChannels,
    };
    return { durationSeconds: info.runtimeSeconds || 0, streamInfo, hasVideo };
  } catch (e) {
    logger.warn("adult", `probe failed: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

export async function getAdultPlaySession(itemId: string): Promise<AdultPlaySession | null> {
  if (!isAdultItemId(itemId)) return null;
  const token = itemId.slice(PREFIX.length);
  const raw = await kvGet(token, NS);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as AdultPlaySession;
    if (typeof s?.url !== "string" || !s.url) return null;
    return s;
  } catch {
    return null;
  }
}
