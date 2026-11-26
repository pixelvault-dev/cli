import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: presets } = await import("../../src/commands/presets.js");
type Cmd = { run?: (ctx: any) => unknown; subCommands?: Record<string, Cmd> };
const sub = (name: string) => (presets as Cmd).subCommands?.[name] as Cmd;

const PRESET = {
  name: "avatar",
  params: { w: 256, h: 256, fit: "cover", gravity: "face", dpr: 2, fmt: "auto" },
  created_at: "2026-11-26T00:00:00Z",
  updated_at: "2026-11-26T01:00:00Z",
};

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn().mockImplementation(() => {
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return Promise.resolve({
      ok: next.status < 400,
      status: next.status,
      statusText: "x",
      headers: new Headers(),
      json: () => Promise.resolve(next.body),
    });
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe("presets commands", () => {
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

  it("lists presets and strict-mode state", async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: [PRESET],
          meta: {
            limit: 5,
            total: 1,
            strict_transforms: true,
            builtin_presets: ["s", "m", "l", "social", "square", "portrait"],
          },
        },
      },
    ]);

    await sub("list").run?.({ args: { json: false } });
    expect(out).toContain("avatar  w=256&h=256&fit=cover&gravity=face&dpr=2&fmt=auto");
    expect(err).toContain("1/5 custom presets used; strict_transforms: on");
  });

  it("upserts a preset from a query string via PUT /v1/presets/:name", async () => {
    const fetchMock = mockFetch([{ status: 201, body: { data: PRESET, meta: { limit: 5 } } }]);

    await sub("set").run?.({
      args: {
        name: "avatar",
        transform: "w=256&h=256&fit=cover&gravity=face&dpr=2&fmt=auto",
        json: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/presets/avatar",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          params: { w: 256, h: 256, fit: "cover", gravity: "face", dpr: 2, fmt: "auto" },
        }),
      }),
    );
    expect(out).toContain("avatar  w=256");
    expect(err).toContain("?size=avatar");
  });

  it("rejects referencing size inside a custom preset locally", async () => {
    await expect(
      sub("set").run?.({
        args: { name: "bad", transform: "size=social", json: false },
      }),
    ).rejects.toThrow('cannot reference "size"');
  });

  it("deletes a preset by encoded name", async () => {
    const fetchMock = mockFetch([{ status: 200, body: { data: { deleted: true, name: "avatar" } } }]);
    await sub("delete").run?.({ args: { name: "avatar", json: false } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/presets/avatar",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(err).toContain('Deleted preset "avatar"');
  });

  it("reads and toggles strict_transforms on the active project", async () => {
    const fetchMock = mockFetch([
      {
        status: 200,
        body: {
          data: [
            { id: "proj_other", name: "Other", strict_transforms: false, created_at: "2026-01-01T00:00:00Z", current: false },
            { id: "proj_cur", name: "Main", strict_transforms: false, created_at: "2026-01-02T00:00:00Z", current: true },
          ],
        },
      },
      {
        status: 200,
        body: {
          data: { id: "proj_cur", name: "Main", strict_transforms: true, created_at: "2026-01-02T00:00:00Z" },
        },
      },
    ]);

    await sub("strict").run?.({ args: { mode: "on", json: false } });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.test.pixelvault.dev/v1/projects/proj_cur",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ strict_transforms: true }),
      }),
    );
    expect(out.trim()).toBe("on");
    expect(err).toContain("Enabled strict_transforms on Main");
  });

  it("prints current strict mode when mode is omitted", async () => {
    mockFetch([
      {
        status: 200,
        body: {
          data: [{ id: "proj_cur", name: "Main", strict_transforms: true, created_at: "2026-01-02T00:00:00Z", current: true }],
        },
      },
    ]);

    await sub("strict").run?.({ args: { json: false } });
    expect(out.trim()).toBe("on");
  });

  it("explains preset_limit_reached clearly", async () => {
    mockFetch([
      {
        status: 409,
        body: { error: { code: "preset_limit_reached", message: "The free plan supports up to 5 custom transform presets per project." } },
      },
    ]);

    await expect(
      sub("set").run?.({ args: { name: "sixth", transform: "w=400", json: false } }),
    ).rejects.toThrow("pixelvault presets delete");
  });
});
