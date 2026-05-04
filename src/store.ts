import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type Credentials, refreshCredentials, isExpiring } from "./oauth.js";

const HOME_DIR = join(homedir(), ".gpt-image-mcp");
const AUTH_FILE = join(HOME_DIR, "auth.json");

function ensureHomeDir() {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}

export function saveCredentials(creds: Credentials): void {
  ensureHomeDir();
  writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  if (existsSync(AUTH_FILE)) {
    writeFileSync(AUTH_FILE, "", { mode: 0o600 });
  }
}

// Returns fresh credentials, auto-refreshing if needed.
export async function getValidCredentials(): Promise<Credentials> {
  const creds = loadCredentials();
  if (!creds?.accessToken) throw new Error("Not authenticated. Use the auth_login tool first.");

  if (!isExpiring(creds)) return creds;

  if (!creds.refreshToken) {
    throw new Error("Token expired and no refresh token available. Use auth_login to re-authenticate.");
  }

  const fresh = await refreshCredentials(creds.refreshToken);
  saveCredentials(fresh);
  return fresh;
}

export function getImagesDir(): string {
  const dir = join(HOME_DIR, "images");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
