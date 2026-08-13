export interface LivemapRuntimeConfiguration {
  readonly gameApiUrl: string;
  readonly keycloakUrl: string;
  readonly keycloakRealm: string;
  readonly publicWorldId: string;
  readonly gameWebUrl: string;
  readonly basemapStyleUrl: string;
  readonly germanyPmtilesUrl: string;
  readonly attribution: string;
}

const TOKEN_KEY = "zugfolge.accessToken";
// The production Livemap lives below the same origin and redirect wildcard as
// game-web. Reusing that public PKCE client also lets both frontends share the
// session-scoped access token without weakening the realm's MFA-protected
// administration boundary.
export const LIVEMAP_OIDC_CLIENT_ID = "game-web";
const EXPIRY_KEY = "zugfolge.accessTokenExpiresAt";
const STATE_KEY = "zugfolge.livemap.oidc.state";
const VERIFIER_KEY = "zugfolge.livemap.oidc.verifier";
const REDIRECT_KEY = "zugfolge.livemap.oidc.redirectUri";

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

export function loadRuntimeConfiguration(): LivemapRuntimeConfiguration {
  const configured = globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ ?? {};
  const metaApi = document.querySelector<HTMLMetaElement>('meta[name="game-api-url"]')?.content ?? "";
  return Object.freeze({
    gameApiUrl: configured.gameApiUrl ?? metaApi,
    keycloakUrl: (configured.keycloakUrl ?? "").replace(/\/$/, ""),
    keycloakRealm: configured.keycloakRealm ?? "zugfolge",
    publicWorldId: configured.publicWorldId ?? "",
    gameWebUrl: configured.gameWebUrl ?? "",
    basemapStyleUrl: configured.mapBasemapStyleUrl ?? "/artifacts/world-basemap/style.json",
    germanyPmtilesUrl: configured.mapGermanyPmtilesUrl ?? "/artifacts/germany-infrastructure/germany.pmtiles",
    attribution: configured.mapAttribution ?? "© OpenStreetMap-Mitwirkende · ODbL",
  });
}

function cleanRedirectUri(): string {
  const url = new URL(window.location.href);
  ["code", "state", "session_state", "iss"].forEach((name) => url.searchParams.delete(name));
  return url.toString();
}

export async function ensureAccessToken(configuration: LivemapRuntimeConfiguration): Promise<string> {
  const current = sessionStorage.getItem(TOKEN_KEY);
  const expiresAt = Number(sessionStorage.getItem(EXPIRY_KEY) ?? "0");
  if (current !== null && current !== "" && (!Number.isFinite(expiresAt) || expiresAt === 0 || expiresAt > Date.now())) {
    return current;
  }
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
  if (configuration.keycloakUrl === "") throw new Error("Keycloak-Laufzeitkonfiguration fehlt.");

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
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: LIVEMAP_OIDC_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw new Error(`Keycloak konnte den Anmeldecode nicht einlösen (HTTP ${response.status}).`);
    const token = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof token.access_token !== "string" || token.access_token === "") {
      throw new Error("Keycloak lieferte kein Zugriffstoken.");
    }
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
    client_id: LIVEMAP_OIDC_CLIENT_ID,
    response_type: "code",
    scope: "openid",
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  window.location.assign(authorization);
  return "";
}
