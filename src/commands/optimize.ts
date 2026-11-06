import { defineCommand } from "citty";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  lstatSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { stdout, stderr, jsonOut, formatBytes } from "../lib/output.js";
import {
  loadSharp,
  optimizeBuffer,
  savedPercent,
  SUPPORTED_EXTENSIONS,
  MAX_INPUT_BYTES,
  type OptimizeOptions,
  type OutFormat,
} from "../lib/optimize.js";

const FORMATS: OutFormat[] = ["keep", "webp", "avif", "jpg", "png"];
const OWNED = /\.optimized$/i; // stem of files this command writes beside the original

interface UploadResponse {
  data: { id: string; url: string; optimized_url?: string };
}

export interface Item {
  file: string;
  /** Directory the file was found under (for --recursive + --out-dir layout), or null. */
  root: string | null;
}

export interface Mode {
  outDir?: string;
  inPlace: boolean;
  /** Write `name.optimized.ext` beside the input (the default when not hosting). */
  writeBeside: boolean;
}

export interface Plan {
  item: Item;
  /** Where the optimized bytes go, or null when this run writes nothing locally. */
  optimized: string | null;
  /** Where an untouched original is copied under --out-dir (so the output tree stays complete). */
  kept: string | null;
}

interface Row {
  input: string;
  output: string | null;
  status: "optimized" | "skipped" | "error";
  reason?: string;
  input_bytes: number;
  output_bytes: number;
  saved_percent: number;
  url?: string;
  upload_error?: string;
}

/** Parse a positive-integer flag, or undefined when unset. */
export function parsePositiveInt(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`${name} must be a positive whole number.`);
  return n;
}

function isSupported(path: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase());
}

/** Descend into `dir`, skipping symlinks (no cycles, no escaping the root), dotfiles, our own outputs and `skipDir`. */
function walk(dir: string, out: string[], skipDir: string | undefined): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (skipDir && resolve(p) === skipDir) continue;
      walk(p, out, skipDir);
    } else if (isSupported(p) && !OWNED.test(basename(p, extname(p)))) {
      out.push(p);
    }
  }
}

/** Expand the positional paths into files; directories need --recursive. */
export function collectItems(paths: string[], recursive: boolean, outDir?: string): Item[] {
  const skipDir = outDir ? resolve(outDir) : undefined;
  const items: Item[] = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new CliError(`No such file or directory: ${p}`);
    }
    if (st.isDirectory()) {
      if (!recursive) throw new CliError(`${p} is a directory. Pass --recursive to optimize everything inside it.`);
      const found: string[] = [];
      walk(p, found, skipDir);
      for (const f of found.sort()) items.push({ file: f, root: p });
    } else {
      items.push({ file: p, root: null });
    }
  }
  return items;
}

/**
 * The extension an optimized file gets. `keep` preserves the input's own spelling
 * (`.jpeg` stays `.jpeg`, `.JPG` stays `.JPG`); otherwise it is the target format's.
 */
export function outputExt(item: Item, format: OutFormat): string {
  if (format === "keep") return extname(item.file).slice(1);
  return format === "jpg" ? "jpg" : format;
}

export function planOutput(item: Item, format: OutFormat, mode: Mode): Plan {
  const stem = basename(item.file, extname(item.file));
  const ext = outputExt(item, format);
  if (mode.inPlace) return { item, optimized: item.file, kept: null }; // exact original path
  if (mode.outDir) {
    const rel = item.root ? dirname(relative(item.root, item.file)) : ".";
    const dir = join(mode.outDir, rel);
    return { item, optimized: join(dir, `${stem}.${ext}`), kept: join(dir, basename(item.file)) };
  }
  if (mode.writeBeside) {
    return { item, optimized: join(dirname(item.file), `${stem}.optimized.${ext}`), kept: null };
  }
  return { item, optimized: null, kept: null };
}

/**
 * Refuse any plan that could lose data, before a single byte is written:
 * two inputs mapping to one output, an output that is another input (or an input
 * in disguise), a symlink as the destination, or --in-place on a symlink.
 */
export function assertSafePlans(plans: Plan[], mode: Mode): void {
  const inputs = new Set(plans.map((p) => resolve(p.item.file)));
  const claimed = new Map<string, string>(); // output path -> input that claimed it

  for (const plan of plans) {
    const src = resolve(plan.item.file);

    if (mode.inPlace && lstatSync(plan.item.file).isSymbolicLink()) {
      throw new CliError(`${plan.item.file} is a symlink; refusing to overwrite it in place. Optimize the real file instead.`);
    }

    const targets: Array<[string | null, boolean]> = [
      [plan.optimized, false],
      [plan.kept, true],
    ];
    for (const [target, isKept] of targets) {
      if (!target) continue;
      const out = resolve(target);
      const own = out === src;

      // Copying an untouched original onto itself is a harmless no-op; overwriting it with
      // optimized bytes is not, and is caught below.
      if (own && isKept && !mode.inPlace && plan.optimized !== target) continue;
      if (own && !mode.inPlace) {
        throw new CliError(`${plan.item.file}: the output would overwrite the original. Use --in-place if that is what you want.`);
      }
      if (!own && inputs.has(out)) {
        throw new CliError(`${target} is also an input file; refusing to overwrite it. Use different output settings.`);
      }
      const prior = claimed.get(out);
      if (prior && prior !== plan.item.file) {
        throw new CliError(`${plan.item.file} and ${prior} would both be written to ${target}. Optimize them separately or use --out-dir with --recursive.`);
      }
      claimed.set(out, plan.item.file);

      if (!own && existsSync(out) && lstatSync(out).isSymbolicLink()) {
        throw new CliError(`${target} is a symlink; refusing to write through it.`);
      }
    }
  }
}

/** Write via a temp file in the same directory, then rename, so a crash can't truncate the target. */
export function writeAtomic(target: string, data: Buffer, mode?: number): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export default defineCommand({
  meta: {
    name: "optimize",
    description:
      "Compress images locally (no account needed): resize, convert, strip metadata. Never writes a file bigger than the original",
  },
  args: {
    files: {
      type: "positional",
      description: "Image files (or directories with --recursive)",
      required: true,
    },
    format: {
      type: "string",
      description: "Output format: keep (default), webp, avif, jpg, png",
      default: "keep",
    },
    "max-width": { type: "string", description: "Downscale to at most this width in px (never upscales)" },
    "max-height": { type: "string", description: "Downscale to at most this height in px (never upscales)" },
    quality: {
      type: "string",
      description: "JPEG/WebP/AVIF quality 1-100 (default 80). PNG output is always lossless",
      default: "80",
    },
    "keep-metadata": {
      type: "boolean",
      description: "Keep EXIF/GPS and other metadata (stripped by default)",
      default: false,
    },
    "out-dir": { type: "string", description: "Write results into this directory (mirrors subfolders with --recursive)" },
    "in-place": {
      type: "boolean",
      description: "Overwrite each original (only with --format keep). Default writes name.optimized.ext beside it",
      default: false,
    },
    recursive: { type: "boolean", description: "Descend into directories", alias: "r", default: false },
    "dry-run": { type: "boolean", description: "Report what would be saved without writing anything", default: false },
    host: {
      type: "boolean",
      description:
        "Upload the optimized image and print its CDN URL (needs an API key). Local files are written only with --out-dir/--in-place",
      default: false,
    },
    json: { type: "boolean", description: "Output a JSON report (always an array)", default: false },
  },
  async run({ args }) {
    const format = String(args.format) as OutFormat;
    if (!FORMATS.includes(format)) {
      throw new CliError(`--format must be one of: ${FORMATS.join(", ")}.`);
    }
    const quality = parsePositiveInt("--quality", args.quality) ?? 80;
    if (quality > 100) throw new CliError("--quality must be a whole number between 1 and 100.");
    const maxWidth = parsePositiveInt("--max-width", args["max-width"]);
    const maxHeight = parsePositiveInt("--max-height", args["max-height"]);

    const outDir = args["out-dir"] ? String(args["out-dir"]) : undefined;
    if (args["in-place"] && outDir) throw new CliError("Use either --in-place or --out-dir, not both.");
    if (args["in-place"] && format !== "keep") {
      throw new CliError("--in-place only works with --format keep (changing format would need a different file name).");
    }

    const dryRun = Boolean(args["dry-run"]);
    const host = Boolean(args.host);
    if (host && dryRun) throw new CliError("--host can't be combined with --dry-run (it would upload).");
    const apiKey = host ? requireApiKey() : undefined;

    const paths = args._.length ? args._.map(String) : [String(args.files)];
    const items = collectItems(paths, Boolean(args.recursive), outDir);
    if (items.length === 0) throw new CliError("No supported images found (jpg, png, webp, avif).");

    const mode: Mode = {
      outDir,
      inPlace: Boolean(args["in-place"]),
      // With --host the point is the URL; only write beside the original when not hosting.
      writeBeside: !host,
    };
    const plans = items.map((item) => planOutput(item, format, mode));
    assertSafePlans(plans, mode);

    const sharp = await loadSharp();
    const opts: OptimizeOptions = { format, maxWidth, maxHeight, quality, keepMetadata: Boolean(args["keep-metadata"]) };
    // Uploads share the API's rate limit, so go gentler when hosting.
    const concurrency = host ? 2 : Math.max(1, Math.min(4, availableParallelism()));

    const rows = await pool(plans, concurrency, async (plan): Promise<Row> => {
      const { item } = plan;
      const inputExt = extname(item.file).slice(1).toLowerCase();
      const row: Row = {
        input: item.file,
        output: null,
        status: "error",
        input_bytes: 0,
        output_bytes: 0,
        saved_percent: 0,
      };
      let input: Buffer;
      try {
        const size = statSync(item.file).size;
        if (size > MAX_INPUT_BYTES) throw new Error(`file is over ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
        input = readFileSync(item.file);
        const res = await optimizeBuffer(sharp, input, inputExt, opts);
        const optimized = res.status === "optimized" && res.buffer ? res.buffer : null;
        row.status = res.status;
        row.reason = res.reason;
        row.input_bytes = res.inputBytes;
        row.output_bytes = res.outputBytes;
        row.saved_percent = savedPercent(res.inputBytes, res.outputBytes);

        if (!dryRun) {
          if (optimized && plan.optimized) {
            const keepMode = mode.inPlace ? statSync(item.file).mode & 0o777 : undefined;
            writeAtomic(plan.optimized, optimized, keepMode);
            row.output = plan.optimized;
          } else if (!optimized && plan.kept && resolve(plan.kept) !== resolve(item.file)) {
            // Keep the output tree complete: copy the untouched original across.
            writeAtomic(plan.kept, input);
            row.output = plan.kept;
          }
        }

        if (host && apiKey) {
          // Upload failures are reported separately so the local result above is never lost.
          try {
            // Skipped ("already optimal") files are uploaded as-is so every input gets a URL.
            const bytes = optimized ?? input;
            const name = optimized ? `${basename(item.file, extname(item.file))}.${res.ext}` : basename(item.file);
            const formData = new FormData();
            formData.append("file", new File([new Uint8Array(bytes)], name));
            const up = await apiRequest<UploadResponse>({
              method: "POST",
              path: "/v1/images",
              auth: apiKey,
              formData,
              // Same bytes → same image, so a retried batch doesn't create duplicates.
              headers: { "Idempotency-Key": createHash("sha256").update(bytes).digest("hex") },
            });
            row.url = up.data.optimized_url ?? up.data.url;
          } catch (err) {
            row.upload_error = err instanceof Error ? err.message : String(err);
          }
        }
      } catch (err) {
        row.status = "error";
        row.reason = err instanceof Error ? err.message : String(err);
      }
      return row;
    });

    let totalBefore = 0;
    let totalAfter = 0;
    let failures = 0;
    for (const r of rows) {
      if (r.status === "error") {
        failures++;
        stderr(`Failed ${r.input}: ${r.reason}`);
        continue;
      }
      if (r.upload_error) {
        failures++;
        stderr(`Upload failed for ${r.input}: ${r.upload_error}`);
      }
      totalBefore += r.input_bytes;
      totalAfter += r.output_bytes;
      if (r.status === "skipped") {
        stderr(`Skipped ${r.input}: ${r.reason}`);
      } else {
        const where = r.output ? ` → ${r.output}` : r.url ? ` → ${r.url}` : "";
        stderr(
          `${dryRun ? "Would save" : "Optimized"} ${r.input}${where}  ${formatBytes(r.input_bytes)} → ${formatBytes(r.output_bytes)} (-${r.saved_percent}%)`
        );
      }
    }
    if (rows.length > 1) {
      stderr(`Total: ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (-${savedPercent(totalBefore, totalAfter)}%)`);
      if (failures) stderr(`${failures} of ${rows.length} failed.`);
    }

    if (args.json) {
      jsonOut(rows); // always an array, so scripts need only one code path
    } else {
      // stdout stays machine-readable: the hosted URL, else the written (or, if skipped, original) path.
      for (const r of rows) {
        if (r.status === "error") continue;
        const line = r.url ?? r.output ?? (r.status === "skipped" ? r.input : null);
        if (line) stdout(line);
      }
    }

    // exitCode (not process.exit) so large piped stdout isn't truncated.
    if (failures) process.exitCode = 1;
  },
});
