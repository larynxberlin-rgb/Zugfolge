/**
 * Keycloak-Integration (M2.1).
 *
 * Keycloak bleibt der eigenständige OIDC-Identity-Provider (`architektur.md`
 * 5): Dieses Modul verifiziert nur ein mitgebrachtes Zugriffstoken gegen den
 * öffentlichen Schlüsselsatz des Realms und liest daraus, wer sich meldet.
 * Es speichert nichts und entscheidet nichts über Rollen oder Weltzugänge —
 * das ist Sache von `accounts.ts`.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { HealthCheck } from "@zugfolge/health";

export interface KeycloakConfig {
  readonly issuer: string;
  readonly audience: string;
  /** Überschreibt die aus `issuer` abgeleitete Standardadresse des JWKS. */
  readonly jwksUri?: string;
}

export interface IdentityClaims {
  readonly keycloakSubject: string;
  readonly displayName: string;
}

/** Ein mitgebrachtes Token war ungültig, abgelaufen oder unvollständig. */
export class TokenVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenVerificationError";
  }
}

function extractDisplayName(payload: JWTPayload): string {
  const preferredUsername = payload["preferred_username"];
  if (typeof preferredUsername === "string" && preferredUsername.length > 0) {
    return preferredUsername;
  }
  const name = payload["name"];
  if (typeof name === "string" && name.length > 0) {
    return name;
  }
  return String(payload.sub);
}

/**
 * Prüft ein Token gegen einen Schlüsselsatz und liest die Identitätsangaben
 * heraus. Der Schlüsselsatz ist ein Parameter, kein festverdrahteter
 * Netzzugriff — so lässt sich die Prüfung selbst ohne Keycloak testen.
 */
export async function verifyIdentityToken(
  token: string,
  getKey: JWTVerifyGetKey,
  options: { readonly issuer: string; readonly audience: string },
): Promise<IdentityClaims> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      issuer: options.issuer,
      audience: options.audience,
    }));
  } catch (cause) {
    throw new TokenVerificationError("Token ungültig oder abgelaufen.", { cause });
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new TokenVerificationError("Token ohne Subject (sub).");
  }
  return { keycloakSubject: payload.sub, displayName: extractDisplayName(payload) };
}

/** Liest die Keycloak-Konfiguration aus Umgebungsvariablen. */
export function loadKeycloakConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KeycloakConfig {
  const issuer = env["KEYCLOAK_ISSUER"];
  const audience = env["KEYCLOAK_AUDIENCE"];
  if (issuer === undefined || issuer.length === 0 || audience === undefined || audience.length === 0) {
    throw new Error("KEYCLOAK_ISSUER und KEYCLOAK_AUDIENCE müssen gesetzt sein.");
  }
  const jwksUri = env["KEYCLOAK_JWKS_URI"];
  return jwksUri === undefined || jwksUri.length === 0 ? { issuer, audience } : { issuer, audience, jwksUri };
}

/** Baut eine einsatzbereite Verifikationsfunktion gegen den echten Realm. */
export function createKeycloakVerifier(
  config: KeycloakConfig,
): (token: string) => Promise<IdentityClaims> {
  const jwksUri = config.jwksUri ?? `${config.issuer}/protocol/openid-connect/certs`;
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  return (token: string) => verifyIdentityToken(token, jwks, config);
}

/** Readiness-Prüfung des tatsächlich verwendeten öffentlichen Schlüsselsatzes. */
export function createKeycloakHealthCheck(
  config: KeycloakConfig,
  fetchImplementation: typeof fetch = fetch,
): HealthCheck {
  const jwksUri = config.jwksUri ?? `${config.issuer}/protocol/openid-connect/certs`;
  return {
    name: "keycloak-jwks",
    async check(signal?: AbortSignal) {
      const response = await fetchImplementation(jwksUri, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new Error(`JWKS antwortet mit HTTP ${response.status}.`);
      }
      const document = (await response.json()) as { readonly keys?: unknown };
      if (!Array.isArray(document.keys) || document.keys.length === 0) {
        return { status: "down", code: "jwks_empty", detail: "Kein aktiver Signaturschlüssel." };
      }
      return { status: "ok", code: "jwks_available" };
    },
  };
}
