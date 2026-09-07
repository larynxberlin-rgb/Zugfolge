/** Read-only integrity check; this does not approve a production art release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function local(file) { assert.match(file, /^[a-z0-9][a-z0-9.-]*$/u); return resolve(directory, file); }
export async function verifyOfflineArt() {
  const provenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
  assert.equal(provenance.schemaVersion, 'conductor-offline-art-provenance/v1');
  assert.equal(provenance.testOnly, true);
  assert.equal(provenance.generationTool, 'image_gen');
  assert.deepEqual(provenance.externalReferenceImages, []);
  assert.equal(provenance.images.length, 3);
  assert.equal(new Set(provenance.files.map(row => row.file)).size, provenance.files.length);
  const bytes = new Map();
  for (const file of provenance.files) {
    const actual = await readFile(local(file.file));
    assert.equal(actual.length, file.bytes, `Artwork source size changed: ${file.file}`);
    assert.equal(sha(actual), file.sha256, `Artwork source changed: ${file.file}`);
    bytes.set(file.file, actual);
  }
  for (const image of provenance.images) {
    const actual = bytes.get(image.file);
    assert.ok(actual);
    assert.equal(sha(actual), image.sha256);
    assert.equal(sha(bytes.get(image.prompt)), image.promptSha256);
    for (const reference of image.references) assert.ok(provenance.images.some(row => row.id === reference));
    let offset = 8, metadata;
    while (offset + 12 <= actual.length) {
      const length = actual.readUInt32BE(offset), kind = actual.subarray(offset + 4, offset + 8).toString('latin1');
      assert.ok(offset + length + 12 <= actual.length);
      if (kind === 'caBX') metadata = actual.subarray(offset + 8, offset + 8 + length);
      offset += length + 12;
    }
    assert.ok(metadata);
    assert.equal(sha(metadata), image.providerDeclaredModel.metadataSha256);
    assert.equal(image.providerDeclaredModel.signatureVerification, 'not_performed');
  }
  for (const [name, width, height] of [['characters.png', 192, 480], ['environment.png', 192, 128]]) {
    const png = bytes.get(name);
    assert.ok(png);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  }
  return { verified: true, testOnly: true, sources: provenance.images.length, files: provenance.files.length,
    outputs: ['characters.png', 'environment.png'].map(file => ({ file, sha256: sha(bytes.get(file)) })) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await verifyOfflineArt()) + '\n');
}
