import { describe, expect, it } from "vitest";
import {
  audioArtifacts,
  audioEnrichmentState,
  waitForAudioEnrichment,
  type AudioAsset,
  type AudioEnrichmentStatus,
} from "../../src/lib/audio-enrichment.js";

function audio(status: AudioEnrichmentStatus, visibility: "public" | "private" = "public"): AudioAsset {
  return {
    id: "aud_1",
    kind: "audio",
    url: "https://img.pixelvault.dev/proj_1/aud_1.mp3",
    original_url: "https://img.pixelvault.dev/proj_1/aud_1.mp3",
    visibility,
    mime_type: "audio/mpeg",
    size: 1_000,
    container: "mp3",
    codec: "mp3",
    duration_seconds: 12,
    sample_rate: 44_100,
    channels: 2,
    filename: "episode.mp3",
    folder: null,
    collection_id: null,
    metadata: null,
    created_at: "2026-11-17T10:00:00.000Z",
    signed_expires: visibility === "private" ? 1_795_000_000 : undefined,
    enrichment: { job_id: "aen_1", status },
  };
}

describe("waitForAudioEnrichment", () => {
  it("backs off through queued and running states", async () => {
    let now = 0;
    const waits: number[] = [];
    const statuses: AudioEnrichmentStatus[] = [];
    const responses = [audio("processing"), audio("complete")];
    const result = await waitForAudioEnrichment(audio("pending"), "pv_live_test", {
      timeoutMs: 10_000,
      now: () => now,
      sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      fetchAudio: async () => responses.shift()!,
      onStatus: (status) => statuses.push(status),
    });
    expect(result.audio.enrichment.status).toBe("complete");
    expect(result.timedOut).toBe(false);
    expect(waits).toEqual([1_000, 1_500]);
    expect(statuses).toEqual(["processing", "complete"]);
  });

  it("returns the last state when the local deadline expires", async () => {
    let now = 0;
    const result = await waitForAudioEnrichment(audio("pending"), "pv_live_test", {
      timeoutMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      fetchAudio: async () => audio("processing"),
    });
    expect(result).toMatchObject({ timedOut: true, audio: { enrichment: { status: "processing" } } });
    expect(audioEnrichmentState(result.audio.enrichment.status, true)).toBe("timeout");
  });
});

describe("audioArtifacts", () => {
  it("returns only available private URLs with their shared signed expiry", () => {
    const value = audio("complete", "private");
    value.original_url = "https://img.pixelvault.dev/private/original?token=one";
    value.enrichment.transcript = {
      status: "complete",
      text_url: "https://img.pixelvault.dev/private/transcript.txt?token=two",
      vtt_url: "https://img.pixelvault.dev/private/transcript.vtt?token=three",
    };
    expect(audioArtifacts(value)).toEqual([
      expect.objectContaining({ type: "original_audio", visibility: "private", signed_url_expiry: { status: "known", expires_at: expect.any(String) } }),
      expect.objectContaining({ type: "transcript_text", visibility: "private", signed_url_expiry: { status: "known", expires_at: expect.any(String) } }),
      expect.objectContaining({ type: "transcript_vtt", visibility: "private", signed_url_expiry: { status: "known", expires_at: expect.any(String) } }),
    ]);
  });
});
