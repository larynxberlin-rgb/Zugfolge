interface ZugfolgeRuntimeConfiguration {
  readonly gameApiUrl?: string;
  readonly keycloakUrl?: string;
  readonly keycloakRealm?: string;
  readonly publicWorldId?: string;
  readonly tutorialWorldId?: string;
  readonly gameWebUrl?: string;
  readonly livemapUrl?: string;
  readonly mapBasemapStyleUrl?: string;
  readonly mapGermanyPmtilesUrl?: string;
  readonly mapAttribution?: string;
}

var __ZUGFOLGE_RUNTIME_CONFIG__: ZugfolgeRuntimeConfiguration | undefined;
