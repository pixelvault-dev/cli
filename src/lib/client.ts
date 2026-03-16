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

export async function apiRequest<T>(
  options: RequestOptions & { auth?: string }
): Promise<T> {
  const baseUrl = getApiUrl();
  const url = `${baseUrl}${options.path}`;

  const headers: Record<string, string> = { ...options.headers };

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
    throw new CliError(message, 1);
  }

  return (await res.json()) as T;
}
