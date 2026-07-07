import { describe, it, expect, vi, afterEach } from "vitest";
import { applyTransform } from "../../src/commands/get.js";

// Mock config so imports resolve without a real key/URL.
vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

describe("get command", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("applyTransform", () => {
    const U = "https://img.pixelvault.dev/proj/img.png";

    it("returns the URL unchanged when no transform is given", () => {
      expect(applyTransform(U)).toBe(U);
      expect(applyTransform(U, "")).toBe(U);
      expect(applyTransform(U, "   ")).toBe(U); // whitespace-only → no-op
    });

    it("appends params with ? when the URL has no query", () => {
      expect(applyTransform(U, "w=400&fmt=webp")).toBe(`${U}?w=400&fmt=webp`);
    });

    it("appends with & when the URL already has a query", () => {
      expect(applyTransform(`${U}?v=2`, "segment=foreground")).toBe(
        `${U}?v=2&segment=foreground`,
      );
    });

    it("tolerates a leading ? or & in the transform string", () => {
      expect(applyTransform(U, "?tile=img_logo.png")).toBe(`${U}?tile=img_logo.png`);
    });

    it("percent-encodes reserved chars so hex colors aren't lost as a fragment", () => {
      // Without encoding, `#ffaa00` would be parsed as a URL fragment → background lost.
      expect(applyTransform(U, "segment=foreground&background=#ffaa00")).toBe(
        `${U}?segment=foreground&background=%23ffaa00`,
      );
    });

    it("encodes a folder-prefixed tile path", () => {
      expect(applyTransform(U, "tile=blog/logo.png")).toBe(`${U}?tile=blog%2Flogo.png`);
    });
  });

  it("fetches image metadata by id and exposes the CDN URL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "img_abc123",
            url: "https://img.pixelvault.dev/proj_123/img_abc123.png",
            mime_type: "image/png",
            size: 2048,
            filename: "photo.png",
            folder: null,
            created_at: "2026-07-07T00:00:00Z",
          },
        }),
    });

    const { apiRequest } = await import("../../src/lib/client.js");
    const res = await apiRequest<{ data: { url: string; id: string } }>({
      path: "/v1/images/img_abc123",
      auth: "pv_live_test",
    });

    expect(res.data.id).toBe("img_abc123");
    expect(applyTransform(res.data.url, "w=400")).toBe(
      "https://img.pixelvault.dev/proj_123/img_abc123.png?w=400",
    );
  });
});
