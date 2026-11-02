import { describe, it, expect } from "vitest";
import { parseMetadataFlags } from "../../src/lib/metadata.js";
import { CliError } from "../../src/lib/errors.js";

describe("parseMetadataFlags", () => {
  it("returns null when no flag is given", () => {
    expect(parseMetadataFlags({})).toBeNull();
    expect(parseMetadataFlags({ meta: "", metadata: undefined })).toBeNull();
  });

  it("parses a single and repeated --meta key=value (string values)", () => {
    expect(parseMetadataFlags({ meta: "env=prod" })).toEqual({ env: "prod" });
    expect(parseMetadataFlags({ meta: ["env=prod", "run=42"] })).toEqual({ env: "prod", run: "42" });
  });

  it("splits on the first = only and allows an empty value", () => {
    expect(parseMetadataFlags({ meta: "q=a=b" })).toEqual({ q: "a=b" });
    expect(parseMetadataFlags({ meta: "flag=" })).toEqual({ flag: "" });
  });

  it("parses --metadata JSON with typed values and merges with --meta", () => {
    expect(parseMetadataFlags({ metadata: '{"n":3,"ok":true}', meta: "env=prod" })).toEqual({
      n: 3,
      ok: true,
      env: "prod",
    });
  });

  it("rejects malformed input", () => {
    for (const bad of [{ meta: "novalue" }, { meta: "=x" }, { metadata: "nope" }, { metadata: "[1]" }, { metadata: "null" }, { metadata: ["{}", "{}"] }]) {
      expect(() => parseMetadataFlags(bad)).toThrow(CliError);
    }
  });

  it("rejects conflicting values for one key but allows an identical repeat", () => {
    expect(() => parseMetadataFlags({ metadata: '{"env":"prod"}', meta: "env=dev" })).toThrow(/conflicting/);
    expect(() => parseMetadataFlags({ meta: ["a=1", "a=2"] })).toThrow(/conflicting/);
    expect(parseMetadataFlags({ meta: ["a=1", "a=1"] })).toEqual({ a: "1" });
  });

  it("keeps __proto__ as a normal key", () => {
    const r = parseMetadataFlags({ meta: "__proto__=x" });
    expect(r && Object.keys(r)).toEqual(["__proto__"]);
  });
});
