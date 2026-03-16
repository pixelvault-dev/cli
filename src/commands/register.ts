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
      description: "Password (min 8 characters)",
    },
  },
  async run({ args }) {
    const email = args.email || (await prompt("Email: "));
    const password = args.password || (await promptPassword("Password: "));

    if (!email || !password) {
      stderr("Email and password are required.");
      process.exit(1);
    }

    if (password.length < 8) {
      stderr("Password must be at least 8 characters.");
      process.exit(1);
    }

    stderr("Creating account...");

    const res = await apiRequest<RegisterResponse>({
      method: "POST",
      path: "/v1/auth/register",
      body: { email, password },
    });

    updateConfig({
      api_key: res.data.default_project.api_keys.live,
      default_project: res.data.default_project.id,
      email: res.data.email,
    });

    stderr(`Account created. API key saved to ~/.pixelvault/config.json`);
    stderr(`Email: ${res.data.email}`);
    stderr(`Project: ${res.data.default_project.id}`);

    if (!res.data.email_verified) {
      stderr("Check your email to verify your account before uploading.");
    }
  },
});
