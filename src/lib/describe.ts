import { apiRequest } from "./client.js";

export interface ImageDescription {
  status: "pending" | "done" | "failed";
  alt?: string;
  caption?: string;
  ocr_text?: string;
  error?: string;
  cached?: boolean;
}

interface GetResponse {
  data: { description?: ImageDescription | null };
}

const POLL_MS = 2000;
const MAX_WAIT_MS = 40_000;

/**
 * Poll GET /v1/images/:id until its AI description is `done` or `failed` (or the wait
 * runs out, returning the last state). The server reports a description that never
 * finished as `failed`/`describe_timeout`, so this never waits forever on a lost job.
 * `sleep`/`now` are injectable for tests.
 */
export async function waitForDescription(
  id: string,
  auth: string,
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ImageDescription | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + MAX_WAIT_MS;
  let last: ImageDescription | null = null;
  for (;;) {
    const res = await apiRequest<GetResponse>({ path: `/v1/images/${encodeURIComponent(id)}`, auth });
    last = res.data.description ?? null;
    if (!last || last.status !== "pending") return last;
    if (now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

/** One human-readable stderr line summarising a finished description. */
export function describeSummary(d: ImageDescription | null): string {
  if (!d) return "No description was produced.";
  if (d.status === "done") return `Alt: ${d.alt ?? ""}`;
  if (d.status === "failed") return `Description failed (${d.error ?? "unknown"}).`;
  return "Description is still pending; run `pixelvault get <id> --json` in a few seconds.";
}
