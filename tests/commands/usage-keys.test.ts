import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: usage } = await import("../../src/commands/usage.js");
const { default: keys } = await import("../../src/commands/keys.js");
const { formatBytes } = await import("../../src/lib/output.js");

type Cmd = { run?: (ctx: any) => unknown; subCommands?: any };
const sub = (n: string) => (keys as Cmd).subCommands[n] as Cmd;

const USAGE = {
  plan: "free",
  period: "2026-10",
  resets_at: "2026-11-01T00:00:00Z",
  usage: { storage_bytes: 5 * 1024 * 1024, uploads: 12 },
  limits: {
    storage_bytes: 1024 ** 3,
    uploads_per_month: 500,
    bandwidth_bytes_per_month: 10 * 1024 ** 3,
  },
  remaining: { storage_bytes: 1024 ** 3 - 5 * 1024 * 1024, uploads: 488 },
};

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const f = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    statusText: "x",
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = f as any;
  return f;
}
const apiErr = (code: string, message = "msg") => ({ error: { code, message } });

describe("usage / keys commands", () => {
  const originalFetch = globalThis.fetch;
  let out = "";
  let err = "";

  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => {
      out += s;
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => {
      err += s;
      return true;
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  describe("usage", () => {
    it("prints human-readable summary to stdout", async () => {
      const f = mockFetch(200, { data: USAGE });
      await usage.run!({ args: { json: false } } as any);
      expect(f.mock.calls[0][0]).toBe("https://api.test.pixelvault.dev/v1/usage");
      expect(out).toContain("Plan:      free");
      expect(out).toContain("2026-10");
      expect(out).toContain("5 MB used / 1 GB limit");
      expect(out).toContain("12 used / 500 limit / 488 remaining");
      expect(out).toContain("10 GB limit per month");
      expect(err).toBe("");
    });

    it("--json prints the data object", async () => {
      mockFetch(200, { data: USAGE });
      await usage.run!({ args: { json: true } } as any);
      expect(JSON.parse(out)).toEqual(USAGE);
    });

    it("rejects with the API message on 403", async () => {
      mockFetch(403, apiErr("forbidden", "Secret key required"));
      await expect(usage.run!({ args: { json: false } } as any)).rejects.toThrow(
        "Secret key required",
      );
      expect(out).toBe("");
    });
  });

  describe("keys list", () => {
    const KEYS = [
      {
        id: "key_1",
        type: "secret",
        environment: "live",
        label: "ci",
        key_prefix: "pv_live_ab12",
        allowed_origins: null,
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: null,
        current: true,
      },
    ];

    it("prints one line per key, no raw secrets", async () => {
      mockFetch(200, { data: KEYS });
      await sub("list").run!({ args: { json: false } });
      expect(out).toContain("key_1");
      expect(out).toContain("pv_live_ab12...");
      expect(out).toContain("last used never");
      expect(out).toContain("(current)");
      expect(err).toBe("");
    });

    it("--json prints the array", async () => {
      mockFetch(200, { data: KEYS });
      await sub("list").run!({ args: { json: true } });
      expect(JSON.parse(out)).toEqual(KEYS);
    });

    it("explains publishable-key 403", async () => {
      mockFetch(403, apiErr("forbidden"));
      await expect(sub("list").run!({ args: {} })).rejects.toThrow(/secret key/);
    });
  });

  describe("keys create", () => {
    const CREATED = {
      id: "key_2",
      api_key: "pv_live_SECRETVALUE",
      type: "secret",
      environment: "live",
      label: "ci",
      created_at: "2026-10-24T00:00:00Z",
    };

    it("prints ONLY the raw key on stdout; warning on stderr", async () => {
      const f = mockFetch(201, { data: CREATED });
      await sub("create").run!({ args: { label: "ci", env: "live", json: false } });
      expect(out).toBe("pv_live_SECRETVALUE\n");
      expect(err).toMatch(/shown ONCE/);
      expect(err).not.toContain("SECRETVALUE");
      const init = f.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ label: "ci", environment: "live" });
    });

    it("sends an empty body when no options given", async () => {
      const f = mockFetch(201, { data: CREATED });
      await sub("create").run!({ args: { json: false } });
      expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({});
    });

    it("--json prints whole data object", async () => {
      mockFetch(201, { data: CREATED });
      await sub("create").run!({ args: { json: true } });
      expect(JSON.parse(out)).toEqual(CREATED);
      expect(err).toMatch(/shown ONCE/);
    });

    it("rejects bad --env and long --label without calling the API", async () => {
      const f = mockFetch(201, { data: CREATED });
      await expect(sub("create").run!({ args: { env: "prod" } })).rejects.toThrow(/--env/);
      await expect(
        sub("create").run!({ args: { label: "x".repeat(61) } }),
      ).rejects.toThrow(/60/);
      expect(f).not.toHaveBeenCalled();
    });

    it("maps 400 validation_error", async () => {
      mockFetch(400, apiErr("validation_error", "label too long"));
      await expect(sub("create").run!({ args: {} })).rejects.toThrow(/Invalid request: label too long/);
      expect(out).toBe("");
    });

    it("maps 409 key_limit_reached", async () => {
      mockFetch(409, apiErr("key_limit_reached"));
      await expect(sub("create").run!({ args: {} })).rejects.toThrow(/25 per project/);
    });

    it("maps 429 with Retry-After", async () => {
      mockFetch(429, apiErr("rate_limit_exceeded"), { "Retry-After": "120" });
      await expect(sub("create").run!({ args: {} })).rejects.toThrow(
        /20 key changes per hour.*Retry after 120 seconds/,
      );
    });
  });

  describe("keys revoke", () => {
    it("is quiet on stdout, confirms on stderr", async () => {
      const f = mockFetch(200, { data: { deleted: true } });
      await sub("revoke").run!({ args: { id: "key_9", json: false } });
      expect(f.mock.calls[0][0]).toBe("https://api.test.pixelvault.dev/v1/keys/key_9");
      expect(f.mock.calls[0][1].method).toBe("DELETE");
      expect(out).toBe("");
      expect(err).toContain("Revoked key key_9");
    });

    it("--json prints data", async () => {
      mockFetch(200, { data: { deleted: true } });
      await sub("revoke").run!({ args: { id: "key_9", json: true } });
      expect(JSON.parse(out)).toEqual({ deleted: true });
    });

    it("maps 404 not_found", async () => {
      mockFetch(404, apiErr("not_found"));
      await expect(sub("revoke").run!({ args: { id: "pk" } })).rejects.toThrow(
        /Only secret keys can be revoked/,
      );
    });

    it("maps 409 cannot_revoke_current_key", async () => {
      mockFetch(409, apiErr("cannot_revoke_current_key"));
      await expect(sub("revoke").run!({ args: { id: "k" } })).rejects.toThrow(
        /Create a new key, switch to it/,
      );
    });

    it("maps 429", async () => {
      mockFetch(429, apiErr("rate_limit_exceeded"));
      await expect(sub("revoke").run!({ args: { id: "k" } })).rejects.toThrow(/Rate limit/);
    });
  });
});
