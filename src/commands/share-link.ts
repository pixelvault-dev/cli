import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";
import { promptPassword, readLine } from "../lib/prompt.js";

export interface ShareLink {
  id: string;
  url: string;
  asset_id: string;
  asset_kind: "image" | "video";
  status: "active" | "expired" | "revoked";
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  origin: string;
}

/** Allowed `--expires` values, in seconds (the API accepts 1 hour to 90 days). */
export const SHARE_LINK_EXPIRIES = {
  "1h": 3600,
  "1d": 86400,
  "7d": 604800,
  "30d": 2592000,
  "90d": 7776000,
} as const;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export function parseShareExpires(value: string): number {
  const seconds = SHARE_LINK_EXPIRIES[value as keyof typeof SHARE_LINK_EXPIRIES];
  if (seconds === undefined) {
    throw new CliError(
      `Invalid --expires ${value}. Use one of: ${Object.keys(SHARE_LINK_EXPIRIES).join(", ")}.`,
      1,
    );
  }
  return seconds;
}

/**
 * Resolve the link password: `--password` > `--password-stdin` (one line) > hidden
 * prompt on a TTY. A headless run without either flag is an error, never a hung prompt.
 */
async function resolvePassword(args: { password?: string; "password-stdin"?: boolean }): Promise<string> {
  const fromFlag = typeof args.password === "string" ? args.password : undefined;
  const fromStdin = Boolean(args["password-stdin"]);
  if (fromFlag !== undefined && fromStdin) {
    throw new CliError("Pass either --password or --password-stdin, not both.", 1);
  }

  let password: string;
  if (fromFlag !== undefined) {
    password = fromFlag;
  } else if (fromStdin) {
    password = await readLine(process.stdin);
    if (!password) throw new CliError("--password-stdin read no password from stdin.", 1);
  } else if (process.stdin.isTTY) {
    password = await promptPassword("Password for the link: ");
    const confirm = await promptPassword("Repeat the password: ");
    if (password !== confirm) throw new CliError("The passwords do not match.", 1);
  } else {
    throw new CliError(
      "A password is required and stdin is not a terminal, so the CLI cannot prompt. " +
        "Pipe it with --password-stdin (preferred) or pass --password <password>.",
      1,
    );
  }

  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new CliError(`The password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`, 1);
  }
  return password;
}

function explainShareLinkError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "share_links_require_paid_plan":
        throw new CliError(`${error.message} Run \`pixelvault upgrade starter\` to get a checkout URL.`, 1);
      case "share_link_management_forbidden":
        throw new CliError(
          "Share links need a secret key (pv_live_...); publishable keys are not allowed.",
          1,
        );
      case "share_link_not_found":
        throw new CliError(`${error.message} Run \`pixelvault share-link list\` to get its id.`, 1);
      case "validation_error":
        throw new CliError(`Invalid request: ${error.message}`, 1);
    }
  }
  throw error;
}

function formatLink(link: ShareLink): string {
  return [link.id, link.status, link.asset_id, `expires ${link.expires_at}`, link.url].join("  ");
}

const create = defineCommand({
  meta: { name: "create", description: "Create a password-protected link to a private image or MP4" },
  args: {
    asset: { type: "positional", description: "Private image (img_...) or MP4 (vid_...) asset id", required: true },
    password: { type: "string", description: "Link password, 8-128 characters (prefer --password-stdin)" },
    "password-stdin": { type: "boolean", description: "Read the password from the first line of stdin", default: false },
    expires: { type: "string", description: "Link lifetime: 1h, 1d, 7d (default), 30d or 90d" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const expiresIn = typeof args.expires === "string" ? parseShareExpires(args.expires) : undefined;
    const password = await resolvePassword(args);

    let response: { data: ShareLink };
    try {
      response = await apiRequest({
        method: "POST",
        path: "/v1/share-links",
        auth: requireApiKey(),
        body: {
          asset_id: args.asset,
          password,
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        },
      });
    } catch (error) {
      explainShareLinkError(error);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }
    const link = response.data;
    stdout(link.url);
    stderr(`Asset: ${link.asset_id} (${link.asset_kind})`);
    stderr(`Expires: ${link.expires_at}`);
    stderr(`Status: ${link.status}`);
    stderr("Send the password to the recipient separately; PixelVault never shows it again.");
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List share links, newest first" },
  args: {
    asset: { type: "string", description: "Only links for this asset id" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const query = typeof args.asset === "string" && args.asset
      ? `?${new URLSearchParams({ asset_id: args.asset })}`
      : "";
    let response: { data: ShareLink[] };
    try {
      response = await apiRequest({ path: `/v1/share-links${query}`, auth: requireApiKey() });
    } catch (error) {
      explainShareLinkError(error);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }
    if (response.data.length === 0) {
      stderr("No share links.");
      return;
    }
    for (const link of response.data) stdout(formatLink(link));
  },
});

const revoke = defineCommand({
  meta: { name: "revoke", description: "Turn off a share link (idempotent)" },
  args: {
    id: { type: "positional", description: "Share-link id (shr_...)", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: ShareLink };
    try {
      response = await apiRequest({
        method: "DELETE",
        path: `/v1/share-links/${encodeURIComponent(args.id)}`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainShareLinkError(error);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }
    stdout(formatLink(response.data));
    stderr(`Revoked ${response.data.id}; the link no longer opens.`);
  },
});

export default defineCommand({
  meta: { name: "share-link", description: "Manage password-protected share links (Starter and Pro)" },
  subCommands: { create, list, revoke },
});
