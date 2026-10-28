import { defineCommand } from "citty";
import { runCli } from "./lib/run.js";
import { VERSION } from "./lib/client.js";

const main = defineCommand({
  meta: {
    name: "pixelvault",
    version: VERSION,
    description: "CLI for PixelVault — agent-first image hosting",
  },
  subCommands: {
    register: () => import("./commands/register.js").then((m) => m.default),
    login: () => import("./commands/login.js").then((m) => m.default),
    upload: () => import("./commands/upload.js").then((m) => m.default),
    list: () => import("./commands/list.js").then((m) => m.default),
    get: () => import("./commands/get.js").then((m) => m.default),
    delete: () => import("./commands/delete.js").then((m) => m.default),
    export: () => import("./commands/export.js").then((m) => m.default),
    usage: () => import("./commands/usage.js").then((m) => m.default),
    keys: () => import("./commands/keys.js").then((m) => m.default),
    upgrade: () => import("./commands/upgrade.js").then((m) => m.default),
    billing: () => import("./commands/billing.js").then((m) => m.default),
    whoami: () => import("./commands/whoami.js").then((m) => m.default),
    config: () => import("./commands/config.js").then((m) => m.default),
  },
});

void runCli(main);
