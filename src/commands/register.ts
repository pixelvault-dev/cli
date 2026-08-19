import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { updateConfig } from "../lib/config.js";
import { prompt, promptPassword } from "../lib/prompt.js";
import { stderr } from "../lib/output.js";

interface RegisterResponse {
  data: {
    account_id: string;
    email: string;
    email_verified: boolean;
    // Optional: older API versions omit it. Absent → treat as "unknown".
    password_set?: boolean;
    plan: string;
    default_project: {
      id: string;
      name: string;
      api_keys: { live: string };
    };
  };
}

export default defineCommand({
  meta: {
    name: "register",
    description: "Create a new PixelVault account",
  },
  args: {
    email: {
      type: "string",
      description: "Email address",
    },
    password: {
      type: "string",
      description: "Password (min 8 characters). Omit for a passwordless account.",
    },
    passwordless: {
      type: "boolean",
      description:
        "Create the account without a password (for agents/automation). Set a password later via the web 'Forgot password' flow.",
    },
  },
  async run({ args }) {
    const interactive = Boolean(process.stdin.isTTY);

    // Email is always required. Only prompt when we have a TTY — in a headless
    // (agent) run, missing --email is a hard error rather than a hung prompt.
    const email = args.email || (interactive ? await prompt("Email: ") : "");
    if (!email) {
      stderr("Email is required. Pass --email <email>.");
      process.exit(1);
    }

    // Resolve the password. Precedence: explicit --password > --passwordless >
    // interactive prompt (blank = passwordless) > headless default (passwordless,
    // so a non-TTY run never blocks on a hidden prompt).
    let password: string | undefined;
    if (args.password) {
      password = args.password;
    } else if (args.passwordless) {
      password = undefined;
    } else if (interactive) {
      const entered = await promptPassword(
        "Password (leave blank for a passwordless account): "
      );
      password = entered || undefined;
    } else {
      password = undefined;
    }

    if (password !== undefined && password.length < 8) {
      stderr("Password must be at least 8 characters.");
      process.exit(1);
    }

    stderr("Creating account...");

    const res = await apiRequest<RegisterResponse>({
      method: "POST",
      path: "/v1/auth/register",
      // Only send the password field when one was chosen — omitting it creates
      // a passwordless account server-side. `attribution.source: "cli"` buckets
      // the signup to this channel (server treats it as an untrusted hint that
      // wins over the derived source — see lead-attribution spec).
      body: {
        email,
        ...(password ? { password } : {}),
        attribution: { source: "cli" },
      },
    });

    updateConfig({
      api_key: res.data.default_project.api_keys.live,
      default_project: res.data.default_project.id,
      email: res.data.email,
    });

    stderr(`Account created. API key saved to ~/.pixelvault/config.json`);
    stderr(`Email: ${res.data.email}`);
    stderr(`Project: ${res.data.default_project.id}`);

    // password_set === false (or a passwordless request on an older API) means
    // there's no dashboard login yet — tell the user how to claim one.
    const passwordless = res.data.password_set === false || !password;
    if (passwordless) {
      stderr(
        "No password set. To enable dashboard login, use 'Forgot password' at " +
          "https://pixelvault.dev/forgot-password to set one."
      );
    }

    if (!res.data.email_verified) {
      stderr("Verify your email to lift the upload limit for the free tier.");
    }
  },
});
