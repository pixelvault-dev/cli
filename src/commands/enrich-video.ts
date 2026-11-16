import { existsSync } from "node:fs";
import { extname } from "node:path";
import { defineCommand } from "citty";
import { ApiRequestError, apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { CliError } from "../lib/errors.js";
import {
  enrichmentState,
  videoArtifacts,
  waitForVideoEnrichment,
  type VideoArtifact,
} from "../lib/video-enrichment.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";
import {
  isRemoteVideoUrl,
  uploadVideoFile,
  type VideoData,
  type VideoEnrichmentStatus,
} from "../lib/video-upload.js";

const DEFAULT_TIMEOUT_SECONDS = 600;

function isVideoId(value: string): boolean {
  return /^vid_[A-Za-z0-9_-]+$/.test(value);
}

function timeoutMilliseconds(value: unknown): number {
  const seconds = Number(value ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError("--timeout must be a positive number of seconds.");
  }
  return Math.ceil(seconds * 1_000);
}

function startError(error: unknown, assetId: string): CliError {
  const resume = `Re-run pixelvault enrich-video ${assetId}; active or completed jobs are reused.`;
  if (!(error instanceof ApiRequestError)) {
    const message = error instanceof Error ? error.message : String(error);
    return new CliError(`${message} The uploaded asset is preserved. ${resume}`);
  }

  switch (error.code) {
    case "enrichment_limit_reached":
      return new CliError(`${error.message} Check pixelvault usage for the reset date or plan allowance.`);
    case "enrichment_source_too_large":
      return new CliError(`${error.message} The original video remains hosted as ${assetId}.`);
    case "enrichment_duration_too_long":
    case "video_duration_unavailable":
      return new CliError(`${error.message} Enrichment supports MP4 sources from 1 second through 10 minutes.`);
    case "video_metadata_unavailable":
      return new CliError(`${error.message} The original video remains hosted as ${assetId}.`);
    default:
      return new CliError(`${error.message} The uploaded asset is preserved. ${resume}`);
  }
}

function accessLabel(artifact: VideoArtifact): string {
  if (artifact.signed_url_expiry.status === "known") {
    return `private; signed URL expires ${artifact.signed_url_expiry.expires_at}`;
  }
  if (artifact.signed_url_expiry.status === "unknown") {
    return "private; signed URL expiry was not reported";
  }
  return "public; no signed-URL expiry";
}

function printReadable(artifacts: VideoArtifact[]): void {
  for (const artifact of artifacts) {
    const sheet = artifact.sheet_index === undefined ? "" : `[${artifact.sheet_index}]`;
    stderr(`${artifact.type}${sheet} (${accessLabel(artifact)}): ${artifact.url}`);
    stdout(artifact.url);
  }
}

function statusLabel(status: VideoEnrichmentStatus): string {
  if (status === "pending") return "queued";
  if (status === "processing") return "running";
  return status;
}

export default defineCommand({
  meta: {
    name: "enrich-video",
    description: "Upload or resume an MP4 transcript + storyboard job",
  },
  args: {
    source: {
      type: "positional",
      description: "Local .mp4 path or existing PixelVault video ID (vid_...)",
      required: true,
    },
    private: {
      type: "boolean",
      description: "Upload a local MP4 privately; generated artifacts inherit privacy",
      default: false,
    },
    expires: {
      type: "string",
      description: "Signed-link lifetime for a new private upload (for example 12h or 7d)",
    },
    wait: {
      type: "boolean",
      description: "Wait for a terminal enrichment state",
      default: true,
    },
    timeout: {
      type: "string",
      description: `Maximum seconds to wait locally (default: ${DEFAULT_TIMEOUT_SECONDS})`,
      default: String(DEFAULT_TIMEOUT_SECONDS),
    },
    json: {
      type: "boolean",
      description: "Output structured asset, job, state, access, and artifact data as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const source = String(args.source);
    const existingAsset = isVideoId(source);

    if (isRemoteVideoUrl(source)) {
      throw new CliError(
        "enrich-video accepts a local MP4 or an existing vid_ asset ID, not a URL. "
        + "Import it first with pixelvault upload <url> --json, then pass the returned video ID.",
      );
    }
    if (!existingAsset && extname(source).toLowerCase() !== ".mp4") {
      throw new CliError("enrich-video accepts only a local .mp4 path or an existing vid_ asset ID.");
    }
    if (!existingAsset && !existsSync(source)) {
      throw new CliError(`Video file not found: ${source}`);
    }
    if (existingAsset && (args.private || args.expires !== undefined)) {
      throw new CliError(
        "--private and --expires apply only when enrich-video uploads a local MP4. "
        + "An existing asset keeps its current visibility.",
      );
    }
    if (args.expires !== undefined && !args.private) {
      throw new CliError("--expires requires --private and controls signed-link expiry, not asset deletion.");
    }

    const timeoutMs = timeoutMilliseconds(args.timeout);
    const signExpiresIn = args.private ? parseExpires(String(args.expires ?? "7d")) : null;
    let assetId = source;

    if (!existingAsset) {
      const uploaded = await uploadVideoFile(source, apiKey, {
        private: Boolean(args.private),
        signExpiresIn,
      });
      if (args.private && uploaded.visibility !== "private") {
        throw new CliError("The API did not confirm private visibility; refusing to continue.");
      }
      assetId = uploaded.id;
      stderr(`Uploaded video asset ${assetId}. Original: ${uploaded.original_url}`);
    } else {
      stderr(`Using existing video asset ${assetId}.`);
    }
    stderr(`Resume safely with: pixelvault enrich-video ${assetId}`);

    let video: VideoData;
    try {
      ({ data: video } = await apiRequest<{ data: VideoData }>({
        method: "POST",
        path: `/v1/videos/${encodeURIComponent(assetId)}/enrich`,
        auth: apiKey,
      }));
    } catch (error) {
      throw startError(error, assetId);
    }

    const jobId = video.enrichment.job_id;
    if (jobId) {
      stderr(`Enrichment job ${jobId}: ${statusLabel(video.enrichment.status)}.`);
    } else {
      stderr(`Enrichment ${statusLabel(video.enrichment.status)}; resume with asset ID ${assetId}.`);
    }

    let timedOut = false;
    if (args.wait && (video.enrichment.status === "pending" || video.enrichment.status === "processing")) {
      const result = await waitForVideoEnrichment(video, apiKey, {
        timeoutMs,
        onStatus(status) {
          stderr(`Enrichment ${statusLabel(status)} (${video.enrichment.job_id ?? assetId}).`);
        },
      });
      video = result.video;
      timedOut = result.timedOut;
    }

    const artifacts = videoArtifacts(video);
    const output = {
      asset_id: video.id,
      ...(video.enrichment.job_id ? { job_id: video.enrichment.job_id } : {}),
      state: enrichmentState(video.enrichment.status, timedOut),
      server_status: video.enrichment.status,
      resume_command: `pixelvault enrich-video ${video.id}`,
      visibility: video.visibility,
      artifacts,
      enrichment: video.enrichment,
    };

    if (args.json) jsonOut(output);
    else printReadable(artifacts);

    if (timedOut) {
      throw new CliError(
        `Timed out after ${Number(args.timeout)}s while job ${video.enrichment.job_id ?? "(ID unavailable)"} `
        + `was ${statusLabel(video.enrichment.status)}. The server job was not cancelled. `
        + `Resume with pixelvault enrich-video ${video.id}.`,
      );
    }
    if (video.enrichment.status === "failed") {
      throw new CliError(
        `Enrichment job ${video.enrichment.job_id ?? "(ID unavailable)"} failed: `
        + (video.enrichment.error?.message ?? "The video could not be enriched."),
      );
    }
    if (video.enrichment.status === "not_requested") {
      throw new CliError(`The server did not start an enrichment job. Retry with pixelvault enrich-video ${video.id}.`);
    }
  },
});
