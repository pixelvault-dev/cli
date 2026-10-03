import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `pixelvault-config-cmd-test-${Date.now()}`);

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { runCommand } = await import("citty");
const { readConfig, writeConfig } = await import("../../src/lib/config.js");
const { default: config } = await import("../../src/commands/config.js");

const set = (key: string, value: string) =>
  runCommand(config, { rawArgs: ["set", key, value] });

describe("config set", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeConfig({
      api_key: "pv_live_accountA",
      email: "a@example.com",
      default_project: "proj_a",
      api_url: "https://api.test",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("clears the cached email and project when the api key changes", async () => {
    await set("api_key", "pv_live_accountB");
    expect(readConfig()).toEqual({ api_key: "pv_live_accountB", api_url: "https://api.test" });
  });

  it("keeps the cached email and project when the same key is set again", async () => {
    await set("api_key", "pv_live_accountA");
    expect(readConfig().email).toBe("a@example.com");
    expect(readConfig().default_project).toBe("proj_a");
  });

  it("only updates the given field for other keys", async () => {
    await set("email", "b@example.com");
    expect(readConfig()).toMatchObject({ api_key: "pv_live_accountA", email: "b@example.com", default_project: "proj_a" });
  });
});
