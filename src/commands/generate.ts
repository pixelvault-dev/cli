import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { parseExpires } from "../lib/duration.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

interface GenerateResponse {
  data: {
    id: string;
    url: string;
    optimized_url?: string;
    visibility?: "public" | "private";
    mime_type: string;
    size: number;
    width?: number;
    height?: number;
    filename: string;
    folder: string | null;
    created_at: string;
    expires_in?: number;
    signed_expires?: number;
    generation: {
      model: string;
      credits_charged: number;
      credits_remaining: number;
    };
  };
}

export default defineCommand({
  meta: {
    name: "generate",
    description:
      "Generate an image from a prompt and host it (spends monthly AI credits; secret key required)",
  },
  args: {
    prompt: {
      type: "positional",
      description: "What to draw. Quote it, or pass several words",
      required: true,
    },
    model: {
      type: "string",
      alias: "m",
      description:
        "flux-1-schnell (default, 1 credit), sdxl-lightning or sdxl-base (1, paid plans), lucid-origin or phoenix-1.0 (20, paid plans)",
    },
    folder: {
      type: "string",
      description: "Folder to organize the image in",
    },
    private: {
      type: "boolean",
      description:
        "Keep it private: returns a signed URL only holders of the link can open",
      default: false,
    },
    expires: {
      type: "string",
      description:
        "Lifetime of a --private signed link: e.g. 30m, 12h, 7d (default 7d; min 60s, max 30d)",
    },
    "delete-after": {
      type: "string",
      description:
        "Delete the image automatically after this long: e.g. 1h, 7d (min 60s, max 30d)",
    },
    optimized: {
      type: "boolean",
      description:
        "Print the optimized URL (WebP/AVIF, usually much smaller) instead of the original; falls back to the original URL when none is returned",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output the full JSON response",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();

    // Every positional (including the first) lands in `args._`, so an unquoted
    // multi-word prompt still works.
    const prompt = (args._.length ? args._.map(String) : [String(args.prompt ?? "")])
      .join(" ")
      .trim();
    if (!prompt) {
      throw new CliError('Give a prompt, e.g. pixelvault generate "a red bicycle".');
    }

    // Resolve durations up front so a bad value fails before any credit is spent.
    if (args.expires !== undefined && !args.private) {
      throw new CliError(
        "--expires only applies to --private images (it sets the signed link's lifetime). Use --delete-after to expire the image itself."
      );
    }
    const signExpires =
      args.expires !== undefined ? parseExpires(String(args.expires)) : undefined;
    const deleteAfter =
      args["delete-after"] !== undefined
        ? parseExpires(String(args["delete-after"]), "--delete-after")
        : undefined;

    if (args.private && args.folder) {
      stderr("Note: --folder is ignored for --private images.");
    }

    const res = await apiRequest<GenerateResponse>({
      method: "POST",
      path: "/v1/images/generate",
      auth: apiKey,
      body: {
        prompt,
        ...(args.model ? { model: String(args.model) } : {}),
        ...(args.folder ? { folder: String(args.folder) } : {}),
        ...(args.private ? { visibility: "private" } : {}),
        ...(signExpires !== undefined ? { sign_expires_in: signExpires } : {}),
        ...(deleteAfter !== undefined ? { expires_in: deleteAfter } : {}),
      },
    });

    // Fail closed: if we asked for private but the server didn't confirm it,
    // don't hand back a URL the user would wrongly trust as private.
    if (args.private && res.data.visibility !== "private") {
      throw new CliError(
        "Refusing to report the image: the server did not confirm it is private."
      );
    }

    const g = res.data.generation;
    // stderr only: stdout stays the bare URL so scripts and agents can capture it.
    stderr(
      `Generated with ${g.model}: ${g.credits_charged} credit${g.credits_charged === 1 ? "" : "s"} used, ${g.credits_remaining} left this month.`
    );

    if (args.json) {
      jsonOut(res.data);
    } else {
      stdout(args.optimized ? (res.data.optimized_url ?? res.data.url) : res.data.url);
    }
  },
});
