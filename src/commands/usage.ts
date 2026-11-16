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
  bandwidth?: {
    status: "available" | "unavailable" | "unlimited";
    used: number | null;
    remaining: number | null;
    limit: number | null;
    unit: "bytes";
    accounting_period: string;
    resets_at: string;
    measured_at: string | null;
    freshness: "near_real_time" | "delayed" | "unavailable" | "not_applicable";
  };
  /** AI image-generation credits (`pixelvault generate`) for the month. */
  generation?: {
    credits_used: number;
    credits_limit: number;
    credits_remaining: number;
  };
  editing?: {
    credits_used: number;
    credits_limit: number;
    credits_remaining: number;
  };
  video_optimization?: {
    seconds_used: number;
    seconds_limit: number;
    seconds_remaining: number;
  };
  video_enrichment?: {
    seconds_used: number;
    seconds_limit: number;
    seconds_remaining: number;
  };
}

const bytes = (n: number | null | undefined) =>
  n == null ? "unlimited" : formatBytes(n);
const count = (n: number | null | undefined) =>
  n == null ? "unlimited" : String(n);

function renderBandwidth(d: UsageData): string {
  const bandwidth = d.bandwidth;
  if (!bandwidth) {
    return `${bytes(d.limits.bandwidth_bytes_per_month)} limit per month (usage unavailable)`;
  }
  if (bandwidth.status === "unavailable") {
    return `${bytes(bandwidth.limit)} limit for ${bandwidth.accounting_period} (used and remaining unknown; accounting unavailable)`;
  }
  if (bandwidth.status === "unlimited") {
    return `${bandwidth.used == null ? "unknown" : formatBytes(bandwidth.used)} used / unlimited`;
  }
  const used = bandwidth.used == null ? "unknown" : formatBytes(bandwidth.used);
  const limit = bandwidth.limit == null ? "unknown" : formatBytes(bandwidth.limit);
  const left = bandwidth.remaining == null ? "unknown" : formatBytes(bandwidth.remaining);
  return `${used} used / ${limit} limit / ${left} remaining (${bandwidth.freshness})`;
}

export function renderUsage(d: UsageData): string[] {
  return [
    `Plan:      ${d.plan}`,
    `Period:    ${d.period} (resets ${d.resets_at})`,
    `Storage:   ${formatBytes(d.usage.storage_bytes)} used / ${bytes(d.limits.storage_bytes)} limit / ${bytes(d.remaining.storage_bytes)} remaining`,
    `Uploads:   ${d.usage.uploads} used / ${count(d.limits.uploads_per_month)} limit / ${count(d.remaining.uploads)} remaining`,
    `Bandwidth: ${renderBandwidth(d)}`,
    ...(d.generation
      ? [
          `AI images: ${d.generation.credits_used} credits used / ${d.generation.credits_limit} limit / ${d.generation.credits_remaining} remaining`,
        ]
      : []),
    ...(d.editing
      ? [
          `AI edits:  ${d.editing.credits_used} credits used / ${d.editing.credits_limit} limit / ${d.editing.credits_remaining} remaining`,
        ]
      : []),
    ...(d.video_optimization
      ? [
          `Social-ready video: ${d.video_optimization.seconds_used}s used / ${d.video_optimization.seconds_limit}s limit / ${d.video_optimization.seconds_remaining}s remaining`,
        ]
      : []),
    ...(d.video_enrichment
      ? [
          `Video enrichment: ${d.video_enrichment.seconds_used}s used / ${d.video_enrichment.seconds_limit}s limit / ${d.video_enrichment.seconds_remaining}s remaining`,
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
