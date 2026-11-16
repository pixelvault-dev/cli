import { setTimeout as delay } from "node:timers/promises";
import { getVideo } from "./video-optimization.js";
import type { VideoData } from "./video-upload.js";

const POLL_INTERVAL_MS = 2_000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1_000;

export async function waitForVideoEnrichment(
  initial: VideoData,
  apiKey: string,
): Promise<VideoData> {
  let video = initial;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (video.enrichment.status === "pending" || video.enrichment.status === "processing") {
    if (Date.now() >= deadline) return video;
    await delay(POLL_INTERVAL_MS);
    video = await getVideo(video.id, apiKey);
  }
  return video;
}
