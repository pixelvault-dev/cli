import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isRemoteVideoUrl, uploadVideoFile, uploadVideoUrl } from "../../src/lib/video-upload.js";

vi.mock("../../src/lib/config.js", () => ({
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const testDir = join(tmpdir(), `pixelvault-video-upload-test-${Date.now()}`);
const video = {
  id: "vid_test",
  kind: "video" as const,
  url: "https://img.pixelvault.dev/proj_test/vid_test.mp4",
  original_url: "https://img.pixelvault.dev/proj_test/vid_test.mp4",
  visibility: "public" as const,
  mime_type: "video/mp4" as const,
  size: 16,
  filename: "clip.mp4",
  created_at: "2026-11-15T00:00:00.000Z",
  social_optimization: {
    preset: "social" as const,
    status: "not_requested" as const,
  },
};

async function cancelBody(init?: RequestInit): Promise<void> {
  if (init?.body instanceof ReadableStream) await init.body.cancel();
}

describe("video upload client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("asks the API to import a public MP4 URL without downloading it locally", async () => {
    const sourceUrl = "https://media.example.com/demo.mp4?token=secret";
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.test.pixelvault.dev/v1/videos");
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ url: sourceUrl, visibility: "public" });
      return Response.json({ data: video }, { status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(uploadVideoUrl(sourceUrl, "pv_live_test")).resolves.toEqual(video);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(isRemoteVideoUrl(sourceUrl)).toBe(true);
    expect(isRemoteVideoUrl("/tmp/demo.mp4")).toBe(false);
  });

  it("requests a social-ready copy for URL imports", async () => {
    const sourceUrl = "https://media.example.com/demo.mp4";
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        url: sourceUrl,
        visibility: "public",
        social_ready: true,
      });
      return Response.json({
        data: {
          ...video,
          social_optimization: { preset: "social", status: "pending" },
        },
      }, { status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(uploadVideoUrl(sourceUrl, "pv_live_test", {
      socialReady: true,
    })).resolves.toMatchObject({
      social_optimization: { status: "pending" },
    });
  });

  it("sends private visibility and signed-link expiry for a direct MP4", async () => {
    const path = join(testDir, "clip.mp4");
    writeFileSync(path, Buffer.from("\0\0\0\x10ftypisom\0\0\0\0", "binary"));
    const privateVideo = {
      ...video,
      visibility: "private" as const,
      signed_expires: 1_800_000_000,
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      await cancelBody(init);
      expect(String(url)).toBe("https://api.test.pixelvault.dev/v1/videos");
      expect(init?.headers).toMatchObject({
        "Content-Type": "video/mp4",
        "Content-Length": "16",
        "X-PixelVault-Filename": "clip.mp4",
        "X-PixelVault-Visibility": "private",
        "X-PixelVault-Sign-Expires-In": "43200",
        "X-PixelVault-Social-Ready": "true",
      });
      return Response.json({ data: privateVideo }, { status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(uploadVideoFile(path, "pv_live_test", {
      private: true,
      signExpiresIn: 43_200,
      socialReady: true,
    })).resolves.toEqual(privateVideo);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses ordered multipart requests above 100 MB without reading the file into memory", async () => {
    const path = join(testDir, "large.mp4");
    writeFileSync(path, Buffer.alloc(0));
    truncateSync(path, 100_000_001);
    const calls: { method?: string; path: string; length?: string }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const pathName = new URL(String(url)).pathname;
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ method: init?.method, path: pathName, length: headers?.["Content-Length"] });
      await cancelBody(init);
      if (pathName === "/v1/videos/uploads") {
        return Response.json({ data: { upload_id: "vup_test", part_size: 100_000_000 } }, { status: 201 });
      }
      if (pathName.endsWith("/complete")) {
        return Response.json({ data: { ...video, size: 100_000_001 } }, { status: 201 });
      }
      return Response.json({ data: { received: Number(headers?.["Content-Length"]) } });
    }) as typeof fetch;

    const result = await uploadVideoFile(path, "pv_live_test");

    expect(result.size).toBe(100_000_001);
    expect(calls).toEqual([
      { method: "POST", path: "/v1/videos/uploads", length: undefined },
      { method: "PUT", path: "/v1/videos/uploads/vup_test/parts/1", length: "100000000" },
      { method: "PUT", path: "/v1/videos/uploads/vup_test/parts/2", length: "1" },
      { method: "POST", path: "/v1/videos/uploads/vup_test/complete", length: undefined },
    ]);
  });
});
