import { CliError } from "./errors.js";

/** Signed-URL lifetime bounds, matching the API's `sign_expires_in` (60s..30d). */
export const MIN_EXPIRES_SECONDS = 60;
export const MAX_EXPIRES_SECONDS = 30 * 24 * 60 * 60;

/**
 * Parse a signed-link lifetime like `30m`, `12h`, `7d`, `90s`, or a bare number
 * of seconds, into seconds. Rejects anything outside the API's accepted range so
 * a bad value fails locally with a clear message instead of a 400 from the server.
 */
export function parseExpires(input: string): number {
  const match = /^(\d+)\s*([smhd]?)$/i.exec(input.trim());
  if (!match) {
    throw new CliError(
      `Invalid --expires "${input}". Use e.g. 30m, 12h, 7d, or a number of seconds.`
    );
  }

  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = Number(match[1] ?? "") * multiplier;

  if (seconds < MIN_EXPIRES_SECONDS || seconds > MAX_EXPIRES_SECONDS) {
    throw new CliError(
      `--expires must be between 60s and 30d (got ${seconds}s).`
    );
  }

  return seconds;
}
