import { defineCommand } from "citty";
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { stdout, stderr, jsonOut, formatBytes } from "../lib/output.js";
import {
  loadSharp,
  optimizeBuffer,
  savedPercent,
  SUPPORTED_EXTENSIONS,
  type OptimizeOptions,
  type OptimizeResult,
  type OutFormat,
} from "../lib/optimize.js";

const FORMATS: OutFormat[] = ["keep", "webp", "avif", "jpg", "png"];
const CONCURRENCY = 4;

interface UploadResponse {
  data: { id: string; url: string; optimized_url?: string };
}

interface Item {
  file: string;
  /** Directory the file was found under (for --recursive + --out-dir layout), or null. */
  root: string | null;
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

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (isSupported(p)) out.push(p);
  }
}

/** Expand the positional paths into files; directories need --recursive. */
export function collectItems(paths: string[], recursive: boolean): Item[] {
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
      walk(p, found);
      for (const f of found.sort()) items.push({ file: f, root: p });
    } else {
      items.push({ file: p, root: null });
    }
  }
  return items;
}

/** Where to write the result, or null when this run writes nothing locally. */
export function resolveOutputPath(
  item: Item,
  ext: string,
  mode: { outDir?: string; inPlace: boolean; writeBeside: boolean }
): string | null {
  const stem = basename(item.file, extname(item.file));
  if (mode.outDir) {
    const rel = item.root ? dirname(relative(item.root, item.file)) : ".";
    return join(mode.outDir, rel, `${stem}.${ext}`);
  }
  if (mode.inPlace) return join(dirname(item.file), `${stem}.${ext}`);
  if (mode.writeBeside) return join(dirname(item.file), `${stem}.optimized.${ext}`);
  return null;
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
    json: { type: "boolean", description: "Output a JSON report", default: false },
  },
  async run({ args }) {
    const format = String(args.format) as OutFormat;
    if (!FORMATS.includes(format)) {
      throw new CliError(`--format must be one of: ${FORMATS.join(", ")}.`);
    }
    const quality = parsePositiveInt("--quality", args.quality) ?? 80;
    if (quality > 100) throw new CliError("--quality must be between 1 and 100.");
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
    const items = collectItems(paths, Boolean(args.recursive));
    if (items.length === 0) throw new CliError("No supported images found (jpg, png, webp, avif).");

    const sharp = await loadSharp();
    const opts: OptimizeOptions = { format, maxWidth, maxHeight, quality, keepMetadata: Boolean(args["keep-metadata"]) };
    const mode = {
      outDir,
      inPlace: Boolean(args["in-place"]),
      // With --host the point is the URL; only write beside the original when not hosting.
      writeBeside: !host && !dryRun,
    };

    let hadError = false;

    const rows = await pool(items, CONCURRENCY, async (item): Promise<Row> => {
      const inputExt = extname(item.file).slice(1).toLowerCase();
      try {
        const input = readFileSync(item.file);
        const res: OptimizeResult = await optimizeBuffer(sharp, input, inputExt, opts);
        const optimized = res.status === "optimized" && res.buffer;

        let output: string | null = null;
        if (!dryRun && optimized) {
          output = resolveOutputPath(item, res.ext, mode);
          if (output) {
            mkdirSync(dirname(output), { recursive: true });
            writeFileSync(output, res.buffer!);
          }
        }

        let url: string | undefined;
        if (host && apiKey) {
          // Skipped ("already optimal") files are uploaded as-is so every input gets a URL.
          const bytes = optimized ? res.buffer! : input;
          const name = optimized ? `${basename(item.file, extname(item.file))}.${res.ext}` : basename(item.file);
          const formData = new FormData();
          formData.append("file", new File([new Uint8Array(bytes)], name));
          const up = await apiRequest<UploadResponse>({ method: "POST", path: "/v1/images", auth: apiKey, formData });
          url = up.data.optimized_url ?? up.data.url;
        }

        return {
          input: item.file,
          output,
          status: res.status,
          reason: res.reason,
          input_bytes: res.inputBytes,
          output_bytes: res.outputBytes,
          saved_percent: savedPercent(res.inputBytes, res.outputBytes),
          url,
        };
      } catch (err) {
        hadError = true;
        return {
          input: item.file,
          output: null,
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
          input_bytes: 0,
          output_bytes: 0,
          saved_percent: 0,
        };
      }
    });

    let totalBefore = 0;
    let totalAfter = 0;
    for (const r of rows) {
      if (r.status === "error") {
        stderr(`Failed ${r.input}: ${r.reason}`);
        continue;
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
    }

    if (args.json) {
      jsonOut(rows.length === 1 ? rows[0] : rows);
    } else {
      // stdout stays machine-readable: the hosted URL, else the written (or, if skipped, original) path.
      for (const r of rows) {
        if (r.status === "error") continue;
        const line = r.url ?? r.output ?? (r.status === "skipped" ? r.input : null);
        if (line) stdout(line);
      }
    }

    if (hadError) process.exit(1);
  },
});
