import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { apiRequest } from "./client.js";
import { CliError } from "./errors.js";

const DIRECT_MAX_BYTES = 100_000_000;

export interface VideoData {
  id: string;
  kind: "video";
  url: string;
  mime_type: "video/mp4";
  size: number;
  filename: string;
  created_at: string;
}

interface UploadSession {
  upload_id: string;
  part_size: number;
}

function fileBody(filePath: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const stream = createReadStream(filePath, {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
  });
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}

/** Upload one MP4 without buffering it in the CLI process. */
export async function uploadVideoFile(filePath: string, apiKey: string): Promise<VideoData> {
  const stat = statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new CliError("Video must be a non-empty file.", 1);
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
      body: { filename, size: stat.size },
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
