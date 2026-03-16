import { defineCommand } from "citty";
import { apiRequest } from "../lib/client.js";
import { updateConfig, getApiUrl } from "../lib/config.js";
import { prompt, promptPassword } from "../lib/prompt.js";
import { stderr } from "../lib/output.js";

interface LoginResponse {
  data: {
    token: string;
    account_id: string;
    email: string;
    email_verified: boolean;
  };
}

interface RotateKeyResponse {
  data: {
    key_id: string;
    api_key: string;
    project_id: string;
    environment: string;
  };
}

interface ProjectsResponse {
  data: Array<{ id: string; name: string }>;
}

export default defineCommand({
  meta: {
    name: "login",
    description: "Log in to your PixelVault account",
  },
  args: {
    email: {
      type: "string",
      description: "Email address",
    },
    password: {
      type: "string",
      description: "Password",
    },
  },
  async run({ args }) {
    const email = args.email || (await prompt("Email: "));
    const password = args.password || (await promptPassword("Password: "));

    if (!email || !password) {
      stderr("Email and password are required.");
      process.exit(1);
    }

    stderr("Logging in...");

    // Step 1: Login to get JWT
    const loginRes = await apiRequest<LoginResponse>({
      method: "POST",
      path: "/v1/auth/login",
      body: { email, password },
    });

    const token = loginRes.data.token;

    // Step 2: Get projects to find default project ID
    let projectId: string | undefined;
    try {
      const projectsRes = await apiRequest<ProjectsResponse>({
        method: "GET",
        path: "/v1/projects",
        auth: token,
      });
      projectId = projectsRes.data[0]?.id;
    } catch {
      // Projects endpoint may not exist yet — continue without project ID
    }

    // Step 3: Rotate key to get a fresh API key
    if (projectId) {
      const rotateRes = await apiRequest<RotateKeyResponse>({
        method: "POST",
        path: "/v1/auth/rotate-key",
        auth: token,
        body: { project_id: projectId },
      });

      updateConfig({
        api_key: rotateRes.data.api_key,
        default_project: projectId,
        email: loginRes.data.email,
      });

      stderr(`Logged in. API key saved to ~/.pixelvault/config.json`);
      stderr(`Email: ${loginRes.data.email}`);
      stderr(`Project: ${projectId}`);
    } else {
      // Fallback: save JWT for manual key setup
      stderr(`Logged in as ${loginRes.data.email}.`);
      stderr(
        `Could not auto-configure API key. Set PIXELVAULT_API_KEY manually.`
      );
      updateConfig({ email: loginRes.data.email });
    }
  },
});
