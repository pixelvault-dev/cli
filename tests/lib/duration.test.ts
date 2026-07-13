import { describe, it, expect } from "vitest";
import { parseExpires, MIN_EXPIRES_SECONDS, MAX_EXPIRES_SECONDS } from "../../src/lib/duration.js";
import { CliError } from "../../src/lib/errors.js";

describe("parseExpires", () => {
  it("parses unit suffixes into seconds", () => {
    expect(parseExpires("90s")).toBe(90);
    expect(parseExpires("30m")).toBe(1800);
    expect(parseExpires("12h")).toBe(43200);
    expect(parseExpires("7d")).toBe(604800);
  });

  it("treats a bare number as seconds and tolerates whitespace/case", () => {
    expect(parseExpires("3600")).toBe(3600);
    expect(parseExpires("  7D ")).toBe(604800);
  });

  it("accepts the inclusive bounds exactly (60s .. 30d)", () => {
    expect(parseExpires("60")).toBe(MIN_EXPIRES_SECONDS);
    expect(parseExpires("30d")).toBe(MAX_EXPIRES_SECONDS);
  });

  it("rejects values outside the accepted range", () => {
    expect(() => parseExpires("59")).toThrow(CliError); // below min
    expect(() => parseExpires("0")).toThrow(CliError);
    expect(() => parseExpires("31d")).toThrow(CliError); // above max
    expect(() => parseExpires("2592001")).toThrow(CliError);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "7w", "-1", "7.5d", "d7", "7 days"]) {
      expect(() => parseExpires(bad)).toThrow(CliError);
    }
  });
});
