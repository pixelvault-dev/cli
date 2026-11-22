import { defineCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import visibility, { parseVisibility } from "../../src/commands/visibility.js";
import { runCli } from "../../src/lib/run.js";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

type Cmd = { run?: (ctx: { args: Record<string, unknown> }) => unknown };
const run = (args: Record<string, unknown>) =>
  (visibility as unknown as Cmd).run?.({ args: { id: "img_one", json: false, ...args } });

const SIGNED_EXPIRES = 1795000000;
const PRIVATE_IMAGE = {
  id: "img_one",
  kind: "image",
  url: `https://img.pixelvault.dev/proj_1/cp/i/img_one.png?exp=${SIGNED_EXPIRES}&sig=abc`,
  visibility: "private",
  mime_type: "image/png",
  size: 1234,
  width: 10,
  height: 10,
  filename: "one.png",
  folder: null,
  metadata: null,
  description: null,
  created_at: "2026-11-22T00:00:00.000Z",
  signed_expires: SIGNED_EXPIRES,
};
const PUBLIC_IMAGE = {
  ...PRIVATE_IMAGE,
  url: "https://img.pixelvault.dev/proj_1/img_one.png",
  visibility: "public",
  signed_expires: undefined,
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

describe("visibility command", () => {
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

  it("PATCHes the image with the secret key and only the visibility", async () => {
    const fetchMock = mockFetch(200, { data: PRIVATE_IMAGE });
    await run({ id: "img/one", visibility: "private" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test.pixelvault.dev/v1/images/img%2Fone");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(init.headers).toMatchObject({
      Authorization: "Bearer pv_live_test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({ visibility: "private" });
  });

  it("going private prints the signed URL, its expiry and the old-URL warning", async () => {
    mockFetch(200, { data: PRIVATE_IMAGE });
    await run({ visibility: "private" });
    expect(out).toBe(`${PRIVATE_IMAGE.url}\n`);
    expect(err).toContain("Visibility: private");
    expect(err).toContain(`Signed link expires: ${new Date(SIGNED_EXPIRES * 1000).toISOString()}`);
    expect(err).toContain("public URL for this file no longer works");
    expect(err).not.toContain("share links");
  });

  it("omits the expiry line when the response has no signed_expires", async () => {
    mockFetch(200, { data: { ...PRIVATE_IMAGE, signed_expires: undefined } });
    await run({ visibility: "private" });
    expect(err).not.toContain("Signed link expires");
    expect(err).toContain("no longer works");
  });

  it("going public prints the public URL and the share-link warning", async () => {
    mockFetch(200, { data: PUBLIC_IMAGE });
    await run({ visibility: "public" });
    expect(out).toBe(`${PUBLIC_IMAGE.url}\n`);
    expect(err).toContain("Visibility: public");
    expect(err).toContain("password share links to this file are now turned off");
    expect(err).not.toContain("Signed link expires");
    expect(err).not.toContain("no longer works");
  });

  it("prints the API data with --json and nothing on stderr", async () => {
    mockFetch(200, { data: PRIVATE_IMAGE });
    await run({ visibility: "private", json: true });
    expect(JSON.parse(out)).toEqual(PRIVATE_IMAGE);
    expect(err).toBe("");
  });

  it("rejects an invalid visibility before any request", async () => {
    const fetchMock = mockFetch(200, { data: PUBLIC_IMAGE });
    await expect(run({ visibility: "Public" })).rejects.toThrow(
      'Invalid visibility "Public". Use one of: public, private.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [402, "private_limit_reached", "The free plan allows up to 100 private assets.", "private", /100 private assets\. Run `pixelvault upgrade starter`/],
    [409, "visibility_change_collection", "This file belongs to a collection.", "private", /collection\. To change only this file, upload it again on its own \(`pixelvault upload <file> --private`\)/],
    [400, "visibility_change_unsupported", "Only images and PDF documents can change visibility.", "public", /Only images and PDFs can change visibility; upload the file again without --private\./],
    [409, "visibility_change_conflict", "This file changed while its visibility was being changed.", "private", /safe to retry: `pixelvault visibility img_one private`/],
  ])("adds a hint to %s %s", async (status, code, message, target, hint) => {
    mockFetch(status, { error: { code, message } });
    await expect(run({ visibility: target })).rejects.toThrow(hint);
  });

  it("passes other API errors through unchanged", async () => {
    mockFetch(404, { error: { code: "image_not_found", message: "Image not found." } });
    await expect(run({ visibility: "public" })).rejects.toThrow(/^Image not found\.$/);
  });

  describe("through runCli", () => {
    const main = defineCommand({ meta: { name: "pixelvault" }, subCommands: { visibility } });

    it("sends X-PixelVault-Command visibility", async () => {
      const fetchMock = mockFetch(200, { data: PUBLIC_IMAGE });
      const exit = vi.fn();
      await runCli(main, ["visibility", "img_one", "public"], exit);
      expect(exit).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ "X-PixelVault-Command": "visibility" });
    });

    it("prints the API message and exits 1 on an API error", async () => {
      mockFetch(403, {
        error: { code: "visibility_change_blocked", message: "This file was taken down." },
      });
      const exit = vi.fn();
      await runCli(main, ["visibility", "img_one", "private"], exit);
      expect(err).toBe("Error: This file was taken down.\n");
      expect(exit).toHaveBeenCalledWith(1);
    });

    it("exits 1 with the allowed values on a bad argument", async () => {
      const fetchMock = mockFetch(200, { data: PUBLIC_IMAGE });
      const exit = vi.fn();
      await runCli(main, ["visibility", "img_one", "hidden"], exit);
      expect(err).toBe('Error: Invalid visibility "hidden". Use one of: public, private.\n');
      expect(exit).toHaveBeenCalledWith(1);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("parseVisibility", () => {
  it("accepts exactly public and private", () => {
    expect(parseVisibility("public")).toBe("public");
    expect(parseVisibility("private")).toBe("private");
    for (const value of ["", "PRIVATE", "pub", "unlisted"]) {
      expect(() => parseVisibility(value)).toThrow("Use one of: public, private.");
    }
  });
});
