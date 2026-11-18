import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: domains } = await import("../../src/commands/domains.js");
type Cmd = { run?: (ctx: any) => unknown; subCommands?: Record<string, Cmd> };
const sub = (name: string) => (domains as Cmd).subCommands?.[name] as Cmd;

const DOMAIN = {
  id: "dom_one",
  project_id: "proj_one",
  hostname: "media.example.com",
  status: "pending",
  hostname_status: "pending",
  certificate_status: "pending_validation",
  ready: false,
  cname_target: "custom.pvcdn.dev",
  ownership_verification: null,
  created_at: "2026-11-18T00:00:00Z",
  updated_at: "2026-11-18T00:00:00Z",
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

describe("domains commands", () => {
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

  it("lists account capacity and project domains", async () => {
    mockFetch(200, {
      data: [{ ...DOMAIN, ready: true, status: "active", hostname_status: "active", certificate_status: "active" }],
      meta: { limit: 1, total: 1, project_total: 1, cname_target: "custom.pvcdn.dev" },
    });
    await sub("list").run?.({ args: { json: false } });
    expect(out).toContain("dom_one  active  media.example.com  CNAME custom.pvcdn.dev");
    expect(err).toContain("1/1 account custom domains used; 1 on this project");
  });

  it("adds a hostname and prints its DNS target", async () => {
    const fetchMock = mockFetch(201, { data: DOMAIN, meta: { limit: 1 } });
    await sub("add").run?.({ args: { hostname: "media.example.com", json: false } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/custom-domains",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ hostname: "media.example.com" }) }),
    );
    expect(out).toContain("media.example.com  CNAME custom.pvcdn.dev");
    expect(err).toContain("pixelvault domains refresh dom_one");
  });

  it("refreshes and deletes by encoded id", async () => {
    const refreshFetch = mockFetch(200, { data: { ...DOMAIN, ready: true, status: "active" } });
    await sub("refresh").run?.({ args: { id: "dom/one", json: true } });
    expect(refreshFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test.pixelvault.dev/v1/custom-domains/dom%2Fone/refresh",
    );

    const deleteFetch = mockFetch(200, { data: { deleted: true, id: "dom_one" } });
    await sub("delete").run?.({ args: { id: "dom/one", json: false } });
    expect(deleteFetch.mock.calls[0]?.[0]).toBe(
      "https://api.test.pixelvault.dev/v1/custom-domains/dom%2Fone",
    );
    expect(deleteFetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("explains the paid-plan requirement", async () => {
    mockFetch(402, {
      error: { code: "custom_domains_require_paid_plan", message: "paid" },
    });
    await expect(sub("add").run?.({ args: { hostname: "media.example.com", json: false } }))
      .rejects.toThrow("require a Starter or Pro plan");
  });
});
