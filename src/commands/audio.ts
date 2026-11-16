import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { CliError } from "../lib/errors.js";
import { parseMetadataFlags } from "../lib/metadata.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";

const AUDIO_PATH = "/v1/audio";
const AUDIO_MAX_BYTES = 25_000_000;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

interface AudioAsset {
  id: string;
  kind: "audio";
  url: string;
  original_url: string;
  visibility: "public" | "private";
  mime_type: string;
  size: number;
  container: "mp3" | "wav" | "m4a" | "ogg";
  codec: "mp3" | "pcm" | "pcm_float" | "aac" | "opus" | "vorbis";
  duration_seconds: number;
  sample_rate: number;
  channels: number;
  filename: string;
  folder: string | null;
  collection_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  expires_at?: string;
  signed_expires?: number;
  replayed?: true;
}

interface DataResponse<T> {
  data: T;
}

function isRemoteSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function lifecycleArgs(args: Record<string, unknown>): {
  visibility: "public" | "private";
  signExpiresIn?: number;
  expiresIn?: number;
  folder?: string;
  collectionId?: string;
  metadata: Record<string, unknown> | null;
  idempotencyKey?: string;
} {
  const privateAsset = args.private === true;
  const signExpiresIn = args["link-expires"] === undefined
    ? undefined
    : parseExpires(String(args["link-expires"]), "--link-expires");
  if (signExpiresIn !== undefined && !privateAsset) {
    throw new CliError("--link-expires only applies with --private.");
  }
  const expiresIn = args["delete-after"] === undefined
    ? undefined
    : parseExpires(String(args["delete-after"]), "--delete-after");
  return {
    visibility: privateAsset ? "private" : "public",
    signExpiresIn,
    expiresIn,
    folder: typeof args.folder === "string" && args.folder ? args.folder : undefined,
    collectionId: typeof args.collection === "string" && args.collection ? args.collection : undefined,
    metadata: parseMetadataFlags({ meta: args.meta, metadata: args.metadata }),
    idempotencyKey: typeof args["idempotency-key"] === "string" && args["idempotency-key"]
      ? args["idempotency-key"]
      : undefined,
  };
}

function explainAudioError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    if (error.code === "audio_policy_pending") {
      throw new CliError("Audio hosting is temporarily unavailable because the deployment is missing its approved 25,000,000-byte ceiling.");
    }
    if (error.code === "file_too_large") {
      throw new CliError(`${error.message} The server's audio policy is authoritative; the CLI does not invent a plan limit.`);
    }
    if (error.code === "invalid_audio" || error.code === "unsupported_audio_codec" || error.code === "unsupported_media_type") {
      throw new CliError(`${error.message} Supported original containers/codecs: MP3, PCM/float WAV, AAC M4A, and Opus/Vorbis OGG.`);
    }
    if (error.code === "idempotency_key_reuse") {
      throw new CliError(`${error.message} Reuse a key only for an identical source and lifecycle settings.`);
    }
  }
  throw error;
}

const lifecycleOptions = {
  private: { type: "boolean" as const, description: "Store privately and return a signed URL", default: false },
  "link-expires": { type: "string" as const, description: "Private link lifetime, e.g. 1h or 7d (requires --private)" },
  "delete-after": { type: "string" as const, description: "Delete the asset after this TTL, e.g. 1h or 7d; omit to keep it" },
  folder: { type: "string" as const, description: "Folder name" },
  collection: { type: "string" as const, description: "Existing collection ID with matching visibility" },
  meta: { type: "string" as const, description: "Custom metadata key=value (repeatable)" },
  metadata: { type: "string" as const, description: "Custom metadata JSON object" },
  "idempotency-key": { type: "string" as const, description: "Replay-safe key for this exact upload/import" },
  json: { type: "boolean" as const, description: "Output complete JSON", default: false },
};

const upload = defineCommand({
  meta: { name: "upload", description: "Upload local audio or securely import a public audio URL" },
  args: {
    source: { type: "positional", description: "MP3, WAV, M4A, or OGG path or public HTTP(S) URL", required: true },
    ...lifecycleOptions,
  },
  async run({ args }) {
    const auth = requireApiKey();
    const options = lifecycleArgs(args as Record<string, unknown>);
    let response: DataResponse<AudioAsset>;
    try {
      if (isRemoteSource(args.source)) {
        response = await apiRequest({
          method: "POST",
          path: AUDIO_PATH,
          auth,
          headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
          body: {
            url: args.source,
            visibility: options.visibility,
            ...(options.signExpiresIn !== undefined ? { sign_expires_in: options.signExpiresIn } : {}),
            ...(options.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
            ...(options.folder ? { folder: options.folder } : {}),
            ...(options.collectionId ? { collection_id: options.collectionId } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
        });
      } else {
        const info = await stat(args.source).catch((error: unknown) => {
          throw new CliError(`Cannot read audio path ${args.source}: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (!info.isFile()) throw new CliError(`Audio path is not a regular file: ${args.source}`);
        if (info.size > AUDIO_MAX_BYTES) {
          throw new CliError(
            `Local audio is ${info.size.toLocaleString("en-US")} bytes. Audio originals are limited to the approved global maximum of 25,000,000 bytes; this is not a plan allowance.`,
          );
        }
        const filename = basename(args.source);
        const contentType = CONTENT_TYPES[extname(filename).toLowerCase()];
        if (!contentType) throw new CliError("Audio filename must end in .mp3, .wav, .m4a, or .ogg.");
        const bytes = await readFile(args.source);
        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Content-Length": String(bytes.byteLength),
          "X-PixelVault-Filename": encodeURIComponent(filename),
          "X-PixelVault-Visibility": options.visibility,
        };
        if (options.signExpiresIn !== undefined) headers["X-PixelVault-Sign-Expires-In"] = String(options.signExpiresIn);
        if (options.expiresIn !== undefined) headers["X-PixelVault-Expires-In"] = String(options.expiresIn);
        if (options.folder) headers["X-PixelVault-Folder"] = options.folder;
        if (options.collectionId) headers["X-PixelVault-Collection-Id"] = options.collectionId;
        if (options.metadata) headers["X-PixelVault-Metadata"] = JSON.stringify(options.metadata);
        if (options.idempotencyKey) {
          headers["Idempotency-Key"] = options.idempotencyKey;
          headers["X-PixelVault-Content-SHA256"] = createHash("sha256").update(bytes).digest("hex");
        }
        response = await apiRequest({ method: "POST", path: AUDIO_PATH, auth, headers, rawBody: bytes });
      }
    } catch (error) {
      explainAudioError(error);
    }

    if (args.json) jsonOut(response.data);
    else {
      stdout(response.data.url);
      stderr(`${response.data.replayed ? "Replayed" : "Hosted"} ${response.data.id}: ${response.data.codec}, ${response.data.duration_seconds}s, ${response.data.visibility}.`);
    }
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List hosted audio" },
  args: {
    page: { type: "string", description: "Page number", default: "1" },
    "per-page": { type: "string", description: "Items per page (max 100)", default: "20" },
    folder: { type: "string", description: "Filter by folder" },
    collection: { type: "string", description: "Filter by collection ID" },
    meta: { type: "string", description: "Filter metadata key=value (repeatable)" },
    metadata: { type: "string", description: "Filter by metadata JSON containment" },
    json: { type: "boolean", description: "Output complete JSON", default: false },
  },
  async run({ args }) {
    const params = new URLSearchParams({ page: args.page, per_page: args["per-page"] });
    if (args.folder) params.set("folder", args.folder);
    if (args.collection) params.set("collection_id", args.collection);
    const metadata = parseMetadataFlags({ meta: args.meta, metadata: args.metadata });
    if (metadata) params.set("metadata", JSON.stringify(metadata));
    const response = await apiRequest<{ data: AudioAsset[]; meta: Record<string, unknown> }>({
      path: `${AUDIO_PATH}?${params}`,
      auth: requireApiKey(),
    });
    if (args.json) jsonOut(response);
    else for (const audio of response.data) stdout(audio.url);
  },
});

const get = defineCommand({
  meta: { name: "get", description: "Get audio metadata and its current original URL" },
  args: {
    id: { type: "positional", description: "Stable aud_ asset ID", required: true },
    json: { type: "boolean", description: "Output complete JSON", default: false },
  },
  async run({ args }) {
    const response = await apiRequest<DataResponse<AudioAsset>>({
      path: `${AUDIO_PATH}/${encodeURIComponent(args.id)}`,
      auth: requireApiKey(),
    });
    if (args.json) jsonOut(response.data);
    else stdout(response.data.url);
  },
});

const update = defineCommand({
  meta: { name: "update", description: "Replace audio metadata, folder, or collection membership" },
  args: {
    id: { type: "positional", description: "Stable aud_ asset ID", required: true },
    folder: { type: "string", description: "Replacement folder" },
    "clear-folder": { type: "boolean", description: "Remove folder membership", default: false },
    collection: { type: "string", description: "Replacement existing collection ID" },
    "clear-collection": { type: "boolean", description: "Remove collection membership", default: false },
    meta: { type: "string", description: "Replacement metadata key=value (repeatable)" },
    metadata: { type: "string", description: "Replacement metadata JSON object" },
    "clear-metadata": { type: "boolean", description: "Replace metadata with an empty object", default: false },
    json: { type: "boolean", description: "Output complete JSON", default: false },
  },
  async run({ args }) {
    if (args.folder && args["clear-folder"]) throw new CliError("Use --folder or --clear-folder, not both.");
    if (args.collection && args["clear-collection"]) throw new CliError("Use --collection or --clear-collection, not both.");
    if ((args.meta || args.metadata) && args["clear-metadata"]) {
      throw new CliError("Use metadata flags or --clear-metadata, not both.");
    }
    const body: Record<string, unknown> = {};
    if (args.folder) body.folder = args.folder;
    else if (args["clear-folder"]) body.folder = null;
    if (args.collection) body.collection_id = args.collection;
    else if (args["clear-collection"]) body.collection_id = null;
    const metadata = parseMetadataFlags({ meta: args.meta, metadata: args.metadata });
    if (metadata) body.metadata = metadata;
    else if (args["clear-metadata"]) body.metadata = {};
    if (Object.keys(body).length === 0) {
      throw new CliError("Provide --folder, --clear-folder, --collection, --clear-collection, metadata, or --clear-metadata.");
    }
    const response = await apiRequest<DataResponse<AudioAsset>>({
      method: "PATCH",
      path: `${AUDIO_PATH}/${encodeURIComponent(args.id)}`,
      auth: requireApiKey(),
      body,
    });
    if (args.json) jsonOut(response.data);
    else stdout(response.data.url);
  },
});

const sign = defineCommand({
  meta: { name: "sign", description: "Mint a fresh signed URL for a private audio original" },
  args: {
    id: { type: "positional", description: "Stable aud_ asset ID", required: true },
    expires: { type: "string", description: "Signed-link lifetime, e.g. 1h or 7d", default: "1h" },
    json: { type: "boolean", description: "Output complete JSON", default: false },
  },
  async run({ args }) {
    const response = await apiRequest<DataResponse<{ url: string; expires: number; visibility: string }>>({
      method: "POST",
      path: `${AUDIO_PATH}/${encodeURIComponent(args.id)}/sign-url`,
      auth: requireApiKey(),
      body: { expires_in: parseExpires(args.expires) },
    });
    if (args.json) jsonOut(response.data);
    else stdout(response.data.url);
  },
});

const remove = defineCommand({
  meta: { name: "delete", description: "Permanently delete an audio original" },
  args: { id: { type: "positional", description: "Stable aud_ asset ID", required: true } },
  async run({ args }) {
    await apiRequest({
      method: "DELETE",
      path: `${AUDIO_PATH}/${encodeURIComponent(args.id)}`,
      auth: requireApiKey(),
    });
  },
});

export default defineCommand({
  meta: { name: "audio", description: "Host and manage original audio files" },
  subCommands: { upload, list, get, update, sign, delete: remove },
});
