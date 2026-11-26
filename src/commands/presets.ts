import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";
import { formatTransformParams, resolveTransformInput } from "../lib/transforms.js";

export interface TransformPreset {
  name: string;
  params: Record<string, string | number | boolean>;
  created_at: string;
  updated_at: string;
}

type PresetListResponse = {
  data: TransformPreset[];
  meta: {
    limit: number;
    total: number;
    strict_transforms: boolean;
    builtin_presets: string[];
  };
};

type ProjectSummary = {
  id: string;
  name: string;
  strict_transforms: boolean;
  created_at: string;
  current?: boolean;
};

function explainPresetError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "preset_limit_reached":
        throw new CliError(
          `${error.message} Delete an unused preset with \`pixelvault presets delete <name>\` or upgrade with \`pixelvault upgrade starter\`.`,
          1,
        );
      case "preset_not_found":
        throw new CliError(
          "Transform preset not found. Run `pixelvault presets list` to see configured presets.",
          1,
        );
      case "preset_management_forbidden":
      case "project_management_forbidden":
        throw new CliError(
          "Preset and project transform settings require a secret key (pv_live_...); publishable keys are not allowed.",
          1,
        );
      case "validation_error":
        throw new CliError(`Invalid preset: ${error.message}`, 1);
    }
  }
  throw error;
}

function parseStrictToggle(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "on" || normalized === "true" || normalized === "1") return true;
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  throw new CliError(`Invalid strict mode value "${raw}". Use "on" or "off".`, 1);
}

const list = defineCommand({
  meta: { name: "list", description: "List custom named transform presets and strict-mode state" },
  args: {
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: PresetListResponse;
    try {
      response = await apiRequest<PresetListResponse>({
        path: "/v1/presets",
        auth: requireApiKey(),
      });
    } catch (error) {
      explainPresetError(error);
    }

    if (args.json) {
      jsonOut(response);
      return;
    }

    stderr(
      `${response.meta.total}/${response.meta.limit} custom presets used; strict_transforms: ${response.meta.strict_transforms ? "on" : "off"}; built-ins: ${response.meta.builtin_presets.join(", ")}.`,
    );
    if (response.data.length === 0) {
      stderr("No custom presets configured yet.");
      return;
    }
    for (const preset of response.data) {
      stdout([preset.name, formatTransformParams(preset.params), `updated ${preset.updated_at}`].join("  "));
    }
  },
});

const set = defineCommand({
  meta: {
    name: "set",
    description: "Create or update a custom named transform preset (use via ?size=<name>)",
  },
  args: {
    name: {
      type: "positional",
      description: "Preset slug (2-40 lowercase a-z, 0-9, -, _; cannot shadow built-ins)",
      required: true,
    },
    transform: {
      type: "positional",
      description: 'Query string of transform params, e.g. "w=800&fit=cover&fmt=auto&dpr=2"',
      required: false,
    },
    params: {
      type: "string",
      description: 'JSON object of transform params, e.g. \'{"w":800,"fit":"cover","fmt":"auto"}\'',
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const name = String(args.name).trim();
    const params = resolveTransformInput({
      query: typeof args.transform === "string" ? args.transform : undefined,
      paramsJson: typeof args.params === "string" ? args.params : undefined,
      required: true,
      allowSize: false,
    })!;

    let response: { data: TransformPreset; meta?: { limit: number } };
    try {
      response = await apiRequest({
        method: "PUT",
        path: `/v1/presets/${encodeURIComponent(name)}`,
        auth: requireApiKey(),
        body: { params },
      });
    } catch (error) {
      explainPresetError(error);
    }

    if (args.json) {
      jsonOut(response);
      return;
    }
    stdout(`${response.data.name}  ${formatTransformParams(response.data.params)}`);
    stderr(`Saved preset "${response.data.name}". Apply it with ?size=${response.data.name}.`);
  },
});

const remove = defineCommand({
  meta: { name: "delete", description: "Delete a custom named transform preset" },
  args: {
    name: { type: "positional", description: "Preset name to delete", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const name = String(args.name).trim();
    let response: { data: { deleted: boolean; name: string } };
    try {
      response = await apiRequest({
        method: "DELETE",
        path: `/v1/presets/${encodeURIComponent(name)}`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainPresetError(error);
    }

    if (args.json) {
      jsonOut(response.data);
      return;
    }
    stderr(`Deleted preset "${response.data.name}".`);
  },
});

const strict = defineCommand({
  meta: {
    name: "strict",
    description: "Show or toggle strict transform mode (on|off) for the active project",
  },
  args: {
    mode: {
      type: "positional",
      description: "on or off (omit to print current status)",
      required: false,
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    let listResponse: { data: ProjectSummary[] };
    try {
      listResponse = await apiRequest<{ data: ProjectSummary[] }>({
        path: "/v1/projects",
        auth: apiKey,
      });
    } catch (error) {
      explainPresetError(error);
    }

    const current = listResponse.data.find((p) => p.current) ?? listResponse.data[0];
    if (!current) {
      throw new CliError("Could not resolve the active project.", 1);
    }

    if (args.mode === undefined || String(args.mode).trim() === "") {
      if (args.json) {
        jsonOut({
          project_id: current.id,
          project_name: current.name,
          strict_transforms: current.strict_transforms,
        });
        return;
      }
      stdout(current.strict_transforms ? "on" : "off");
      stderr(`Project ${current.name} (${current.id}): strict_transforms is ${current.strict_transforms ? "on" : "off"}.`);
      return;
    }

    const want = parseStrictToggle(String(args.mode));
    let updated: { data: ProjectSummary };
    try {
      updated = await apiRequest<{ data: ProjectSummary }>({
        method: "PATCH",
        path: `/v1/projects/${encodeURIComponent(current.id)}`,
        auth: apiKey,
        body: { strict_transforms: want },
      });
    } catch (error) {
      explainPresetError(error);
    }

    if (args.json) {
      jsonOut(updated.data);
      return;
    }
    stdout(updated.data.strict_transforms ? "on" : "off");
    stderr(
      updated.data.strict_transforms
        ? `Enabled strict_transforms on ${updated.data.name}. Ad-hoc transform params now return 403 on public URLs; use ?size=<name> or signed private URLs.`
        : `Disabled strict_transforms on ${updated.data.name}. Ad-hoc transform params are allowed again.`,
    );
  },
});

export default defineCommand({
  meta: {
    name: "presets",
    description: "Manage named image transform presets and strict transform mode",
  },
  subCommands: { list, set, delete: remove, strict },
});
