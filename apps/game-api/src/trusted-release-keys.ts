import { createPublicKey, type KeyObject } from "node:crypto";

const SAFE_KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const CANONICAL_PUBLIC_KEY_PEM = /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n$/u;

export interface TrustedReleaseKeyScopes {
  readonly alphaWorldDeployments: Readonly<Record<string, string>>;
  readonly mapInfraDeliveries: Readonly<Record<string, string>>;
}

function invalidKey(message: string): never {
  throw new Error(`InfraRelease-Trust-Store enthaelt einen ungueltigen Schluessel: ${message}`);
}

export function canonicalEd25519SpkiPublicKeyPem(value: unknown, keyId: string): string {
  if (typeof value !== "string" || value.length === 0) invalidKey(`${keyId} ist kein oeffentlicher PEM-Schluessel.`);
  if (/PRIVATE KEY/u.test(value)) invalidKey(`${keyId} enthaelt privates Schluesselmaterial.`);
  if (!CANONICAL_PUBLIC_KEY_PEM.test(value)) {
    invalidKey(`${keyId} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`);
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(value);
  } catch {
    invalidKey(`${keyId} ist kein gueltiger Ed25519-SPKI-Public-Key-PEM.`);
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    invalidKey(`${keyId} ist kein Ed25519-SPKI-Public-Key-PEM.`);
  }
  const canonical = publicKey.export({ type: "spki", format: "pem" });
  if (typeof canonical !== "string" || value !== canonical) {
    invalidKey(`${keyId} ist nicht exakt als kanonischer Ed25519-SPKI-Public-Key-PEM ohne Restbytes serialisiert.`);
  }
  return value;
}

export function parseTrustedReleaseKeys(value: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("INFRA_RELEASE_TRUSTED_KEYS_JSON ist kein gueltiges JSON-Objekt.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("INFRA_RELEASE_TRUSTED_KEYS_JSON muss ein Objekt sein.");
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("InfraRelease-Trust-Store darf nicht leer sein.");
  const canonicalEntries = entries.map(([keyId, pem]) => {
    if (!SAFE_KEY_ID.test(keyId)) throw new Error("InfraRelease-Trust-Store enthaelt eine ungueltige Schluessel-ID.");
    return [keyId, canonicalEd25519SpkiPublicKeyPem(pem, keyId)] as const;
  });
  return Object.freeze(Object.fromEntries(canonicalEntries));
}

function scopedKeyIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string" && SAFE_KEY_ID.test(entry))) {
    throw new Error(`${label} muss eine nichtleere Liste sicherer Schluessel-IDs sein.`);
  }
  const ids = ([...value] as string[]).sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} enthaelt doppelte Schluessel-IDs.`);
  return Object.freeze(ids);
}

function selectScopedKeys(
  trustedKeys: Readonly<Record<string, string>>,
  keyIds: readonly string[],
  label: string,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(keyIds.map((keyId) => {
    const publicKey = trustedKeys[keyId];
    if (publicKey === undefined) throw new Error(`${label} referenziert den unbekannten Schluessel '${keyId}'.`);
    return [keyId, publicKey] as const;
  })));
}

/**
 * Teilt den einen kanonischen Public-Keyring fail-closed in disjunkte
 * Protokollrollen. Kein Alpha-Weltschluessel darf dadurch Delivery-v2
 * autorisieren und kein Map-/Infra-Schluessel ein Weltdeployment.
 */
export function parseTrustedReleaseKeyScopes(
  value: string,
  trustedKeys: Readonly<Record<string, string>>,
): TrustedReleaseKeyScopes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("RELEASE_TRUSTED_KEY_SCOPES_JSON ist kein gueltiges JSON-Objekt.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RELEASE_TRUSTED_KEY_SCOPES_JSON muss ein Objekt sein.");
  }
  const scopes = parsed as Record<string, unknown>;
  if (Object.keys(scopes).sort().join(",") !== "alphaWorldDeployments,mapInfraDeliveries") {
    throw new Error("RELEASE_TRUSTED_KEY_SCOPES_JSON muss exakt Alpha-Welt- und Map-/Infra-Allow-lists enthalten.");
  }
  const alphaWorldKeyIds = scopedKeyIds(scopes["alphaWorldDeployments"], "alphaWorldDeployments");
  const mapInfraKeyIds = scopedKeyIds(scopes["mapInfraDeliveries"], "mapInfraDeliveries");
  const alphaWorldKeySet = new Set(alphaWorldKeyIds);
  const overlap = mapInfraKeyIds.find((keyId) => alphaWorldKeySet.has(keyId));
  if (overlap !== undefined) throw new Error(`Release-Schluessel '${overlap}' darf nicht mehreren Protokollrollen angehoeren.`);

  const alphaWorldDeployments = selectScopedKeys(trustedKeys, alphaWorldKeyIds, "Alpha-Welt-Allow-list");
  const mapInfraDeliveries = selectScopedKeys(trustedKeys, mapInfraKeyIds, "Map-/Infra-Allow-list");

  const assigned = [...alphaWorldKeyIds, ...mapInfraKeyIds].sort((left, right) => left.localeCompare(right, "en"));
  const available = Object.keys(trustedKeys).sort((left, right) => left.localeCompare(right, "en"));
  if (assigned.join("\0") !== available.join("\0")) {
    throw new Error("Release-Key-Allow-lists muessen den kanonischen Public-Keyring disjunkt und vollstaendig abdecken.");
  }
  return Object.freeze({
    alphaWorldDeployments,
    mapInfraDeliveries,
  });
}
