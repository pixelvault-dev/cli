import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const video = {
  id: "vid_1",
  kind: "video",
  url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
  visibility: "public",
  mime_type: "video/mp4",
  size: 1_000,
  filename: "clip.mp4",
  created_at: "2026-01-01T00:00:00.000Z",
  width: 640,
  height: 360,
  duration_seconds: 5,
  video_codec: "hevc",
  audio_codec: "aac",
  has_audio: true,
  fast_start: false,
  social_compatible: false,
  compatibility_warnings: [],
};

function fakeApi(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    calls,
    stdout: () => out.mock.calls.map((call) => String(call[0])).join(""),
    stderr: () => err.mock.calls.map((call) => String(call[0])).join(""),
  };
}

async function run(args: Record<string, unknown>) {
  const { default: command } = await import("../../src/commands/optimize-video.js");
  // Citty's command union erases the concrete run context after dynamic import.
  const runnable = command as unknown as {
    run(context: { args: Record<string, unknown> }): Promise<void>;
  };
  await runnable.run({
    args: { id: "vid_1", wait: false, json: false, ...args },
  });
}

describe("optimize-video command", () => {
  it("prints only the completed social URL to stdout", async () => {
    const api = fakeApi({
      data: {
        ...video,
        social_optimization: {
          preset: "social",
          status: "complete",
          source: "derived",
          url: "https://img.pixelvault.dev/proj_1/vid_1.social.mp4",
        },
      },
    });

    await run({});

    expect(api.calls[0].url).toBe(
      "https://api.test.pixelvault.dev/v1/videos/vid_1/optimize",
    );
    expect(api.calls[0].init.method).toBe("POST");
    expect(api.stdout()).toBe(
      "https://img.pixelvault.dev/proj_1/vid_1.social.mp4\n",
    );
    expect(api.stderr()).toContain("original is unchanged");
  });

  it("reports an enqueued job without putting the original URL on stdout", async () => {
    const api = fakeApi({
      data: {
        ...video,
        social_optimization: { preset: "social", status: "pending" },
      },
    });

    await run({});

    expect(api.stdout()).toBe("");
    expect(api.stderr()).toContain("Optimization pending");
  });

  it("surfaces a failed job message", async () => {
    fakeApi({
      data: {
        ...video,
        social_optimization: {
          preset: "social",
          status: "failed",
          error: { code: "optimization_failed", message: "Codec not supported." },
        },
      },
    });

    await expect(run({})).rejects.toThrow("Codec not supported");
  });
});
