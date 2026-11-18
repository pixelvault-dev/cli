import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock config
vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const testDir = join(tmpdir(), `pixelvault-upload-test-${Date.now()}`);

describe("upload command", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uploads a file and gets back a URL", async () => {
    // Create a test file
    const testFile = join(testDir, "test.png");
    writeFileSync(testFile, Buffer.from("fake-png-data"));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "img_abc123",
            url: "https://img.pixelvault.dev/proj_123/img_abc123.png",
            mime_type: "image/png",
            size: 14,
            filename: "test.png",
            folder: null,
            created_at: "2026-03-16T00:00:00Z",
          },
        }),
    });

    // Import the upload module and test its core logic
    const { apiRequest } = await import("../../src/lib/client.js");

    const res = await apiRequest<{
      data: { url: string; id: string };
    }>({
      method: "POST",
      path: "/v1/images",
      auth: "pv_live_test",
      formData: new FormData(),
    });

    expect(res.data.url).toBe(
      "https://img.pixelvault.dev/proj_123/img_abc123.png"
    );
    expect(res.data.id).toBe("img_abc123");
  });

  it("uploads every positional file, not just the first", async () => {
    const paths = ["a.jpg", "b.jpg", "c.jpg"].map((name) => {
      const p = join(testDir, name);
      writeFileSync(p, Buffer.from(name));
      return p;
    });

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      return {
        ok: true,
        json: () =>
          Promise.resolve({ data: { id: file.name, url: `https://img.test/${file.name}` } }),
      };
    });
    globalThis.fetch = fetchMock;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [...paths, "--folder", "test"] });
    const printed = out.mock.calls.map((c) => String(c[0]).trim());
    out.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(printed).toEqual([
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
    ]);
  });

  it("imports a public MP4 URL through the video endpoint", async () => {
    const sourceUrl = "https://media.example.com/demo.mp4?token=secret";
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ url: sourceUrl, visibility: "public" });
      return Response.json({
        data: {
          id: "vid_test",
          kind: "video",
          url: "https://img.test/vid_test.mp4",
          visibility: "public",
          mime_type: "video/mp4",
          size: 16,
          filename: "demo.mp4",
          created_at: "2026-11-15T00:00:00.000Z",
          social_compatible: false,
          compatibility_warnings: [
            { code: "not_fast_start", message: "Move the moov atom before media data." },
          ],
        },
      }, { status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [sourceUrl] });
    const printed = out.mock.calls.map((call) => String(call[0]).trim());
    out.mockRestore();
    const errors = err.mock.calls.map((call) => String(call[0]).trim());
    err.mockRestore();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(printed).toEqual(["https://img.test/vid_test.mp4"]);
    expect(errors).toEqual([
      "Video compatibility warning: Move the moov atom before media data.",
    ]);
  });

  it("--social uploads, waits, and prints the social-ready URL", async () => {
    const sourceUrl = "https://media.example.com/hevc-demo.mp4";
    const socialUrl = "https://img.test/vid_social.social.mp4";
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        url: sourceUrl,
        visibility: "public",
        social_ready: true,
      });
      return Response.json({
        data: {
          id: "vid_social",
          kind: "video",
          url: "https://img.test/vid_social.mp4",
          original_url: "https://img.test/vid_social.mp4",
          social_ready_url: socialUrl,
          visibility: "public",
          mime_type: "video/mp4",
          size: 16,
          filename: "hevc-demo.mp4",
          created_at: "2026-11-15T00:00:00.000Z",
          width: 1920,
          height: 1080,
          duration_seconds: 12,
          video_codec: "hevc",
          audio_codec: "aac",
          has_audio: true,
          fast_start: false,
          social_compatible: false,
          compatibility_warnings: [
            { code: "video_codec_not_h264", message: "Use H.264 video." },
          ],
          social_optimization: {
            preset: "social",
            status: "complete",
            source: "derived",
            url: socialUrl,
          },
        },
      }, { status: 201 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [sourceUrl, "--social"] });
    const printed = out.mock.calls.map((call) => String(call[0]).trim());
    out.mockRestore();
    const errors = err.mock.calls.map((call) => String(call[0]).trim());
    err.mockRestore();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(printed).toEqual([socialUrl]);
    expect(errors).toEqual([]);
  });

  it("keeps going past a failed file and exits non-zero", async () => {
    const good = ["a.jpg", "c.jpg"].map((name) => {
      const p = join(testDir, name);
      writeFileSync(p, Buffer.from(name));
      return p;
    });
    const missing = join(testDir, "missing.jpg");

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      return {
        ok: true,
        json: () =>
          Promise.resolve({ data: { id: file.name, url: `https://img.test/${file.name}` } }),
      };
    });
    globalThis.fetch = fetchMock;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [good[0], missing, good[1]] });
    const printed = out.mock.calls.map((c) => String(c[0]).trim());
    out.mockRestore();
    err.mockRestore();
    const exitCodes = exit.mock.calls.map((c) => c[0]);
    exit.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(printed).toEqual(["https://img.test/a.jpg", "https://img.test/c.jpg"]);
    expect(exitCodes).toEqual([1]);
  });

  it("--optimized prints optimized_url, falling back to url when absent", async () => {
    const names = ["a.png", "b.svg"];
    const paths = names.map((name) => {
      const p = join(testDir, name);
      writeFileSync(p, Buffer.from(name));
      return p;
    });
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      const base = `https://img.test/${file.name}`;
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              id: file.name,
              url: base,
              ...(file.name.endsWith(".png") ? { optimized_url: `${base}?fmt=auto&q=85` } : {}),
            },
          }),
      };
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [...paths, "--optimized"] });
    const printed = out.mock.calls.map((c) => String(c[0]).trim());
    out.mockRestore();

    expect(printed).toEqual([
      "https://img.test/a.png?fmt=auto&q=85",
      "https://img.test/b.svg",
    ]);
  });
  it("--branded prints the custom-domain URL and falls back to the canonical URL", async () => {
    const names = ["custom.png", "canonical.png"];
    const paths = names.map((name) => {
      const path = join(testDir, name);
      writeFileSync(path, Buffer.from(name));
      return path;
    });
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      const canonical = `https://img.test/proj_1/${file.name}`;
      return {
        ok: true,
        json: () => Promise.resolve({
          data: {
            id: file.name,
            url: canonical,
            ...(file.name === "custom.png"
              ? { branded_url: `https://media.example.com/${file.name}` }
              : {}),
          },
        }),
      };
    });
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [...paths, "--branded"] });
    const printed = out.mock.calls.map((call) => String(call[0]).trim());
    out.mockRestore();

    expect(printed).toEqual([
      "https://media.example.com/custom.png",
      "https://img.test/proj_1/canonical.png",
    ]);
  });

});
