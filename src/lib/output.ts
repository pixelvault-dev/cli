/**
 * Write to stdout (for machine-parseable output — URLs, JSON).
 */
export function stdout(text: string): void {
  process.stdout.write(text + "\n");
}

/**
 * Write to stderr (for human messages — prompts, progress, errors).
 */
export function stderr(text: string): void {
  process.stderr.write(text + "\n");
}

/**
 * Output data as JSON to stdout.
 */
export function jsonOut(data: unknown): void {
  stdout(JSON.stringify(data, null, 2));
}

/**
 * Print an error message to stderr and exit.
 */
export function fatal(message: string, exitCode = 1): never {
  stderr(`Error: ${message}`);
  process.exit(exitCode);
}

/**
 * Format a byte count for humans (1024-based).
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : 1)} ${units[i]}`;
}
