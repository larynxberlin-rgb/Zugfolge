import { ensureBrowserAccessToken } from "@zugfolge/browser-identity";

export interface OperationsRuntimeConfiguration {
  readonly publicWorldId: string;
  readonly gameApiUrl: string;
  readonly gameWebUrl: string;
  readonly livemapUrl: string;
  readonly keycloakUrl: string;
  readonly keycloakRealm: string;
  readonly oidcClientId: string;
}

export function loadOperationsRuntimeConfiguration(): OperationsRuntimeConfiguration {
  const configured = globalThis.__ZUGFOLGE_RUNTIME_CONFIG__ ?? {};
  return {
    publicWorldId: configured.publicWorldId ?? "",
    gameApiUrl: configured.gameApiUrl ?? document.querySelector<HTMLMetaElement>('meta[name="game-api-url"]')?.content ?? "",
    gameWebUrl: configured.gameWebUrl ?? "",
    livemapUrl: configured.livemapUrl ?? "",
    keycloakUrl: (configured.keycloakUrl ?? "").replace(/\/$/, ""),
    keycloakRealm: configured.keycloakRealm ?? "zugfolge",
    oidcClientId: configured.operationsCenterOidcClientId?.trim() || "operations-center",
  };
}

export function operationsAccessToken(configuration: OperationsRuntimeConfiguration, forceRefresh = false): Promise<string> {
  return ensureBrowserAccessToken({
    keycloakUrl: configuration.keycloakUrl,
    realm: configuration.keycloakRealm,
    clientId: configuration.oidcClientId,
  }, forceRefresh);
}
