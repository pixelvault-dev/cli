import { defineCommand } from "citty";
import { readConfig, getApiKey } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

export default defineCommand({
  meta: {
    name: "whoami",
    description: "Show current authentication state",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const config = readConfig();
    const apiKey = getApiKey();

    if (!apiKey && !config.email) {
      stderr("Not authenticated. Run `pixelvault register` or `pixelvault login`.");
      process.exit(1);
    }

    const info = {
      email: config.email || "(unknown)",
      project: config.default_project || "(unknown)",
      api_key: apiKey
        ? `${apiKey.slice(0, 12)}...${apiKey.slice(-4)}`
        : "(not set)",
      source: process.env["PIXELVAULT_API_KEY"] ? "env" : "config",
    };

    if (args.json) {
      jsonOut(info);
    } else {
      stdout(`Email:   ${info.email}`);
      stdout(`Project: ${info.project}`);
      stdout(`API Key: ${info.api_key} (${info.source})`);
    }
  },
});
