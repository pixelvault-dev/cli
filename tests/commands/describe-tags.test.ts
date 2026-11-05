import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Fake fetch answering each call from `responses` in order (the last one repeats). */
function fakeApi(...responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => responses[Math.min(i++, responses.length - 1)] };
  }) as unknown as typeof fetch;
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    calls,
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(""),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(""),
  };
}

describe("describe command", () => {
  const run = async (args: Record<string, unknown>) => {
    const { default: cmd } = await import("../../src/commands/describe.js");
    await (cmd as any).run({ args: { id: "img_1", wait: false, json: false, ...args } });
  };

  it("POSTs to the image's describe endpoint and reports a running job on stderr", async () => {
    const api = fakeApi({ data: { id: "img_1", description: { status: "pending", alt: null, tags: [] } } });

    await run({});

    expect(api.calls[0].url).toBe("https://api.test.pixelvault.dev/v1/images/img_1/describe");
    expect(api.calls[0].init.method).toBe("POST");
    expect(api.stdout()).toBe("");
    expect(api.stderr()).toMatch(/still pending/);
  });

  it("prints the alt text on stdout and the tags on stderr when it is already done", async () => {
    const api = fakeApi({ data: { id: "img_1", description: { status: "done", alt: "A red boat", tags: ["boat", "sea"] } } });

    await run({});

    expect(api.stdout()).toBe("A red boat\n");
    expect(api.stderr()).toContain("Tags: boat, sea");
  });

  it("--wait polls GET /v1/images/:id until done and --json carries the full description", async () => {
    const full = { status: "done", alt: "A boat", caption: "c", ocr_text: "HELLO", tags: ["boat"] };
    const api = fakeApi(
      { data: { id: "img_1", description: { status: "pending", alt: null, tags: [] } } },
      { data: { description: full } },
    );

    await run({ wait: true, json: true });

    expect(api.calls[1].url).toBe("https://api.test.pixelvault.dev/v1/images/img_1");
    expect(api.calls[1].init.method ?? "GET").toBe("GET");
    expect(JSON.parse(api.stdout())).toEqual({ id: "img_1", description: full });
  });

  it("fails with the reason when the description could not start", async () => {
    fakeApi({ data: { id: "img_1", describe_skipped: "quota" } });
    await expect(run({})).rejects.toThrow(/not started: quota/);
  });

  it("fails when the description failed", async () => {
    fakeApi({ data: { id: "img_1", description: { status: "failed", error: "describe_failed" } } });
    await expect(run({})).rejects.toThrow(/failed \(describe_failed\)/);
  });

  it("encodes the id in the path", async () => {
    const api = fakeApi({ data: { id: "x", description: { status: "pending" } } });
    await run({ id: "../x?y=1" });
    expect(api.calls[0].url).toBe("https://api.test.pixelvault.dev/v1/images/..%2Fx%3Fy%3D1/describe");
  });
});

describe("tags command", () => {
  const run = async (args: Record<string, unknown> = {}) => {
    const { default: cmd } = await import("../../src/commands/tags.js");
    await (cmd as any).run({ args: { json: false, ...args } });
  };

  it("prints one tag<TAB>count line per tag", async () => {
    const api = fakeApi({ data: [{ tag: "boat", count: 12 }, { tag: "receipt", count: 3 }] });

    await run();

    expect(api.calls[0].url).toBe("https://api.test.pixelvault.dev/v1/images/tags");
    expect(api.stdout()).toBe("boat\t12\nreceipt\t3\n");
  });

  it("--json prints the full response", async () => {
    const body = { data: [{ tag: "boat", count: 12 }] };
    const api = fakeApi(body);
    await run({ json: true });
    expect(JSON.parse(api.stdout())).toEqual(body);
  });
});

describe("list --tag", () => {
  const run = async (args: Record<string, unknown>) => {
    const { default: cmd } = await import("../../src/commands/list.js");
    await (cmd as any).run({ args: { page: "1", "per-page": "20", json: false, ...args } });
  };

  it("sends tag (trimmed) next to the other filters", async () => {
    const api = fakeApi({ data: [{ id: "img_1", url: "https://img.test/a.png" }], meta: { total: 1, page: 1, per_page: 20 } });

    await run({ tag: " boat ", search: "harbour" });

    const params = new URL(api.calls[0].url).searchParams;
    expect(params.get("tag")).toBe("boat");
    expect(params.get("q")).toBe("harbour");
    expect(api.stdout()).toBe("https://img.test/a.png\n");
  });

  it("omits a blank tag", async () => {
    const api = fakeApi({ data: [], meta: { total: 0, page: 1, per_page: 20 } });
    await run({ tag: "  " });
    expect(api.calls[0].url).not.toContain("tag=");
  });
});
