import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: webhooks } = await import("../../src/commands/webhooks.js");
type Cmd = { run?: (ctx: any) => unknown; subCommands?: Record<string, Cmd> };
const sub = (name: string) => (webhooks as Cmd).subCommands?.[name] as Cmd;

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

describe("webhooks commands", () => {
  const originalFetch = globalThis.fetch;
  let out = "";
  let err = "";

  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      out += value;
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      err += value;
      return true;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates an endpoint and prints only the one-time secret to stdout", async () => {
    const fetchMock = mockFetch(201, {
      data: {
        id: "whk_one",
        url: "https://hooks.example.com/pv",
        description: "social",
        events: ["media.created"],
        active: true,
        created_at: "2026-11-16T00:00:00Z",
        updated_at: "2026-11-16T00:00:00Z",
        signing_secret: "whsec_secret",
      },
    });
    await sub("create").run?.({
      args: {
        url: "https://hooks.example.com/pv",
        description: "social",
        events: "media.created,media.created",
        json: false,
      },
    });
    expect(out).toBe("whsec_secret\n");
    expect(err).toContain("shown ONCE");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/webhooks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          url: "https://hooks.example.com/pv",
          description: "social",
          events: ["media.created"],
        }),
      }),
    );
  });

  it("lists plan capacity and endpoint state", async () => {
    mockFetch(200, {
      data: {
        limit: 3,
        remaining: 2,
        webhooks: [{
          id: "whk_one",
          url: "https://hooks.example.com/pv",
          description: null,
          events: ["video.optimization.completed", "video.optimization.failed"],
          active: false,
          created_at: "2026-11-16T00:00:00Z",
          updated_at: "2026-11-16T00:00:00Z",
        }],
      },
    });
    await sub("list").run?.({ args: { json: false } });
    expect(err).toContain("1/3 endpoints configured");
    expect(out).toContain("whk_one  paused  https://hooks.example.com/pv");
  });

  it("updates subscriptions and resumes delivery", async () => {
    const fetchMock = mockFetch(200, { data: { id: "whk_one" } });
    await sub("update").run?.({
      args: {
        id: "whk_one",
        events: "failed",
        resume: true,
        pause: false,
        json: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/webhooks/whk_one",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ events: ["video.optimization.failed"], active: true }),
      }),
    );
  });

  it("prints delivery failures for automation diagnostics", async () => {
    mockFetch(200, {
      data: [{
        id: "whd_one",
        event_id: "whe_one",
        event: "video.optimization.failed",
        status: "retrying",
        attempts: 2,
        response_status: 503,
        error: "Destination returned HTTP 503.",
        next_attempt_at: "2026-11-16T00:05:00Z",
        last_attempt_at: "2026-11-16T00:00:00Z",
        delivered_at: null,
        created_at: "2026-11-16T00:00:00Z",
      }],
    });
    await sub("deliveries").run?.({ args: { id: "whk_one", limit: "25", json: false } });
    expect(out).toContain("whd_one  retrying  video.optimization.failed  2 attempts  HTTP 503");
    expect(out).toContain("Destination returned HTTP 503.");
  });

  it("explains the paid-plan requirement", async () => {
    mockFetch(402, { error: { code: "webhooks_require_paid_plan", message: "paid" } });
    await expect(sub("create").run?.({
      args: { url: "https://hooks.example.com/pv", json: false },
    })).rejects.toThrow("require a Starter or Pro plan");
  });
});
