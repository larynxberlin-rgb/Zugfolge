const baseUrl = (process.env.KEYCLOAK_ADMIN_URL ?? "http://keycloak:8080").replace(/\/$/, "");
const realm = process.env.KEYCLOAK_REALM ?? "zugfolge";
const username = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? "";
const password = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? "";

if (username === "" || password === "") throw new Error("Keycloak-Administrator fuer den Client-Abgleich fehlt.");

async function checked(response, action) {
  if (!response.ok) throw new Error(`${action} ist fehlgeschlagen (HTTP ${response.status}).`);
  return response;
}

const tokenResponse = await checked(await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username, password }),
}), "Keycloak-Administratoranmeldung");
const token = (await tokenResponse.json()).access_token;
if (typeof token !== "string" || token === "") throw new Error("Keycloak lieferte kein Administratortoken.");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const realmResponse = await checked(await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}`, { headers }), "Realm lesen");
const realmRepresentation = await realmResponse.json();
await checked(await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ ...realmRepresentation, loginTheme: "zugfolge", accessTokenLifespan: 900, ssoSessionIdleTimeout: 28_800, offlineSessionIdleTimeout: 2_592_000 }),
}), "Sitzungslaufzeiten abgleichen");

const clients = [
  ["game-web", process.env.GAME_WEB_URL],
  ["livemap", process.env.LIVEMAP_URL],
  ["operations-center", process.env.OPERATIONS_CENTER_URL],
];
for (const [clientId, publicUrl] of clients) {
  if (typeof publicUrl !== "string" || publicUrl === "") throw new Error(`Oeffentliche URL fuer ${clientId} fehlt.`);
  const existingResponse = await checked(await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(clientId)}`, { headers }), `${clientId} suchen`);
  const existing = await existingResponse.json();
  const representation = {
    clientId,
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${publicUrl.replace(/\/$/, "")}/*`],
    webOrigins: [publicUrl.replace(/\/$/, "")],
    protocol: "openid-connect",
    attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: [{ name: "game-api-audience", protocol: "openid-connect", protocolMapper: "oidc-audience-mapper", config: { "included.client.audience": "game-api", "access.token.claim": "true", "id.token.claim": "false" } }],
  };
  if (Array.isArray(existing) && existing[0]?.id !== undefined) {
    await checked(await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(existing[0].id)}`, { method: "PUT", headers, body: JSON.stringify({ ...existing[0], ...representation }) }), `${clientId} aktualisieren`);
  } else {
    await checked(await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients`, { method: "POST", headers, body: JSON.stringify(representation) }), `${clientId} anlegen`);
  }
}

console.log(`Keycloak-Realm ${realm}: Browser-Clients und Sitzungslaufzeiten abgeglichen.`);
