import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stderr } from "../lib/output.js";

export default defineCommand({
  meta: {
    name: "delete",
    description: "Delete an image by ID",
  },
  args: {
    id: {
      type: "positional",
      description: "Image ID (e.g. img_abc123)",
      required: true,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    await apiRequest<{ success: boolean }>({
      method: "DELETE",
      path: `/v1/images/${args.id}`,
      auth: apiKey,
    });

    // Silent on success (agent-friendly)
  },
});
