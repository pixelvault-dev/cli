import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: audio } = await import("../../src/commands/audio.js");
type Cmd = { run?: (ctx: { args: Record<string, unknown> }) => unknown; subCommands?: Record<string, Cmd> };
const sub = (name: string) => (audio as Cmd).subCommands?.[name] as Cmd;

const ASSET = {
  id: "aud_1",
  kind: "audio",
  url: "https://img.example/aud_1.ogg",
  original_url: "https://img.example/aud_1.ogg",
  visibility: "private",
  mime_type: "audio/ogg",
  size: 3,
  container: "ogg",
  codec: "opus",
  duration_seconds: 1,
  sample_rate: 48_000,
  channels: 2,
  filename: "episode.ogg",
  folder: "episodes",
  collection_id: null,
  metadata: { season: 1 },
  created_at: "2026-11-16T00:00:00Z",
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    statusText: "x",
    headers: new Headers(),
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe("audio commands", () => {
  const originalFetch = globalThis.fetch;
  let out = "";

  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      out += value;
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uploads local audio with privacy, TTL, organization, and retry headers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pv-cli-audio-"));
    const path = join(dir, "episode.ogg");
    await writeFile(path, Buffer.from("ogg"));
    const fetchMock = mockFetch(201, { data: ASSET });
    try {
      await sub("upload").run?.({
        args: {
          source: path,
          private: true,
          "link-expires": "1h",
          "delete-after": "1d",
          folder: "episodes",
          collection: "col_1",
          meta: "season=1",
          "idempotency-key": "audio-retry-1",
          json: false,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    expect(out).toBe(`${ASSET.url}\n`);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      "Content-Type": "audio/ogg",
      "Content-Length": "3",
      "X-PixelVault-Filename": "episode.ogg",
      "X-PixelVault-Visibility": "private",
      "X-PixelVault-Sign-Expires-In": "3600",
      "X-PixelVault-Expires-In": "86400",
      "X-PixelVault-Folder": "episodes",
      "X-PixelVault-Collection-Id": "col_1",
      "X-PixelVault-Metadata": '{"season":"1"}',
      "Idempotency-Key": "audio-retry-1",
      "X-PixelVault-Content-SHA256": "90308fe99871113bf5490ec73a8813b667adc60fe01530102a6c7bfb73c66481",
    });
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe("ogg");
  });

  it("securely imports a URL and emits complete JSON", async () => {
    const fetchMock = mockFetch(201, { data: ASSET });
    await sub("upload").run?.({
      args: {
        source: "https://example.com/episode.m4a",
        private: false,
        "delete-after": "1h",
        metadata: '{"source":"demo"}',
        "idempotency-key": "audio-import-1",
        json: true,
      },
    });
    expect(JSON.parse(out)).toMatchObject({ id: "aud_1", codec: "opus" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "Idempotency-Key": "audio-import-1" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      url: "https://example.com/episode.m4a",
      visibility: "public",
      expires_in: 3600,
      metadata: { source: "demo" },
    });
  });

  it("lists, gets, updates, signs, and deletes by stable audio ID", async () => {
    const fetchMock = mockFetch(200, { data: [ASSET], meta: { total: 1, page: 1, per_page: 20 } });
    await sub("list").run?.({
      args: { page: "1", "per-page": "20", collection: "col_1", meta: "season=1", json: false },
    });
    expect(out).toBe(`${ASSET.url}\n`);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("collection_id=col_1");

    out = "";
    mockFetch(200, { data: ASSET });
    await sub("get").run?.({ args: { id: "aud/1", json: false } });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/audio/aud%2F1",
      expect.any(Object),
    );

    const updateFetch = mockFetch(200, { data: ASSET });
    await sub("update").run?.({
      args: {
        id: "aud_1",
        folder: "archive",
        "clear-folder": false,
        "clear-collection": true,
        "clear-metadata": true,
        json: true,
      },
    });
    expect(JSON.parse((updateFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      folder: "archive",
      collection_id: null,
      metadata: {},
    });

    const signFetch = mockFetch(200, { data: { url: "https://signed", expires: 123, visibility: "private" } });
    await sub("sign").run?.({ args: { id: "aud_1", expires: "5m", json: false } });
    expect(JSON.parse((signFetch.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ expires_in: 300 });

    const deleteFetch = mockFetch(200, { success: true });
    await sub("delete").run?.({ args: { id: "aud_1" } });
    expect(deleteFetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("turns the backend policy gate into an explicit CLI error", async () => {
    mockFetch(503, {
      error: { code: "audio_policy_pending", message: "not configured" },
    });
    await expect(sub("upload").run?.({
      args: { source: "https://example.com/episode.mp3", private: false, json: false },
    })).rejects.toThrow("approved 25,000,000-byte ceiling");
  });

  it("rejects a local original above the approved global ceiling before reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pv-cli-audio-limit-"));
    const path = join(dir, "oversized.mp3");
    await writeFile(path, "");
    await truncate(path, 25_000_001);
    try {
      await expect(sub("upload").run?.({
        args: { source: path, private: false, json: false },
      })).rejects.toThrow("25,000,000 bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
