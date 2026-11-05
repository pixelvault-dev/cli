import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, jsonOut } from "../lib/output.js";

interface TagsResponse {
  data: Array<{ tag: string; count: number }>;
}

export default defineCommand({
  meta: {
    name: "tags",
    description:
      "List the AI tags on your described images with how many images carry each (filter with `list --tag`)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output the full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    const res = await apiRequest<TagsResponse>({ path: "/v1/images/tags", auth: apiKey });

    if (args.json) {
      jsonOut(res);
    } else {
      for (const t of res.data) {
        stdout(`${t.tag}\t${t.count}`);
      }
    }
  },
});
