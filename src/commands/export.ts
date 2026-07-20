import { defineCommand } from "citty";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { apiRequest } from "../lib/client.js";
import { getApiUrl, requireApiKey } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";
import { CliError } from "../lib/errors.js";

interface StartResponse {
  job_id: string;
  status: string;
  image_count: number;
  status_url: string;
}

interface StatusResponse {
  id: string;
  status: "pending" | "processing" | "complete" | "failed" | "expired";
  image_count: number;
  processed_count: number;
  bytes: number;
  created_at: string;
  expires_at: string;
  download_url?: string;
  error?: string;
}

/** Default archive filename when `--output` isn't given. Pure, for tests. */
export function defaultOutputPath(jobId: string, out?: string): string {
  return out && out.length > 0 ? out : `pixelvault-export-${jobId}.tar`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineCommand({
  meta: {
    name: "export",
    description:
      "Export every image in your project as a tar archive (manifest.json + all images). Your data is always portable — no lock-in.",
  },
  args: {
    output: {
      type: "string",
      description: "Write the archive to this path (default: pixelvault-export-<job>.tar)",
      alias: "o",
    },
    extract: {
      type: "boolean",
      description: "Extract the archive into a directory after download (requires `tar`)",
      default: false,
    },
    timeout: {
      type: "string",
      description: "Max seconds to wait for the export to finish (default: 600)",
      default: "600",
    },
    json: {
      type: "boolean",
      description: "Output the final job JSON to stdout",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const timeoutMs = (Number(args.timeout) || 600) * 1000;

    // 1. Start the async export job (project-scoped by the secret key).
    let start: StartResponse;
    try {
      start = await apiRequest<StartResponse>({ method: "POST", path: "/v1/export", auth: apiKey });
    } catch (err) {
      // Surface the "already running" case helpfully.
      if (err instanceof CliError && /in progress/i.test(err.message)) {
        throw new CliError(
          "An export for this project is already in progress. Wait for it to finish, then try again.",
          1,
        );
      }
      throw err;
    }
    stderr(`Export started — ${start.image_count} image(s), job ${start.job_id}`);

    // 2. Poll until the archive is ready (backoff 1s → 5s).
    const deadline = Date.now() + timeoutMs;
    let status: StatusResponse;
    let delay = 1000;
    for (;;) {
      status = await apiRequest<StatusResponse>({
        path: `/v1/export-jobs/${encodeURIComponent(start.job_id)}`,
        auth: apiKey,
      });
      if (status.status === "complete") break;
      if (status.status === "failed") {
        throw new CliError(`Export failed: ${status.error ?? "unknown error"}`, 1);
      }
      if (status.status === "expired") {
        throw new CliError("Export expired before it could be downloaded. Start a new one.", 1);
      }
      if (Date.now() > deadline) {
        throw new CliError(
          `Timed out after ${args.timeout}s (job still ${status.status}). It may still finish — re-run to poll, or raise --timeout.`,
          1,
        );
      }
      stderr(`  ${status.status}… ${status.processed_count}/${status.image_count}`);
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 5000);
    }

    // 3. Download the tar. apiRequest parses JSON, so fetch the raw bytes directly
    // (the endpoint requires the same Bearer auth).
    const out = defaultOutputPath(start.job_id, args.output as string | undefined);
    const downloadUrl = `${getApiUrl()}/v1/export-jobs/${encodeURIComponent(start.job_id)}/download`;
    let bytes: ArrayBuffer;
    try {
      const dl = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!dl.ok) throw new CliError(`Failed to download export: HTTP ${dl.status}`, 1);
      bytes = await dl.arrayBuffer();
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        `Failed to download export: ${err instanceof Error ? err.message : String(err)}`,
        1,
      );
    }
    // A 200 with an empty/truncated body must not report success for a backup.
    if (bytes.byteLength === 0) {
      throw new CliError("Downloaded 0 bytes — refusing to write an empty archive.", 1);
    }
    try {
      writeFileSync(out, Buffer.from(bytes));
    } catch (err) {
      throw new CliError(
        `Failed to save ${out}: ${err instanceof Error ? err.message : String(err)}`,
        1,
      );
    }
    stderr(`Saved ${out} — ${status.image_count} image(s), ${bytes.byteLength} bytes`);

    // 4. Optional extraction via the system `tar`.
    if (args.extract) {
      const dir = out.replace(/\.tar$/, "") || `${out}-extracted`;
      try {
        mkdirSync(dir, { recursive: true });
        execFileSync("tar", ["-xf", out, "-C", dir], { stdio: "ignore" });
        stderr(`Extracted into ${dir}/`);
      } catch (err) {
        throw new CliError(
          `Saved ${out}, but extraction failed (is \`tar\` installed?): ${err instanceof Error ? err.message : String(err)}`,
          1,
        );
      }
    }

    if (args.json) {
      jsonOut({ ...status, output: out });
    } else {
      stdout(out); // machine-parseable path on stdout; progress went to stderr
    }
  },
});
