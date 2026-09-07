import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { signDialogueRelease } from './release.mjs';
import { dialogueSha256, loadDialogueReleaseForWorld } from '../../packages/conductor-dialogue/dist/index.js';

const directory = fileURLToPath(new URL('../../assets/conductor-dialogue/v1', import.meta.url));
const releaseBytes = await readFile(join(directory, 'release.json'));
const editorialReviewBytes = await readFile(join(directory, 'editorial-review.json'));
const release = JSON.parse(releaseBytes);
const binary = process.env.ZUGFOLGE_DIALOGUE_TEST_BINARY;
const addon = process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH;
const pair = generateKeyPairSync('ed25519');
const trustedKeys = new Map([['explicit-test-key', pair.publicKey.export({ type: 'spki', format: 'pem' })]]);
const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const expectedPin = { schemaVersion: 'conductor-dialogue-world-pin/v1', worldId: 'test-world', releaseId: release.releaseId,
  releaseSha256: dialogueSha256(releaseBytes), editorialReviewSha256: dialogueSha256(editorialReviewBytes), signingKeyId: 'explicit-test-key' };
const unavailable = { validateConductorDialogueRelease() { throw new Error('PRIVATE_VALIDATOR_MARKER'); } };
function validator() {
  if (binary) return { validateConductorDialogueRelease(input) {
    const result = spawnSync(binary, ['validate'], { input, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Native Prüfung abgelehnt.'); return result.stdout;
  } };
  if (addon) return createRequire(import.meta.url)(addon);
  throw new Error('Echter nativer Validator erforderlich.');
}
const base = { worldId: 'test-world', expectedPin, keyId: 'explicit-test-key', trustedKeys, privateKeyPem, releaseBytes, editorialReviewBytes };

test('Fremder privater Schlüssel erzeugt keine Signatur und verrät kein Schlüsselmaterial', async () => {
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(signDialogueRelease({ ...base, privateKeyPem: other, validator: unavailable }), /passen nicht zusammen/);
  await assert.rejects(signDialogueRelease({ ...base, validator: unavailable }), (error) =>
    !error.message.includes('PRIVATE_VALIDATOR_MARKER') && error.message.includes('Freigabeprüfung'));
});
test('Echter Autorenkorpus und unabhängige Stichprobe werden mit explizitem Testschlüssel signiert', { skip: !(binary || addon) }, async () => {
  const signature = await signDialogueRelease({ ...base, validator: validator() });
  const loaded = loadDialogueReleaseForWorld({ ...base, signature, validator: validator() });
  assert.equal(loaded.report('test-world').trees, 156);
  assert.equal(loaded.report('test-world').utterances, 624);
  assert.throws(() => loaded.report('another-world'), /dialogue_world_mismatch/);
});
test('CLI schreibt eine neue Datei, überschreibt nichts und aktiviert keine Welt', { skip: !(binary || addon) }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dialogue-signing-'));
  try {
    await writeFile(join(temporary, 'pin.json'), JSON.stringify(expectedPin));
    await writeFile(join(temporary, 'keys.json'), JSON.stringify(Object.fromEntries(trustedKeys)));
    await writeFile(join(temporary, 'private.pem'), privateKeyPem);
    const output = join(temporary, 'signature.json');
    const args = [fileURLToPath(new URL('./release.mjs', import.meta.url)), '--directory', directory,
      '--world-id', 'test-world', '--world-pin', join(temporary, 'pin.json'), '--trusted-keys', join(temporary, 'keys.json'),
      '--private-key', join(temporary, 'private.pem'), '--key-id', 'explicit-test-key', '--output', output,
      ...(binary ? ['--validator-binary', binary] : ['--validator-addon', addon])];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(first.status, 0, first.stderr);
    const bytes = await readFile(output);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(second.status, 1); assert.match(second.stderr, /nicht überschrieben/);
    assert.deepEqual(await readFile(output), bytes);
    await writeFile(join(temporary, 'pin.json'), '{"secret":"PRIVATE_JSON_MARKER"');
    const malformed = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
    assert.equal(malformed.status, 1); assert.equal(malformed.stdout, '');
    assert.ok(!malformed.stderr.includes('PRIVATE_JSON_MARKER'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
