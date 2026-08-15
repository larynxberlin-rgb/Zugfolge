export interface BrowserOidcConfiguration {
  readonly keycloakUrl: string;
  readonly realm: string;
  readonly clientId: string;
}

interface TokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_expires_in?: unknown;
}

const inFlight = new Map<string, Promise<string>>();

function key(clientId: string, name: string): string {
  return `zugfolge.oidc.${clientId}.${name}`;
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

function issuer(configuration: BrowserOidcConfiguration): string {
  if (configuration.keycloakUrl.trim() === "") throw new Error("Keycloak-Laufzeitkonfiguration fehlt.");
  return `${configuration.keycloakUrl.replace(/\/$/, "")}/realms/${encodeURIComponent(configuration.realm)}`;
}

function cleanRedirectUri(): string {
  const url = new URL(window.location.href);
  ["code", "state", "session_state", "iss", "error", "error_description"].forEach((name) => url.searchParams.delete(name));
  return url.toString();
}

function clearAttempt(configuration: BrowserOidcConfiguration): void {
  ["state", "verifier", "redirectUri"].forEach((name) => sessionStorage.removeItem(key(configuration.clientId, name)));
}

function clearTokens(configuration: BrowserOidcConfiguration): void {
  ["accessToken", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt"].forEach((name) => sessionStorage.removeItem(key(configuration.clientId, name)));
}

function lifetimeSeconds(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function saveTokens(configuration: BrowserOidcConfiguration, response: TokenResponse, now = Date.now()): string {
  if (typeof response.access_token !== "string" || response.access_token === "") throw new Error("Keycloak lieferte kein Zugriffstoken.");
  const accessLifetime = lifetimeSeconds(response.expires_in, 300);
  sessionStorage.setItem(key(configuration.clientId, "accessToken"), response.access_token);
  sessionStorage.setItem(key(configuration.clientId, "accessTokenExpiresAt"), String(now + accessLifetime * 1_000));
  if (typeof response.refresh_token === "string" && response.refresh_token !== "") {
    const refreshLifetime = lifetimeSeconds(response.refresh_expires_in, Math.max(1_800, accessLifetime));
    sessionStorage.setItem(key(configuration.clientId, "refreshToken"), response.refresh_token);
    sessionStorage.setItem(key(configuration.clientId, "refreshTokenExpiresAt"), String(now + refreshLifetime * 1_000));
  }
  return response.access_token;
}

function usable(expiresAt: number, now: number): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  const remaining = expiresAt - now;
  const skew = Math.min(30_000, Math.max(1_000, Math.floor(remaining / 10)));
  return expiresAt - skew > now;
}

async function tokenRequest(configuration: BrowserOidcConfiguration, body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(`${issuer(configuration)}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`Keycloak konnte die Sitzung nicht erneuern (HTTP ${response.status}).`);
  return response.json() as Promise<TokenResponse>;
}

async function refresh(configuration: BrowserOidcConfiguration): Promise<string | undefined> {
  const refreshToken = sessionStorage.getItem(key(configuration.clientId, "refreshToken"));
  const refreshExpiresAt = Number(sessionStorage.getItem(key(configuration.clientId, "refreshTokenExpiresAt")) ?? "0");
  if (refreshToken === null || refreshToken === "" || refreshExpiresAt <= Date.now()) return undefined;
  try {
    return saveTokens(configuration, await tokenRequest(configuration, new URLSearchParams({
      grant_type: "refresh_token",
      client_id: configuration.clientId,
      refresh_token: refreshToken,
    })));
  } catch {
    clearTokens(configuration);
    return undefined;
  }
}

async function authenticate(configuration: BrowserOidcConfiguration, forceRefresh: boolean): Promise<string> {
  const accessToken = sessionStorage.getItem(key(configuration.clientId, "accessToken"));
  const expiresAt = Number(sessionStorage.getItem(key(configuration.clientId, "accessTokenExpiresAt")) ?? "0");
  if (!forceRefresh && accessToken !== null && accessToken !== "" && usable(expiresAt, Date.now())) return accessToken;

  const refreshed = await refresh(configuration);
  if (refreshed !== undefined) return refreshed;

  const parameters = new URLSearchParams(window.location.search);
  const error = parameters.get("error");
  if (error !== null) throw new Error(`Die Anmeldung wurde abgebrochen (${error}). Bitte erneut versuchen.`);
  const code = parameters.get("code");
  if (code !== null) {
    const expectedState = sessionStorage.getItem(key(configuration.clientId, "state"));
    const verifier = sessionStorage.getItem(key(configuration.clientId, "verifier"));
    const redirectUri = sessionStorage.getItem(key(configuration.clientId, "redirectUri"));
    if (expectedState === null || verifier === null || redirectUri === null || parameters.get("state") !== expectedState) {
      clearAttempt(configuration);
      throw new Error("OIDC-Anmeldung besitzt keinen gültigen lokalen PKCE-Zustand.");
    }
    const token = saveTokens(configuration, await tokenRequest(configuration, new URLSearchParams({
      grant_type: "authorization_code",
      client_id: configuration.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })));
    clearAttempt(configuration);
    window.history.replaceState({}, "", cleanRedirectUri());
    return token;
  }

  const verifier = randomValue(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = randomValue(24);
  const redirectUri = cleanRedirectUri();
  sessionStorage.setItem(key(configuration.clientId, "state"), state);
  sessionStorage.setItem(key(configuration.clientId, "verifier"), verifier);
  sessionStorage.setItem(key(configuration.clientId, "redirectUri"), redirectUri);
  const authorization = new URL(`${issuer(configuration)}/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: configuration.clientId,
    response_type: "code",
    scope: "openid offline_access",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(authorization);
  return "";
}

/** Liefert ein gueltiges Token, erneuert es vor Ablauf und dedupliziert parallele Erneuerungen. */
export function ensureBrowserAccessToken(configuration: BrowserOidcConfiguration, forceRefresh = false): Promise<string> {
  const flightKey = `${configuration.keycloakUrl}|${configuration.realm}|${configuration.clientId}`;
  const current = inFlight.get(flightKey);
  if (current !== undefined) return current;
  const pending = authenticate(configuration, forceRefresh).finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, pending);
  return pending;
}

export function resetBrowserAuthentication(configuration: BrowserOidcConfiguration): void {
  clearTokens(configuration);
  clearAttempt(configuration);
  const clean = new URL(window.location.href);
  ["code", "state", "session_state", "iss", "error", "error_description"].forEach((name) => clean.searchParams.delete(name));
  window.history.replaceState({}, "", clean);
}
