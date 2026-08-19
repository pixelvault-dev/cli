import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config to return a test API URL
vi.mock("../../src/lib/config.js", () => ({
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { apiRequest } = await import("../../src/lib/client.js");

describe("client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("makes GET request with auth header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "img_123" } }),
    });

    const res = await apiRequest<{ data: { id: string } }>({
      path: "/v1/images/img_123",
      auth: "pv_live_test",
    });

    expect(res.data.id).toBe("img_123");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/images/img_123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer pv_live_test",
        }),
      })
    );
  });

  it("makes POST request with JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { token: "jwt_xxx" } }),
    });

    await apiRequest({
      method: "POST",
      path: "/v1/auth/login",
      body: { email: "test@example.com", password: "test1234" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      })
    );
  });

  it("sends the X-PixelVault-Client identity header on every request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    });

    await apiRequest({ path: "/v1/images" });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/images",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-PixelVault-Client": expect.stringMatching(/^pixelvault-cli\//),
        }),
      })
    );
  });

  it("lets a caller override the X-PixelVault-Client header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    });

    await apiRequest({
      path: "/v1/images",
      headers: { "X-PixelVault-Client": "custom/9.9.9" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.test.pixelvault.dev/v1/images",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-PixelVault-Client": "custom/9.9.9",
        }),
      })
    );
  });

  it("throws CliError on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () =>
        Promise.resolve({
          error: { code: "unauthorized", message: "Invalid API key." },
        }),
    });

    await expect(
      apiRequest({ path: "/v1/images", auth: "bad_key" })
    ).rejects.toThrow("Invalid API key.");
  });

  it("throws CliError on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(apiRequest({ path: "/v1/images" })).rejects.toThrow(
      "Network error: ECONNREFUSED"
    );
  });
});
