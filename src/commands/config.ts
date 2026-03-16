import { defineCommand } from "citty";
import { readConfig, updateConfig, getConfigPath } from "../lib/config.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

const configGet = defineCommand({
  meta: {
    name: "get",
    description: "Get a config value",
  },
  args: {
    key: {
      type: "positional",
      description: "Config key (api_key, default_project, email, api_url)",
      required: true,
    },
  },
  async run({ args }) {
    const config = readConfig();
    const value = config[args.key as keyof typeof config];

    if (value === undefined) {
      stderr(`Key "${args.key}" is not set.`);
      process.exit(1);
    }

    stdout(String(value));
  },
});

const configSet = defineCommand({
  meta: {
    name: "set",
    description: "Set a config value",
  },
  args: {
    key: {
      type: "positional",
      description: "Config key",
      required: true,
    },
    value: {
      type: "positional",
      description: "Config value",
      required: true,
    },
  },
  async run({ args }) {
    const validKeys = ["api_key", "default_project", "email", "api_url"];
    if (!validKeys.includes(args.key)) {
      stderr(`Invalid key. Valid keys: ${validKeys.join(", ")}`);
      process.exit(1);
    }

    updateConfig({ [args.key]: args.value });
    stderr(`Set ${args.key} = ${args.key === "api_key" ? "***" : args.value}`);
  },
});

const configShow = defineCommand({
  meta: {
    name: "show",
    description: "Show all config values",
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

    if (args.json) {
      jsonOut(config);
    } else {
      stderr(`Config: ${getConfigPath()}`);
      for (const [key, value] of Object.entries(config)) {
        const display = key === "api_key" && value
          ? `${(value as string).slice(0, 12)}...`
          : value;
        stdout(`${key} = ${display}`);
      }
    }
  },
});

export default defineCommand({
  meta: {
    name: "config",
    description: "Manage CLI configuration",
  },
  subCommands: {
    get: configGet,
    set: configSet,
    show: configShow,
  },
});
