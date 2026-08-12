interface ZugfolgeRuntimeConfiguration {
  readonly gameApiUrl?: string;
  readonly keycloakUrl?: string;
  readonly keycloakRealm?: string;
  readonly publicWorldId?: string;
  readonly tutorialWorldId?: string;
}

var __ZUGFOLGE_RUNTIME_CONFIG__: ZugfolgeRuntimeConfiguration | undefined;
