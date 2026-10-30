import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { stdout, jsonOut, formatBytes } from "../lib/output.js";

export interface UsageData {
  plan: string;
  period: string;
  resets_at: string;
  usage: { storage_bytes: number; uploads: number };
  limits: {
    storage_bytes: number | null;
    uploads_per_month: number | null;
    bandwidth_bytes_per_month: number | null;
  };
  remaining: { storage_bytes: number | null; uploads: number | null };
  /** AI image-generation credits (`pixelvault generate`) for the month. */
  generation?: {
    credits_used: number;
    credits_limit: number;
    credits_remaining: number;
  };
}

const bytes = (n: number | null | undefined) =>
  n == null ? "unlimited" : formatBytes(n);
const count = (n: number | null | undefined) =>
  n == null ? "unlimited" : String(n);

export function renderUsage(d: UsageData): string[] {
  return [
    `Plan:      ${d.plan}`,
    `Period:    ${d.period} (resets ${d.resets_at})`,
    `Storage:   ${formatBytes(d.usage.storage_bytes)} used / ${bytes(d.limits.storage_bytes)} limit / ${bytes(d.remaining.storage_bytes)} remaining`,
    `Uploads:   ${d.usage.uploads} used / ${count(d.limits.uploads_per_month)} limit / ${count(d.remaining.uploads)} remaining`,
    `Bandwidth: ${bytes(d.limits.bandwidth_bytes_per_month)} limit per month (usage not reported)`,
    ...(d.generation
      ? [
          `AI images: ${d.generation.credits_used} credits used / ${d.generation.credits_limit} limit / ${d.generation.credits_remaining} remaining`,
        ]
      : []),
  ];
}

export default defineCommand({
  meta: {
    name: "usage",
    description: "Show plan, quota usage and limits (secret key required)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output the usage object as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const res = await apiRequest<{ data: UsageData }>({
      path: "/v1/usage",
      auth: apiKey,
    });

    if (args.json) {
      jsonOut(res.data);
    } else {
      for (const line of renderUsage(res.data)) stdout(line);
    }
  },
});
