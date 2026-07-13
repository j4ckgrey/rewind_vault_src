import { describe, expect, it } from "vitest";

import {
  buildAdultHlsProxyUrl,
  isBlockedProxyHost,
  rewritePlaylist,
  verifyAdultHlsSig,
} from "@vault/hls";

const SECRET = "test-secret-0123456789";
const ORIGIN = "https://rewind.example.com";

// Pull the ?u= and &sig= back out of a built proxy URL.
function parts(proxyUrl: string) {
  const q = new URL(proxyUrl).searchParams;
  const u = q.get("u")!;
  const target = Buffer.from(u, "base64url").toString("utf8");
  return { u, sig: q.get("sig")!, target };
}

describe("buildAdultHlsProxyUrl", () => {
  it("keeps the target's .m3u8 extension so the web player picks hls.js", () => {
    const target = "https://m2cdn.playergo.top/abc/720p/video.m3u8";
    const url = buildAdultHlsProxyUrl(ORIGIN, target, SECRET);
    // The client tests /\.m3u8(\?|$)/ against the URL — it must match.
    expect(/\.m3u8(\?|$)/i.test(url)).toBe(true);
    expect(url.startsWith(`${ORIGIN}/api/adult-hls/`)).toBe(true);
  });

  it("keeps a segment's .ts extension", () => {
    const url = buildAdultHlsProxyUrl(ORIGIN, "https://m2cdn.playergo.top/abc/720p/seg17.ts", SECRET);
    expect(url).toContain("/api/adult-hls/seg17.ts?");
  });

  it("round-trips: a freshly built URL verifies, a tampered target does not", () => {
    const target = "https://m2cdn.playergo.top/abc/720p/video.m3u8";
    const { sig, target: decoded } = parts(buildAdultHlsProxyUrl(ORIGIN, target, SECRET));
    expect(decoded).toBe(target);
    expect(verifyAdultHlsSig(target, sig, SECRET)).toBe(true);
    expect(verifyAdultHlsSig(target + "?evil=1", sig, SECRET)).toBe(false);
    expect(verifyAdultHlsSig(target, sig, "other-secret")).toBe(false);
  });
});

describe("rewritePlaylist", () => {
  const base = "https://m2cdn.playergo.top/abc/720p/video.m3u8";

  it("proxies relative segment URIs and keeps their extension, pinned to the parent host", () => {
    const m3u8 = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.000,",
      "seg0.ts",
      "#EXTINF:6.000,",
      "seg1.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const out = rewritePlaylist(m3u8, base, ORIGIN, SECRET);
    const lines = out.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(lines.length).toBe(2);
    for (const [i, line] of lines.entries()) {
      expect(line.startsWith(`${ORIGIN}/api/adult-hls/seg${i}.ts?`)).toBe(true);
      const { target, sig } = parts(line);
      expect(target).toBe(`https://m2cdn.playergo.top/abc/720p/seg${i}.ts`);
      expect(verifyAdultHlsSig(target, sig, SECRET)).toBe(true);
    }
  });

  it("proxies EXT-X-KEY URI attributes", () => {
    const m3u8 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0\nseg0.ts\n';
    const out = rewritePlaylist(m3u8, base, ORIGIN, SECRET);
    const keyLine = out.split("\n").find((l) => l.startsWith("#EXT-X-KEY"))!;
    const uri = /URI="([^"]+)"/.exec(keyLine)![1];
    expect(uri.startsWith(`${ORIGIN}/api/adult-hls/`)).toBe(true);
    const { target } = parts(uri);
    expect(target).toBe("https://m2cdn.playergo.top/abc/720p/key.bin");
  });

  it("refuses to proxy a hostile absolute URI on a different host (SSRF guard)", () => {
    const m3u8 = "#EXTM3U\nhttp://169.254.169.254/latest/meta-data\nhttps://evil.example/x.ts\nseg0.ts\n";
    const out = rewritePlaylist(m3u8, base, ORIGIN, SECRET);
    expect(out).toContain("http://169.254.169.254/latest/meta-data"); // left untouched
    expect(out).toContain("https://evil.example/x.ts"); // different host → not proxied
    expect(out).toContain(`${ORIGIN}/api/adult-hls/seg0.ts?`); // same host → proxied
  });
});

describe("isBlockedProxyHost", () => {
  it("blocks internal / link-local / bare-name hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1", "rewind-server"]) {
      expect(isBlockedProxyHost(h)).toBe(true);
    }
  });
  it("allows public CDN hosts", () => {
    for (const h of ["m2cdn.playergo.top", "server.apijav.com", "cdn.example.com"]) {
      expect(isBlockedProxyHost(h)).toBe(false);
    }
  });
});
