import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

import { waitForDescription, describeSummary } from "../../src/lib/describe.js";

describe("waitForDescription", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function respond(...states: Array<unknown>) {
    let i = 0;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { description: states[Math.min(i++, states.length - 1)] } }),
    })) as unknown as typeof fetch;
    return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  }

  it("polls until the description is done", async () => {
    const f = respond({ status: "pending" }, { status: "pending" }, { status: "done", alt: "A cat" });
    const sleep = vi.fn(async () => {});
    const d = await waitForDescription("img_1", "pv_live_test", { sleep });
    expect(d).toEqual({ status: "done", alt: "A cat" });
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test.pixelvault.dev/v1/images/img_1");
  });

  it("returns immediately on failed or when there is no description", async () => {
    respond({ status: "failed", error: "describe_timeout" });
    expect(await waitForDescription("img_1", "k", { sleep: async () => {} })).toMatchObject({ status: "failed" });
    respond(null);
    expect(await waitForDescription("img_1", "k", { sleep: async () => {} })).toBeNull();
  });

  it("gives up after the max wait and returns the pending state", async () => {
    respond({ status: "pending" });
    let t = 0;
    const d = await waitForDescription("img_1", "k", { sleep: async () => { t += 15_000; }, now: () => t });
    expect(d).toEqual({ status: "pending" });
  });
});

describe("describeSummary", () => {
  it("summarises each state on one line", () => {
    expect(describeSummary({ status: "done", alt: "A cat" })).toBe("Alt: A cat");
    expect(describeSummary({ status: "done", alt: "A cat", tags: ["cat", "sofa"] })).toBe("Alt: A cat (tags: cat, sofa)");
    expect(describeSummary({ status: "failed", error: "describe_timeout" })).toMatch(/failed \(describe_timeout\)/);
    expect(describeSummary({ status: "pending" })).toMatch(/still pending/);
    expect(describeSummary(null)).toMatch(/No description/);
  });
});
