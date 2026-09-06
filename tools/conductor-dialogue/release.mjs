import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dialogueSha256, loadDialogueReleaseForWorld, parseDialogueWorldPin } from '../../packages/conductor-dialogue/dist/index.js';

/** Signiert nur nach bestehendem Schlüssel-/Weltpin und vollständig geprüftem Korpus. */
export async function signDialogueRelease(input) {
  const pin = parseDialogueWorldPin(input.expectedPin);
  if (input.keyId !== pin.signingKeyId) throw new Error('Der Schlüssel entspricht nicht dem bestehenden Weltpin.');
  const trustedPem = input.trustedKeys.get(input.keyId);
  if (trustedPem === undefined) throw new Error('Der öffentliche Signierschlüssel ist nicht unabhängig freigegeben.');
  let privateKey, publicKey;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
    publicKey = createPublicKey(trustedPem);
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
      || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
      throw new Error();
    }
  } catch { throw new Error('Privater Schlüssel und bestehender öffentlicher Ed25519-Pin passen nicht zusammen.'); }
  const releaseBytes = Uint8Array.from(input.releaseBytes);
  const editorialReviewBytes = Uint8Array.from(input.editorialReviewBytes);
  const signedHash = dialogueSha256(releaseBytes);
  const signature = { algorithm: 'ed25519', keyId: input.keyId, signedHash,
    valueBase64: sign(null, Buffer.from(signedHash, 'utf8'), privateKey).toString('base64') };
  // Auch eine eigene Signatur darf ungültige Fachtexte oder ungeprüfte Reviews
  // nicht publizierbar machen. Fremde Parsertexte gelangen nie in die Ausgabe.
  try { loadDialogueReleaseForWorld({ worldId: input.worldId, expectedPin: pin, releaseBytes, editorialReviewBytes,
    signature, trustedKeys: input.trustedKeys, validator: input.validator }); }
  catch { throw new Error('Der Dialogrelease besteht die Welt-, Korpus- oder redaktionelle Freigabeprüfung nicht.'); }
  return signature;
}

async function main() {
  const allowed = new Set(['directory', 'world-id', 'world-pin', 'trusted-keys', 'private-key', 'key-id', 'output', 'validator-addon', 'validator-binary']);
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]?.slice(2), value = process.argv[i + 1];
    if (!process.argv[i]?.startsWith('--') || !allowed.has(key) || !value || Object.hasOwn(args, key)) throw new Error('Ungültige Signierargumente.');
    args[key] = value;
  }
  if (['directory', 'world-id', 'world-pin', 'trusted-keys', 'private-key', 'key-id', 'output'].some((key) => !args[key])
    || Boolean(args['validator-addon']) === Boolean(args['validator-binary'])) throw new Error('Bestehende Welt-/Schlüsseldateien und genau ein nativer Validator sind erforderlich.');
  let expectedPin, keys, privateKeyPem, releaseBytes, editorialReviewBytes;
  try {
    [expectedPin, keys, privateKeyPem, releaseBytes, editorialReviewBytes] = await Promise.all([
      readFile(args['world-pin'], 'utf8').then(JSON.parse), readFile(args['trusted-keys'], 'utf8').then(JSON.parse),
      readFile(args['private-key'], 'utf8'), readFile(join(args.directory, 'release.json')),
      readFile(join(args.directory, 'editorial-review.json')),
    ]);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.values(keys).some((value) => typeof value !== 'string')) throw new Error();
  } catch { throw new Error('Die vorhandenen Freigabe- und Schlüsseldateien konnten nicht sicher gelesen werden.'); }
  let validator;
  if (args['validator-addon']) {
    try { validator = createRequire(import.meta.url)(resolve(args['validator-addon'])); }
    catch { throw new Error('Das konfigurierte native Modul konnte nicht geladen werden.'); }
  } else {
    validator = { validateConductorDialogueRelease(source) {
      const result = spawnSync(resolve(args['validator-binary']), ['validate'], { input: source, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (result.status !== 0) throw new Error('Der native Korpusvalidator lehnt die Datei ab.');
      return result.stdout;
    } };
  }
  const signature = await signDialogueRelease({ worldId: args['world-id'], expectedPin, keyId: args['key-id'],
    trustedKeys: new Map(Object.entries(keys)), privateKeyPem, releaseBytes, editorialReviewBytes, validator });
  try { await writeFile(args.output, `${JSON.stringify(signature, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
  catch { throw new Error('Die Signatur konnte nicht als neue Datei geschrieben werden; vorhandene Dateien werden nicht überschrieben.'); }
  process.stdout.write('Geprüfte Dialogsignatur als neue Datei geschrieben; keine Weltaktivierung ausgeführt.\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'Dialogsignierung abgelehnt.'}\n`); process.exitCode = 1; });
}
