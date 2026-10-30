import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { default: generate } = await import("../../src/commands/generate.js");

const DATA = {
  id: "img_abc",
  url: "https://img.pixelvault.dev/proj/img_abc.jpg",
  optimized_url: "https://img.pixelvault.dev/proj/img_abc.jpg?fmt=auto&q=85",
  visibility: "public",
  mime_type: "image/jpeg",
  size: 160196,
  width: 1024,
  height: 1024,
  filename: "a-red-bicycle.jpg",
  folder: null,
  created_at: "2026-10-30T00:00:00Z",
  generation: { model: "flux-1-schnell", credits_charged: 1, credits_remaining: 9 },
};

function mockFetch(status: number, body: unknown) {
  const f = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    statusText: "x",
    headers: new Headers(),
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = f as any;
  return f;
}
const sent = (f: ReturnType<typeof vi.fn>) => JSON.parse(f.mock.calls[0][1].body as string);
const run = (args: Record<string, unknown>) =>
  generate.run!({ args: { _: [], json: false, private: false, optimized: false, ...args } } as any);

describe("generate command", () => {
  const originalFetch = globalThis.fetch;
  let out = "";
  let err = "";

  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => ((out += s), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => ((err += s), true));
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POSTs the prompt as JSON and prints ONLY the URL on stdout", async () => {
    const f = mockFetch(201, { data: DATA });
    await run({ prompt: "a red bicycle", _: ["a red bicycle"] });
    expect(f.mock.calls[0][0]).toBe("https://api.test.pixelvault.dev/v1/images/generate");
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer pv_live_test");
    expect(sent(f)).toEqual({ prompt: "a red bicycle" });
    expect(out).toBe("https://img.pixelvault.dev/proj/img_abc.jpg\n");
    expect(err).toContain("Generated with flux-1-schnell: 1 credit used, 9 left this month.");
  });

  it("joins an unquoted multi-word prompt", async () => {
    const f = mockFetch(201, { data: DATA });
    await run({ prompt: "a", _: ["a", "red", "bicycle"] });
    expect(sent(f).prompt).toBe("a red bicycle");
  });

  it("sends model, folder and --delete-after as expires_in", async () => {
    const f = mockFetch(201, { data: DATA });
    await run({
      prompt: "x",
      _: ["x"],
      model: "lucid-origin",
      folder: "heroes",
      "delete-after": "1h",
    });
    expect(sent(f)).toEqual({
      prompt: "x",
      model: "lucid-origin",
      folder: "heroes",
      expires_in: 3600,
    });
  });

  it("--optimized prints the optimized URL, falling back to the original", async () => {
    mockFetch(201, { data: DATA });
    await run({ prompt: "x", _: ["x"], optimized: true });
    expect(out).toBe("https://img.pixelvault.dev/proj/img_abc.jpg?fmt=auto&q=85\n");
    out = "";
    mockFetch(201, { data: { ...DATA, optimized_url: undefined } });
    await run({ prompt: "x", _: ["x"], optimized: true });
    expect(out).toBe("https://img.pixelvault.dev/proj/img_abc.jpg\n");
  });

  it("--json prints the full response data (including generation)", async () => {
    mockFetch(201, { data: DATA });
    await run({ prompt: "x", _: ["x"], json: true });
    expect(JSON.parse(out).generation.credits_remaining).toBe(9);
  });

  it("--private sends visibility + sign_expires_in and prints the signed URL", async () => {
    const f = mockFetch(201, {
      data: { ...DATA, visibility: "private", url: "https://img.pixelvault.dev/p?sig=1" },
    });
    await run({ prompt: "x", _: ["x"], private: true, expires: "12h", folder: "ignored" });
    expect(sent(f)).toEqual({
      prompt: "x",
      folder: "ignored",
      visibility: "private",
      sign_expires_in: 43200,
    });
    expect(out).toBe("https://img.pixelvault.dev/p?sig=1\n");
    expect(err).toContain("--folder is ignored for --private");
  });

  it("--private fails closed when the server does not confirm it", async () => {
    mockFetch(201, { data: DATA }); // visibility: public
    await expect(run({ prompt: "x", _: ["x"], private: true })).rejects.toThrow(
      "did not confirm it is private",
    );
    expect(out).toBe("");
  });

  it("rejects --expires without --private, before any request", async () => {
    const f = mockFetch(201, { data: DATA });
    await expect(run({ prompt: "x", _: ["x"], expires: "1h" })).rejects.toThrow(
      "--expires only applies to --private",
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("a bad --delete-after names that flag and sends nothing", async () => {
    const f = mockFetch(201, { data: DATA });
    await expect(
      run({ prompt: "x", _: ["x"], "delete-after": "soon" }),
    ).rejects.toThrow('Invalid --delete-after "soon"');
    await expect(
      run({ prompt: "x", _: ["x"], "delete-after": "10s" }),
    ).rejects.toThrow("--delete-after must be between 60s and 30d");
    expect(f).not.toHaveBeenCalled();
  });

  it("requires a prompt", async () => {
    const f = mockFetch(201, { data: DATA });
    await expect(run({ prompt: "  ", _: [] })).rejects.toThrow("Give a prompt");
    expect(f).not.toHaveBeenCalled();
  });

  it("surfaces credit exhaustion with the API message and prints nothing", async () => {
    mockFetch(402, {
      error: { code: "generation_credits_exhausted", message: "You have 0 left this month." },
    });
    await expect(run({ prompt: "x", _: ["x"] })).rejects.toThrow("You have 0 left this month.");
    expect(out).toBe("");
  });

  it("pluralizes credits (20 credits for a Leonardo model)", async () => {
    mockFetch(201, {
      data: {
        ...DATA,
        generation: { model: "lucid-origin", credits_charged: 20, credits_remaining: 280 },
      },
    });
    await run({ prompt: "x", _: ["x"], model: "lucid-origin" });
    expect(err).toContain("20 credits used, 280 left");
  });
});
