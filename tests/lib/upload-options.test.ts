import { describe, it, expect } from "vitest";
import { validateReuseOptions } from "../../src/lib/upload-options.js";

describe("validateReuseOptions", () => {
  it("accepts no flags, a lone dedupe, and a key on a single file", () => {
    expect(validateReuseOptions({ fileCount: 3 })).toBeNull();
    expect(validateReuseOptions({ dedupe: true, fileCount: 3 })).toBeNull();
    expect(validateReuseOptions({ idempotencyKey: "run-42:shot_1", fileCount: 1 })).toBeNull();
  });

  it("rejects keys the API would reject", () => {
    for (const bad of ["", "has space", "a".repeat(256), "café"]) {
      expect(validateReuseOptions({ idempotencyKey: bad, fileCount: 1 })).toMatch(/printable ASCII/);
    }
    expect(validateReuseOptions({ idempotencyKey: "a".repeat(255), fileCount: 1 })).toBeNull();
  });

  it("rejects dedupe combined with a key", () => {
    expect(validateReuseOptions({ idempotencyKey: "k", dedupe: true, fileCount: 1 })).toMatch(/cannot be combined/);
  });

  it("rejects one key for several files (they'd collide as different bytes)", () => {
    expect(validateReuseOptions({ idempotencyKey: "k", fileCount: 2 })).toMatch(/multiple files/);
  });
});
