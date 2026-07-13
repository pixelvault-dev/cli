import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

interface UploadResponse {
  data: {
    id: string;
    url: string;
    visibility?: "public" | "private";
    mime_type: string;
    size: number;
    filename: string;
    folder: string | null;
    created_at: string;
    signed_expires?: number;
  };
}

export default defineCommand({
  meta: {
    name: "upload",
    description: "Upload one or more images",
  },
  args: {
    files: {
      type: "positional",
      description: "File path(s) to upload",
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
    json: {
      type: "boolean",
      description: "Output full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    // Resolve the signed-link lifetime up front so a bad value fails before any
    // upload happens. `--expires` only makes sense for a private (signed) URL.
    let signExpires: number | null = null;
    if (args.expires !== undefined) {
      if (!args.private) {
        stderr("--expires only applies to --private uploads (it sets the signed link's lifetime).");
        process.exit(1);
      }
      signExpires = parseExpires(String(args.expires));
    }

    if (args.private && args.folder) {
      stderr("Note: --folder is ignored for --private uploads.");
    }

    // citty passes positional as a single string; we handle globs via shell expansion
    const files = Array.isArray(args.files) ? args.files : [args.files];
    let hadError = false;

    const results: UploadResponse["data"][] = [];

    for (const filePath of files) {
      try {
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

        const res = await apiRequest<UploadResponse>({
          method: "POST",
          path: "/v1/images",
          auth: apiKey,
          formData,
        });

        // Fail closed: if we asked for private but the server didn't confirm it,
        // don't hand back a URL the user would wrongly trust as private.
        if (args.private && res.data.visibility !== "private") {
          hadError = true;
          stderr(`Refusing to report ${filePath}: server did not confirm a private upload.`);
          continue;
        }

        if (args.json) {
          results.push(res.data);
        } else {
          stdout(res.data.url);
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
