/**
 * Validation for the retry-safety / reuse flags on `upload`, done up front so a
 * bad combination fails before any file is read or sent.
 */

// Mirrors the API: 1-255 printable ASCII characters, no spaces.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

/** Returns an error message for an invalid flag combination, or null when fine. */
export function validateReuseOptions(opts: {
  idempotencyKey?: string;
  dedupe?: boolean;
  fileCount: number;
}): string | null {
  const { idempotencyKey, dedupe, fileCount } = opts;
  if (idempotencyKey !== undefined) {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return "--idempotency-key must be 1-255 printable ASCII characters with no spaces.";
    }
    if (dedupe) {
      return "--dedupe cannot be combined with --idempotency-key. Use the key for retry-safety, or --dedupe to reuse an identical image.";
    }
    if (fileCount > 1) {
      return "--idempotency-key identifies a single upload, so it can't be used with multiple files. Upload them one at a time with distinct keys.";
    }
  }
  return null;
}
