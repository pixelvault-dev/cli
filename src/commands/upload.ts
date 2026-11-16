import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { validateReuseOptions } from "../lib/upload-options.js";
import { parseMetadataFlags } from "../lib/metadata.js";
import { waitForDescription, describeSummary, type ImageDescription } from "../lib/describe.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";
import { isRemoteVideoUrl, uploadVideoFile, uploadVideoUrl } from "../lib/video-upload.js";
import { waitForVideoOptimization } from "../lib/video-optimization.js";

interface UploadResponse {
  data: {
    id: string;
    kind?: "image" | "video";
    url: string;
    optimized_url?: string;
    poster_url?: string;
    visibility?: "public" | "private";
    mime_type: string;
    size: number;
    filename: string;
    folder?: string | null;
    created_at: string;
    signed_expires?: number;
    /** The API reused an identical existing image (--dedupe). */
    deduplicated?: boolean;
    /** The API returned the original of a repeated --idempotency-key. */
    replayed?: boolean;
    metadata?: Record<string, unknown> | null;
    /** AI description (--describe): pending right after upload, `done` once ready. */
    description?: ImageDescription | null;
    /** --describe was requested but could not start (quota, type, busy, ...). */
    describe_skipped?: string;
  };
}

export default defineCommand({
  meta: {
    name: "upload",
    description: "Upload one or more images, MP4 files, or public MP4 URLs",
  },
  args: {
    files: {
      type: "positional",
      description: "Image/MP4 file path(s), or public MP4 URL(s), to upload",
      required: true,
    },
    folder: {
      type: "string",
      description: "Folder to organize images in",
    },
    private: {
      type: "boolean",
      description:
        "Upload privately — returns a signed URL only holders of the link can open (needs a secret key)",
      default: false,
    },
    expires: {
      type: "string",
      description:
        "Lifetime of a --private signed link: e.g. 30m, 12h, 7d (default 7d; min 60s, max 30d)",
    },
    optimized: {
      type: "boolean",
      description:
        "Print the optimized URL (WebP/AVIF, usually much smaller) instead of the original; falls back to the original URL when none is returned (SVG, GIF, private)",
      default: false,
    },
    social: {
      type: "boolean",
      description:
        "For MP4 uploads, wait for and print a separate social-ready H.264/AAC fast-start URL; the original is preserved",
      default: false,
    },
    "idempotency-key": {
      type: "string",
      description:
        "Make retries safe: repeating the same key with the same file returns the original image instead of storing a copy (single file only)",
    },
    dedupe: {
      type: "boolean",
      description:
        "Reuse an identical image already in your project instead of storing and counting another upload",
      default: false,
    },
    meta: {
      type: "string",
      description:
        "Attach custom metadata as key=value (repeatable), e.g. --meta env=prod --meta run=42",
    },
    metadata: {
      type: "string",
      description: 'Attach custom metadata as a JSON object, e.g. --metadata \'{"env":"prod","n":3}\'',
    },
    describe: {
      type: "boolean",
      description:
        "Generate an AI description (alt text, caption, OCR) in the background; needs a secret key. Free 20 in total, Starter 1,000/mo, Pro 10,000/mo. Read it with `get <id> --json`, or add --wait",
      default: false,
    },
    wait: {
      type: "boolean",
      description:
        "With --describe: wait up to ~40s for the description and include it in --json output (alt text goes to stderr otherwise)",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    // Resolve the signed-link lifetime up front so a bad value fails before any
    // upload happens. Private image and video links default to seven days.
    let signExpires: number | null = null;
    if (args.expires !== undefined && !args.private) {
      stderr("--expires only applies to --private uploads (it sets the signed link's lifetime).");
      process.exit(1);
    }
    if (args.private) {
      signExpires = parseExpires(String(args.expires ?? "7d"));
    }

    if (args.private && args.folder) {
      stderr("Note: --folder is ignored for --private uploads.");
    }

    // A citty positional binds only the first value; every positional (including
    // the first, and anything a shell glob expanded to) lands in `args._`.
    const files = args._.length ? args._.map(String) : [String(args.files)];

    const hasVideo = files.some(
      (source) => isRemoteVideoUrl(source) || extname(source).toLowerCase() === ".mp4"
    );
    const allVideo = files.every(
      (source) => isRemoteVideoUrl(source) || extname(source).toLowerCase() === ".mp4"
    );
    if (args.social && !allVideo) {
      stderr("--social only applies to MP4 file or URL uploads.");
      process.exit(1);
    }
    const imageOnlyOption =
      args.folder ||
      args.optimized ||
      args["idempotency-key"] ||
      args.dedupe ||
      args.meta ||
      args.metadata ||
      args.describe ||
      args.wait;
    if (hasVideo && imageOnlyOption) {
      stderr(
        "MP4 uploads do not support folder, optimization, reuse, metadata, or AI-description options. Use --private and --expires for signed video delivery."
      );
      process.exit(1);
    }
    let hadError = false;

    const idempotencyKey = args["idempotency-key"] as string | undefined;
    const reuseError = validateReuseOptions({
      idempotencyKey,
      dedupe: args.dedupe,
      fileCount: files.length,
    });
    if (reuseError) {
      stderr(reuseError);
      process.exit(1);
    }

    const metadata = parseMetadataFlags({ meta: args.meta, metadata: args.metadata });

    if (args.wait && !args.describe) {
      stderr("--wait only applies together with --describe.");
      process.exit(1);
    }

    const results: UploadResponse["data"][] = [];

    for (const filePath of files) {
      try {
        if (isRemoteVideoUrl(filePath) || extname(filePath).toLowerCase() === ".mp4") {
          const options = {
            private: Boolean(args.private),
            signExpiresIn: signExpires,
            socialReady: Boolean(args.social),
          };
          let video = isRemoteVideoUrl(filePath)
            ? await uploadVideoUrl(filePath, apiKey, options)
            : await uploadVideoFile(filePath, apiKey, options);
          if (args.private && video.visibility !== "private") {
            throw new Error("The API did not confirm private visibility; refusing to print the URL.");
          }
          if (args.social) {
            video = await waitForVideoOptimization(video, apiKey);
            const optimization = video.social_optimization;
            if (optimization.status === "failed") {
              hadError = true;
              stderr(
                `Uploaded ${filePath} at ${video.original_url}, but social-ready conversion failed: ` +
                (optimization.error?.message ?? "Try again with pixelvault optimize-video.")
              );
              if (args.json) results.push(video);
              continue;
            }
            if (
              (optimization.status !== "complete" && optimization.status !== "not_needed")
              || !optimization.url
            ) {
              hadError = true;
              stderr(
                `Uploaded ${filePath} at ${video.original_url}; optimization is still ${optimization.status}. ` +
                `Check it with pixelvault optimize-video ${video.id}.`
              );
              if (args.json) results.push(video);
              continue;
            }
          }
          if (!args.social && video.social_compatible === false) {
            const detail = video.compatibility_warnings.map(({ message }) => message).join(" ");
            stderr(`Video compatibility warning: ${detail || "social compatibility could not be verified."}`);
          }
          if (args.json) {
            results.push(video);
          } else {
            stdout(args.social ? video.social_optimization.url! : video.url);
          }
          continue;
        }

        const buffer = readFileSync(filePath);
        const fileName = basename(filePath);

        const formData = new FormData();
        formData.append(
          "file",
          new File([buffer], fileName)
        );

        if (args.folder) {
          formData.append("folder", args.folder);
        }

        if (args.private) {
          // The server routes private images to a signed-URL-only path and
          // returns the ready-to-share signed URL in `data.url`. A user-supplied
          // folder is ignored for private uploads (server-side).
          formData.append("visibility", "private");
          if (signExpires !== null) {
            formData.append("sign_expires_in", String(signExpires));
          }
        }

        if (args.dedupe) {
          formData.append("dedupe", "true");
        }

        if (metadata) {
          formData.append("metadata", JSON.stringify(metadata));
        }

        if (args.describe) {
          formData.append("describe", "true");
        }

        const res = await apiRequest<UploadResponse>({
          method: "POST",
          path: "/v1/images",
          auth: apiKey,
          formData,
          ...(idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : {}),
        });

        // stderr only: stdout stays the bare URL so scripts keep working.
        if (res.data.replayed) {
          stderr(`Replayed: ${filePath} was already uploaded with this key; returning the original.`);
        } else if (res.data.deduplicated) {
          stderr(`Deduplicated: ${filePath} matches an existing image; nothing new was stored.`);
        }

        // Fail closed: if we asked for private but the server didn't confirm it,
        // don't hand back a URL the user would wrongly trust as private.
        if (args.private && res.data.visibility !== "private") {
          hadError = true;
          stderr(`Refusing to report ${filePath}: server did not confirm a private upload.`);
          continue;
        }

        // The upload itself never fails because of --describe; say what happened on stderr.
        if (args.describe) {
          if (res.data.describe_skipped) {
            stderr(`Description skipped for ${filePath}: ${res.data.describe_skipped}.`);
          } else if (args.wait && res.data.description?.status === "pending") {
            res.data.description = await waitForDescription(res.data.id, apiKey);
            if (!args.json) stderr(describeSummary(res.data.description ?? null));
          } else if (res.data.description?.status === "pending") {
            stderr(`Describing ${filePath} in the background; read it with: pixelvault get ${res.data.id} --json`);
          } else if (res.data.description?.status === "done" && !args.json) {
            stderr(describeSummary(res.data.description)); // reused from an identical image
          }
        }

        if (args.json) {
          results.push(res.data);
        } else {
          stdout(args.optimized ? (res.data.optimized_url ?? res.data.url) : res.data.url);
        }
      } catch (err) {
        hadError = true;
        stderr(
          `Failed to upload ${filePath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (args.json && results.length > 0) {
      jsonOut(results.length === 1 ? results[0] : results);
    }

    if (hadError) {
      process.exit(1);
    }
  },
});
