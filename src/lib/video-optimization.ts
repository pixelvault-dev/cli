import { setTimeout as delay } from "node:timers/promises";
import { apiRequest } from "./client.js";
import type { VideoData } from "./video-upload.js";

const POLL_INTERVAL_MS = 2_000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1_000;

export async function getVideo(id: string, apiKey: string): Promise<VideoData> {
  const response = await apiRequest<{ data: VideoData }>({
    path: `/v1/videos/${encodeURIComponent(id)}`,
    auth: apiKey,
  });
  return response.data;
}

export async function waitForVideoOptimization(
  initial: VideoData,
  apiKey: string,
): Promise<VideoData> {
  let video = initial;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (
    video.social_optimization.status === "pending"
    || video.social_optimization.status === "processing"
  ) {
    if (Date.now() >= deadline) return video;
    await delay(POLL_INTERVAL_MS);
    video = await getVideo(video.id, apiKey);
  }
  return video;
}
