import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoData, VideoEnrichmentStatus } from "../../src/lib/video-upload.js";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function video(status: VideoEnrichmentStatus, visibility: "public" | "private" = "public"): VideoData {
  return {
    id: "vid_1",
    kind: "video",
    url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
    original_url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
    visibility,
    mime_type: "video/mp4",
    size: 1_000,
    filename: "clip.mp4",
    created_at: "2026-11-16T10:00:00.000Z",
    signed_expires: visibility === "private" ? 1_795_000_000 : undefined,
    width: 640,
    height: 360,
    duration_seconds: 12,
    video_codec: "h264",
    audio_codec: "aac",
    has_audio: true,
    fast_start: true,
    social_compatible: true,
    compatibility_warnings: [],
    social_optimization: { preset: "social", status: "not_requested" },
    enrichment: { job_id: "ven_1", status },
  };
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

function fakeApi(responses: FakeResponse[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected API request");
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
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
    args: {
      source: "vid_1",
      private: false,
      wait: true,
      timeout: "600",
      json: false,
      ...args,
    },
  });
}

describe("enrich-video command", () => {
  it("returns typed private artifacts and stable resume identifiers as JSON", async () => {
    const complete = video("complete", "private");
    complete.original_url = "https://img.pixelvault.dev/private/original?token=one";
    complete.enrichment.transcript = {
      status: "complete",
      text_url: "https://img.pixelvault.dev/private/transcript.txt?token=two",
    };
    complete.enrichment.storyboard = {
      status: "complete",
      index_url: "https://img.pixelvault.dev/private/storyboard.json?token=three",
      frame_count: 1,
      sheets: [],
    };
    const api = fakeApi([{ body: { data: complete } }]);

    await run({ json: true });

    expect(api.calls[0].url).toBe("https://api.test.pixelvault.dev/v1/videos/vid_1/enrich");
    expect(api.calls[0].init.method).toBe("POST");
    expect(JSON.parse(api.stdout())).toMatchObject({
      asset_id: "vid_1",
      job_id: "ven_1",
      state: "complete",
      server_status: "complete",
      resume_command: "pixelvault enrich-video vid_1",
      artifacts: [
        { type: "original_video", visibility: "private", signed_url_expiry: { status: "known" } },
        { type: "transcript_text", visibility: "private", signed_url_expiry: { status: "known" } },
        { type: "storyboard_index", visibility: "private", signed_url_expiry: { status: "known" } },
      ],
    });
    expect(api.stderr()).toContain("Using existing video asset vid_1");
    expect(api.stderr()).toContain("Enrichment job ven_1: complete");
  });

  it("uploads a local MP4 once and exposes IDs before returning the queued state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pixelvault-enrich-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "clip.mp4");
    writeFileSync(file, Buffer.from("small-fixture"));
    const uploaded = video("not_requested");
    const queued = video("pending");
    const api = fakeApi([
      { status: 201, body: { data: uploaded } },
      { status: 202, body: { data: queued } },
    ]);

    await run({ source: file, wait: false, json: true });

    expect(api.calls.map(({ url }) => url)).toEqual([
      "https://api.test.pixelvault.dev/v1/videos",
      "https://api.test.pixelvault.dev/v1/videos/vid_1/enrich",
    ]);
    expect(JSON.parse(api.stdout())).toMatchObject({
      asset_id: "vid_1",
      job_id: "ven_1",
      state: "queued",
      artifacts: [{ type: "original_video" }],
    });
    expect(api.stderr()).toContain("Uploaded video asset vid_1");
    expect(api.stderr()).toContain("Resume safely with: pixelvault enrich-video vid_1");
    expect(api.stderr()).toContain("Enrichment job ven_1: queued");
  });

  it("reports failed jobs as structured output and exits non-zero", async () => {
    const failed = video("failed");
    failed.enrichment.error = { code: "storyboard_failed", message: "Storyboard generation failed." };
    const api = fakeApi([{ body: { data: failed } }]);

    await expect(run({ json: true })).rejects.toThrow("Storyboard generation failed");
    expect(JSON.parse(api.stdout())).toMatchObject({
      asset_id: "vid_1",
      job_id: "ven_1",
      state: "failed",
      artifacts: [{ type: "original_video" }],
    });
  });

  it("times out locally without claiming the server job was cancelled", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { status: 202, body: { data: video("pending") } },
      { body: { data: video("processing") } },
    ]);

    const pending = run({ timeout: "0.001", json: true });
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).rejects.toThrow("server job was not cancelled");
    expect(JSON.parse(api.stdout())).toMatchObject({
      asset_id: "vid_1",
      job_id: "ven_1",
      state: "timeout",
      server_status: "processing",
    });
  });

  it("explains quota failures without retrying or losing the asset ID", async () => {
    const api = fakeApi([{
      status: 402,
      body: {
        error: {
          code: "enrichment_limit_reached",
          message: "Monthly video enrichment limit reached (2 minutes on free).",
        },
      },
    }]);

    await expect(run({})).rejects.toThrow("Check pixelvault usage for the reset date");
    expect(api.calls).toHaveLength(1);
    expect(api.stderr()).toContain("Resume safely with: pixelvault enrich-video vid_1");
  });

  it("rejects URL and non-MP4 sources before any upload", async () => {
    const api = fakeApi([]);
    await expect(run({ source: "https://example.com/clip.mp4" })).rejects.toThrow(
      "Import it first with pixelvault upload",
    );
    await expect(run({ source: "clip.mov" })).rejects.toThrow("local .mp4 path");
    expect(api.calls).toHaveLength(0);
  });
});
