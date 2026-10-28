import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";
import { explainBillingError } from "./billing.js";

const PLANS = ["starter", "pro"] as const;

export default defineCommand({
  meta: {
    name: "upgrade",
    description:
      "Print a Stripe Checkout URL to subscribe to a paid plan (live key required; nothing is charged until you pay)",
  },
  args: {
    plan: {
      type: "positional",
      description: `Plan to subscribe to: ${PLANS.join(" | ")}`,
      required: true,
    },
    json: {
      type: "boolean",
      description: "Output { url } as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const plan = String(args.plan);
    if (!(PLANS as readonly string[]).includes(plan)) {
      throw new CliError(`Unknown plan "${plan}". Choose one of: ${PLANS.join(", ")}.`, 1);
    }
    const apiKey = requireApiKey();
    let res: { url: string };
    try {
      res = await apiRequest<{ url: string }>({
        method: "POST",
        path: "/v1/billing/checkout",
        body: { plan },
        auth: apiKey,
      });
    } catch (err) {
      explainBillingError(err);
    }

    if (args.json) {
      jsonOut({ url: res.url });
    } else {
      stdout(res.url);
      stderr(
        "Open this link to complete payment. The plan changes once Stripe confirms — check with `pixelvault usage`."
      );
    }
  },
});
