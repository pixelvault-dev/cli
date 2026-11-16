import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";

const EVENT_ALIASES = {
  completed: "video.optimization.completed",
  failed: "video.optimization.failed",
  "video.optimization.completed": "video.optimization.completed",
  "video.optimization.failed": "video.optimization.failed",
} as const;
type WebhookEvent = (typeof EVENT_ALIASES)[keyof typeof EVENT_ALIASES];

interface WebhookInfo {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEvent[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

interface DeliveryInfo {
  id: string;
  event_id: string;
  event: WebhookEvent;
  status: string;
  attempts: number;
  response_status: number | null;
  error: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

function parseEvents(value: string | undefined): WebhookEvent[] | undefined {
  if (!value) return undefined;
  const events: WebhookEvent[] = [];
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const event = EVENT_ALIASES[part as keyof typeof EVENT_ALIASES];
    if (!event) {
      throw new CliError(
        "--events accepts completed, failed, video.optimization.completed, or video.optimization.failed.",
        1,
      );
    }
    if (!events.includes(event)) events.push(event);
  }
  if (events.length === 0) throw new CliError("--events must include at least one event.", 1);
  return events;
}

function explainWebhookError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    if (error.code === "webhooks_require_paid_plan") {
      throw new CliError("Webhooks require a Starter or Pro plan. Run `pixelvault upgrade starter` to get a checkout URL.", 1);
    }
    if (error.code === "webhook_limit_reached") {
      throw new CliError(`${error.message} List endpoints with \`pixelvault webhooks list\`.`, 1);
    }
    if (error.code === "webhook_url_exists") {
      throw new CliError("That webhook URL is already configured. Update the existing endpoint instead.", 1);
    }
    if (error.code === "webhook_management_forbidden") {
      throw new CliError("Webhook management requires a secret PixelVault API key (pv_live_ or pv_test_).", 1);
    }
    if (error.code === "not_found") {
      throw new CliError("Webhook not found. Run `pixelvault webhooks list` to get its id.", 1);
    }
  }
  throw error;
}

const list = defineCommand({
  meta: { name: "list", description: "List webhook endpoints" },
  args: { json: { type: "boolean", description: "Output as JSON", default: false } },
  async run({ args }) {
    let response: { data: { webhooks: WebhookInfo[]; limit: number; remaining: number } };
    try {
      response = await apiRequest({ path: "/v1/webhooks", auth: requireApiKey() });
    } catch (error) {
      explainWebhookError(error);
    }
    if (args.json) {
      jsonOut(response.data);
      return;
    }
    stderr(`${response.data.webhooks.length}/${response.data.limit} endpoints configured.`);
    for (const webhook of response.data.webhooks) {
      stdout([
        webhook.id,
        webhook.active ? "active" : "paused",
        webhook.url,
        webhook.description ?? "-",
        webhook.events.join(","),
      ].join("  "));
    }
  },
});

const create = defineCommand({
  meta: { name: "create", description: "Create a signed webhook endpoint" },
  args: {
    url: { type: "positional", description: "Public HTTPS destination URL", required: true },
    description: { type: "string", description: "Endpoint description (max 100 chars)" },
    events: { type: "string", description: "Comma-separated: completed,failed (default: both)" },
    json: { type: "boolean", description: "Output the complete endpoint as JSON", default: false },
  },
  async run({ args }) {
    const events = parseEvents(args.events);
    if (args.description && args.description.length > 100) {
      throw new CliError("--description must be 100 characters or fewer.", 1);
    }
    let response: { data: WebhookInfo & { signing_secret: string } };
    try {
      response = await apiRequest({
        method: "POST",
        path: "/v1/webhooks",
        auth: requireApiKey(),
        body: {
          url: args.url,
          ...(args.description ? { description: args.description } : {}),
          ...(events ? { events } : {}),
        },
      });
    } catch (error) {
      explainWebhookError(error);
    }
    stderr("This signing secret is shown ONCE. Store it in the receiving service's secret manager.");
    if (args.json) jsonOut(response.data);
    else stdout(response.data.signing_secret);
  },
});

const update = defineCommand({
  meta: { name: "update", description: "Update a webhook URL, events, description, or state" },
  args: {
    id: { type: "positional", description: "Webhook id", required: true },
    url: { type: "string", description: "Replacement public HTTPS URL" },
    description: { type: "string", description: "Replacement description (empty string clears it)" },
    events: { type: "string", description: "Comma-separated: completed,failed" },
    pause: { type: "boolean", description: "Pause delivery", default: false },
    resume: { type: "boolean", description: "Resume delivery", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    if (args.pause && args.resume) throw new CliError("Use either --pause or --resume, not both.", 1);
    if (args.description !== undefined && args.description.length > 100) {
      throw new CliError("--description must be 100 characters or fewer.", 1);
    }
    const events = parseEvents(args.events);
    const body: Record<string, unknown> = {};
    if (args.url) body.url = args.url;
    if (args.description !== undefined) body.description = args.description || null;
    if (events) body.events = events;
    if (args.pause) body.active = false;
    if (args.resume) body.active = true;
    if (Object.keys(body).length === 0) {
      throw new CliError("Provide --url, --description, --events, --pause, or --resume.", 1);
    }
    let response: { data: WebhookInfo };
    try {
      response = await apiRequest({
        method: "PATCH",
        path: `/v1/webhooks/${encodeURIComponent(args.id)}`,
        auth: requireApiKey(),
        body,
      });
    } catch (error) {
      explainWebhookError(error);
    }
    if (args.json) jsonOut(response.data);
    else stderr(`Updated webhook ${response.data.id}.`);
  },
});

const remove = defineCommand({
  meta: { name: "delete", description: "Delete a webhook and its delivery log" },
  args: {
    id: { type: "positional", description: "Webhook id", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: { deleted: boolean } };
    try {
      response = await apiRequest({
        method: "DELETE",
        path: `/v1/webhooks/${encodeURIComponent(args.id)}`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainWebhookError(error);
    }
    if (args.json) jsonOut(response.data);
    else stderr(`Deleted webhook ${args.id}.`);
  },
});

const rotateSecret = defineCommand({
  meta: { name: "rotate-secret", description: "Rotate and print a webhook signing secret once" },
  args: {
    id: { type: "positional", description: "Webhook id", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: { id: string; signing_secret: string } };
    try {
      response = await apiRequest({
        method: "POST",
        path: `/v1/webhooks/${encodeURIComponent(args.id)}/rotate-secret`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainWebhookError(error);
    }
    stderr("The previous secret is invalid now. Store this replacement before sending another optimization job.");
    if (args.json) jsonOut(response.data);
    else stdout(response.data.signing_secret);
  },
});

const deliveries = defineCommand({
  meta: { name: "deliveries", description: "Inspect recent webhook deliveries" },
  args: {
    id: { type: "positional", description: "Webhook id", required: true },
    limit: { type: "string", description: "Number of deliveries (1-100, default 50)" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new CliError("--limit must be an integer from 1 to 100.", 1);
    }
    let response: { data: DeliveryInfo[] };
    try {
      response = await apiRequest({
        path: `/v1/webhooks/${encodeURIComponent(args.id)}/deliveries?limit=${limit}`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainWebhookError(error);
    }
    if (args.json) {
      jsonOut(response.data);
      return;
    }
    for (const delivery of response.data) {
      stdout([
        delivery.id,
        delivery.status,
        delivery.event,
        `${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}`,
        delivery.response_status ? `HTTP ${delivery.response_status}` : "-",
        delivery.created_at,
        delivery.error ?? "",
      ].filter(Boolean).join("  "));
    }
  },
});

export default defineCommand({
  meta: { name: "webhooks", description: "Manage signed media-job webhooks" },
  subCommands: { list, create, update, delete: remove, "rotate-secret": rotateSecret, deliveries },
});
