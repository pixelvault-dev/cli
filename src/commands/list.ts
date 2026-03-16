import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, jsonOut } from "../lib/output.js";

interface ListResponse {
  data: Array<{
    id: string;
    url: string;
    mime_type: string;
    size: number;
    filename: string;
    folder: string | null;
    created_at: string;
  }>;
  meta: {
    total: number;
    page: number;
    per_page: number;
  };
}

export default defineCommand({
  meta: {
    name: "list",
    description: "List uploaded images",
  },
  args: {
    page: {
      type: "string",
      description: "Page number",
      default: "1",
    },
    "per-page": {
      type: "string",
      description: "Items per page (max 100)",
      default: "20",
    },
    json: {
      type: "boolean",
      description: "Output full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    const params = new URLSearchParams({
      page: args.page,
      per_page: args["per-page"],
    });

    const res = await apiRequest<ListResponse>({
      path: `/v1/images?${params}`,
      auth: apiKey,
    });

    if (args.json) {
      jsonOut(res);
    } else {
      for (const img of res.data) {
        stdout(img.url);
      }
    }
  },
});
