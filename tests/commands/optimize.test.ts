import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import sharp from "sharp";
import { CliError } from "../../src/lib/errors.js";
import optimizeCmd, {
  collectItems,
  planOutput,
  assertSafePlans,
  writeAtomic,
  outputExt,
  parsePositiveInt,
  type Mode,
} from "../../src/commands/optimize.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-optimize-"));
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const beside: Mode = { inPlace: false, writeBeside: true };

async function noisyJpeg(width = 900, height = 700): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i * 2654435761) >>> 24)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
}

/** Run the real command, capturing stdout/stderr. */
async function run(rawArgs: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: any) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => (err.push(String(c)), true));
  let thrown: unknown;
  try {
    await runCommand(optimizeCmd, { rawArgs });
  } catch (e) {
    thrown = e;
  }
  vi.restoreAllMocks();
  return { out: out.join(""), err: err.join(""), thrown, exitCode: process.exitCode };
}

describe("collectItems", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "shots", "nested"), { recursive: true });
    writeFileSync(join(dir, "a.png"), "x");
    writeFileSync(join(dir, "shots", "b.jpg"), "x");
    writeFileSync(join(dir, "shots", "nested", "c.webp"), "x");
    writeFileSync(join(dir, "shots", "notes.txt"), "x");
    writeFileSync(join(dir, "shots", ".hidden.png"), "x");
    writeFileSync(join(dir, "shots", "b.optimized.jpg"), "x");
  });

  it("returns plain files as given", () => {
    expect(collectItems([join(dir, "a.png")], false)).toEqual([{ file: join(dir, "a.png"), root: null }]);
  });
  it("refuses a directory without --recursive", () => {
    expect(() => collectItems([join(dir, "shots")], false)).toThrow(CliError);
  });
  it("walks recursively: supported types only, no dotfiles, no previous .optimized outputs", () => {
    const files = collectItems([join(dir, "shots")], true).map((i) => i.file);
    expect(files).toEqual([join(dir, "shots", "b.jpg"), join(dir, "shots", "nested", "c.webp")]);
  });
  it("does not follow symlinks (no cycles, no escaping the root)", () => {
    symlinkSync(join(dir, "shots"), join(dir, "shots", "loop"));
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "secret.png"), "x");
    symlinkSync(join(dir, "outside"), join(dir, "shots", "link-out"));
    const files = collectItems([join(dir, "shots")], true).map((i) => i.file);
    expect(files).toEqual([join(dir, "shots", "b.jpg"), join(dir, "shots", "nested", "c.webp")]);
  });
  it("skips the --out-dir tree when it is nested inside the input", () => {
    mkdirSync(join(dir, "shots", "out"));
    writeFileSync(join(dir, "shots", "out", "old.png"), "x");
    const files = collectItems([join(dir, "shots")], true, join(dir, "shots", "out")).map((i) => i.file);
    expect(files).not.toContain(join(dir, "shots", "out", "old.png"));
  });
  it("errors clearly on a missing path", () => {
    expect(() => collectItems([join(dir, "nope.png")], false)).toThrow(/No such file/);
  });
});

describe("planOutput", () => {
  it("writes name.optimized.ext beside the input by default", () => {
    expect(planOutput({ file: "/p/a.png", root: null }, "webp", beside).optimized).toBe("/p/a.optimized.webp");
  });
  it("mirrors subfolders under --out-dir and plans a copy of the original", () => {
    const plan = planOutput({ file: "/p/shots/nested/c.png", root: "/p/shots" }, "webp", { outDir: "/out", inPlace: false, writeBeside: true });
    expect(plan.optimized).toBe("/out/nested/c.webp");
    expect(plan.kept).toBe("/out/nested/c.png");
  });
  it("--in-place targets the exact original path (.jpeg stays .jpeg)", () => {
    expect(planOutput({ file: "/p/photo.jpeg", root: null }, "keep", { inPlace: true, writeBeside: true }).optimized).toBe("/p/photo.jpeg");
  });
  it("writes nothing locally when hosting without --out-dir/--in-place", () => {
    expect(planOutput({ file: "/p/a.png", root: null }, "keep", { inPlace: false, writeBeside: false }).optimized).toBeNull();
  });
  it("keep preserves the input's extension spelling", () => {
    expect(outputExt({ file: "/p/PHOTO.JPG", root: null }, "keep")).toBe("JPG");
    expect(outputExt({ file: "/p/a.png", root: null }, "jpg")).toBe("jpg");
  });
});

describe("assertSafePlans", () => {
  const plans = (files: string[], format: any, mode: Mode) => files.map((f) => planOutput({ file: f, root: null }, format, mode));

  it("rejects two inputs that map to one output (a.png + a.jpg -> webp)", () => {
    expect(() => assertSafePlans(plans(["/p/a.png", "/p/a.jpg"], "webp", beside), beside)).toThrow(/would both be written/);
  });
  it("rejects inputs from different dirs colliding under --out-dir", () => {
    const m: Mode = { outDir: "/out", inPlace: false, writeBeside: true };
    expect(() => assertSafePlans(plans(["/a/x.png", "/b/x.png"], "keep", m), m)).toThrow(/would both be written/);
  });
  it("rejects an output that would overwrite its own input (--out-dir == input dir)", () => {
    const m: Mode = { outDir: "/p", inPlace: false, writeBeside: true };
    expect(() => assertSafePlans(plans(["/p/a.png"], "keep", m), m)).toThrow(/overwrite the original/);
  });
  it("rejects an output that is another input", () => {
    // a.png -> a.optimized.png, which is also being passed in as an input
    expect(() => assertSafePlans(plans(["/p/a.png", "/p/a.optimized.png"], "keep", beside), beside)).toThrow(/also an input/);
  });
  it("allows --in-place on distinct files", () => {
    const m: Mode = { inPlace: true, writeBeside: true };
    writeFileSync(join(dir, "a.jpeg"), "x");
    writeFileSync(join(dir, "a.jpg"), "x");
    expect(() => assertSafePlans(plans([join(dir, "a.jpeg"), join(dir, "a.jpg")], "keep", m), m)).not.toThrow();
  });
  it("refuses --in-place on a symlink", () => {
    writeFileSync(join(dir, "real.png"), "x");
    symlinkSync(join(dir, "real.png"), join(dir, "link.png"));
    const m: Mode = { inPlace: true, writeBeside: true };
    expect(() => assertSafePlans([planOutput({ file: join(dir, "link.png"), root: null }, "keep", m)], m)).toThrow(/symlink/);
  });
  it("refuses to write through a symlink destination", () => {
    writeFileSync(join(dir, "a.png"), "x");
    writeFileSync(join(dir, "target.png"), "x");
    symlinkSync(join(dir, "target.png"), join(dir, "a.optimized.png"));
    expect(() => assertSafePlans([planOutput({ file: join(dir, "a.png"), root: null }, "keep", beside)], beside)).toThrow(/symlink/);
  });
});

describe("writeAtomic", () => {
  it("writes the file and leaves no temp file behind", () => {
    const target = join(dir, "sub", "out.bin");
    writeAtomic(target, Buffer.from("hello"));
    expect(readFileSync(target, "utf8")).toBe("hello");
    expect(readdirSync(join(dir, "sub"))).toEqual(["out.bin"]);
  });
  it("leaves the original untouched when the write fails", () => {
    const target = join(dir, "orig.bin");
    writeFileSync(target, "ORIGINAL");
    // a directory where the temp file must go forces the write to fail
    mkdirSync(join(dir, `.orig.bin.${process.pid}.tmp`));
    expect(() => writeAtomic(target, Buffer.from("new"))).toThrow();
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
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

// End to end through the real command and real sharp.
describe("optimize command (integration)", () => {
  it("optimizes beside the original, never touches it, and a second run is a no-op", async () => {
    const orig = await noisyJpeg();
    writeFileSync(join(dir, "photo.jpg"), orig);

    const first = await run([join(dir, "photo.jpg")]);
    expect(first.thrown).toBeUndefined();
    expect(first.exitCode).toBeUndefined();
    expect(first.out.trim()).toBe(join(dir, "photo.optimized.jpg"));
    expect(readFileSync(join(dir, "photo.jpg")).equals(orig)).toBe(true);
    expect(readFileSync(join(dir, "photo.optimized.jpg")).length).toBeLessThan(orig.length);

    // Re-running over the directory ignores its own output and skips the already-optimized original
    // only if nothing changed; the optimized file itself is never re-collected.
    const again = await run([join(dir), "-r"]);
    expect(readdirSync(dir).sort()).toEqual(["photo.jpg", "photo.optimized.jpg"]);
    expect(again.err).not.toMatch(/optimized\.optimized/);
  });

  it("--in-place overwrites atomically and keeps the file name (.jpeg stays .jpeg)", async () => {
    const orig = await noisyJpeg();
    writeFileSync(join(dir, "photo.jpeg"), orig);
    const res = await run([join(dir, "photo.jpeg"), "--in-place"]);
    expect(res.exitCode).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["photo.jpeg"]);
    expect(readFileSync(join(dir, "photo.jpeg")).length).toBeLessThan(orig.length);
  });

  it("--out-dir mirrors folders and copies already-optimal files so the tree is complete", async () => {
    mkdirSync(join(dir, "in", "nested"), { recursive: true });
    writeFileSync(join(dir, "in", "big.jpg"), await noisyJpeg());
    const tiny = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).png().toBuffer();
    writeFileSync(join(dir, "in", "nested", "tiny.png"), tiny);

    const res = await run([join(dir, "in"), "-r", "--out-dir", join(dir, "out")]);
    expect(res.exitCode).toBeUndefined();
    expect(existsSync(join(dir, "out", "big.jpg"))).toBe(true);
    expect(readFileSync(join(dir, "out", "nested", "tiny.png")).equals(tiny)).toBe(true); // copied as-is
  });

  it("refuses colliding outputs before writing anything", async () => {
    writeFileSync(join(dir, "a.jpg"), await noisyJpeg());
    writeFileSync(join(dir, "a.jpeg"), await noisyJpeg());
    const res = await run([join(dir, "a.jpg"), join(dir, "a.jpeg"), "--format", "webp"]);
    expect(String(res.thrown)).toMatch(/would both be written/);
    expect(readdirSync(dir).sort()).toEqual(["a.jpeg", "a.jpg"]);
  });

  it("a corrupt file is a failure (exit code 1), not a silent skip", async () => {
    writeFileSync(join(dir, "bad.png"), "<html>not an image</html>");
    const res = await run([join(dir, "bad.png")]);
    expect(res.exitCode).toBe(1);
    expect(res.err).toMatch(/not a readable image/);
  });

  it("--json always emits an array", async () => {
    writeFileSync(join(dir, "a.jpg"), await noisyJpeg());
    const res = await run([join(dir, "a.jpg"), "--json", "--dry-run"]);
    const parsed = JSON.parse(res.out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].status).toBe("optimized");
    expect(readdirSync(dir)).toEqual(["a.jpg"]); // dry run wrote nothing
  });
});
