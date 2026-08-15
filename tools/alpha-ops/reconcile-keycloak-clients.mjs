import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baseUrl = (process.env.KEYCLOAK_ADMIN_URL ?? "http://keycloak:8080").replace(/\/$/, "");
const realm = process.env.KEYCLOAK_REALM ?? "zugfolge";
const username = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? "";
const password = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? "";
const clientId = process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? "";
const clientSecret = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? "";

const retryableStatuses = new Set([429, 502, 503, 504]);

export async function fetchKeycloak(
  url,
  init,
  action,
  fetchImplementation = fetch,
  { attempts = 5, delayMs = 250, sleep = (duration) => new Promise((resolvePromise) => setTimeout(resolvePromise, duration)) } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImplementation(url, init);
    if (response.ok) return response;
    if (!retryableStatuses.has(response.status) || attempt === attempts) {
      throw new Error(`${action} ist fehlgeschlagen (HTTP ${response.status}).`);
    }
    console.warn(`${action}: voruebergehend HTTP ${response.status}, Versuch ${attempt + 1}/${attempts}.`);
    await sleep(delayMs * (2 ** (attempt - 1)));
  }
  throw new Error(`${action} ist ohne Antwort fehlgeschlagen.`);
}

export async function requestKeycloakAdminToken(configuration, fetchImplementation = fetch, retryOptions = undefined) {
  const serviceAccountConfigured = configuration.clientId !== "" || configuration.clientSecret !== "";
  let tokenResponse;
  if (serviceAccountConfigured) {
    if (configuration.clientId === "" || configuration.clientSecret === "") {
      throw new Error("Keycloak-Servicekonto fuer den Client-Abgleich ist unvollstaendig.");
    }
    tokenResponse = await fetchKeycloak(`${configuration.baseUrl}/realms/${encodeURIComponent(configuration.realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: configuration.clientId, client_secret: configuration.clientSecret }),
    }, "Keycloak-Servicekontoanmeldung", fetchImplementation, retryOptions);
  } else {
    if (configuration.username === "" || configuration.password === "") {
      throw new Error("Keycloak-Administrator fuer den Client-Abgleich fehlt.");
    }
    tokenResponse = await fetchKeycloak(`${configuration.baseUrl}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: configuration.username, password: configuration.password }),
    }, "Keycloak-Administratoranmeldung", fetchImplementation, retryOptions);
  }
  const token = (await tokenResponse.json()).access_token;
  if (typeof token !== "string" || token === "") throw new Error("Keycloak lieferte kein Administratortoken.");
  return token;
}

async function reconcileKeycloakClients() {
  const token = await requestKeycloakAdminToken({ baseUrl, realm, clientId, clientSecret, username, password });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const realmResponse = await fetchKeycloak(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}`, { headers }, "Realm lesen");
const realmRepresentation = await realmResponse.json();
await fetchKeycloak(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ ...realmRepresentation, loginTheme: "zugfolge", accessTokenLifespan: 86_400, ssoSessionIdleTimeout: 2_592_000, offlineSessionIdleTimeout: 2_592_000 }),
}, "Sitzungslaufzeiten abgleichen");

const clients = [
  ["game-web", process.env.GAME_WEB_URL],
  ["livemap", process.env.LIVEMAP_URL],
  ["operations-center", process.env.OPERATIONS_CENTER_URL],
];
for (const [clientId, publicUrl] of clients) {
  if (typeof publicUrl !== "string" || publicUrl === "") throw new Error(`Oeffentliche URL fuer ${clientId} fehlt.`);
  const normalizedPublicUrl = publicUrl.replace(/\/$/, "");
  const publicOrigin = new URL(normalizedPublicUrl).origin;
  const existingResponse = await fetchKeycloak(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(clientId)}`, { headers }, `${clientId} suchen`);
  const existing = await existingResponse.json();
  const representation = {
    clientId,
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    rootUrl: normalizedPublicUrl,
    baseUrl: normalizedPublicUrl,
    redirectUris: [`${normalizedPublicUrl}/*`],
    webOrigins: [publicOrigin],
    protocol: "openid-connect",
    attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: [{ name: "game-api-audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.client.audience": "game-api", "access.token.claim": "true", "id.token.claim": "false" } }],
  };
  if (Array.isArray(existing) && existing[0]?.id !== undefined) {
    await fetchKeycloak(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(existing[0].id)}`, { method: "PUT", headers, body: JSON.stringify({ ...existing[0], ...representation }) }, `${clientId} aktualisieren`);
  } else {
    await fetchKeycloak(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients`, { method: "POST", headers, body: JSON.stringify(representation) }, `${clientId} anlegen`);
  }
}

  console.log(`Keycloak-Realm ${realm}: Browser-Clients und Sitzungslaufzeiten abgeglichen.`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await reconcileKeycloakClients();
}
