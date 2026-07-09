import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the outbound request so we can assert whether `password` is sent.
const apiRequest = vi.fn();
const updateConfig = vi.fn();

vi.mock("../../src/lib/client.js", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
}));
vi.mock("../../src/lib/config.js", () => ({
  updateConfig: (...args: unknown[]) => updateConfig(...args),
}));
vi.mock("../../src/lib/output.js", () => ({ stderr: () => {} }));
vi.mock("../../src/lib/prompt.js", () => ({
  prompt: vi.fn(),
  promptPassword: vi.fn(),
}));

import register from "../../src/commands/register.js";

function canned(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      account_id: "acct_1",
      email: "a@b.com",
      email_verified: false,
      password_set: false,
      plan: "free",
      default_project: {
        id: "proj_1",
        name: "Default",
        api_keys: { live: "pv_live_x" },
      },
      ...overrides,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (args: Record<string, unknown>) =>
  (register as any).run({ args, rawArgs: [], cmd: register });

function sentBody() {
  return apiRequest.mock.calls[0][0].body;
}

describe("register command — password handling", () => {
  beforeEach(() => {
    apiRequest.mockReset().mockResolvedValue(canned());
    updateConfig.mockReset();
    // Simulate a headless (agent) run.
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  it("omits password with --passwordless", async () => {
    await run({ email: "a@b.com", passwordless: true });
    expect(sentBody()).toEqual({ email: "a@b.com" });
  });

  it("includes password when provided", async () => {
    apiRequest.mockResolvedValue(canned({ password_set: true }));
    await run({ email: "a@b.com", password: "longenough1" });
    expect(sentBody()).toEqual({ email: "a@b.com", password: "longenough1" });
  });

  it("defaults to passwordless in a non-TTY run with no password flags", async () => {
    await run({ email: "a@b.com" });
    expect(sentBody()).toEqual({ email: "a@b.com" });
  });

  it("saves the returned API key to config", async () => {
    await run({ email: "a@b.com", passwordless: true });
    expect(updateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: "pv_live_x", default_project: "proj_1" })
    );
  });
});
