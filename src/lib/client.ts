import { getApiUrl } from "./config.js";
import { CliError } from "./errors.js";

interface RequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  formData?: FormData;
}

interface ApiError {
  error: { code: string; message: string };
}

// Identifies the CLI to the API so signups made through it can be attributed to
// this channel (server reads X-PixelVault-Client at register/device-login — see
// pixelvault docs/specs/lead-attribution.md). Keep the version in sync with
// package.json on release.
const CLIENT_ID = "pixelvault-cli/0.6.0";

/** CliError carrying the API's machine-readable error details. */
export class ApiRequestError extends CliError {
  status: number;
  code?: string;
  retryAfter?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    retryAfter?: string
  ) {
    super(message, 1);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function apiRequest<T>(
  options: RequestOptions & { auth?: string }
): Promise<T> {
  const baseUrl = getApiUrl();
  const url = `${baseUrl}${options.path}`;

  const headers: Record<string, string> = { ...options.headers };

  if (!headers["X-PixelVault-Client"]) {
    headers["X-PixelVault-Client"] = CLIENT_ID;
  }

  if (options.auth) {
    headers["Authorization"] = `Bearer ${options.auth}`;
  }

  let fetchBody: BodyInit | undefined;

  if (options.formData) {
    fetchBody = options.formData;
  } else if (options.body) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: fetchBody,
    });
  } catch (err) {
    throw new CliError(
      `Network error: ${err instanceof Error ? err.message : "Failed to connect"}`,
      1
    );
  }

  if (!res.ok) {
    let errorBody: ApiError | undefined;
    try {
      errorBody = (await res.json()) as ApiError;
    } catch {
      // ignore parse failures
    }

    const message =
      errorBody?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
    throw new ApiRequestError(
      message,
      res.status,
      errorBody?.error?.code,
      res.headers?.get?.("Retry-After") ?? undefined
    );
  }

  return (await res.json()) as T;
}
