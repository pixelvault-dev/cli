import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: upgrade } = await import("../../src/commands/upgrade.js");
const { default: billing } = await import("../../src/commands/billing.js");

type Cmd = { run?: (ctx: any) => Promise<unknown> };

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

describe("upgrade / billing commands", () => {
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

  describe("upgrade", () => {
    it("POSTs the plan and prints only the URL to stdout, guidance to stderr", async () => {
      const f = mockFetch(200, { url: "https://checkout.stripe.com/c/1" });
      await (upgrade as Cmd).run!({ args: { plan: "pro", json: false } });
      const [url, init] = f.mock.calls[0];
      expect(url).toBe("https://api.test.pixelvault.dev/v1/billing/checkout");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer pv_live_test");
      expect(JSON.parse(init.body)).toEqual({ plan: "pro" });
      expect(out).toBe("https://checkout.stripe.com/c/1\n");
      expect(err).toContain("pixelvault usage");
    });

    it("--json prints { url }", async () => {
      mockFetch(200, { url: "https://checkout.stripe.com/c/1" });
      await (upgrade as Cmd).run!({ args: { plan: "starter", json: true } });
      expect(JSON.parse(out)).toEqual({ url: "https://checkout.stripe.com/c/1" });
    });

    it("rejects an unknown plan before any request", async () => {
      const f = mockFetch(200, {});
      await expect((upgrade as Cmd).run!({ args: { plan: "enterprise" } })).rejects.toThrow(
        /Unknown plan/
      );
      expect(f).not.toHaveBeenCalled();
    });

    it.each([
      ["test_key_forbidden", 403, /live key/],
      ["publishable_key_forbidden", 403, /publishable keys are not allowed/],
      ["email_not_verified", 403, /Verify your email/],
      ["already_subscribed", 409, /pixelvault billing/],
      ["billing_unavailable", 503, /not available/],
    ])("explains %s", async (code, status, re) => {
      mockFetch(status, apiErr(code));
      await expect(
        (upgrade as Cmd).run!({ args: { plan: "starter", json: false } })
      ).rejects.toThrow(re);
      expect(out).toBe("");
    });

    it("explains the rate limit with Retry-After", async () => {
      mockFetch(429, apiErr("rate_limit_exceeded"), { "Retry-After": "120" });
      await expect(
        (upgrade as Cmd).run!({ args: { plan: "starter", json: false } })
      ).rejects.toThrow(/Retry after 120 seconds/);
    });
  });

  describe("billing", () => {
    it("POSTs to the portal and prints only the URL", async () => {
      const f = mockFetch(200, { url: "https://billing.stripe.com/p/1" });
      await (billing as Cmd).run!({ args: { json: false } });
      expect(f.mock.calls[0][0]).toBe("https://api.test.pixelvault.dev/v1/billing/portal");
      expect(out).toBe("https://billing.stripe.com/p/1\n");
      expect(err).toContain("cancel");
    });

    it("explains no_subscription", async () => {
      mockFetch(404, apiErr("no_subscription"));
      await expect((billing as Cmd).run!({ args: { json: false } })).rejects.toThrow(
        /pixelvault upgrade/
      );
    });
  });
});
