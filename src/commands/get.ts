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
 */
export function applyTransform(url: string, transform?: string): string {
  if (!transform) return url;
  const q = transform.replace(/^[?&]+/, "");
  if (!q) return url;
  return url.includes("?") ? `${url}&${q}` : `${url}?${q}`;
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
        'Transform params to apply, e.g. "w=400&fmt=webp", "segment=foreground", "tile=logo.png"',
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
      path: `/v1/images/${args.id}`,
      auth: apiKey,
    });

    const url = applyTransform(res.data.url, args.transform as string | undefined);

    // Download mode: fetch the (possibly transformed) bytes to disk.
    if (args.output) {
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
      writeFileSync(args.output as string, Buffer.from(bytes));
      stderr(`Saved ${args.output}`);
      stdout(url); // URL to stdout (machine-parseable), confirmation to stderr
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
