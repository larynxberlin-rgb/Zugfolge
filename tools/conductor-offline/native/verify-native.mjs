/** Read-only pin gate for the already tested, embedded original Rust kernel. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, '../../..');
const hash = value => createHash('sha256').update(value).digest('hex');
async function tree(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = resolve(path, entry.name);
    assert.ok(!entry.isSymbolicLink(), 'Native source inventory must not follow symlinks');
    if (entry.isDirectory()) files.push(...await tree(target));
    else if (entry.isFile()) files.push(relative(repository, target).replaceAll('\\', '/'));
  }
  return files;
}
function scoped(path) {
  assert.equal(typeof path, 'string');
  assert.ok(!isAbsolute(path));
  const target = resolve(repository, path), local = relative(repository, target);
  assert.ok(local && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local));
  return target;
}
export async function verifyNativeKernel() {
  const manifest = JSON.parse(await readFile(resolve(directory, 'source-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 'conductor-offline-native-source/v1');
  assert.equal(manifest.target, 'wasm32-unknown-unknown');
  const lock = await readFile(resolve(directory, 'Cargo.lock'), 'utf8');
  const crates = [...lock.matchAll(/^name = "(zugfolge-[a-z-]+)"$/gm)].map(match => match[1])
    .filter(name => name !== 'zugfolge-offline-demo').sort();
  assert.deepEqual(manifest.crates, crates, 'Native dependency inventory differs from Cargo.lock');
  const prefix = relative(repository, directory).replaceAll('\\', '/');
  const inventory = ['Cargo.toml', `${prefix}/Cargo.toml`, `${prefix}/Cargo.lock`, ...await tree(resolve(directory, 'src'))];
  for (const name of crates) inventory.push(`crates/${name}/Cargo.toml`, ...await tree(resolve(repository, 'crates', name, 'src')));
  inventory.sort();
  assert.deepEqual(manifest.sources.map(source => source.path), inventory, 'Native source file set changed; rebuild and review its pins');
  for (const source of manifest.sources) {
    const bytes = await readFile(scoped(source.path));
    assert.equal(bytes.length, source.bytes, `Native source size changed: ${source.path}`);
    assert.equal(hash(bytes), source.sha256, `Native source changed; old WASM must not be used: ${source.path}`);
  }
  assert.equal(manifest.artifact.file, 'kernel.wasm');
  const bytes = await readFile(resolve(directory, manifest.artifact.file));
  assert.equal(bytes.length, manifest.artifact.bytes, 'Pinned WASM size changed');
  assert.equal(hash(bytes), manifest.artifact.sha256, 'Pinned WASM hash changed');
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [], 'Offline kernel must not import external capabilities');
  const exports = WebAssembly.Module.exports(module);
  for (const [name, kind] of [['memory', 'memory'], ['alloc', 'function'], ['dealloc', 'function'], ['invoke', 'function'], ['result_len', 'function']]) {
    assert.ok(exports.some(item => item.name === name && item.kind === kind), `Missing offline ABI export: ${name}`);
  }
  return { verified: true, kernelSha256: manifest.artifact.sha256, bytes: bytes.length,
    sourceRevision: manifest.origin.repositoryRevision, sourceFiles: inventory.length, imports: 0 };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await verifyNativeKernel()) + '\n');
}
