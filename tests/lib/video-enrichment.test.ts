import { describe, expect, it } from "vitest";
import {
  enrichmentState,
  videoArtifacts,
  waitForVideoEnrichment,
} from "../../src/lib/video-enrichment.js";
import type { VideoData, VideoEnrichmentStatus } from "../../src/lib/video-upload.js";

function video(status: VideoEnrichmentStatus): VideoData {
  return {
    id: "vid_1",
    kind: "video",
    url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
    original_url: "https://img.pixelvault.dev/proj_1/vid_1.mp4",
    visibility: "public",
    mime_type: "video/mp4",
    size: 1_000,
    filename: "clip.mp4",
    created_at: "2026-11-16T10:00:00.000Z",
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

describe("waitForVideoEnrichment", () => {
  it("backs off while queued/running and stops at completion", async () => {
    let now = 0;
    const waits: number[] = [];
    const statuses: VideoEnrichmentStatus[] = [];
    const responses = [video("processing"), video("complete")];

    const result = await waitForVideoEnrichment(video("pending"), "pv_live_test", {
      timeoutMs: 10_000,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      fetchVideo: async () => responses.shift()!,
      onStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual({ video: expect.objectContaining({ enrichment: { job_id: "ven_1", status: "complete" } }), timedOut: false });
    expect(waits).toEqual([1_000, 1_500]);
    expect(statuses).toEqual(["processing", "complete"]);
  });

  it("returns the last server state when the local deadline expires", async () => {
    let now = 0;
    const waits: number[] = [];
    const result = await waitForVideoEnrichment(video("pending"), "pv_live_test", {
      timeoutMs: 1_200,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      fetchVideo: async () => video("processing"),
    });

    expect(result.timedOut).toBe(true);
    expect(result.video.enrichment.status).toBe("processing");
    expect(waits).toEqual([1_000, 200]);
    expect(enrichmentState(result.video.enrichment.status, true)).toBe("timeout");
  });
});

describe("videoArtifacts", () => {
  it("returns only existing URLs with inherited privacy and exact signed expiry", () => {
    const complete = video("complete");
    complete.visibility = "private";
    complete.signed_expires = 1_795_000_000;
    complete.original_url = "https://img.pixelvault.dev/private/original?token=one";
    complete.enrichment.transcript = {
      status: "complete",
      text_url: "https://img.pixelvault.dev/private/transcript.txt?token=two",
      vtt_url: "https://img.pixelvault.dev/private/transcript.vtt?token=three",
    };
    complete.enrichment.storyboard = {
      status: "complete",
      index_url: "https://img.pixelvault.dev/private/storyboard.json?token=four",
      frame_count: 2,
      sheets: [
        {
          url: "https://img.pixelvault.dev/private/sheet-0.jpg?token=five",
          start_seconds: 0,
          end_seconds: 12,
          frame_count: 2,
        },
      ],
    };

    const artifacts = videoArtifacts(complete);
    expect(artifacts.map(({ type }) => type)).toEqual([
      "original_video",
      "transcript_text",
      "transcript_vtt",
      "storyboard_index",
      "storyboard_sheet",
    ]);
    expect(artifacts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "transcript_segments" }),
    ]));
    expect(artifacts.every(({ visibility }) => visibility === "private")).toBe(true);
    expect(artifacts[0].signed_url_expiry).toEqual({
      status: "known",
      expires_at: new Date(1_795_000_000_000).toISOString(),
    });
  });
});
