import { setTimeout as delay } from "node:timers/promises";
import { apiRequest } from "./client.js";

const INITIAL_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;

export type AudioEnrichmentStatus = "not_requested" | "pending" | "processing" | "complete" | "failed";
export type AudioEnrichmentState = "not_started" | "queued" | "running" | "complete" | "failed" | "timeout";

export interface AudioEnrichment {
  job_id?: string;
  status: AudioEnrichmentStatus;
  requested_at?: string;
  completed_at?: string | null;
  transcript?: {
    status: "complete";
    text_url?: string;
    vtt_url?: string;
    segments_url?: string;
    language?: string | null;
    languages?: string[];
    model?: string | null;
    segment_count?: number;
  } | null;
  error?: { code: string; message: string };
}

export interface AudioAsset {
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
  enrichment: AudioEnrichment;
  created_at: string;
  expires_at?: string;
  signed_expires?: number;
  replayed?: true;
}

export type AudioArtifactType = "original_audio" | "transcript_text" | "transcript_vtt" | "transcript_segments";
export type SignedUrlExpiry =
  | { status: "not_applicable" }
  | { status: "known"; expires_at: string }
  | { status: "unknown" };

export interface AudioArtifact {
  type: AudioArtifactType;
  url: string;
  visibility: "public" | "private";
  signed_url_expiry: SignedUrlExpiry;
}

interface WaitOptions {
  timeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  fetchAudio?: (id: string, apiKey: string) => Promise<AudioAsset>;
  onStatus?: (status: AudioEnrichmentStatus) => void;
}

export function audioEnrichmentState(
  status: AudioEnrichmentStatus,
  timedOut = false,
): AudioEnrichmentState {
  if (timedOut) return "timeout";
  if (status === "pending") return "queued";
  if (status === "processing") return "running";
  if (status === "not_requested") return "not_started";
  return status;
}

async function getAudio(id: string, apiKey: string): Promise<AudioAsset> {
  const response = await apiRequest<{ data: AudioAsset }>({
    path: `/v1/audio/${encodeURIComponent(id)}`,
    auth: apiKey,
  });
  return response.data;
}

export async function waitForAudioEnrichment(
  initial: AudioAsset,
  apiKey: string,
  options: WaitOptions,
): Promise<{ audio: AudioAsset; timedOut: boolean }> {
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const fetchAudio = options.fetchAudio ?? getAudio;
  const deadline = now() + options.timeoutMs;
  let pollDelayMs = INITIAL_POLL_DELAY_MS;
  let audio = initial;
  let previousStatus = audio.enrichment.status;

  while (audio.enrichment.status === "pending" || audio.enrichment.status === "processing") {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { audio, timedOut: true };
    await sleep(Math.min(pollDelayMs, remainingMs));
    audio = await fetchAudio(audio.id, apiKey);
    if (audio.enrichment.status !== previousStatus) {
      previousStatus = audio.enrichment.status;
      options.onStatus?.(previousStatus);
    }
    pollDelayMs = Math.min(Math.ceil(pollDelayMs * 1.5), MAX_POLL_DELAY_MS);
  }
  return { audio, timedOut: false };
}

function signedUrlExpiry(audio: AudioAsset): SignedUrlExpiry {
  if (audio.visibility === "public") return { status: "not_applicable" };
  if (audio.signed_expires === undefined || !Number.isFinite(audio.signed_expires)) {
    return { status: "unknown" };
  }
  return {
    status: "known",
    expires_at: new Date(audio.signed_expires * 1_000).toISOString(),
  };
}

export function audioArtifacts(audio: AudioAsset): AudioArtifact[] {
  const signed_url_expiry = signedUrlExpiry(audio);
  const common = { visibility: audio.visibility, signed_url_expiry };
  const artifacts: AudioArtifact[] = [
    { type: "original_audio", url: audio.original_url, ...common },
  ];
  const transcript = audio.enrichment.transcript;
  if (transcript?.status === "complete") {
    if (transcript.text_url) artifacts.push({ type: "transcript_text", url: transcript.text_url, ...common });
    if (transcript.vtt_url) artifacts.push({ type: "transcript_vtt", url: transcript.vtt_url, ...common });
    if (transcript.segments_url) artifacts.push({ type: "transcript_segments", url: transcript.segments_url, ...common });
  }
  return artifacts;
}
