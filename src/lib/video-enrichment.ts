import { setTimeout as delay } from "node:timers/promises";
import type { VideoData, VideoEnrichmentStatus } from "./video-upload.js";
import { getVideo } from "./video-optimization.js";

const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;

export type EnrichmentState = "not_started" | "queued" | "running" | "complete" | "failed" | "timeout";

export type VideoArtifactType =
  | "original_video"
  | "transcript_text"
  | "transcript_vtt"
  | "transcript_segments"
  | "storyboard_index"
  | "storyboard_sheet";

export type SignedUrlExpiry =
  | { status: "not_applicable" }
  | { status: "known"; expires_at: string }
  | { status: "unknown" };

export interface VideoArtifact {
  type: VideoArtifactType;
  url: string;
  visibility: "public" | "private";
  signed_url_expiry: SignedUrlExpiry;
  sheet_index?: number;
}

export interface WaitForVideoEnrichmentResult {
  video: VideoData;
  timedOut: boolean;
}

interface WaitForVideoEnrichmentOptions {
  timeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  fetchVideo?: (id: string, apiKey: string) => Promise<VideoData>;
  onStatus?: (status: VideoEnrichmentStatus) => void;
}

function isActive(status: VideoEnrichmentStatus): boolean {
  return status === "pending" || status === "processing";
}

export function enrichmentState(
  status: VideoEnrichmentStatus,
  timedOut = false,
): EnrichmentState {
  if (timedOut) return "timeout";
  if (status === "pending") return "queued";
  if (status === "processing") return "running";
  if (status === "not_requested") return "not_started";
  return status;
}

export async function waitForVideoEnrichment(
  initial: VideoData,
  apiKey: string,
  options: WaitForVideoEnrichmentOptions,
): Promise<WaitForVideoEnrichmentResult> {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const fetchVideo = options.fetchVideo ?? getVideo;
  const deadline = now() + options.timeoutMs;
  let pollDelayMs = INITIAL_POLL_DELAY_MS;
  let video = initial;
  let previousStatus = video.enrichment.status;

  while (isActive(video.enrichment.status)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { video, timedOut: true };

    await sleep(Math.min(pollDelayMs, remainingMs));
    video = await fetchVideo(video.id, apiKey);
    if (video.enrichment.status !== previousStatus) {
      previousStatus = video.enrichment.status;
      options.onStatus?.(previousStatus);
    }
    pollDelayMs = Math.min(Math.ceil(pollDelayMs * 1.5), MAX_POLL_DELAY_MS);
  }

  return { video, timedOut: false };
}

function signedUrlExpiry(video: VideoData): SignedUrlExpiry {
  if (video.visibility === "public") return { status: "not_applicable" };
  if (video.signed_expires === undefined || !Number.isFinite(video.signed_expires)) {
    return { status: "unknown" };
  }
  return {
    status: "known",
    expires_at: new Date(video.signed_expires * 1_000).toISOString(),
  };
}

export function videoArtifacts(video: VideoData): VideoArtifact[] {
  const artifacts: VideoArtifact[] = [];
  const signed_url_expiry = signedUrlExpiry(video);
  const common = { visibility: video.visibility, signed_url_expiry };
  artifacts.push({ type: "original_video", url: video.original_url, ...common });

  const transcript = video.enrichment.transcript;
  if (transcript?.status === "complete") {
    if (transcript.text_url) {
      artifacts.push({ type: "transcript_text", url: transcript.text_url, ...common });
    }
    if (transcript.vtt_url) {
      artifacts.push({ type: "transcript_vtt", url: transcript.vtt_url, ...common });
    }
    if (transcript.segments_url) {
      artifacts.push({ type: "transcript_segments", url: transcript.segments_url, ...common });
    }
  }

  const storyboard = video.enrichment.storyboard;
  if (storyboard?.index_url) {
    artifacts.push({ type: "storyboard_index", url: storyboard.index_url, ...common });
  }
  for (const [sheet_index, sheet] of (storyboard?.sheets ?? []).entries()) {
    if (sheet.url) {
      artifacts.push({
        type: "storyboard_sheet",
        url: sheet.url,
        sheet_index,
        ...common,
      });
    }
  }

  return artifacts;
}
