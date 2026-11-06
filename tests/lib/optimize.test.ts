import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { optimizeBuffer, savedPercent, type SharpFactory } from "../../src/lib/optimize.js";

const factory = sharp as unknown as SharpFactory;
const base = { format: "keep" as const, quality: 80, keepMetadata: false };

/** A noisy photo-like JPEG saved at maximum quality, so there is plenty to shave. */
async function noisyJpeg(width = 800, height = 600, opts: Record<string, unknown> = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + ((i * 2654435761) >>> 24)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100, ...opts }).toBuffer();
}

describe("optimizeBuffer", () => {
  it("recompresses a large JPEG and reports the saving", async () => {
    const input = await noisyJpeg();
    const res = await optimizeBuffer(factory, input, "jpg", base);
    expect(res.status).toBe("optimized");
    expect(res.outputBytes).toBeLessThan(res.inputBytes);
    expect(res.buffer!.length).toBe(res.outputBytes);
    expect(res.ext).toBe("jpg");
  });

  it("converts to webp and reports the new extension", async () => {
    const res = await optimizeBuffer(factory, await noisyJpeg(), "jpg", { ...base, format: "webp" });
    expect(res.status).toBe("optimized");
    expect(res.ext).toBe("webp");
    expect((await sharp(res.buffer!).metadata()).format).toBe("webp");
  });

  it("downscales with max-width but never upscales", async () => {
    const input = await noisyJpeg(800, 600);
    const small = await optimizeBuffer(factory, input, "jpg", { ...base, maxWidth: 400 });
    expect(small.width).toBe(400);
    expect(small.height).toBe(300);
    const big = await optimizeBuffer(factory, input, "jpg", { ...base, maxWidth: 4000 });
    expect(big.width).toBe(800);
  });

  it("never returns something bigger: keeps the original and says why", async () => {
    const tiny = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).png().toBuffer();
    const res = await optimizeBuffer(factory, tiny, "png", base);
    expect(res.status).toBe("skipped");
    expect(res.reason).toMatch(/already optimal/);
    expect(res.buffer).toBeUndefined();
    expect(res.outputBytes).toBe(res.inputBytes);
  });

  it("applies EXIF orientation before stripping metadata", async () => {
    // 800x600 stored landscape with orientation 6 (rotate 90° CW) → displays 600x800.
    const input = await noisyJpeg(800, 600, { quality: 100 }).then((b) => sharp(b).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer());
    const res = await optimizeBuffer(factory, input, "jpg", base);
    expect(res.status).toBe("optimized");
    expect(res.width).toBe(600);
    expect(res.height).toBe(800);
    const out = await sharp(res.buffer!).metadata();
    expect(out.orientation).toBeUndefined(); // metadata stripped
  });

  it("flattens transparency onto white when converting to jpg", async () => {
    const png = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const res = await optimizeBuffer(factory, png, "png", { ...base, format: "jpg" });
    expect(res.status).toBe("optimized");
    const { data } = await sharp(res.buffer!).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240); // white, not black
  });

  it("skips GIF, SVG and unreadable files instead of failing", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    expect((await optimizeBuffer(factory, gif, "gif", base)).reason).toMatch(/GIF/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    expect((await optimizeBuffer(factory, svg, "svg", base)).reason).toMatch(/SVG/);
    await expect(optimizeBuffer(factory, Buffer.from("not an image"), "png", base)).rejects.toThrow(/not a readable image/);
  });
});

describe("idempotence", () => {
  it("leaves an already-optimized file alone on a second run", async () => {
    const first = await optimizeBuffer(factory, await noisyJpeg(), "jpg", base);
    expect(first.status).toBe("optimized");
    const again = await optimizeBuffer(factory, first.buffer!, "jpg", base);
    expect(again.status).toBe("skipped");
    expect(again.reason).toMatch(/already optimal/);
  });
});

describe("idempotence (explicit settings)", () => {
  it("skips when the same format is requested explicitly and nothing else changes", async () => {
    const first = await optimizeBuffer(factory, await noisyJpeg(), "jpg", base);
    const again = await optimizeBuffer(factory, first.buffer!, "jpg", { ...base, format: "jpg" });
    expect(again.status).toBe("skipped");
  });
  it("skips when max-width does not bind", async () => {
    const first = await optimizeBuffer(factory, await noisyJpeg(), "jpg", base);
    const again = await optimizeBuffer(factory, first.buffer!, "jpg", { ...base, maxWidth: 4000 });
    expect(again.status).toBe("skipped");
  });
});

describe("savedPercent", () => {
  it("rounds and handles zero", () => {
    expect(savedPercent(1000, 160)).toBe(84);
    expect(savedPercent(0, 0)).toBe(0);
  });
});
