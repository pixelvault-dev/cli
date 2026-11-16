import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { apiRequest } from "./client.js";
import { CliError } from "./errors.js";

const DIRECT_MAX_BYTES = 100_000_000;

export interface VideoSocialOptimization {
  preset: "social";
  status: "not_requested" | "pending" | "processing" | "complete" | "failed" | "not_needed";
  source?: "original" | "derived";
  url?: string;
  size?: number | null;
  error?: { code: string; message: string };
}

export interface VideoEnrichment {
  status: "not_requested" | "pending" | "processing" | "complete" | "failed";
  requested_at?: string;
  completed_at?: string | null;
  transcript?: {
    status: "complete" | "skipped";
    text_url?: string;
    vtt_url?: string;
    segments_url?: string;
    language?: string | null;
    languages?: string[];
    model?: string | null;
    segment_count?: number;
    reason?: "no_audio";
  };
  storyboard?: {
    status: "complete";
    index_url: string;
    frame_count: number;
    sheets: {
      url: string;
      start_seconds: number;
      end_seconds: number;
      frame_count: number;
    }[];
  } | null;
  error?: { code: string; message: string };
}

export interface VideoData {
  id: string;
  kind: "video";
  url: string;
  original_url: string;
  social_ready_url?: string;
  poster_url?: string;
  visibility: "public" | "private";
  mime_type: "video/mp4";
  size: number;
  filename: string;
  created_at: string;
  signed_expires?: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: boolean | null;
  fast_start: boolean | null;
  social_compatible: boolean | null;
  compatibility_warnings: { code: string; message: string }[];
  social_optimization: VideoSocialOptimization;
  enrichment: VideoEnrichment;
}

interface UploadSession {
  upload_id: string;
  part_size: number;
}

export interface VideoUploadOptions {
  private?: boolean;
  signExpiresIn?: number | null;
  socialReady?: boolean;
}

function fileBody(filePath: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const stream = createReadStream(filePath, {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  });
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

export function isRemoteVideoUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Ask PixelVault to import an MP4 directly from a public URL. */
export async function uploadVideoUrl(
  sourceUrl: string,
  apiKey: string,
  options: VideoUploadOptions = {},
): Promise<VideoData> {
  const { data } = await apiRequest<{ data: VideoData }>({
    method: "POST",
    path: "/v1/videos",
    auth: apiKey,
    body: {
      url: sourceUrl,
      visibility: options.private ? "private" : "public",
      ...(options.signExpiresIn ? { sign_expires_in: options.signExpiresIn } : {}),
      ...(options.socialReady ? { social_ready: true } : {}),
    },
  });
  return data;
}

/** Upload one MP4 without buffering it in the CLI process. */
export async function uploadVideoFile(
  filePath: string,
  apiKey: string,
  options: VideoUploadOptions = {},
): Promise<VideoData> {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new CliError("Video must be a non-empty file.", 1);
  }
  if (options.socialReady && stat.size > DIRECT_MAX_BYTES) {
    throw new CliError("Social-ready upload supports source MP4s up to 100 MB.", 1);
  }


  const filename = basename(filePath);
  if (stat.size <= DIRECT_MAX_BYTES) {
    const { data } = await apiRequest<{ data: VideoData }>({
      method: "POST",
      path: "/v1/videos",
      auth: apiKey,
      rawBody: fileBody(filePath),
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(stat.size),
        "X-PixelVault-Filename": encodeURIComponent(filename),
        "X-PixelVault-Visibility": options.private ? "private" : "public",
        ...(options.socialReady ? { "X-PixelVault-Social-Ready": "true" } : {}),
        ...(options.signExpiresIn
          ? { "X-PixelVault-Sign-Expires-In": String(options.signExpiresIn) }
          : {}),
      },
    });
    return data;
  }

  let uploadId: string | undefined;
  try {
    const session = await apiRequest<{ data: UploadSession }>({
      method: "POST",
      path: "/v1/videos/uploads",
      auth: apiKey,
      body: {
        filename,
        size: stat.size,
        visibility: options.private ? "private" : "public",
      },
    });
    uploadId = session.data.upload_id;
    const partSize = session.data.part_size;
    if (!Number.isSafeInteger(partSize) || partSize <= 0) {
      throw new CliError("The API returned an invalid video part size.", 1);
    }

    let partNumber = 1;
    for (let start = 0; start < stat.size; start += partSize, partNumber += 1) {
      const length = Math.min(partSize, stat.size - start);
      await apiRequest({
        method: "PUT",
        path: `/v1/videos/uploads/${uploadId}/parts/${partNumber}`,
        auth: apiKey,
        rawBody: fileBody(filePath, start, start + length - 1),
        headers: { "Content-Length": String(length) },
      });
    }

    const { data } = await apiRequest<{ data: VideoData }>({
      method: "POST",
      path: `/v1/videos/uploads/${uploadId}/complete`,
      auth: apiKey,
      ...((options.signExpiresIn || options.socialReady)
        ? {
            headers: {
              ...(options.signExpiresIn
                ? { "X-PixelVault-Sign-Expires-In": String(options.signExpiresIn) }
                : {}),
              ...(options.socialReady ? { "X-PixelVault-Social-Ready": "true" } : {}),
            },
          }
        : {}),
    });
    return data;
  } catch (error) {
    if (uploadId) {
      await apiRequest({
        method: "DELETE",
        path: `/v1/videos/uploads/${uploadId}`,
        auth: apiKey,
      }).catch(() => undefined);
    }
    throw error;
  }
}
