import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";

export type Visibility = "public" | "private";

/** The image object PATCH /v1/images/{id} returns (the fields this command reads). */
export interface VisibilityImage {
  id: string;
  url: string;
  visibility: Visibility;
  /** Unix seconds when a private file's signed `url` stops working; absent when public. */
  signed_expires?: number;
  [key: string]: unknown;
}

/** Exact lowercase only, like the API: a typo must never mean "public". */
export function parseVisibility(value: string): Visibility {
  if (value === "public" || value === "private") return value;
  throw new CliError(`Invalid visibility "${value}". Use one of: public, private.`, 1);
}

function explainVisibilityError(error: unknown, id: string, visibility: Visibility): never {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "private_limit_reached":
        throw new CliError(
          `${error.message} Run \`pixelvault upgrade starter\` for a checkout URL, or delete private files you no longer need.`,
          1,
        );
      case "visibility_change_collection":
        throw new CliError(
          `${error.message} To change only this file, upload it again on its own (\`pixelvault upload <file>${visibility === "private" ? " --private" : ""}\`).`,
          1,
        );
      case "visibility_change_unsupported":
        throw new CliError(
          `${error.message} Only images and PDFs can change visibility; upload the file again${visibility === "private" ? " with --private" : " without --private"}.`,
          1,
        );
      case "visibility_change_conflict":
        throw new CliError(
          `${error.message} Nothing was moved, so it is safe to retry: \`pixelvault visibility ${id} ${visibility}\`.`,
          1,
        );
    }
  }
  throw error;
}

export default defineCommand({
  meta: {
    name: "visibility",
    description: "Make an image or PDF public or private (moves the file; prints its new URL)",
  },
  args: {
    id: {
      type: "positional",
      description: "Image or PDF id (e.g. img_abc123)",
      required: true,
    },
    visibility: {
      type: "positional",
      description: "public or private",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output the updated image as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const id = String(args.id);
    const visibility = parseVisibility(String(args.visibility));
    const apiKey = requireApiKey();

    let response: { data: VisibilityImage };
    try {
      response = await apiRequest({
        method: "PATCH",
        path: `/v1/images/${encodeURIComponent(id)}`,
        auth: apiKey,
        body: { visibility },
      });
    } catch (error) {
      explainVisibilityError(error, id, visibility);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }
    const image = response.data;
    stdout(image.url);
    stderr(`Visibility: ${image.visibility}`);
    if (image.visibility === "private") {
      if (typeof image.signed_expires === "number") {
        stderr(`Signed link expires: ${new Date(image.signed_expires * 1000).toISOString()}`);
      }
      stderr(
        "Warning: any earlier public URL for this file no longer works (resized versions within about a minute); copies already saved elsewhere cannot be recalled.",
      );
    } else {
      stderr("Warning: any password share links to this file are now turned off.");
    }
  },
});
