import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

interface UploadResponse {
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
    json: {
      type: "boolean",
      description: "Output full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

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

        const res = await apiRequest<UploadResponse>({
          method: "POST",
          path: "/v1/images",
          auth: apiKey,
          formData,
        });

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
