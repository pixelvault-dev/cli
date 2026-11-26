import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: signUrl } = await import("../../src/commands/sign-url.js");
type Cmd = { run?: (ctx: any) => unknown };

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

describe("sign-url command", () => {
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

  it("mints a signed URL with transforms and expires_in", async () => {
    const fetchMock = mockFetch(200, {
      data: {
        url: "https://img.pixelvault.dev/proj_1/cp/i/img_priv.png?token=abc&expires=1900000000&w=800&fmt=auto",
        branded_url: "https://media.example.com/cp/i/img_priv.png?token=abc&expires=1900000000&w=800&fmt=auto",
        expires: 1900000000,
        expires_at: "2026-11-26T12:00:00Z",
        transforms: { w: 800, fmt: "auto" },
      },
    });

    await (signUrl as Cmd).run?.({
      args: {
        id: "img_priv",
        expires: "1h",
        transform: "w=800&fmt=auto",
        branded: false,
        json: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/images/img_priv/sign-url",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          expires_in: 3600,
          transforms: { w: 800, fmt: "auto" },
        }),
      }),
    );
    expect(out.trim()).toBe("https://img.pixelvault.dev/proj_1/cp/i/img_priv.png?token=abc&expires=1900000000&w=800&fmt=auto");
    expect(err).toContain("Expires: 2026-11-26T12:00:00Z");
    expect(err).toContain("Signed transforms: w=800&fmt=auto");
  });

  it("supports --branded and --params JSON including size preset", async () => {
    const fetchMock = mockFetch(200, {
      data: {
        url: "https://img.pixelvault.dev/proj_1/cp/i/img_priv.png?token=abc&expires=1900000000&size=avatar",
        branded_url: "https://media.example.com/cp/i/img_priv.png?token=abc&expires=1900000000&size=avatar",
        expires: 1900000000,
        expires_at: "2026-11-26T12:00:00Z",
      },
    });

    await (signUrl as Cmd).run?.({
      args: {
        id: "img_priv",
        params: '{"size":"avatar","dpr":2}',
        branded: true,
        json: false,
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/images/img_priv/sign-url",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ transforms: { size: "avatar", dpr: 2 } }),
      }),
    );
    expect(out.trim()).toBe("https://media.example.com/cp/i/img_priv.png?token=abc&expires=1900000000&size=avatar");
  });

  it("explains PDF and SVG transform rejections clearly", async () => {
    mockFetch(400, { error: { code: "document_transforms_unsupported", message: "PDFs cannot be transformed." } });
    await expect(
      (signUrl as Cmd).run?.({ args: { id: "img_pdf", transform: "w=400", branded: false, json: false } }),
    ).rejects.toThrow("PDF documents cannot be signed with image transforms");

    mockFetch(400, { error: { code: "svg_transforms_unsupported", message: "SVGs cannot be transformed." } });
    await expect(
      (signUrl as Cmd).run?.({ args: { id: "img_svg", transform: "w=400", branded: false, json: false } }),
    ).rejects.toThrow("SVG images cannot be signed with raster transforms");
  });
});
