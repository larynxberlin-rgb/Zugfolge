import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseTrustedReleaseKeys,
  parseTrustedReleaseKeyScopes,
} from "./trusted-release-keys.js";

describe("parseTrustedReleaseKeys", () => {
  it("akzeptiert ausschließlich den exakt kanonischen Ed25519-SPKI-Public-Key-PEM", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(parseTrustedReleaseKeys(JSON.stringify({ "delivery-2026": pem })))
      .toEqual({ "delivery-2026": pem });
  });

  it.each([
    ["privater PKCS8-Schluessel", () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString()],
    ["RSA-SPKI", () => generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["CRLF-Serialisierung", () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString().replaceAll("\n", "\r\n")],
    ["Restbytes", () => `${generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()}rest`],
    ["fehlender Abschluss-Newline", () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString().trimEnd()],
  ] as const)("verwirft %s fail-closed", (_label, invalidPem) => {
    expect(() => parseTrustedReleaseKeys(JSON.stringify({ "delivery-2026": invalidPem() })))
      .toThrow(/ungueltigen Schluessel|Ed25519-SPKI|privates Schluesselmaterial/u);
  });

  it("verwirft leere Keyrings und unsichere Schluessel-IDs", () => {
    const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => parseTrustedReleaseKeys("{}"))
      .toThrow("darf nicht leer sein");
    expect(() => parseTrustedReleaseKeys(JSON.stringify({ "Unknown Key": pem })))
      .toThrow("ungueltige Schluessel-ID");
  });
});

describe("parseTrustedReleaseKeyScopes", () => {
  function keyring() {
    const alpha2026 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const alpha20263 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const map20264 = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    return parseTrustedReleaseKeys(JSON.stringify({
      "zugfolge-alpha-2026": alpha2026,
      "zugfolge-alpha-2026.3": alpha20263,
      "zugfolge-map-deutschland-2026.4": map20264,
    }));
  }

  it("schneidet den gemeinsamen Keyring in disjunkte Alpha- und Map-/Infra-Allow-lists", () => {
    const trustedKeys = keyring();
    const scopes = parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
      mapInfraDeliveries: ["zugfolge-map-deutschland-2026.4"],
    }), trustedKeys);

    expect(Object.keys(scopes.alphaWorldDeployments).sort()).toEqual([
      "zugfolge-alpha-2026",
      "zugfolge-alpha-2026.3",
    ]);
    expect(Object.keys(scopes.mapInfraDeliveries)).toEqual(["zugfolge-map-deutschland-2026.4"]);
    expect(scopes.alphaWorldDeployments["zugfolge-map-deutschland-2026.4"])
      .toBeUndefined();
    expect(scopes.mapInfraDeliveries["zugfolge-alpha-2026.3"])
      .toBeUndefined();
  });

  it("verwirft beide Cross-Domain-Richtungen bereits bei der Schluesselauswahl", () => {
    const trustedKeys = keyring();
    const scopes = parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
      mapInfraDeliveries: ["zugfolge-map-deutschland-2026.4"],
    }), trustedKeys);

    expect(() => {
      const mapKeyAtWorldBoundary = scopes.alphaWorldDeployments["zugfolge-map-deutschland-2026.4"];
      if (mapKeyAtWorldBoundary === undefined) throw new Error("Map-Key am Alpha-Welt-Gate abgelehnt");
    }).toThrow("Map-Key am Alpha-Welt-Gate abgelehnt");
    expect(() => {
      const alphaKeyAtDeliveryBoundary = scopes.mapInfraDeliveries["zugfolge-alpha-2026.3"];
      if (alphaKeyAtDeliveryBoundary === undefined) throw new Error("Alpha-Key am Map-/Infra-Gate abgelehnt");
    }).toThrow("Alpha-Key am Map-/Infra-Gate abgelehnt");
  });

  it("verwirft Rollenueberlappung, unbekannte IDs und unvollstaendige Partitionen", () => {
    const trustedKeys = keyring();
    expect(() => parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
      mapInfraDeliveries: ["zugfolge-alpha-2026.3", "zugfolge-map-deutschland-2026.4"],
    }), trustedKeys)).toThrow("nicht mehreren Protokollrollen");
    expect(() => parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
      mapInfraDeliveries: ["zugfolge-map-deutschland-2026.5"],
    }), trustedKeys)).toThrow("unbekannten Schluessel");
    expect(() => parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026"],
      mapInfraDeliveries: ["zugfolge-map-deutschland-2026.4"],
    }), trustedKeys)).toThrow("vollstaendig abdecken");
  });

  it("verwirft fehlende, feldunvollstaendige und leere Scope-Vertraege", () => {
    const trustedKeys = keyring();
    expect(() => parseTrustedReleaseKeyScopes("", trustedKeys))
      .toThrow("kein gueltiges JSON-Objekt");
    expect(() => parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: ["zugfolge-alpha-2026", "zugfolge-alpha-2026.3"],
    }), trustedKeys)).toThrow("muss exakt");
    expect(() => parseTrustedReleaseKeyScopes(JSON.stringify({
      alphaWorldDeployments: [],
      mapInfraDeliveries: ["zugfolge-map-deutschland-2026.4"],
    }), trustedKeys)).toThrow("nichtleere Liste");
  });
});
