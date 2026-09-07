// Explizite lokale Übungsdaten vor dem ersten Checkpoint, keine Produktionsfreigabe.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadOfflineKernel } from './src/wasm-loader.ts';
import { verifyNativeKernel } from './native/verify-native.mjs';
const fixturePath = new URL('./data/fixture.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const economyRelease = JSON.parse(readFileSync(new URL('./data/economy.json', import.meta.url), 'utf8'));
await verifyNativeKernel();
const kernel = await loadOfflineKernel(new Uint8Array(readFileSync(new URL('./native/kernel.wasm', import.meta.url))));
const worldId = fixture.access.worldId, periodId = fixture.source.sessionPolicy.periodId;
const inspectionPolicy = { schemaVersion: 'fare-inspection-policy/v1', policyId: 'offline-explicit-test-inspection', worldId, periodId, contentHash: '',
  invalidDocumentPresentedBasisPoints: 5000, identityRefusalBasisPoints: 3000, concreteDangerBasisPoints: 0 };
inspectionPolicy.contentHash = await kernel.invoke('fare.policyHash', inspectionPolicy);
const policeResponseModel = { schemaVersion: 'police-response-model/v1', modelId: 'offline-explicit-test-police', worldId, contentHash: '',
  availableBasisPoints: 10000, delayedBasisPoints: 0, responseMs: 1000, delayedResponseMs: 2000, identitySuccessBasisPoints: 10000 };
policeResponseModel.contentHash = await kernel.invoke('fare.modelHash', policeResponseModel);
const journeys = new Map();
for (const manifest of fixture.source.projection.evaluation.manifests) {
  for (const passenger of manifest.passengers) {
    const key = `${manifest.trainRunId}:${passenger.boardingStopId}:${passenger.alightingStopId}`;
    if (journeys.has(key)) continue;
    const journey = { schemaVersion: 'fare-journey-evidence/v1', evidenceId: `offline-test:${key}`, worldId, periodId, trainRunId: manifest.trainRunId,
      boardingStopId: passenger.boardingStopId, alightingStopId: passenger.alightingStopId, ordinaryFareCents: '1250', ticketOffice: 'available', ticketMachine: 'unknown',
      sourceId: 'explicit-fictional-game-tariff-not-real-world-fare', contentHash: '' };
    journey.contentHash = await kernel.invoke('fare.journeyHash', journey);
    journeys.set(key, journey);
  }
}
fixture.control = { economyRelease, inspectionPolicy, policeResponseModel, journeys: [...journeys.values()] };
// Die Demo verwendet die tatsächlich geprüften öffentlichen Artbytes. Ihre
// Bindung erfolgt vor dem ersten Sitzungscheckpoint; Layout- und Platzhashes
// erzeugen anschließend ausschließlich die Original-Rustfunktionen neu.
const art = JSON.parse(readFileSync(new URL('./data/art-view.json', import.meta.url), 'utf8'));
fixture.source.interior.binding.artReleaseId = art.releaseId;
fixture.source.interior.binding.artManifestHash = art.manifestSha256;
const layout = await kernel.invoke('interior.build', fixture.source.interior);
fixture.source.projection.interior = await kernel.invoke('interior.bind', {
  schemaVersion: 'conductor-interior-bind-input/v1', layout,
  trainRunId: fixture.source.projection.binding.trainRunId, service: fixture.source.projection.service,
});
if (layout.binding.artReleaseId !== art.releaseId || layout.binding.artManifestHash !== art.manifestSha256)
  throw new Error('Der native Innenraum ist nicht an den tatsächlichen Demoatlas gebunden.');
writeFileSync(fixturePath, JSON.stringify(fixture));
writeFileSync(new URL('./data/layout-art-binding.json', import.meta.url), JSON.stringify({ testOnly: true,
  artReleaseId: art.releaseId, artManifestSha256: art.manifestSha256, layoutHash: layout.layoutHash,
  passengerPlacesHash: fixture.source.projection.interior.layoutHash, sourceLayoutHash: fixture.source.projection.interior.sourceLayoutHash,
  producers: ['zugfolge_conductor::build_interior_layout', 'zugfolge_conductor::bind_interior_passenger_places'] }, null, 2));
writeFileSync(new URL('./data/control-provenance.json', import.meta.url), JSON.stringify({ testOnly: true, schemaVersion: 'offline-control-configuration/v1',
  source: 'apps/game-api/src/conductor-control.native-fixture.ts', ordinaryFareCents: '1250', inspectionPolicy,
  reason: 'Explizite Demoquoten ermöglichen geprüfte Dokumente, vorläufige Forderungen und Identitätsverweigerung; keine pro Person geänderten Tatsachen.',
  policeResponseModel, economyReleaseHash: economyRelease.checksum, journeyCount: journeys.size }, null, 2));
console.log(JSON.stringify({ testOnly: true, journeys: journeys.size, economyReleaseHash: economyRelease.checksum, inspectionPolicyHash: inspectionPolicy.contentHash }));
