interface ZugfolgeOperationsRuntimeConfiguration {
  readonly publicWorldId?: string;
  readonly gameApiUrl?: string;
  readonly gameWebUrl?: string;
  readonly livemapUrl?: string;
  readonly keycloakUrl?: string;
  readonly keycloakRealm?: string;
  readonly operationsCenterOidcClientId?: string;
}

var __ZUGFOLGE_RUNTIME_CONFIG__: ZugfolgeOperationsRuntimeConfiguration | undefined;
