import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";
import type { VideoData } from "../lib/video-upload.js";
import { waitForVideoOptimization } from "../lib/video-optimization.js";


export default defineCommand({
  meta: {
    name: "optimize-video",
    description: "Preserve an MP4 and create a social-ready H.264/AAC fast-start copy",
  },
  args: {
    id: {
      type: "positional",
      description: "Video ID (e.g. vid_abc123)",
      required: true,
    },
    wait: {
      type: "boolean",
      description: "Wait up to five minutes and print the social-ready URL",
      default: true,
    },
    json: {
      type: "boolean",
      description: "Output the full video response as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const id = String(args.id);
    let { data } = await apiRequest<{ data: VideoData }>({
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/optimize`,
      auth: apiKey,
    });

    if (args.wait) data = await waitForVideoOptimization(data, apiKey);
    const optimization = data.social_optimization;
    if (optimization.status === "failed") {
      throw new CliError(
        optimization.error?.message ?? "Video optimization failed. Try again.",
      );
    }

    if (args.json) {
      jsonOut(data);
      return;
    }

    if (
      (optimization.status === "complete" || optimization.status === "not_needed")
      && optimization.url
    ) {
      stdout(optimization.url);
      stderr(
        optimization.status === "complete"
          ? "Social-ready copy created. The original is unchanged."
          : "The original was already social-ready; no copy was needed.",
      );
      return;
    }

    stderr(
      `Optimization ${optimization.status}. Run pixelvault optimize-video ${id} later to check again.`,
    );
  },
});
