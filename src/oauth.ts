import { webcrypto, randomBytes } from "node:crypto";
import http from "node:http";
import { exec } from "node:child_process";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const CALLBACK_PORT = 1455;
const AUTH_TIMEOUT_MS = 3 * 60_000;

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string | null;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function buildPkce() {
  const verifier = new Uint8Array(32);
  webcrypto.getRandomValues(verifier);
  const cv = base64url(verifier);
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(cv));
  return { codeVerifier: cv, codeChallenge: base64url(new Uint8Array(digest)) };
}

function parseJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return;
  try {
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
}

export function extractAccountId(token: string): string | null {
  const payload = parseJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

function extractExpiry(token: string): number | undefined {
  const payload = parseJwtPayload(token);
  const exp = payload?.["exp"];
  return typeof exp === "number" ? exp : undefined;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (u.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Invalid state or missing code.");
        server.close();
        finish(() => reject(new Error("OAuth state mismatch or missing code")));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family:system-ui;padding:2em;text-align:center;">` +
          `<h2 style="color:#10a37f">✓ Authorised!</h2>` +
          `<p>You can close this tab and return to Claude.</p>` +
          `</body></html>`,
      );
      server.close();
      finish(() => resolve(code));
    });

    server.on("error", (err) => finish(() => reject(err)));
    server.listen(CALLBACK_PORT, "127.0.0.1");

    setTimeout(() => {
      server.close();
      finish(() => reject(new Error("Auth timed out after 3 minutes")));
    }, AUTH_TIMEOUT_MS);
  });
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function tokensToCredentials(json: RawTokenResponse, oldRefreshToken?: string): Credentials {
  const jwtExp = extractExpiry(json.access_token);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? oldRefreshToken ?? "",
    expiresAt:
      jwtExp !== undefined
        ? jwtExp * 1000
        : Date.now() + (json.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

async function callTokenEndpoint(params: Record<string, string>, oldRefreshToken?: string): Promise<Credentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token endpoint error ${res.status}: ${text}`);
  return tokensToCredentials(JSON.parse(text) as RawTokenResponse, oldRefreshToken);
}

export async function loginWithBrowser(): Promise<{ credentials: Credentials; authUrl: string }> {
  const { codeVerifier, codeChallenge } = await buildPkce();
  const state = randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "gpt-image-mcp",
  })) {
    url.searchParams.set(k, v);
  }

  const authUrl = url.toString();
  process.stderr.write(`\n[gpt-image-mcp] Opening browser for auth...\nIf browser didn't open, visit:\n${authUrl}\n\n`);
  openBrowser(authUrl);

  const code = await waitForCallback(state);
  const credentials = await callTokenEndpoint({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  return { credentials, authUrl };
}

export async function refreshCredentials(refreshToken: string): Promise<Credentials> {
  return callTokenEndpoint(
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPE,
    },
    refreshToken,
  );
}

export function isExpiring(creds: Credentials, skewSeconds = 300): boolean {
  return Date.now() >= creds.expiresAt - skewSeconds * 1000;
}
