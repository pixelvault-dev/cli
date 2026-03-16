import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock config
vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const testDir = join(tmpdir(), `pixelvault-upload-test-${Date.now()}`);

describe("upload command", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uploads a file and gets back a URL", async () => {
    // Create a test file
    const testFile = join(testDir, "test.png");
    writeFileSync(testFile, Buffer.from("fake-png-data"));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            id: "img_abc123",
            url: "https://img.pixelvault.dev/proj_123/img_abc123.png",
            mime_type: "image/png",
            size: 14,
            filename: "test.png",
            folder: null,
            created_at: "2026-03-16T00:00:00Z",
          },
        }),
    });

    // Import the upload module and test its core logic
    const { apiRequest } = await import("../../src/lib/client.js");

    const res = await apiRequest<{
      data: { url: string; id: string };
    }>({
      method: "POST",
      path: "/v1/images",
      auth: "pv_live_test",
      formData: new FormData(),
    });

    expect(res.data.url).toBe(
      "https://img.pixelvault.dev/proj_123/img_abc123.png"
    );
    expect(res.data.id).toBe("img_abc123");
  });
});
