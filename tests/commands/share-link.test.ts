import { PassThrough, Readable } from "node:stream";
import { defineCommand } from "citty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import shareLink, { parseShareExpires, SHARE_LINK_EXPIRIES } from "../../src/commands/share-link.js";
import * as promptModule from "../../src/lib/prompt.js";
import { readLine } from "../../src/lib/prompt.js";
import { runCli } from "../../src/lib/run.js";

vi.mock("../../src/lib/config.js", () => ({
  requireApiKey: () => "pv_live_test",
  getApiUrl: () => "https://api.test.pixelvault.dev",
}));

const { promptPassword } = vi.hoisted(() => ({ promptPassword: vi.fn() }));
vi.mock("../../src/lib/prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof promptModule>()),
  promptPassword,
}));

type Cmd = { run?: (ctx: { args: Record<string, unknown> }) => unknown; subCommands?: Record<string, Cmd> };
const sub = (name: string) => (shareLink as unknown as Cmd).subCommands?.[name] as Cmd;

const PASSWORD = "correct horse battery";
const LINK = {
  id: "shr_abc123def456",
  url: "https://pixelvault.dev/s/shr_abc123def456",
  asset_id: "img_one",
  asset_kind: "image",
  status: "active",
  expires_at: "2026-11-29T00:00:00.000Z",
  revoked_at: null,
  created_at: "2026-11-22T00:00:00.000Z",
  origin: "cli",
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

function setStdin(lines: string[], isTTY = false) {
  const stream = Object.assign(Readable.from(lines), { isTTY });
  vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
}

const createArgs = (overrides: Record<string, unknown> = {}) => ({
  asset: "img_one",
  "password-stdin": false,
  json: false,
  ...overrides,
});

describe("share-link commands", () => {
  const originalFetch = globalThis.fetch;
  let out = "";
  let err = "";

  beforeEach(() => {
    out = "";
    err = "";
    promptPassword.mockReset();
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

  describe("create", () => {
    it("reads the password from the first stdin line and posts the request", async () => {
      setStdin([`${PASSWORD}\n`, "ignored second line\n"]);
      const fetchMock = mockFetch(201, { data: LINK });
      await sub("create").run?.({ args: createArgs({ "password-stdin": true, expires: "1d" }) });

      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.test.pixelvault.dev/v1/share-links");
      expect(init).toMatchObject({ method: "POST" });
      expect(init.headers).toMatchObject({
        Authorization: "Bearer pv_live_test",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(init.body)).toEqual({ asset_id: "img_one", password: PASSWORD, expires_in: 86400 });
    });

    it("prints the URL on stdout, details on stderr, and never the password", async () => {
      mockFetch(201, { data: LINK });
      await sub("create").run?.({ args: createArgs({ password: PASSWORD }) });
      expect(out).toBe(`${LINK.url}\n`);
      expect(err).toContain("Asset: img_one (image)");
      expect(err).toContain(`Expires: ${LINK.expires_at}`);
      expect(err).toContain("Status: active");
      expect(out + err).not.toContain(PASSWORD);
    });

    it("omits expires_in without --expires so the API default (7 days) applies", async () => {
      const fetchMock = mockFetch(201, { data: LINK });
      await sub("create").run?.({ args: createArgs({ password: PASSWORD }) });
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ asset_id: "img_one", password: PASSWORD });
    });

    it("prints the API data with --json", async () => {
      mockFetch(201, { data: LINK });
      await sub("create").run?.({ args: createArgs({ password: PASSWORD, json: true }) });
      expect(JSON.parse(out)).toEqual(LINK);
    });

    it("prompts twice without echo on a TTY when no password flag is given", async () => {
      setStdin([], true);
      promptPassword.mockResolvedValueOnce(PASSWORD).mockResolvedValueOnce(PASSWORD);
      const fetchMock = mockFetch(201, { data: LINK });
      await sub("create").run?.({ args: createArgs() });
      expect(promptPassword).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).password).toBe(PASSWORD);
    });

    it("refuses mismatched prompt entries", async () => {
      setStdin([], true);
      promptPassword.mockResolvedValueOnce(PASSWORD).mockResolvedValueOnce("something else");
      const fetchMock = mockFetch(201, { data: LINK });
      await expect(sub("create").run?.({ args: createArgs() })).rejects.toThrow("do not match");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("errors instead of prompting when stdin is not a TTY and no flag is given", async () => {
      setStdin([]);
      const fetchMock = mockFetch(201, { data: LINK });
      await expect(sub("create").run?.({ args: createArgs() })).rejects.toThrow("--password-stdin");
      expect(promptPassword).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects empty stdin, both flags, and passwords outside 8-128 characters", async () => {
      const fetchMock = mockFetch(201, { data: LINK });
      setStdin([]);
      await expect(sub("create").run?.({ args: createArgs({ "password-stdin": true }) }))
        .rejects.toThrow("read no password");
      await expect(sub("create").run?.({ args: createArgs({ password: PASSWORD, "password-stdin": true }) }))
        .rejects.toThrow("not both");
      await expect(sub("create").run?.({ args: createArgs({ password: "short" }) }))
        .rejects.toThrow("8 to 128 characters");
      await expect(sub("create").run?.({ args: createArgs({ password: "x".repeat(129) }) }))
        .rejects.toThrow("8 to 128 characters");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects an unsupported --expires before reading the password", async () => {
      setStdin([`${PASSWORD}\n`]);
      const fetchMock = mockFetch(201, { data: LINK });
      await expect(sub("create").run?.({ args: createArgs({ "password-stdin": true, expires: "2d" }) }))
        .rejects.toThrow("Use one of: 1h, 1d, 7d, 30d, 90d.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("adds an upgrade hint to the paid-plan refusal", async () => {
      mockFetch(402, {
        error: {
          code: "share_links_require_paid_plan",
          message: "Password-protected share links are available on Starter and Pro plans.",
        },
      });
      await expect(sub("create").run?.({ args: createArgs({ password: PASSWORD }) }))
        .rejects.toThrow(/Starter and Pro plans\. Run `pixelvault upgrade starter`/);
    });
  });

  describe("list", () => {
    it("filters by asset and prints one line per link", async () => {
      const fetchMock = mockFetch(200, { data: [LINK, { ...LINK, id: "shr_old", status: "revoked" }] });
      await sub("list").run?.({ args: { asset: "img_one", json: false } });
      expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test.pixelvault.dev/v1/share-links?asset_id=img_one");
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "GET" });
      expect(out).toBe(
        `shr_abc123def456  active  img_one  expires ${LINK.expires_at}  ${LINK.url}\n` +
          `shr_old  revoked  img_one  expires ${LINK.expires_at}  ${LINK.url}\n`,
      );
    });

    it("lists every link without --asset and prints the API data with --json", async () => {
      const fetchMock = mockFetch(200, { data: [LINK] });
      await sub("list").run?.({ args: { json: true } });
      expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test.pixelvault.dev/v1/share-links");
      expect(JSON.parse(out)).toEqual([LINK]);
    });

    it("says so when there are no links", async () => {
      mockFetch(200, { data: [] });
      await sub("list").run?.({ args: { json: false } });
      expect(out).toBe("");
      expect(err).toContain("No share links.");
    });
  });

  describe("revoke", () => {
    it("deletes by encoded id and prints the revoked link", async () => {
      const revoked = { ...LINK, status: "revoked", revoked_at: "2026-11-22T01:00:00.000Z" };
      const fetchMock = mockFetch(200, { data: revoked });
      await sub("revoke").run?.({ args: { id: "shr/x", json: false } });
      expect(fetchMock.mock.calls[0]![0]).toBe("https://api.test.pixelvault.dev/v1/share-links/shr%2Fx");
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
      expect(out).toContain("shr_abc123def456  revoked  img_one");
      expect(err).toContain("Revoked shr_abc123def456");
    });

    it("prints the API data with --json", async () => {
      const revoked = { ...LINK, status: "revoked" };
      mockFetch(200, { data: revoked });
      await sub("revoke").run?.({ args: { id: LINK.id, json: true } });
      expect(JSON.parse(out)).toEqual(revoked);
    });

    it("points at list when the link does not exist", async () => {
      mockFetch(404, { error: { code: "share_link_not_found", message: "Share link not found." } });
      await expect(sub("revoke").run?.({ args: { id: "shr_missing", json: false } }))
        .rejects.toThrow("Share link not found. Run `pixelvault share-link list`");
    });
  });

  describe("through runCli", () => {
    const main = defineCommand({ meta: { name: "pixelvault" }, subCommands: { "share-link": shareLink } });

    it("sends X-PixelVault-Command share-link", async () => {
      const fetchMock = mockFetch(200, { data: [] });
      const exit = vi.fn();
      await runCli(main, ["share-link", "list"], exit);
      expect(exit).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ "X-PixelVault-Command": "share-link" });
    });

    it("prints the API message and exits 1 on an API error", async () => {
      mockFetch(409, {
        error: { code: "share_asset_not_private", message: "Share links protect private media." },
      });
      const exit = vi.fn();
      await runCli(main, ["share-link", "create", "img_one", "--password", PASSWORD], exit);
      expect(err).toBe("Error: Share links protect private media.\n");
      expect(exit).toHaveBeenCalledWith(1);
      expect(out + err).not.toContain(PASSWORD);
    });
  });
});

describe("parseShareExpires", () => {
  it("maps every allowed value to seconds", () => {
    expect(SHARE_LINK_EXPIRIES).toEqual({ "1h": 3600, "1d": 86400, "7d": 604800, "30d": 2592000, "90d": 7776000 });
    for (const [value, seconds] of Object.entries(SHARE_LINK_EXPIRIES)) {
      expect(parseShareExpires(value)).toBe(seconds);
    }
  });

  it("rejects anything else with the allowed list", () => {
    for (const value of ["2h", "7", "1w", "", "7D"]) {
      expect(() => parseShareExpires(value)).toThrow("Use one of: 1h, 1d, 7d, 30d, 90d.");
    }
  });
});

describe("readLine", () => {
  it("returns the first line verbatim without its line ending", async () => {
    expect(await readLine(Readable.from(["  spaced pass  \r\n", "next\n"]))).toBe("  spaced pass  ");
  });

  it("returns a final line without a newline, and empty input as empty", async () => {
    expect(await readLine(Readable.from(["no-newline"]))).toBe("no-newline");
    expect(await readLine(Readable.from([]))).toBe("");
  });

  it("releases an input whose writer keeps it open after the first line", async () => {
    const input = new PassThrough();
    input.write("first\nsecond\n");
    expect(await readLine(input)).toBe("first");
    expect(input.destroyed).toBe(true);
  });
});
