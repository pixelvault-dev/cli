import { describe, it, expect } from "vitest";
import { defaultOutputPath } from "./export.js";

describe("defaultOutputPath", () => {
  it("uses the job id when no output is given", () => {
    expect(defaultOutputPath("exp_a1b2c3d4e5f6")).toBe("pixelvault-export-exp_a1b2c3d4e5f6.tar");
  });

  it("honors an explicit output path", () => {
    expect(defaultOutputPath("exp_x", "./backups/mine.tar")).toBe("./backups/mine.tar");
  });

  it("falls back to the default for an empty output string", () => {
    expect(defaultOutputPath("exp_x", "")).toBe("pixelvault-export-exp_x.tar");
  });
});
