export interface BrowserRuntimeConfiguration {
  readonly gameApiUrl: string;
  readonly keycloakUrl: string;
  readonly keycloakRealm: string;
  readonly publicWorldId: string;
  readonly livemapUrl: string;
}

const TOKEN_KEY = "zugfolge.accessToken";
const EXPIRY_KEY = "zugfolge.accessTokenExpiresAt";
const STATE_KEY = "zugfolge.oidc.state";
const VERIFIER_KEY = "zugfolge.oidc.verifier";
const REDIRECT_KEY = "zugfolge.oidc.redirectUri";

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomValue(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function loadRuntimeConfiguration(): BrowserRuntimeConfiguration {
  const configured = globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ ?? {};
  const metaApi = document.querySelector<HTMLMetaElement>('meta[name="game-api-url"]')?.content ?? "";
  return {
    gameApiUrl: configured.gameApiUrl ?? metaApi,
    keycloakUrl: (configured.keycloakUrl ?? "").replace(/\/$/, ""),
    keycloakRealm: configured.keycloakRealm ?? "zugfolge",
    publicWorldId: configured.publicWorldId ?? "",
    livemapUrl: configured.livemapUrl ?? "",
  };
}

export function validateRuntimeConfiguration(configuration: BrowserRuntimeConfiguration): void {
  const missing = [
    configuration.gameApiUrl === "" ? "Game-API" : undefined,
    configuration.keycloakUrl === "" ? "Keycloak" : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  if (missing.length > 0) {
    throw new RuntimeConfigurationError(`Laufzeitkonfiguration unvollständig: ${missing.join(" und ")}.`);
  }
}

/** Verwirft einen beschädigten Anmeldeversuch, damit der nächste Start einen neuen PKCE-Fluss beginnt. */
export function resetAuthenticationAttempt(): void {
  [TOKEN_KEY, EXPIRY_KEY, STATE_KEY, VERIFIER_KEY, REDIRECT_KEY].forEach((key) => sessionStorage.removeItem(key));
  const clean = new URL(window.location.href);
  ["code", "state", "session_state", "iss"].forEach((name) => clean.searchParams.delete(name));
  window.history.replaceState({}, "", clean);
}

function cleanRedirectUri(): string {
  const url = new URL(window.location.href);
  ["code", "state", "session_state", "iss"].forEach((name) => url.searchParams.delete(name));
  return url.toString();
}

export async function ensureAccessToken(configuration: BrowserRuntimeConfiguration): Promise<string> {
  const current = sessionStorage.getItem(TOKEN_KEY);
  const expiresAt = Number(sessionStorage.getItem(EXPIRY_KEY) ?? "0");
  if (current !== null && current !== "" && (!Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt > Date.now())) return current;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
  if (configuration.keycloakUrl === "") throw new RuntimeConfigurationError("Keycloak-Laufzeitkonfiguration fehlt.");
  const issuer = `${configuration.keycloakUrl}/realms/${encodeURIComponent(configuration.keycloakRealm)}`;
  const parameters = new URLSearchParams(window.location.search);
  const code = parameters.get("code");
  if (code !== null) {
    const expectedState = sessionStorage.getItem(STATE_KEY);
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    const redirectUri = sessionStorage.getItem(REDIRECT_KEY);
    if (expectedState === null || verifier === null || redirectUri === null || parameters.get("state") !== expectedState) {
      throw new Error("OIDC-Anmeldung besitzt keinen gültigen lokalen PKCE-Zustand.");
    }
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: "game-web", code, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error(`Keycloak konnte den Anmeldecode nicht einlösen (HTTP ${response.status}).`);
    const token = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof token.access_token !== "string" || token.access_token === "") throw new Error("Keycloak lieferte kein Zugriffstoken.");
    const expiresIn = Number.isSafeInteger(token.expires_in) ? token.expires_in as number : 300;
    sessionStorage.setItem(TOKEN_KEY, token.access_token);
    sessionStorage.setItem(EXPIRY_KEY, String(Date.now() + Math.max(1, expiresIn - 30) * 1_000));
    [STATE_KEY, VERIFIER_KEY, REDIRECT_KEY].forEach((key) => sessionStorage.removeItem(key));
    window.history.replaceState({}, "", cleanRedirectUri());
    return token.access_token;
  }

  const verifier = randomValue(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomValue(24);
  const redirectUri = cleanRedirectUri();
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(REDIRECT_KEY, redirectUri);
  const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: "game-web", response_type: "code", scope: "openid", redirect_uri: redirectUri,
    state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  window.location.assign(authorization);
  return "";
}
