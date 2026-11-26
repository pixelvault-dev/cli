import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { parseExpires } from "../lib/duration.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";
import { formatTransformParams, resolveTransformInput } from "../lib/transforms.js";

export interface SignUrlResponse {
  url: string;
  branded_url?: string;
  expires: number;
  expires_at: string;
  transforms?: Record<string, string | number | boolean>;
}

function explainSignUrlError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "document_transforms_unsupported":
        throw new CliError(
          "PDF documents cannot be signed with image transforms. Omit -t/--params to sign the original PDF.",
          1,
        );
      case "svg_transforms_unsupported":
        throw new CliError(
          "SVG images cannot be signed with raster transforms. Omit -t/--params to sign the original SVG.",
          1,
        );
      case "not_found":
        throw new CliError("Image not found in this project.", 1);
      case "validation_error":
        throw new CliError(`Invalid sign-url request: ${error.message}`, 1);
    }
  }
  throw error;
}

export default defineCommand({
  meta: {
    name: "sign-url",
    description: "Mint a time-limited HMAC-signed URL for a private image (optionally transformed)",
  },
  args: {
    id: {
      type: "positional",
      description: "Private image or PDF id (e.g. img_abc123)",
      required: true,
    },
    expires: {
      type: "string",
      description: "Signed link lifetime, e.g. 30m, 1h (default), 7d, 30d (60s..30d)",
    },
    transform: {
      type: "string",
      description: 'Transform query string to sign into the URL, e.g. "w=800&fmt=auto&watermark=img_logo.png"',
      alias: "t",
    },
    params: {
      type: "string",
      description: 'Transform JSON object to sign into the URL, e.g. \'{"size":"card","dpr":2}\'',
    },
    branded: {
      type: "boolean",
      description: "Use the active custom-domain URL when available",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const id = String(args.id).trim();
    const expiresIn =
      typeof args.expires === "string" && args.expires.trim()
        ? parseExpires(args.expires, "--expires")
        : undefined;
    const transforms = resolveTransformInput({
      query: typeof args.transform === "string" ? args.transform : undefined,
      paramsJson: typeof args.params === "string" ? args.params : undefined,
      required: false,
      allowSize: true,
    });

    const body: Record<string, unknown> = {};
    if (expiresIn !== undefined) body.expires_in = expiresIn;
    if (transforms !== undefined) body.transforms = transforms;

    let response: { data: SignUrlResponse };
    try {
      response = await apiRequest<{ data: SignUrlResponse }>({
        method: "POST",
        path: `/v1/images/${encodeURIComponent(id)}/sign-url`,
        auth: requireApiKey(),
        body,
      });
    } catch (error) {
      explainSignUrlError(error);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }

    const url = args.branded
      ? (response.data.branded_url ?? response.data.url)
      : response.data.url;
    stdout(url);
    stderr(`Expires: ${response.data.expires_at}`);
    if (transforms) {
      stderr(`Signed transforms: ${formatTransformParams(transforms)}`);
    }
  },
});
