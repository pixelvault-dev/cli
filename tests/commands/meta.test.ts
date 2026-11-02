import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

describe("meta command", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function run(args: Record<string, unknown>) {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const body = JSON.parse(String(init.body));
      return { ok: true, json: async () => ({ data: { id: "img_1", metadata: body.metadata } }) };
    }) as unknown as typeof fetch;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { default: cmd } = await import("../../src/commands/meta.js");
    await (cmd as any).run({ args: { id: "img_1", clear: false, ...args } });
    return { calls, out: out.mock.calls.map((c) => String(c[0])).join("") };
  }

  it("PATCHes the metadata from --meta flags and prints the stored value", async () => {
    const { calls, out } = await run({ meta: ["env=prod", "run=42"] });
    expect(calls[0].url).toBe("https://api.test.pixelvault.dev/v1/images/img_1");
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ metadata: { env: "prod", run: "42" } });
    expect(JSON.parse(out)).toEqual({ env: "prod", run: "42" });
  });

  it("sends null for --clear", async () => {
    const { calls } = await run({ clear: true });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ metadata: null });
  });

  it("rejects --clear with metadata, and no-op invocations", async () => {
    await expect(run({ clear: true, meta: "a=b" })).rejects.toThrow(/either --clear/);
    await expect(run({})).rejects.toThrow(/Nothing to set/);
  });
});
