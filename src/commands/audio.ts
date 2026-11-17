import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { CliError } from "../lib/errors.js";
import {
  audioArtifacts,
  audioEnrichmentState,
  waitForAudioEnrichment,
  type AudioArtifact,
  type AudioAsset,
  type AudioEnrichmentStatus,
} from "../lib/audio-enrichment.js";
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

async function uploadAudioSource(
  source: string,
  rawArgs: Record<string, unknown>,
  auth: string,
): Promise<AudioAsset> {
  const options = lifecycleArgs(rawArgs);
  let response: DataResponse<AudioAsset>;
  try {
    if (isRemoteSource(source)) {
      response = await apiRequest({
        method: "POST",
        path: AUDIO_PATH,
        auth,
        headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined,
        body: {
          url: source,
          visibility: options.visibility,
          ...(options.signExpiresIn !== undefined ? { sign_expires_in: options.signExpiresIn } : {}),
          ...(options.expiresIn !== undefined ? { expires_in: options.expiresIn } : {}),
          ...(options.folder ? { folder: options.folder } : {}),
          ...(options.collectionId ? { collection_id: options.collectionId } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
      });
    } else {
      const info = await stat(source).catch((error: unknown) => {
        throw new CliError(`Cannot read audio path ${source}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!info.isFile()) throw new CliError(`Audio path is not a regular file: ${source}`);
      if (info.size > AUDIO_MAX_BYTES) {
        throw new CliError(
          `Local audio is ${info.size.toLocaleString("en-US")} bytes. Audio originals are limited to the approved global maximum of 25,000,000 bytes; this is not a plan allowance.`,
        );
      }
      const filename = basename(source);
      const contentType = CONTENT_TYPES[extname(filename).toLowerCase()];
      if (!contentType) throw new CliError("Audio filename must end in .mp3, .wav, .m4a, or .ogg.");
      const bytes = await readFile(source);
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
  return response.data;
}

const upload = defineCommand({
  meta: { name: "upload", description: "Upload local audio or securely import a public audio URL" },
  args: {
    source: { type: "positional", description: "MP3, WAV, M4A, or OGG path or public HTTP(S) URL", required: true },
    ...lifecycleOptions,
  },
  async run({ args }) {
    const audio = await uploadAudioSource(
      args.source,
      args as Record<string, unknown>,
      requireApiKey(),
    );

    if (args.json) jsonOut(audio);
    else {
      stdout(audio.url);
      stderr(`${audio.replayed ? "Replayed" : "Hosted"} ${audio.id}: ${audio.codec}, ${audio.duration_seconds}s, ${audio.visibility}.`);
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

const DEFAULT_ENRICHMENT_TIMEOUT_SECONDS = 600;

function isAudioId(value: string): boolean {
  return /^aud_[A-Za-z0-9_-]+$/.test(value);
}

function enrichmentTimeoutMilliseconds(value: unknown): number {
  const seconds = Number(value ?? DEFAULT_ENRICHMENT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError("--timeout must be a positive number of seconds.");
  }
  return Math.ceil(seconds * 1_000);
}

function enrichmentStatusLabel(status: AudioEnrichmentStatus): string {
  if (status === "pending") return "queued";
  if (status === "processing") return "running";
  return status;
}

function enrichmentStartError(error: unknown, assetId: string): CliError {
  const resume = `Resume with pixelvault audio enrich ${assetId}; active or completed jobs are reused.`;
  if (!(error instanceof ApiRequestError)) {
    return new CliError(`${error instanceof Error ? error.message : String(error)} ${resume}`);
  }
  switch (error.code) {
    case "enrichment_limit_reached":
      return new CliError(`${error.message} Audio and video transcription share the plan's media-enrichment seconds. ${resume}`);
    case "file_too_large":
    case "audio_too_large":
    case "duration_too_long":
      return new CliError(`${error.message} Audio enrichment accepts hosted originals up to 25,000,000 bytes and 10 minutes. ${resume}`);
    case "audio_enrichment_unavailable":
    case "enrichment_unavailable":
      return new CliError(`${error.message} The original remains hosted. ${resume}`);
    default:
      return new CliError(`${error.message} ${resume}`);
  }
}

function printEnrichmentArtifacts(artifacts: AudioArtifact[]): void {
  for (const artifact of artifacts) {
    stdout(artifact.url);
    const expiry = artifact.signed_url_expiry.status === "known"
      ? `, signed URL expires ${artifact.signed_url_expiry.expires_at}`
      : artifact.signed_url_expiry.status === "unknown"
        ? ", signed URL expiry unavailable"
        : "";
    stderr(`${artifact.type}: ${artifact.visibility}${expiry}`);
  }
}

const enrich = defineCommand({
  meta: { name: "enrich", description: "Upload/import or resume an audio transcription job" },
  args: {
    source: {
      type: "positional",
      description: "MP3, WAV, M4A, or OGG path, public HTTP(S) URL, or existing aud_ asset ID",
      required: true,
    },
    ...lifecycleOptions,
    wait: {
      type: "boolean",
      description: "Wait for a terminal enrichment state",
      default: true,
    },
    timeout: {
      type: "string",
      description: `Maximum seconds to wait locally (default: ${DEFAULT_ENRICHMENT_TIMEOUT_SECONDS})`,
      default: String(DEFAULT_ENRICHMENT_TIMEOUT_SECONDS),
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    const source = String(args.source);
    const existingAsset = isAudioId(source);
    const uploadOnlyOptions = [
      args.private,
      args["link-expires"],
      args["delete-after"],
      args.folder,
      args.collection,
      args.meta,
      args.metadata,
      args["idempotency-key"],
    ];
    if (existingAsset && uploadOnlyOptions.some((value) => value !== undefined && value !== false)) {
      throw new CliError(
        "Privacy, expiry, organization, metadata, and idempotency options apply only when audio enrich uploads or imports a source. "
        + "An existing asset keeps its lifecycle settings.",
      );
    }

    const timeoutMs = enrichmentTimeoutMilliseconds(args.timeout);
    let assetId = source;
    if (existingAsset) {
      stderr(`Using existing audio asset ${assetId}.`);
    } else {
      const uploaded = await uploadAudioSource(source, args as Record<string, unknown>, apiKey);
      assetId = uploaded.id;
      stderr(`Hosted audio asset ${assetId}. Original: ${uploaded.original_url}`);
    }
    stderr(`Resume safely with: pixelvault audio enrich ${assetId}`);

    let audio: AudioAsset;
    try {
      ({ data: audio } = await apiRequest<DataResponse<AudioAsset>>({
        method: "POST",
        path: `${AUDIO_PATH}/${encodeURIComponent(assetId)}/enrich`,
        auth: apiKey,
      }));
    } catch (error) {
      throw enrichmentStartError(error, assetId);
    }

    if (audio.enrichment.job_id) {
      stderr(`Enrichment job ${audio.enrichment.job_id}: ${enrichmentStatusLabel(audio.enrichment.status)}.`);
    } else {
      stderr(`Enrichment ${enrichmentStatusLabel(audio.enrichment.status)}; resume with asset ID ${assetId}.`);
    }

    let timedOut = false;
    if (args.wait && (audio.enrichment.status === "pending" || audio.enrichment.status === "processing")) {
      const result = await waitForAudioEnrichment(audio, apiKey, {
        timeoutMs,
        onStatus(status) {
          stderr(`Enrichment ${enrichmentStatusLabel(status)} (${audio.enrichment.job_id ?? assetId}).`);
        },
      });
      audio = result.audio;
      timedOut = result.timedOut;
    }

    const artifacts = audioArtifacts(audio);
    const output = {
      asset_id: audio.id,
      ...(audio.enrichment.job_id ? { job_id: audio.enrichment.job_id } : {}),
      state: audioEnrichmentState(audio.enrichment.status, timedOut),
      server_status: audio.enrichment.status,
      resume_command: `pixelvault audio enrich ${audio.id}`,
      visibility: audio.visibility,
      ...(audio.expires_at ? { asset_expires_at: audio.expires_at } : {}),
      artifacts,
      enrichment: audio.enrichment,
    };
    if (args.json) jsonOut(output);
    else printEnrichmentArtifacts(artifacts);

    if (timedOut) {
      throw new CliError(
        `Timed out after ${Number(args.timeout)}s while job ${audio.enrichment.job_id ?? "(ID unavailable)"} `
        + `was ${enrichmentStatusLabel(audio.enrichment.status)}. The server job was not cancelled. `
        + `Resume with pixelvault audio enrich ${audio.id}.`,
      );
    }
    if (audio.enrichment.status === "failed") {
      throw new CliError(
        `Enrichment job ${audio.enrichment.job_id ?? "(ID unavailable)"} failed: `
        + (audio.enrichment.error?.message ?? "The audio could not be transcribed."),
      );
    }
    if (audio.enrichment.status === "not_requested") {
      throw new CliError(`The server did not start an enrichment job. Retry with pixelvault audio enrich ${audio.id}.`);
    }
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
  meta: { name: "audio", description: "Host, transcribe, and manage original audio files" },
  subCommands: { upload, enrich, list, get, update, sign, delete: remove },
});
