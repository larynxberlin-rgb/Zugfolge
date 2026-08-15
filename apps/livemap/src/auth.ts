import { ensureBrowserAccessToken } from "@zugfolge/browser-identity";

export interface LivemapRuntimeConfiguration {
  readonly gameApiUrl: string;
  readonly keycloakUrl: string;
  readonly keycloakRealm: string;
  readonly oidcClientId: string;
  readonly publicWorldId: string;
  readonly gameWebUrl: string;
  readonly basemapStyleUrl: string;
  readonly germanyPmtilesUrl: string;
  readonly attribution: string;
}

export const DEFAULT_LIVEMAP_OIDC_CLIENT_ID = "livemap";

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
    oidcClientId: configured.livemapOidcClientId?.trim() || DEFAULT_LIVEMAP_OIDC_CLIENT_ID,
  });
}

export function ensureAccessToken(configuration: LivemapRuntimeConfiguration, forceRefresh = false): Promise<string> {
  const targetPrefix = `zugfolge.oidc.${configuration.oidcClientId}.`;
  const legacy = new Map([
    ["zugfolge.accessToken", `${targetPrefix}accessToken`],
    ["zugfolge.accessTokenExpiresAt", `${targetPrefix}accessTokenExpiresAt`],
    ["zugfolge.livemap.oidc.state", `${targetPrefix}state`],
    ["zugfolge.livemap.oidc.verifier", `${targetPrefix}verifier`],
    ["zugfolge.livemap.oidc.redirectUri", `${targetPrefix}redirectUri`],
  ]);
  legacy.forEach((target, source) => {
    const value = sessionStorage.getItem(source);
    if (value !== null && sessionStorage.getItem(target) === null) sessionStorage.setItem(target, value);
  });
  return ensureBrowserAccessToken({
    keycloakUrl: configuration.keycloakUrl,
    realm: configuration.keycloakRealm,
    clientId: configuration.oidcClientId,
  }, forceRefresh);
}
