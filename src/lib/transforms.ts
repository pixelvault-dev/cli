import { CliError } from "./errors.js";

export type TransformParamsObject = Record<string, string | number | boolean>;

const INT_KEYS = new Set(["w", "h", "watermark_width", "text_size"]);
const NUM_KEYS = new Set([
  "dpr",
  "zoom",
  "blur",
  "sharpen",
  "rotate",
  "brightness",
  "contrast",
  "saturation",
  "watermark_opacity",
  "text_opacity",
]);

/**
 * Parse a transform query string like `"w=800&fit=cover&fmt=auto&dpr=2"` (with
 * optional leading `?`/`&`) into a typed JSON object accepted by
 * `PUT /v1/presets/:name` and `POST /v1/images/:id/sign-url`.
 */
export function parseTransformQuery(raw: string): TransformParamsObject {
  const trimmed = raw.trim().replace(/^[?&]+/, "");
  if (!trimmed) {
    throw new CliError("Transform parameters must not be empty.", 1);
  }

  const sp = new URLSearchParams(trimmed);
  const out: TransformParamsObject = {};

  for (const [key, value] of sp.entries()) {
    const k = key.trim();
    const v = value.trim();
    if (!k || v === "") {
      throw new CliError(`Invalid transform parameter "${key}=${value}". Expected key=value pairs.`, 1);
    }
    if (INT_KEYS.has(k) || NUM_KEYS.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n)) {
        throw new CliError(`Transform parameter "${k}" must be a number (got "${v}").`, 1);
      }
      out[k] = n;
    } else if (k === "anim" && (v === "true" || v === "false")) {
      out[k] = v === "true";
    } else {
      out[k] = v;
    }
  }

  if (Object.keys(out).length === 0) {
    throw new CliError("Transform parameters must not be empty.", 1);
  }
  return out;
}

/** Parse a `--params '<json>'` string into a non-empty transform object. */
export function parseTransformJson(raw: string): TransformParamsObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("--params must be valid JSON (a key/value object).", 1);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("--params must be a JSON object.", 1);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new CliError("--params must contain at least one transform parameter.", 1);
  }
  const out: TransformParamsObject = {};
  for (const [key, value] of entries) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new CliError(
        `Transform parameter "${key}" must be a string, number, or boolean.`,
        1,
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve transform parameters from either a query string (`-t` / positional)
 * or a JSON object (`--params`). Rejects passing both.
 */
export function resolveTransformInput(options: {
  query?: string;
  paramsJson?: string;
  required: boolean;
  allowSize: boolean;
}): TransformParamsObject | undefined {
  const hasQuery = typeof options.query === "string" && options.query.trim().length > 0;
  const hasJson = typeof options.paramsJson === "string" && options.paramsJson.trim().length > 0;

  if (hasQuery && hasJson) {
    throw new CliError("Pass either a query string (-t / positional) or --params JSON, not both.", 1);
  }
  if (!hasQuery && !hasJson) {
    if (options.required) {
      throw new CliError(
        'Provide transform parameters as a query string (e.g. "w=800&fmt=auto") or via --params \'{"w":800,"fmt":"auto"}\'.',
        1,
      );
    }
    return undefined;
  }

  const resolved = hasJson
    ? parseTransformJson(options.paramsJson!)
    : parseTransformQuery(options.query!);

  if (!options.allowSize && "size" in resolved) {
    throw new CliError('A custom preset cannot reference "size".', 1);
  }
  return resolved;
}

/** Render a stored preset params object as a readable query string. */
export function formatTransformParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("&");
}
