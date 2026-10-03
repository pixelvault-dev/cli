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

  it("uploads every positional file, not just the first", async () => {
    const paths = ["a.jpg", "b.jpg", "c.jpg"].map((name) => {
      const p = join(testDir, name);
      writeFileSync(p, Buffer.from(name));
      return p;
    });

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      return {
        ok: true,
        json: () =>
          Promise.resolve({ data: { id: file.name, url: `https://img.test/${file.name}` } }),
      };
    });
    globalThis.fetch = fetchMock;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [...paths, "--folder", "test"] });
    const printed = out.mock.calls.map((c) => String(c[0]).trim());
    out.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(printed).toEqual([
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
    ]);
  });

  it("keeps going past a failed file and exits non-zero", async () => {
    const good = ["a.jpg", "c.jpg"].map((name) => {
      const p = join(testDir, name);
      writeFileSync(p, Buffer.from(name));
      return p;
    });
    const missing = join(testDir, "missing.jpg");

    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const file = (init.body as FormData).get("file") as File;
      return {
        ok: true,
        json: () =>
          Promise.resolve({ data: { id: file.name, url: `https://img.test/${file.name}` } }),
      };
    });
    globalThis.fetch = fetchMock;
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const { runCommand } = await import("citty");
    const { default: upload } = await import("../../src/commands/upload.js");
    await runCommand(upload, { rawArgs: [good[0], missing, good[1]] });
    const printed = out.mock.calls.map((c) => String(c[0]).trim());
    out.mockRestore();
    err.mockRestore();
    const exitCodes = exit.mock.calls.map((c) => c[0]);
    exit.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(printed).toEqual(["https://img.test/a.jpg", "https://img.test/c.jpg"]);
    expect(exitCodes).toEqual([1]);
  });
});
