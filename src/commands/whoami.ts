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
      // email/project come from config written at login; nothing checks them
      // against the current key.
      identity_source: "cached",
    };

    if (args.json) {
      jsonOut(info);
    } else {
      // email/project are read from config, not looked up for the current key.
      const tag = (v?: string) => (v ? " (cached, not verified for this key)" : "");
      stdout(`Email:   ${info.email}${tag(config.email)}`);
      stdout(`Project: ${info.project}${tag(config.default_project)}`);
      stdout(`API Key: ${info.api_key} (${info.source})`);
    }
  },
});
