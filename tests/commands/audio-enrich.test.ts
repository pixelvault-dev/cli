import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioAsset, AudioEnrichmentStatus } from "../../src/lib/audio-enrichment.js";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const originalFetch = globalThis.fetch;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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

function fakeApi(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected API request");
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  let output = "";
  let errors = "";
  vi.spyOn(process.stdout, "write").mockImplementation((value) => { output += value; return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => { errors += value; return true; });
  return { calls, stdout: () => output, stderr: () => errors };
}

async function run(args: Record<string, unknown>) {
  const { default: command } = await import("../../src/commands/audio.js");
  const enrich = (command as unknown as { subCommands: Record<string, { run(context: { args: Record<string, unknown> }): Promise<void> }> }).subCommands.enrich;
  await enrich.run({
    args: {
      source: "aud_1",
      private: false,
      wait: true,
      timeout: "600",
      json: false,
      ...args,
    },
  });
}

describe("audio enrich command", () => {
  it("returns original and available transcript URLs with stable identifiers", async () => {
    const complete = audio("complete", "private");
    complete.enrichment.transcript = {
      status: "complete",
      text_url: "https://img.pixelvault.dev/private/transcript.txt?token=two",
      segments_url: "https://img.pixelvault.dev/private/transcript.json?token=three",
    };
    const api = fakeApi([{ body: { data: complete } }]);
    await run({ json: true });
    expect(api.calls[0]).toMatchObject({ url: "https://api.test.pixelvault.dev/v1/audio/aud_1/enrich", init: { method: "POST" } });
    expect(JSON.parse(api.stdout())).toMatchObject({
      asset_id: "aud_1",
      job_id: "aen_1",
      state: "complete",
      resume_command: "pixelvault audio enrich aud_1",
      artifacts: [
        { type: "original_audio", visibility: "private", signed_url_expiry: { status: "known" } },
        { type: "transcript_text", visibility: "private", signed_url_expiry: { status: "known" } },
        { type: "transcript_segments", visibility: "private", signed_url_expiry: { status: "known" } },
      ],
    });
    expect(api.stderr()).toContain("Enrichment job aen_1: complete");
  });

  it("uploads a local source once and returns a resumable queued job", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pixelvault-audio-enrich-"));
    directories.push(directory);
    const file = join(directory, "episode.mp3");
    await writeFile(file, Buffer.from("small-fixture"));
    const api = fakeApi([
      { status: 201, body: { data: audio("not_requested") } },
      { status: 202, body: { data: audio("pending") } },
    ]);
    await run({ source: file, wait: false, json: true, "idempotency-key": "audio-enrich-1" });
    expect(api.calls.map(({ url }) => url)).toEqual([
      "https://api.test.pixelvault.dev/v1/audio",
      "https://api.test.pixelvault.dev/v1/audio/aud_1/enrich",
    ]);
    expect(JSON.parse(api.stdout())).toMatchObject({ asset_id: "aud_1", job_id: "aen_1", state: "queued" });
    expect(api.stderr()).toContain("Resume safely with: pixelvault audio enrich aud_1");
  });

  it("reports failure after emitting machine-readable state", async () => {
    const failed = audio("failed");
    failed.enrichment.error = { code: "transcription_failed", message: "No speech was detected." };
    const api = fakeApi([{ body: { data: failed } }]);
    await expect(run({ json: true })).rejects.toThrow("No speech was detected");
    expect(JSON.parse(api.stdout())).toMatchObject({ state: "failed", server_status: "failed" });
  });

  it("times out locally without cancelling the running server job", async () => {
    vi.useFakeTimers();
    const api = fakeApi([
      { status: 202, body: { data: audio("pending") } },
      { body: { data: audio("processing") } },
    ]);
    const pending = run({ timeout: "0.001", json: true });
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).rejects.toThrow("server job was not cancelled");
    expect(JSON.parse(api.stdout())).toMatchObject({ state: "timeout", server_status: "processing" });
  });

  it("explains shared quota failures and preserves the resume ID", async () => {
    const api = fakeApi([{ status: 402, body: { error: { code: "enrichment_limit_reached", message: "Media enrichment limit reached." } } }]);
    await expect(run({})).rejects.toThrow("share the plan's media-enrichment seconds");
    expect(api.stderr()).toContain("Resume safely with: pixelvault audio enrich aud_1");
  });
});
