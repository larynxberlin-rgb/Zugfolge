// Explizite lokale Szenenquelle, nativ gegen die tatsächliche Demo-Infrastruktur geprüft.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { nativeExample, outputPath } from './paths.mjs';
import { conductorSceneNativeFixture } from '../../apps/game-api/dist/conductor-scene.native-fixture.js';
import { callInteriorFixtureRust } from '../../apps/game-api/dist/conductor-interior.native-fixture.js';
import { loadConductorSceneDeployment } from '../../apps/game-api/dist/conductor-scene-configuration.js';

const fixture=JSON.parse(await readFile(new URL('./data/fixture.json',import.meta.url),'utf8'));
const world=fixture.source.operationalWorld;
const trainId=fixture.source.projection.binding.trainRunId;
const train=world.trains[trainId];
const infrastructureStateHash=createHash('sha256').update(JSON.stringify(fixture.infrastructure)).digest('hex');
const addonPath=process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH;
process.env.ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY=nativeExample('scene_json','ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY');
const preparation=outputPath('preparation/scene');
await mkdir(preparation,{recursive:true});
const result=await conductorSceneNativeFixture({directory:preparation,
  worldId:world.worldId,periodId:fixture.source.sessionPolicy.periodId,regionId:world.regionId,infrastructure:fixture.infrastructure,
  infrastructureStateHash,routeVersionId:train.routeVersionId,stops:train.passengerStops.plan.stops,
  artReleaseId:fixture.source.interior.binding.artReleaseId,artManifestHash:fixture.source.interior.binding.artManifestHash});
const releasePath=resolve(preparation,'conductor-scene-fixture.json');
const release=JSON.parse(await readFile(releasePath,'utf8'));
// Authored names belong only to this fictional practice route. Actual stop,
// route and platform identities remain the original native fixture identities.
const names=['Ährenfeld','Südstadt','Hauptbahnhof'];
if(release.stations.length!==names.length)throw new Error('offline_scene_station_count_mismatch');
for(const [index,station] of release.stations.entries())station.name=names[index];
for(const route of release.routes)for(const station of route.stations)station.platformLabel='1';
const authoredSource={schemaVersion:'conductor-offline-authored-scene/v1',testOnly:true,
  source:'Authored fictional practice names; no real-world station classification is claimed.',
  stations:release.stations.map(({operatingPointId,name,kind,category})=>({operatingPointId,name,kind,category})),platformLabel:'1'};
const sourceBytes=JSON.stringify(authoredSource)+'\n';
await writeFile(new URL('./data/scene-authored-source.json',import.meta.url),sourceBytes);
release.sources[0].sourceSha256=createHash('sha256').update(sourceBytes).digest('hex');
const validation=JSON.parse(addonPath
  ? createRequire(import.meta.url)(resolve(addonPath)).validateConductorSceneInfrastructure(JSON.stringify([release,fixture.infrastructure]))
  : callInteriorFixtureRust(process.env.ZUGFOLGE_CONDUCTOR_SCENE_TEST_BINARY,['validate-infrastructure'],[release,fixture.infrastructure]));
if(validation.valid!==true)throw new Error('offline_scene_infrastructure_rejected');
const releaseHash=result.runtime.releaseHash(release),releaseBytes=JSON.stringify(release)+'\n';
await writeFile(new URL('./data/conductor-scene-fixture.json',import.meta.url),releaseBytes);
await writeFile(releasePath,releaseBytes);
const deploymentPath=resolve(preparation,'conductor-scene-deployment.json');
const deployment=JSON.parse(await readFile(deploymentPath,'utf8'));
const region=deployment.periods[0].regions[0];
region.sceneReleaseHash=releaseHash;region.sceneFileSha256=createHash('sha256').update(releaseBytes).digest('hex');
const deploymentBytes=JSON.stringify(deployment)+'\n';
await writeFile(deploymentPath,deploymentBytes);
await loadConductorSceneDeployment({path:deploymentPath,expectedSha256:createHash('sha256').update(deploymentBytes).digest('hex'),
  worldId:world.worldId,runtime:result.runtime,allowTestFixtures:true});
await writeFile(new URL('./data/scene.json',import.meta.url),JSON.stringify({testOnly:true,release,releaseHash,
  infrastructureStateHash,source:result.source}));
console.log(JSON.stringify({sceneReleaseHash:releaseHash,coverage:release.coverage,routes:release.routes.length,stations:release.stations.map(({name})=>name)}));
