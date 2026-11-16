import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr } from "../lib/output.js";
import type { VideoData } from "../lib/video-upload.js";
import { waitForVideoEnrichment } from "../lib/video-enrichment.js";

export default defineCommand({
  meta: {
    name: "enrich-video",
    description: "Generate transcript and storyboard artifacts for an owned MP4",
  },
  args: {
    id: {
      type: "positional",
      description: "Video ID (e.g. vid_abc123)",
      required: true,
    },
    wait: {
      type: "boolean",
      description: "Wait up to five minutes for enrichment to finish",
      default: true,
    },
    json: {
      type: "boolean",
      description: "Output the full video response instead of only enrichment",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const id = String(args.id);
    let { data } = await apiRequest<{ data: VideoData }>({
      method: "POST",
      path: `/v1/videos/${encodeURIComponent(id)}/enrich`,
      auth: apiKey,
    });

    if (args.wait) data = await waitForVideoEnrichment(data, apiKey);
    if (data.enrichment.status === "failed") {
      throw new CliError(
        data.enrichment.error?.message ?? "Video enrichment failed. Try again.",
      );
    }

    if (args.json) {
      jsonOut(data);
      return;
    }

    jsonOut(data.enrichment);
    if (data.enrichment.status === "complete") {
      stderr("Transcript and storyboard generated. The original is unchanged.");
    } else {
      stderr(
        `Enrichment ${data.enrichment.status}. Run pixelvault enrich-video ${id} later to check again.`,
      );
    }
  },
});
