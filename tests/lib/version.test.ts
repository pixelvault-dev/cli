import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/lib/client.js";

describe("version", () => {
  it("matches package.json, so --version and the X-PixelVault-Client header never go stale", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});
