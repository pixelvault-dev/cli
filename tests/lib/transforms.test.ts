import { describe, expect, it } from "vitest";
import {
  formatTransformParams,
  parseTransformJson,
  parseTransformQuery,
  resolveTransformInput,
} from "../../src/lib/transforms.js";

describe("transforms parser", () => {
  it("parses query strings with typed numbers and booleans", () => {
    expect(
      parseTransformQuery("?w=800&h=600&fit=cover&dpr=2&anim=false&watermark=img_logo.png&watermark_opacity=0.5"),
    ).toEqual({
      w: 800,
      h: 600,
      fit: "cover",
      dpr: 2,
      anim: false,
      watermark: "img_logo.png",
      watermark_opacity: 0.5,
    });
  });

  it("rejects empty query strings or non-numeric numeric fields", () => {
    expect(() => parseTransformQuery("   ")).toThrow("must not be empty");
    expect(() => parseTransformQuery("w=wide")).toThrow('Transform parameter "w" must be a number');
  });

  it("parses JSON objects and rejects invalid inputs", () => {
    expect(parseTransformJson('{"w":400,"fmt":"auto","anim":false}')).toEqual({
      w: 400,
      fmt: "auto",
      anim: false,
    });
    expect(() => parseTransformJson("[]")).toThrow("JSON object");
    expect(() => parseTransformJson("{}")).toThrow("at least one");
    expect(() => parseTransformJson('{"w":{"nested":1}}')).toThrow("string, number, or boolean");
  });

  it("enforces mutual exclusion and allowSize", () => {
    expect(() =>
      resolveTransformInput({
        query: "w=400",
        paramsJson: '{"w":400}',
        required: true,
        allowSize: false,
      }),
    ).toThrow("not both");

    expect(() =>
      resolveTransformInput({
        query: "size=thumb",
        required: true,
        allowSize: false,
      }),
    ).toThrow('cannot reference "size"');

    expect(
      resolveTransformInput({
        query: "size=avatar&dpr=2",
        required: false,
        allowSize: true,
      }),
    ).toEqual({ size: "avatar", dpr: 2 });

    expect(
      resolveTransformInput({
        required: false,
        allowSize: true,
      }),
    ).toBeUndefined();
  });

  it("formats params cleanly", () => {
    expect(formatTransformParams({ w: 800, fit: "cover", fmt: "auto" })).toBe("w=800&fit=cover&fmt=auto");
  });
});
