import { defineCommand, runMain } from "citty";
import { CliError } from "./lib/errors.js";
import { stderr } from "./lib/output.js";

const main = defineCommand({
  meta: {
    name: "pixelvault",
    version: "0.1.0",
    description: "CLI for PixelVault — agent-first image hosting",
  },
  subCommands: {
    register: () => import("./commands/register.js").then((m) => m.default),
    login: () => import("./commands/login.js").then((m) => m.default),
    upload: () => import("./commands/upload.js").then((m) => m.default),
    list: () => import("./commands/list.js").then((m) => m.default),
    get: () => import("./commands/get.js").then((m) => m.default),
    delete: () => import("./commands/delete.js").then((m) => m.default),
    whoami: () => import("./commands/whoami.js").then((m) => m.default),
    config: () => import("./commands/config.js").then((m) => m.default),
  },
});

runMain(main).catch((err: unknown) => {
  if (err instanceof CliError) {
    stderr(`Error: ${err.message}`);
    process.exit(err.exitCode);
  }
  stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
