import { defineCommand } from "citty";
import { writeFileSync } from "node:fs";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";
import { CliError } from "../lib/errors.js";

interface GetResponse {
  data: {
    id: string;
    url: string;
    mime_type: string;
    size: number;
    filename: string;
    folder: string | null;
    created_at: string;
  };
}

/**
 * Append a transform query string to a CDN URL. Accepts params with or without a
 * leading `?`/`&` (e.g. `w=400&fmt=webp`, `?segment=foreground`). See the transform
 * docs: https://pixelvault.dev/docs#transforms
 *
 * The params are reserialized through URLSearchParams so reserved characters in
 * values are percent-encoded — without this a hex color like `background=#ffaa00`
 * would be parsed as a URL fragment and lost. Idempotent for already-encoded input.
 */
export function applyTransform(url: string, transform?: string): string {
  if (!transform) return url;
  const raw = transform.trim().replace(/^[?&]+/, "");
  if (!raw) return url;
  const params = new URLSearchParams(raw).toString();
  if (!params) return url;
  return url.includes("?") ? `${url}&${params}` : `${url}?${params}`;
}

export default defineCommand({
  meta: {
    name: "get",
    description:
      "Get an image's CDN URL or metadata, or download it — optionally transformed",
  },
  args: {
    id: {
      type: "positional",
      description: "Image ID (e.g. img_abc123)",
      required: true,
    },
    output: {
      type: "string",
      description: "Download the image to this file path",
      alias: "o",
    },
    transform: {
      type: "string",
      description:
        'Transform params to apply, e.g. "w=400&fmt=webp", "segment=foreground", "tile=img_logo.png"',
      alias: "t",
    },
    json: {
      type: "boolean",
      description: "Output full JSON metadata",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    const res = await apiRequest<GetResponse>({
      path: `/v1/images/${encodeURIComponent(args.id)}`,
      auth: apiKey,
    });

    const url = applyTransform(res.data.url, args.transform as string | undefined);

    // Download mode: fetch the (possibly transformed) bytes to disk.
    if (args.output) {
      const output = args.output as string;
      let bytes: ArrayBuffer;
      try {
        const dl = await fetch(url);
        if (!dl.ok) {
          throw new CliError(`Failed to download image: HTTP ${dl.status}`, 1);
        }
        bytes = await dl.arrayBuffer();
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(
          `Failed to download image: ${err instanceof Error ? err.message : String(err)}`,
          1,
        );
      }
      // Refuse to write an empty file — a 200 with an empty/truncated body would
      // otherwise report success and leave a broken image that agents chain on.
      if (bytes.byteLength === 0) {
        throw new CliError("Downloaded 0 bytes — refusing to write an empty file", 1);
      }
      try {
        writeFileSync(output, Buffer.from(bytes));
      } catch (err) {
        throw new CliError(
          `Failed to save ${output}: ${err instanceof Error ? err.message : String(err)}`,
          1,
        );
      }
      stderr(`Saved ${output}`);
      // Honor --json even in download mode so a caller that always requests JSON
      // gets a stable stdout contract regardless of -o.
      if (args.json) {
        jsonOut(
          args.transform ? { ...res, transformed_url: url, output } : { ...res, output },
        );
      } else {
        stdout(url); // URL to stdout (machine-parseable), confirmation to stderr
      }
      return;
    }

    if (args.json) {
      // When a transform is applied there's no separate record for it, so surface
      // the resolved URL alongside the raw metadata.
      jsonOut(args.transform ? { ...res, transformed_url: url } : res);
    } else {
      stdout(url);
    }
  },
});
