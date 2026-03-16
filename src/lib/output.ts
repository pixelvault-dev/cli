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
