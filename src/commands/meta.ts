import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseMetadataFlags } from "../lib/metadata.js";
import { CliError } from "../lib/errors.js";
import { jsonOut } from "../lib/output.js";

interface PatchResponse {
  data: { id: string; metadata: Record<string, unknown> | null };
}

export default defineCommand({
  meta: {
    name: "meta",
    description:
      "Replace an image's custom metadata (the new object replaces the old one; use --clear to remove it)",
  },
  args: {
    id: {
      type: "positional",
      description: "Image ID (e.g. img_abc123)",
      required: true,
    },
    meta: {
      type: "string",
      description: "Metadata as key=value (repeatable), e.g. --meta env=prod --meta run=42",
    },
    metadata: {
      type: "string",
      description: 'Metadata as a JSON object, e.g. --metadata \'{"env":"prod","n":3}\'',
    },
    clear: {
      type: "boolean",
      description: "Remove all metadata from the image",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const metadata = parseMetadataFlags({ meta: args.meta, metadata: args.metadata });

    if (args.clear && metadata) {
      throw new CliError("Use either --clear or --meta/--metadata, not both.");
    }
    if (!args.clear && !metadata) {
      throw new CliError("Nothing to set: pass --meta key=value, --metadata '<json>', or --clear.");
    }

    const res = await apiRequest<PatchResponse>({
      method: "PATCH",
      path: `/v1/images/${encodeURIComponent(String(args.id))}`,
      auth: apiKey,
      body: { metadata: args.clear ? null : metadata },
    });

    jsonOut(res.data.metadata);
  },
});
