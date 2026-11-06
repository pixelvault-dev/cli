import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../src/lib/errors.js";
import { collectItems, resolveOutputPath, parsePositiveInt } from "../../src/commands/optimize.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-optimize-"));
  mkdirSync(join(dir, "shots", "nested"), { recursive: true });
  writeFileSync(join(dir, "a.png"), "x");
  writeFileSync(join(dir, "shots", "b.jpg"), "x");
  writeFileSync(join(dir, "shots", "nested", "c.webp"), "x");
  writeFileSync(join(dir, "shots", "notes.txt"), "x");
  writeFileSync(join(dir, "shots", ".hidden.png"), "x");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("collectItems", () => {
  it("returns plain files as given", () => {
    expect(collectItems([join(dir, "a.png")], false)).toEqual([{ file: join(dir, "a.png"), root: null }]);
  });

  it("refuses a directory without --recursive", () => {
    expect(() => collectItems([join(dir, "shots")], false)).toThrow(CliError);
  });

  it("walks a directory recursively, supported types only, skipping dotfiles", () => {
    const files = collectItems([join(dir, "shots")], true).map((i) => i.file);
    expect(files).toEqual([join(dir, "shots", "b.jpg"), join(dir, "shots", "nested", "c.webp")]);
  });

  it("errors clearly on a missing path", () => {
    expect(() => collectItems([join(dir, "nope.png")], false)).toThrow(/No such file/);
  });
});

describe("resolveOutputPath", () => {
  const item = { file: "/p/shots/nested/c.png", root: "/p/shots" };
  it("writes name.optimized.ext beside the input by default", () => {
    expect(resolveOutputPath({ file: "/p/a.png", root: null }, "webp", { inPlace: false, writeBeside: true })).toBe("/p/a.optimized.webp");
  });
  it("mirrors subfolders under --out-dir", () => {
    expect(resolveOutputPath(item, "webp", { outDir: "/out", inPlace: false, writeBeside: true })).toBe("/out/nested/c.webp");
  });
  it("overwrites in place keeping the name", () => {
    expect(resolveOutputPath({ file: "/p/a.png", root: null }, "png", { inPlace: true, writeBeside: true })).toBe("/p/a.png");
  });
  it("writes nothing locally when hosting without --out-dir/--in-place", () => {
    expect(resolveOutputPath({ file: "/p/a.png", root: null }, "png", { inPlace: false, writeBeside: false })).toBeNull();
  });
});

describe("parsePositiveInt", () => {
  it("accepts whole numbers and unset", () => {
    expect(parsePositiveInt("--max-width", "1600")).toBe(1600);
    expect(parsePositiveInt("--max-width", undefined)).toBeUndefined();
  });
  it("rejects zero, negatives and fractions", () => {
    for (const bad of ["0", "-5", "1.5", "abc"]) expect(() => parsePositiveInt("--max-width", bad)).toThrow(CliError);
  });
});
