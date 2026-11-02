import { CliError } from "./errors.js";

/** citty yields a string for one flag and an array when the flag is repeated. */
function asList(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

/**
 * Build a metadata object from `--meta key=value` (repeatable, string values)
 * and/or `--metadata '<json object>'` (typed values). Returns null when neither
 * flag was given. A key present in both with different values is an error.
 */
export function parseMetadataFlags(opts: {
  meta?: unknown;
  metadata?: unknown;
}): Record<string, unknown> | null {
  // A Map so a key like "__proto__" stays an ordinary entry.
  const out = new Map<string, unknown>();

  const json = asList(opts.metadata);
  if (json.length > 1) throw new CliError("--metadata can be given only once.");
  if (json.length === 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json[0] as string);
    } catch {
      throw new CliError("--metadata must be a JSON object, e.g. --metadata '{\"env\":\"prod\"}'.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError("--metadata must be a JSON object, e.g. --metadata '{\"env\":\"prod\"}'.");
    }
    for (const [k, v] of Object.entries(parsed)) out.set(k, v);
  }

  for (const pair of asList(opts.meta)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--meta expects key=value, got "${pair}".`);
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (out.has(key) && out.get(key) !== value) {
      throw new CliError(`Metadata key "${key}" was given with conflicting values.`);
    }
    out.set(key, value);
  }

  return out.size === 0 ? null : Object.fromEntries(out);
}
