import { outputs, outputPath } from "./paths.mjs";
// Run only after the final browser reports have been confirmed. This script
// verifies and packages existing evidence; it neither builds nor runs a test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, '../..');
const destination = resolve(outputs, 'acceptance');
const practiceDirectory = resolve(outputs, 'practice');
const animationDirectory = resolve(outputs, 'animation');
const artifact = resolve(outputs, 'M15-Offline-Demo.html');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = async path => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function scoped(base, path) {
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0 && !isAbsolute(path));
  const absolute = resolve(base, path), local = relative(base, absolute);
  assert.ok(local !== '' && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local), `Path outside evidence root: ${path}`);
  return absolute;
}
function empty(value, label) { assert.ok(Array.isArray(value) && value.length === 0, label); }
function checked(report, name) { return report.checks.find(check => check.name === name); }
async function verifyFiles(rows, base, label) {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${label} missing`);
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length, `${label} contains duplicate paths`);
  return Promise.all(rows.map(async row => {
    const actual = await digest(scoped(base, row.path));
    assert.equal(actual.sha256, row.sha256, `${label}: ${row.path} changed after build`);
    if (row.bytes !== undefined) assert.equal(actual.bytes, row.bytes, `${label}: ${row.path} size changed`);
    return { path: row.path, ...actual };
  }));
}

// Finish every gate and read every planned file before creating output files.
const html = await digest(artifact), build = await json(outputPath("build-info.json"));
assert.equal(build.schemaVersion, 'zugfolge-offline-demo-build/v1');
assert.equal(resolve(root, build.output), artifact);
assert.equal(html.sha256, build.sha256, 'HTML hash differs from final build');
assert.equal(html.bytes, build.bytes, 'HTML size differs from final build');
empty(build.externalImports, 'Build contains external imports');
const embeddedInputs = await verifyFiles(build.embeddedInputs, root, 'embeddedInputs');
const gameUi = await verifyFiles(build.gameUi, root, 'gameUi');
const originalUi = await verifyFiles(build.originalUi, repository, 'originalUi');

const practice = await json(resolve(practiceDirectory, 'practice-browser-report.json'));
const animation = await json(resolve(animationDirectory, 'animation-browser-report.json'));
assert.equal(practice.schemaVersion, 'conductor-offline-practice-browser/v1');
assert.equal(animation.schemaVersion, 'conductor-offline-animation-browser/v1');
for (const [label, report] of [['practice', practice], ['animation', animation]]) {
  assert.equal(report.passed, true, `${label}: final browser run did not pass`);
  assert.equal(report.htmlSha256, html.sha256, `${label}: report describes another HTML`);
  assert.equal(report.offline, true, `${label}: offline execution is not confirmed`);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  assert.ok(Object.hasOwn(report, 'errors') || Object.hasOwn(report, 'pageErrors'), `${label}: error observation missing`);
  for (const field of ['errors', 'pageErrors']) if (Object.hasOwn(report, field)) empty(report[field], `${label}: ${field}`);
  empty(report.network, `${label}: network activity was observed`);
}
assert.equal(practice.testOnly, true);
assert.equal(practice.allGameplayActionsThroughVisibleUi, true);
assert.equal(practice.diagnosticAccess, 'read-only');
for (const name of ['actual-fixture-and-40-passengers', 'visible-walk-and-document-check',
  'active-conversation-restored-through-ui', 'actual-ui-claim-and-payment',
  'actual-later-proof-reduction', 'actual-new-practice-session']) assert.ok(checked(practice, name), `Missing practice check: ${name}`);
assert.equal(practice.checks.filter(row => row.name === 'visible-walk-and-document-check').length, 3);
for (const name of ['idle-body-pixels-change-with-fixed-feet-and-native-position', 'held-walking-and-render-cadence',
  'reduced-motion', 'actual-held-touch-walking', 'mobile-conversation-layout', 'actual-idle-recording']) {
  assert.ok(checked(animation, name), `Missing animation check: ${name}`);
}
for (const width of [320, 390]) assert.ok(animation.checks.some(row => row.name === 'mobile-conversation-layout' && row.width === width));

const worker = await json(outputPath("worker-smoke-report.json"));
const nativePractice = await json(outputPath("practice-control-report.json"));
const clock = await json(outputPath("offline-api-clock-report.json"));
const publicPractice = await json(resolve(root, 'data/practice-public.json'));
const scene = await json(resolve(root, 'data/scene.json'));
const kernelSha256 = embeddedInputs.find(row => row.path === 'native/kernel.wasm')?.sha256;
assert.ok(kernelSha256);
for (const report of [worker, nativePractice, clock]) {
  assert.equal(report.testOnly, true);
  assert.equal(report.kernelSha256, kernelSha256, 'Component report describes another Rust kernel');
  assert.equal(report.fixtureHash, practice.fixtureHash, 'Component report describes another native fixture');
}
assert.equal(practice.fixtureHash, publicPractice.fixtureHash);
assert.equal(worker.sceneReleaseHash, scene.releaseHash);
assert.equal(clock.adapterSha256, gameUi.find(row => row.path === 'src/offline-api.ts')?.sha256);
for (const report of [worker, nativePractice]) assert.equal(report.passengers, 40);
assert.equal(publicPractice.passengers, 40);
assert.equal(checked(practice, 'actual-fixture-and-40-passengers').passengers, 40);
for (const name of ['restoreEqual', 'staleTokenRejected', 'asynchronousSaveRestoreEqual', 'privateCheckpointExcludedFromRenderResponses', 'saveContainsPrivateCheckpoint']) assert.equal(worker[name], true);
assert.equal(worker.actualFatalWorkerEvent, 'worker-smoke-induced-fatal-error');
assert.equal(worker.waitingCallsRejectedAfterFatalError, true);
assert.equal(worker.newCallsRejectedAfterFatalError, true);
assert.equal(nativePractice.nativeRestoreEqual, true);
assert.equal(nativePractice.cases.length, 3);
for (const name of ['oversizedGapPaused', 'nativeElapsedLimitUnchanged', 'rejectedCommandRecovers', 'hiddenTimersPaused',
  'inFlightResumePreserved', 'restoreWithoutCatchUp']) assert.equal(clock[name], true);

const plannedFiles = [];
async function include(source, path, extra = {}) {
  scoped(destination, path);
  assert.ok(!plannedFiles.some(row => row.path === path), `Duplicate output: ${path}`);
  plannedFiles.push({ source, path, ...await digest(source), ...extra });
}
async function present(path) {
  try { return await digest(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
for (const name of ['worker-smoke-report.json', 'practice-control-report.json', 'offline-api-clock-report.json', 'build-info.json']) {
  await include(outputPath(name), name, { kind: 'component-or-build-report' });
}
await include(resolve(practiceDirectory, 'practice-browser-report.json'), 'practice-browser-report.json', { kind: 'final-browser-report' });
await include(resolve(animationDirectory, 'animation-browser-report.json'), 'animation-browser-report.json', { kind: 'final-browser-report' });
assert.ok(Array.isArray(practice.screenshots) && practice.screenshots.length > 0);
for (const picture of practice.screenshots) {
  assert.ok(!/failure/iu.test(picture.file), 'A passing report must not contain its failure screenshot');
  const source = scoped(practiceDirectory, picture.file), actual = await digest(source);
  assert.equal(actual.sha256, picture.sha256, `Practice screenshot changed: ${picture.file}`);
  await include(source, `screenshots/practice/${picture.file}`, { kind: 'browser-screenshot', reportPinned: true });
}
assert.ok(Array.isArray(animation.screenshots) && animation.screenshots.length > 0, 'Final animation screenshots are not report-pinned');
for (const picture of animation.screenshots) {
  assert.ok(!/failure/iu.test(picture.file));
  const source = scoped(animationDirectory, picture.file), actual = await digest(source);
  assert.equal(actual.sha256, picture.sha256, `Animation screenshot changed: ${picture.file}`);
  await include(source, `screenshots/animation/${picture.file}`, { kind: 'browser-screenshot', reportPinned: true });
}
let recording = null;
const timingPath = resolve(animationDirectory, 'frames/timing.json');
if (await present(timingPath)) {
  const timing = await json(timingPath), expectedFrames = checked(animation, 'actual-idle-recording').frames;
  assert.equal(timing.htmlSha256, html.sha256, 'Animation frame timing describes another HTML');
  assert.ok(Array.isArray(timing.times) && timing.times.length === expectedFrames);
  assert.ok(timing.times.every((value, index) => Number.isSafeInteger(value) && value > 0
    && (index === 0 || value > timing.times[index - 1])), 'Frame times must be real, strictly increasing timestamps');
  await include(timingPath, 'animation/frames/timing.json', { kind: 'browser-recording-times' });
  for (let index = 0; index < expectedFrames; index++) {
    const name = `${String(index).padStart(2, '0')}.png`;
    await include(resolve(animationDirectory, 'frames', name), `animation/frames/${name}`, { kind: 'browser-recording-frame' });
  }
  recording = { htmlSha256: timing.htmlSha256, frames: expectedFrames, timing: 'animation/frames/timing.json' };
}
const gifPath = resolve(outputs, 'M15-Atmen-Demo.gif');
const gifBytes = await present(gifPath);
if (gifBytes) {
  assert.ok(recording, 'An optional GIF requires final, HTML-bound frame timing');
  const conversion = await json(outputPath("assemble-idle-gif-report.json"));
  assert.equal(conversion.htmlSha256, html.sha256, 'GIF conversion describes another HTML');
  assert.equal(resolve(conversion.path), gifPath);
  assert.equal(conversion.gifSha256, gifBytes.sha256, 'GIF changed after conversion');
  assert.equal(conversion.bytes, gifBytes.bytes);
  assert.equal(conversion.timingSha256, (await digest(timingPath)).sha256, 'GIF frame timing changed');
  assert.equal(conversion.frames, recording.frames);
  assert.ok(Number.isSafeInteger(conversion.durationMs) && conversion.durationMs > 0);
  const frames = plannedFiles.filter(row => row.kind === 'browser-recording-frame');
  assert.deepEqual(conversion.frameSha256, frames.map(row => row.sha256), 'GIF source frames changed');
  await include(outputPath("assemble-idle-gif-report.json"), 'assemble-idle-gif-report.json', { kind: 'recorded-image-conversion' });
  await include(gifPath, 'animation/M15-Atmen-Demo.gif', { kind: 'optional-derived-media', reportPinned: true,
    recordingHtmlSha256: recording.htmlSha256,
    limitation: 'Conversion report binds exact GIF, timing and source-frame bytes; no independent GIF decoder comparison is claimed.' });
}
const sourcePaths = ['build.mjs', 'finalize-v2.mjs', 'worker-smoke.mjs', 'practice-control-smoke.mjs',
  'offline-api-clock.test.mjs', 'practice-browser-smoke.mjs', 'animation-browser-smoke.mjs',
  'prepare-practice.mjs', 'prepare-control.mjs', 'prepare-scene.mjs', 'prepare-data.mjs', 'prepare-fixture.mjs', 'assemble-idle-gif.py', 'paths.mjs', 'original-art.mjs', 'check.mjs', 'native/verify-native.mjs', 'assets-v2/verify-art.mjs'];
const testAndPreparationSources = await Promise.all(sourcePaths.map(async path => ({ path, ...await digest(scoped(root, path)) })));
const files = plannedFiles.map(({ source, ...record }) => record);
const report = {
  schemaVersion: 'zugfolge-offline-demo-acceptance/v2', testOnly: true, passed: true,
  artifact: 'M15-Offline-Demo.html', ...html,
  scope: 'Local fictional double-deck practice with 40 actual passengers. This is not complete production M15 acceptance, a production world activation or a real monetary claim.',
  transport: 'file://; embedded dedicated worker and original Rust WASM; all assets included',
  networkDisabled: true, observedNetworkRequests: 0,
  native: { kernelSha256, fixtureHash: practice.fixtureHash, passengers: 40, sceneReleaseHash: scene.releaseHash,
    workerRestoreEqual: true, asynchronousSaveRestoreEqual: true, practiceRestoreEqual: true },
  browser: { practice: { report: 'practice-browser-report.json', checks: practice.checks.map(row => row.name) },
    animation: { report: 'animation-browser-report.json', checks: animation.checks.map(row => row.name) } },
  embeddedInputs, gameUi, originalUi,
  testAndPreparationSources: { observation: 'Current source bytes recorded at finalization; browser results independently pin the exact final HTML.', files: testAndPreparationSources },
  mediaNote: 'Both browser screenshot sets are checked against their report hashes. Optional GIF conversion binds the final HTML, timing, source frames and output bytes.',
  recording, files,
};
await mkdir(destination, { recursive: true });
for (const file of plannedFiles) {
  const target = scoped(destination, file.path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file.source, target);
  assert.equal((await digest(target)).sha256, file.sha256, `Copied evidence changed: ${file.path}`);
}
assert.equal((await digest(artifact)).sha256, html.sha256, 'HTML changed during evidence packaging');
await writeFile(resolve(destination, 'Abnahme.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(resolve(outputs, 'M15-Offline-Demo.html.sha256'), `${html.sha256}  M15-Offline-Demo.html\n`);
process.stdout.write(JSON.stringify({ output: destination, htmlSha256: html.sha256, htmlBytes: html.bytes,
  copiedFiles: files.length, passengers: report.native.passengers, passed: true }) + '\n');
