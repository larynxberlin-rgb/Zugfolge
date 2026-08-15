import { ensureBrowserAccessToken, resetBrowserAuthentication } from "@zugfolge/browser-identity";

export interface BrowserRuntimeConfiguration {
  readonly gameApiUrl: string;
  readonly keycloakUrl: string;
  readonly keycloakRealm: string;
  readonly publicWorldId: string;
  readonly livemapUrl: string;
}

export class RuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
  }
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
  resetBrowserAuthentication({ keycloakUrl: "", realm: "zugfolge", clientId: "game-web" });
  ["zugfolge.accessToken", "zugfolge.accessTokenExpiresAt", "zugfolge.oidc.state", "zugfolge.oidc.verifier", "zugfolge.oidc.redirectUri"].forEach((name) => sessionStorage.removeItem(name));
}

export function ensureAccessToken(configuration: BrowserRuntimeConfiguration, forceRefresh = false): Promise<string> {
  const legacy = new Map([
    ["zugfolge.accessToken", "zugfolge.oidc.game-web.accessToken"],
    ["zugfolge.accessTokenExpiresAt", "zugfolge.oidc.game-web.accessTokenExpiresAt"],
    ["zugfolge.oidc.state", "zugfolge.oidc.game-web.state"],
    ["zugfolge.oidc.verifier", "zugfolge.oidc.game-web.verifier"],
    ["zugfolge.oidc.redirectUri", "zugfolge.oidc.game-web.redirectUri"],
  ]);
  legacy.forEach((target, source) => {
    const value = sessionStorage.getItem(source);
    if (value !== null && sessionStorage.getItem(target) === null) sessionStorage.setItem(target, value);
  });
  return ensureBrowserAccessToken({
    keycloakUrl: configuration.keycloakUrl,
    realm: configuration.keycloakRealm,
    clientId: "game-web",
  }, forceRefresh);
}
