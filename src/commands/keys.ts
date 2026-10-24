import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

export interface KeyInfo {
  id: string;
  type: "secret" | "publishable";
  environment: string;
  label: string | null;
  key_prefix: string;
  allowed_origins: string[] | null;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

/** Turn known key-management API errors into actionable messages. */
export function explainKeyError(err: unknown): never {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case "key_limit_reached":
        throw new CliError(
          "Key limit reached (25 per project). Revoke an unused key with `pixelvault keys revoke <id>` first.",
          1
        );
      case "rate_limit_exceeded": {
        const wait = err.retryAfter
          ? ` Retry after ${err.retryAfter} seconds.`
          : "";
        throw new CliError(
          `Rate limit exceeded (20 key changes per hour per project).${wait}`,
          1
        );
      }
      case "cannot_revoke_current_key":
        throw new CliError(
          "Cannot revoke the key you are authenticating with. Create a new key, switch to it (PIXELVAULT_API_KEY), then revoke the old one with the new key.",
          1
        );
      case "not_found":
        throw new CliError(
          "Key not found. Only secret keys can be revoked; check the id with `pixelvault keys list`.",
          1
        );
      case "validation_error":
        throw new CliError(`Invalid request: ${err.message}`, 1);
      case "forbidden":
        throw new CliError(
          "This endpoint needs a secret key (pv_live_...); publishable keys are not allowed.",
          1
        );
    }
    if (err.status === 403) {
      throw new CliError(
        "This endpoint needs a secret key (pv_live_...); publishable keys are not allowed.",
        1
      );
    }
  }
  throw err;
}

const list = defineCommand({
  meta: { name: "list", description: "List the project's API keys" },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    let res: { data: KeyInfo[] };
    try {
      res = await apiRequest<{ data: KeyInfo[] }>({
        path: "/v1/keys",
        auth: apiKey,
      });
    } catch (err) {
      explainKeyError(err);
    }

    if (args.json) {
      jsonOut(res.data);
      return;
    }
    for (const k of res.data) {
      stdout(
        [
          k.id,
          k.type,
          k.environment,
          `${k.key_prefix}...`,
          k.label ?? "-",
          `created ${k.created_at}`,
          `last used ${k.last_used_at ?? "never"}`,
          k.current ? "(current)" : "",
        ]
          .filter(Boolean)
          .join("  ")
      );
    }
  },
});

const create = defineCommand({
  meta: {
    name: "create",
    description: "Create a new secret API key (the raw key is printed once)",
  },
  args: {
    label: { type: "string", description: "Label for the key (max 60 chars)" },
    env: {
      type: "string",
      description: "Environment: live or test (default: live)",
    },
    json: {
      type: "boolean",
      description: "Output the full data object as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    if (args.env && args.env !== "live" && args.env !== "test") {
      throw new CliError("--env must be 'live' or 'test'.", 1);
    }
    if (args.label && args.label.length > 60) {
      throw new CliError("--label must be 60 characters or fewer.", 1);
    }

    const body: { label?: string; environment?: string } = {};
    if (args.label) body.label = args.label;
    if (args.env) body.environment = args.env;

    let res: { data: { id: string; api_key: string } };
    try {
      res = await apiRequest<{ data: { id: string; api_key: string } }>({
        method: "POST",
        path: "/v1/keys",
        auth: apiKey,
        body,
      });
    } catch (err) {
      explainKeyError(err);
    }

    stderr(
      "This key is shown ONCE. Store it now (secret manager / env var); never commit it or paste it into logs."
    );
    if (args.json) {
      jsonOut(res.data);
    } else {
      stdout(res.data.api_key);
    }
  },
});

const revoke = defineCommand({
  meta: {
    name: "revoke",
    description: "Revoke a secret API key by id (not the one in use)",
  },
  args: {
    id: {
      type: "positional",
      description: "Key id (see `pixelvault keys list`)",
      required: true,
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    let res: { data: { deleted: boolean } };
    try {
      res = await apiRequest<{ data: { deleted: boolean } }>({
        method: "DELETE",
        path: `/v1/keys/${encodeURIComponent(args.id)}`,
        auth: apiKey,
      });
    } catch (err) {
      explainKeyError(err);
    }

    if (args.json) {
      jsonOut(res.data);
    } else {
      stderr(`Revoked key ${args.id}.`);
    }
  },
});

export default defineCommand({
  meta: {
    name: "keys",
    description: "Manage API keys (list, create, revoke)",
  },
  subCommands: { list, create, revoke },
});
