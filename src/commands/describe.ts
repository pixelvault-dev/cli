import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";
import { CliError } from "../lib/errors.js";
import { waitForDescription, describeSummary, type ImageDescription } from "../lib/describe.js";

interface DescribeResponse {
  data: {
    id: string;
    description?: ImageDescription | null;
    /** Why no description was started: quota, email_unverified, busy, unsupported_type, too_large, unavailable. */
    describe_skipped?: string;
  };
}

export default defineCommand({
  meta: {
    name: "describe",
    description:
      "Write an AI description (alt text, caption, OCR text, tags) for an image you already uploaded",
  },
  args: {
    id: {
      type: "positional",
      description: "Image ID (e.g. img_abc123)",
      required: true,
    },
    wait: {
      type: "boolean",
      description: "Wait up to ~40s for the description and print it (otherwise it runs in the background)",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output JSON ({ id, description }); with --wait it includes the full description",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const id = String(args.id);

    // Idempotent: an image that is already described, or in progress, costs nothing.
    const res = await apiRequest<DescribeResponse>({
      method: "POST",
      path: `/v1/images/${encodeURIComponent(id)}/describe`,
      auth: apiKey,
    });

    if (res.data.describe_skipped) {
      throw new CliError(`Description not started: ${res.data.describe_skipped}.`);
    }

    let description = res.data.description ?? null;
    if (args.wait && description?.status === "pending") {
      description = await waitForDescription(id, apiKey);
    }

    if (description?.status === "failed") {
      throw new CliError(describeSummary(description));
    }

    if (args.json) {
      jsonOut({ id, description });
      return;
    }

    if (description?.status === "done") {
      stdout(description.alt ?? "");
      if (description.tags?.length) stderr(`Tags: ${description.tags.join(", ")}`);
    } else {
      stderr(describeSummary(description));
    }
  },
});
