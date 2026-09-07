/** Signiert ausschließlich bereits freigegebene Atlasbytes mit extern bereitgestellten Schlüsseln. */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artSha256, inspectArtAtlas, parseArtAtlasManifest, parseArtAtlasSignature, parseArtAtlasWorldPin } from "../../packages/conductor-art/dist/index.js";
import { checkArtRelease } from "./check.mjs";
import { RELEASE_DIRECTORY } from "./manifest.mjs";

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const USAGE = "Aufruf: node tools/art-atlas/release.mjs --private-key PATH --key-id ID --trusted-keys PATH --world-pin PATH --world-id ID --output PATH [--directory PATH]";
function check(condition, message) { if (!condition) throw new Error(message); }

/** Dateien werden einmal und höchstens bis zur vorher geprüften Länge gelesen. */
function readBounded(path, limit, label) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const stat = fstatSync(descriptor);
    check(stat.isFile() && stat.size > 0 && stat.size <= limit, `${label}: ungültige Dateigröße.`);
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(descriptor, bytes, length, bytes.length - length, null)) > 0) length += count;
    check(length === stat.size, `${label}: Datei wurde beim Lesen verändert.`);
    return bytes.subarray(0, length);
  } catch {
    throw new Error(`${label}: Datei fehlt, ist nicht lesbar oder überschreitet die erlaubte Größe.`);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`${label}: gültiges UTF-8-JSON erforderlich.`); }
}

function publicKey(pem) {
  check(typeof pem === "string" && pem.length <= 16_384 && /^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem), "Vertrauensverzeichnis benötigt öffentliche PEM-Schlüssel.");
  let key;
  try { key = createPublicKey(pem); } catch { throw new Error("Öffentlicher Schlüssel ist ungültig."); }
  check(key.type === "public" && key.asymmetricKeyType === "ed25519", "Vertrauensverzeichnis benötigt Ed25519-Schlüssel.");
  return key;
}

/** Bestehendes Schlüsselringformat: JSON-Objekt mit Schlüsselkennung → öffentlichem PEM. */
export function parseArtTrustedKeys(value) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Vertrauensverzeichnis muss ein JSON-Objekt sein.");
  const entries = Object.entries(value);
  check(entries.length > 0 && entries.length <= 64, "Vertrauensverzeichnis benötigt 1 bis 64 öffentliche Schlüssel.");
  for (const [id, pem] of entries) { check(ID.test(id), "Ungültige Schlüsselkennung im Vertrauensverzeichnis."); publicKey(pem); }
  return new Map(entries);
}

function snapshotResources(manifest, resources) {
  const snapshot = (rows, input, perFileLimit, totalLimit) => {
    const result = new Map(); let total = 0;
    for (const row of rows) {
      if (result.has(row.path)) continue;
      const content = input.get(row.path);
      check(content instanceof Uint8Array && content.byteLength > 0 && content.byteLength <= perFileLimit, "Atlasressource fehlt oder überschreitet die erlaubte Größe.");
      total += content.byteLength;
      check(total <= totalLimit, "Atlasressourcen überschreiten die erlaubte Gesamtgröße.");
      result.set(row.path, Uint8Array.from(content));
    }
    return result;
  };
  return { files: snapshot(manifest.files, resources.files, 64 * 1024 * 1024, 128 * 1024 * 1024),
    evidence: snapshot(manifest.evidence, resources.evidence, 16 * 1024 * 1024, 64 * 1024 * 1024) };
}

/** Keine Schlüsselanlage, Vertrauensänderung oder Weltaktivierung; nur eine getrennte Signatur. */
export function signArtAtlas(input) {
  const worldId = input.worldId, keyId = input.keyId;
  check(typeof worldId === "string" && ID.test(worldId) && typeof keyId === "string" && ID.test(keyId), "Explizite gültige Welt- und Schlüsselkennung erforderlich.");
  check(input.manifestBytes instanceof Uint8Array && input.manifestBytes.byteLength > 0 && input.manifestBytes.byteLength <= 32 * 1024 * 1024, "Manifestgröße ist ungültig.");
  const manifestBytes = Uint8Array.from(input.manifestBytes), pin = parseArtAtlasWorldPin(input.expectedPin);
  const manifest = parseArtAtlasManifest(parseJson(manifestBytes, "Manifest")), digest = artSha256(manifestBytes);
  check(pin.worldId === worldId, "Weltpin gehört zu einer anderen Welt.");
  check(pin.releaseId === manifest.releaseId && pin.manifestSha256 === digest, "Weltpin passt nicht zu den exakten Manifestbytes.");
  const trustedPem = input.trustedKeys.get(keyId);
  check(trustedPem !== undefined, "Schlüsselkennung fehlt im unabhängig bereitgestellten Vertrauensverzeichnis.");
  const trustedKey = publicKey(trustedPem);
  const privatePem = input.privateKeyPem;
  check((typeof privatePem === "string" || privatePem instanceof Uint8Array) && privatePem.length > 0 && privatePem.length <= 16_384, "Externen Ed25519-Privatschlüssel bereitstellen.");
  let privateKey;
  try { privateKey = createPrivateKey(typeof privatePem === "string" ? privatePem : Buffer.from(privatePem)); }
  catch { throw new Error("Extern bereitgestellter Privatschlüssel ist ungültig oder nicht entsperrt."); }
  check(privateKey.type === "private" && privateKey.asymmetricKeyType === "ed25519", "Privatschlüssel muss Ed25519 verwenden.");
  const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  check(derivedPublic.equals(trustedKey.export({ type: "spki", format: "der" })), "Privatschlüssel passt nicht zum unabhängig vertrauten öffentlichen Schlüssel.");
  const resources = snapshotResources(manifest, input.resources), report = inspectArtAtlas(manifestBytes, resources);
  check(report.activationEligible, `Atlasfreigabe ist unvollständig: ${[...new Set(report.issues.map((issue) => issue.code))].join(", ")}.`);
  const signatureBytes = sign(null, Buffer.from(digest, "utf8"), privateKey);
  check(verify(null, Buffer.from(digest, "utf8"), trustedKey, signatureBytes), "Erzeugte Signatur konnte nicht unabhängig geprüft werden.");
  return parseArtAtlasSignature({ algorithm: "ed25519", keyId, signedHash: digest, valueBase64: signatureBytes.toString("base64") });
}

/** Der Dateieinstieg prüft zusätzlich die tatsächlich vorliegenden Builder- und Revieweingänge. */
export function releaseArtAtlasFromFiles(options) {
  for (const field of ["privateKeyPath", "keyId", "trustedKeysPath", "worldPinPath", "worldId", "outputPath"]) check(typeof options[field] === "string" && options[field].length > 0, `Fehlende Eingabe ${field}. ${USAGE}`);
  const directory = resolve(options.directory ?? RELEASE_DIRECTORY);
  const trustedKeys = parseArtTrustedKeys(parseJson(readBounded(options.trustedKeysPath, 1024 * 1024, "Vertrauensverzeichnis"), "Vertrauensverzeichnis"));
  const expectedPin = parseArtAtlasWorldPin(parseJson(readBounded(options.worldPinPath, 8192, "Weltpin"), "Weltpin"));
  const privateKeyPem = readBounded(options.privateKeyPath, 16_384, "Externer Privatschlüssel");
  const manifestBytes = readBounded(resolve(directory, "manifest.json"), 32 * 1024 * 1024, "Manifest");
  const manifest = parseArtAtlasManifest(parseJson(manifestBytes, "Manifest"));
  const readRows = (rows, limit, totalLimit) => {
    const result = new Map(); let total = 0;
    for (const row of rows) {
      if (result.has(row.path)) continue;
      const bytes = readBounded(resolve(directory, row.path), Math.min(limit, totalLimit - total), "Atlasressource");
      total += bytes.byteLength; result.set(row.path, bytes);
    }
    return result;
  };
  const resources = { files: readRows(manifest.files, 64 * 1024 * 1024, 128 * 1024 * 1024), evidence: readRows(manifest.evidence, 16 * 1024 * 1024, 64 * 1024 * 1024) };
  let checked;
  try { checked = checkArtRelease({ directory }); }
  catch { throw new Error("Builder-/Revieweingänge sind ungültig oder passen nicht zum Manifest. Aufbereitung und belegte Freigaben prüfen; Manifest vor dem Signieren erneut bauen."); }
  check(checked.blocking.length === 0 && checked.report.activationEligible, "Strenge Atlasprüfung oder vorhandene Freigaben sind unvollständig.");
  check(checked.report.manifestSha256 === artSha256(manifestBytes), "Manifest wurde während der Freigabeprüfung verändert.");
  const signature = signArtAtlas({ worldId: options.worldId, keyId: options.keyId, expectedPin, trustedKeys, privateKeyPem, manifestBytes, resources });
  try { writeFileSync(options.outputPath, `${JSON.stringify(signature, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 }); }
  catch { throw new Error("Signaturausgabe konnte nicht neu angelegt werden; vorhandene Dateien werden nicht überschrieben."); }
  return { worldId: expectedPin.worldId, releaseId: manifest.releaseId, manifestSha256: signature.signedHash, keyId: signature.keyId };
}

export function parseArtReleaseArguments(args) {
  const fields = { "--private-key": "privateKeyPath", "--key-id": "keyId", "--trusted-keys": "trustedKeysPath", "--world-pin": "worldPinPath", "--world-id": "worldId", "--output": "outputPath", "--directory": "directory" };
  const options = {};
  for (let at = 0; at < args.length; at += 2) {
    const field = fields[args[at]], value = args[at + 1];
    check(field && !Object.hasOwn(options, field) && typeof value === "string" && value.length > 0 && !value.startsWith("--"), USAGE);
    options[field] = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(releaseArtAtlasFromFiles(parseArtReleaseArguments(process.argv.slice(2))))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Atlassignierung fehlgeschlagen."); process.exitCode = 1; }
}
