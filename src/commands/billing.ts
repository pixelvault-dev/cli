import { defineCommand } from "citty";
import { apiRequest, ApiRequestError } from "../lib/client.js";
import { requireApiKey } from "../lib/config.js";
import { CliError } from "../lib/errors.js";
import { stdout, stderr, jsonOut } from "../lib/output.js";

/** Turn known billing API errors into actionable messages. */
export function explainBillingError(err: unknown): never {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case "test_key_forbidden":
        throw new CliError(
          "Billing needs a live key (pv_live_...); test keys can't start checkout or open the portal.",
          1
        );
      case "publishable_key_forbidden":
        throw new CliError(
          "Billing needs a secret live key (pv_live_...); publishable keys are not allowed.",
          1
        );
      case "email_not_verified":
        throw new CliError(
          "Verify your email before upgrading (check your inbox for the code).",
          1
        );
      case "already_subscribed":
        throw new CliError(
          "You already have a subscription. Change or cancel it with `pixelvault billing`.",
          1
        );
      case "no_subscription":
        throw new CliError(
          "This account has no billing history yet. Start one with `pixelvault upgrade <starter|pro>`.",
          1
        );
      case "billing_unavailable":
        throw new CliError("Paid plans are not available right now. Try again later.", 1);
      case "rate_limit_exceeded": {
        const wait = err.retryAfter ? ` Retry after ${err.retryAfter} seconds.` : "";
        throw new CliError(
          `Rate limit exceeded (10 billing requests per hour per account).${wait}`,
          1
        );
      }
    }
  }
  throw err;
}

export default defineCommand({
  meta: {
    name: "billing",
    description:
      "Print a Stripe billing-portal URL to change plan, update payment details or cancel (live key required)",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output { url } as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const apiKey = requireApiKey();
    let res: { url: string };
    try {
      res = await apiRequest<{ url: string }>({
        method: "POST",
        path: "/v1/billing/portal",
        body: {},
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
        "Open this link yourself to change plan, update payment details or cancel. It can cancel the subscription, so don't paste it anywhere shared."
      );
    }
  },
});
