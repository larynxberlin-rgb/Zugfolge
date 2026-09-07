import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fareControlFixtureEconomy } from '../../apps/game-api/dist/conductor-control.native-fixture.js';
import { loadOriginalDemoArt } from './original-art.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const data = resolve(here, 'data');
await mkdir(data, { recursive: true });
const encode = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
await writeFile(resolve(data, 'economy.json'), encode(fareControlFixtureEconomy()));
const { atlas: art, worldId } = await loadOriginalDemoArt();
const view = art.renderView(worldId);
assert.equal(view.files.length, 7);
await writeFile(resolve(data, 'art-view.json'), encode(view));
const atlases = {};
for (const file of view.files) {
  const bytes = art.file(worldId, file.id);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  atlases[file.id] = Buffer.from(bytes).toString('base64');
}
await writeFile(resolve(data, 'atlases.json'), encode(atlases));
console.log(JSON.stringify({ files: ['economy.json','art-view.json','atlases.json'], atlases: view.files.length, assets: view.assets.length, manifestSha256: view.manifestSha256 }));
