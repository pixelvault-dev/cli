import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the config module by mocking homedir
const testDir = join(tmpdir(), `pixelvault-test-${Date.now()}`);
const configDir = join(testDir, ".pixelvault");
const configFile = join(configDir, "config.json");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

const { readConfig, writeConfig, updateConfig, getApiKey, getApiUrl } =
  await import("../../src/lib/config.js");

describe("config", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    delete process.env["PIXELVAULT_API_KEY"];
    delete process.env["PIXELVAULT_API_URL"];
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns empty config when file does not exist", () => {
    expect(readConfig()).toEqual({});
  });

  it("reads and writes config", () => {
    writeConfig({ api_key: "pv_live_test", email: "test@example.com" });
    const config = readConfig();
    expect(config.api_key).toBe("pv_live_test");
    expect(config.email).toBe("test@example.com");
  });

  it("updates config without overwriting other fields", () => {
    writeConfig({ api_key: "pv_live_test", email: "test@example.com" });
    updateConfig({ default_project: "proj_123" });
    const config = readConfig();
    expect(config.api_key).toBe("pv_live_test");
    expect(config.default_project).toBe("proj_123");
  });

  it("env var overrides config for api key", () => {
    writeConfig({ api_key: "pv_live_config" });
    process.env["PIXELVAULT_API_KEY"] = "pv_live_env";
    expect(getApiKey()).toBe("pv_live_env");
  });

  it("returns default api url when not configured", () => {
    expect(getApiUrl()).toBe("https://api.pixelvault.dev");
  });

  it("env var overrides config for api url", () => {
    writeConfig({ api_url: "https://custom.example.com" });
    process.env["PIXELVAULT_API_URL"] = "https://env.example.com";
    expect(getApiUrl()).toBe("https://env.example.com");
  });
});
