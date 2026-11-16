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
  original_url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
  visibility: "public",
  mime_type: "video/mp4",
  size: 1_000,
  filename: "clip.mp4",
  created_at: "2026-01-01T00:00:00.000Z",
  width: 640,
  height: 360,
  duration_seconds: 5,
  video_codec: "h264",
  audio_codec: "aac",
  has_audio: true,
  fast_start: true,
  social_compatible: true,
  compatibility_warnings: [],
  social_optimization: { preset: "social", status: "not_requested" },
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
  const { default: command } = await import("../../src/commands/enrich-video.js");
  const runnable = command as unknown as {
    run(context: { args: Record<string, unknown> }): Promise<void>;
  };
  await runnable.run({
    args: { id: "vid_1", wait: false, json: false, ...args },
  });
}

describe("enrich-video command", () => {
  it("prints completed artifact metadata as JSON", async () => {
    const api = fakeApi({
      data: {
        ...video,
        enrichment: {
          status: "complete",
          transcript: {
            status: "complete",
            vtt_url: "https://img.pixelvault.dev/proj_1/vid_1.transcript.vtt",
          },
          storyboard: {
            status: "complete",
            index_url: "https://img.pixelvault.dev/proj_1/vid_1.storyboard.json",
            frame_count: 16,
            sheets: [],
          },
        },
      },
    });

    await run({});

    expect(api.calls[0].url).toBe(
      "https://api.test.pixelvault.dev/v1/videos/vid_1/enrich",
    );
    expect(api.calls[0].init.method).toBe("POST");
    expect(JSON.parse(api.stdout())).toMatchObject({
      status: "complete",
      transcript: { vtt_url: expect.stringContaining("transcript.vtt") },
      storyboard: { index_url: expect.stringContaining("storyboard.json") },
    });
    expect(api.stderr()).toContain("original is unchanged");
  });

  it("reports a queued job", async () => {
    const api = fakeApi({
      data: { ...video, enrichment: { status: "pending" } },
    });

    await run({});

    expect(JSON.parse(api.stdout())).toEqual({ status: "pending" });
    expect(api.stderr()).toContain("Enrichment pending");
  });

  it("surfaces a failed job message", async () => {
    fakeApi({
      data: {
        ...video,
        enrichment: {
          status: "failed",
          error: { code: "enrichment_failed", message: "Transcription failed." },
        },
      },
    });

    await expect(run({})).rejects.toThrow("Transcription failed");
  });
});
