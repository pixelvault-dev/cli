import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  api_key?: string;
  default_project?: string;
  email?: string;
  api_url?: string;
}

const CONFIG_DIR = join(homedir(), ".pixelvault");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_API_URL = "https://api.pixelvault.dev";

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function readConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function updateConfig(updates: Partial<Config>): void {
  const config = readConfig();
  writeConfig({ ...config, ...updates });
}

export function getApiKey(): string | undefined {
  return process.env["PIXELVAULT_API_KEY"] || readConfig().api_key;
}

export function getApiUrl(): string {
  return (
    process.env["PIXELVAULT_API_URL"] ||
    readConfig().api_url ||
    DEFAULT_API_URL
  );
}

export function requireApiKey(): string {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      "Not authenticated. Run `pixelvault register` or `pixelvault login`, or set PIXELVAULT_API_KEY."
    );
  }
  return key;
}
