import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { jsonOut, stderr, stdout } from "../lib/output.js";

export interface CustomDomain {
  id: string;
  project_id: string;
  hostname: string;
  status: string;
  hostname_status: string;
  certificate_status: string;
  ready: boolean;
  cname_target: string;
  ownership_verification: { type: "TXT"; name: string; value: string } | null;
  created_at: string;
  updated_at: string;
}

type DomainListResponse = {
  data: CustomDomain[];
  meta: { limit: number; total: number; project_total: number; cname_target: string };
};

function explainDomainError(error: unknown): never {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "custom_domains_require_paid_plan":
        throw new CliError(
          "Custom domains require a Starter or Pro plan. Run `pixelvault upgrade starter` to get a checkout URL.",
          1,
        );
      case "custom_domain_limit_reached":
        throw new CliError(`${error.message} Remove an unused hostname with \`pixelvault domains delete <id>\`.`, 1);
      case "custom_domain_exists":
      case "custom_domain_conflict":
        throw new CliError(`${error.message} List configured hostnames with \`pixelvault domains list\`.`, 1);
      case "email_verification_required":
        throw new CliError("Verify the account email before adding a custom domain.", 1);
      case "custom_domain_not_found":
        throw new CliError("Custom domain not found. Run `pixelvault domains list` to get its id.", 1);
      case "custom_domains_unavailable":
      case "custom_domain_provisioning_failed":
        throw new CliError(`Custom-domain provisioning is unavailable: ${error.message}`, 1);
      case "validation_error":
        throw new CliError(`Invalid hostname: ${error.message}`, 1);
    }
  }
  throw error;
}

function printDomain(domain: CustomDomain): void {
  stdout([
    domain.id,
    domain.ready ? "active" : domain.status,
    domain.hostname,
    `CNAME ${domain.cname_target}`,
  ].join("  "));
  if (domain.ownership_verification) {
    stderr(
      `Add ${domain.ownership_verification.type} ${domain.ownership_verification.name} = ${domain.ownership_verification.value}`,
    );
  }
}

const list = defineCommand({
  meta: { name: "list", description: "List custom domains for the active project" },
  args: { json: { type: "boolean", description: "Output as JSON", default: false } },
  async run({ args }) {
    let response: DomainListResponse;
    try {
      response = await apiRequest<DomainListResponse>({
        path: "/v1/custom-domains",
        auth: requireApiKey(),
      });
    } catch (error) {
      explainDomainError(error);
    }
    if (args.json) {
      jsonOut(response);
      return;
    }
    stderr(`${response.meta.total}/${response.meta.limit} account custom domains used; ${response.meta.project_total} on this project.`);
    for (const domain of response.data) printDomain(domain);
  },
});

const add = defineCommand({
  meta: { name: "add", description: "Attach a hostname to the active project" },
  args: {
    hostname: { type: "positional", description: "Customer hostname, e.g. media.example.com", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: CustomDomain; meta: { limit: number } };
    try {
      response = await apiRequest({
        method: "POST",
        path: "/v1/custom-domains",
        auth: requireApiKey(),
        body: { hostname: args.hostname },
      });
    } catch (error) {
      explainDomainError(error);
    }
    if (args.json) jsonOut(response);
    else {
      printDomain(response.data);
      stderr(`Point ${response.data.hostname} to ${response.data.cname_target}, then run pixelvault domains refresh ${response.data.id}.`);
    }
  },
});

const refresh = defineCommand({
  meta: { name: "refresh", description: "Refresh DNS and certificate status" },
  args: {
    id: { type: "positional", description: "Custom-domain id", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: CustomDomain };
    try {
      response = await apiRequest({
        method: "POST",
        path: `/v1/custom-domains/${encodeURIComponent(args.id)}/refresh`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainDomainError(error);
    }
    if (args.json) jsonOut(response.data);
    else printDomain(response.data);
  },
});

const remove = defineCommand({
  meta: { name: "delete", description: "Remove a custom domain" },
  args: {
    id: { type: "positional", description: "Custom-domain id", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    let response: { data: { deleted: boolean; id: string } };
    try {
      response = await apiRequest({
        method: "DELETE",
        path: `/v1/custom-domains/${encodeURIComponent(args.id)}`,
        auth: requireApiKey(),
      });
    } catch (error) {
      explainDomainError(error);
    }
    if (args.json) jsonOut(response.data);
    else stderr(`Deleted custom domain ${response.data.id}.`);
  },
});

export default defineCommand({
  meta: { name: "domains", description: "Manage project custom domains" },
  subCommands: { list, add, refresh, delete: remove },
});
