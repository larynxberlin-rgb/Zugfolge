import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSceneSourceCatalog, compileSceneRelease, populationUrbanity, canonicalBytes, sha256 } from './source-compiler.mjs';

const selection=JSON.parse(await readFile(new URL('./sources/selection.json',import.meta.url),'utf8'));
const catalog=JSON.parse(await readFile(new URL('./sources/catalog.json',import.meta.url),'utf8'));
const evidence=JSON.parse(await readFile(new URL('./sources/evidence.json',import.meta.url),'utf8'));

test('real pinned InfraGO/OpenStation/BKG selection reproduces every catalog byte',()=> {
  assert.equal(sha256(canonicalBytes(selection)),evidence.selectionSha256);
  const actual=buildSceneSourceCatalog(selection);
  assert.deepEqual(actual,catalog);
  assert.equal(sha256(canonicalBytes(actual)),evidence.catalogSha256);
  assert.equal(actual.stations.length,9);
  assert.equal(actual.settlements.length,112);
  assert.deepEqual(actual.excluded,[]);
  assert.deepEqual(actual.stations.filter((s)=>s.category<=2).map((s)=>s.name),['Leipzig Hbf']);
  assert.equal(actual.stations.find((s)=>s.rl100==='LGE').category,6);
  assert.equal(actual.stations.find((s)=>s.rl100==='LBOR').category,5);
  assert.ok(actual.stations.every((s)=>s.dailyCalls===null));
  assert.equal(evidence.operationalReleaseAttached,false);
});

test('names cannot create urbanity and unapproved rights cannot enter the catalog',()=> {
  const point=catalog.stations.find((s)=>s.rl100==='LL').coordinateE7;
  const original=populationUrbanity(point,catalog.settlements);
  assert.equal(populationUrbanity(point,catalog.settlements.map((s)=>({...s,name:'Unrelated words'}))),original);
  assert.equal(populationUrbanity(point,catalog.settlements.map((s)=>({...s,population:0}))),0);
  const denied=structuredClone(selection);denied.rightsRegistry.quellen[0].status='gesperrt';
  assert.throws(()=>buildSceneSourceCatalog(denied),/scene_source_rights_not_approved/u);
  const ambiguous=structuredClone(selection);ambiguous.openStation.push(ambiguous.openStation[0]);
  const report=buildSceneSourceCatalog(ambiguous);
  assert.ok(report.excluded.some((e)=>e.reason==='station_join_not_unique'));
});

// This small compiler unit input is explicitly fictional; it is no production railway proof.
function compilerInput() {
  const station=catalog.stations.find((s)=>s.rl100==='LL');
  const sourcePlatform=station.platforms.find((p)=>p.lengthMm!==null&&p.lengthMm>0&&p.lengthMm<400000);
  const center=station.coordinateE7,length=sourcePlatform.lengthMm;
  const infrastructure={id:'infra:compiler-unit-test',directedEdges:{'test:edge':{}},rzueLayoutId:'rzue:unit-test',
    signals:['test:signal'],switches:[],blockResources:['test:block','test:overlap','test:flank'],regionBoundaries:[],
    routeVersions:{'test:route':{id:'test:route',templateId:'test:template',legs:[{edgeId:'test:edge',direction:'along',edgeEntryMm:0,edgeExitMm:500000,routeStartMm:0}]}},
    edgeGeometries:{'test:edge':[{edgeOffsetMm:0,latitudeE7:center.latitudeE7,longitudeE7:center.longitudeE7},
      {edgeOffsetMm:500000,latitudeE7:center.latitudeE7,longitudeE7:center.longitudeE7+50000}]},
    platformIntervals:{'test:platform':{edgeId:'test:edge',direction:'along',fromMm:0,toMm:length}},
    interlockingRoutes:{'test:locking':{routeTemplateId:'test:template',signalId:'test:signal',authorityStartRouteMm:0,
      pathResources:['test:block'],overlapResources:['test:overlap'],flankResources:['test:flank']}}};
  const infrastructureBytes=canonicalBytes(infrastructure);
  return {catalog,infrastructure,infrastructureBytes,expectedInfrastructureSha256:sha256(infrastructureBytes),releaseId:'scene:compiler-unit-test',
    routeVersionIds:['test:route'],stationBindings:[{operatingPointId:station.operatingPointId,routeVersionId:'test:route',
      sourcePlatformId:sourcePlatform.platformId,platformId:'test:platform'}],
    calendar:{epochUtcTimeOfDayMs:0,offsets:[{fromMs:0,untilMs:86400000,utcOffsetMinutes:60}]}};
}

test('compiler samples existing route geometry and preserves independently sourced station facts',()=> {
  const input=compilerInput(),before=sha256(input.infrastructureBytes);
  const output=compileSceneRelease(input);
  assert.equal(output.stations[0].name,'Leipzig Hbf');assert.equal(output.stations[0].category,1);
  assert.equal(output.stations[0].dailyCalls,null);
  assert.match(output.infraReleaseHash,/^[a-f0-9]{64}$/u);
  assert.notEqual(output.infraReleaseHash,input.expectedInfrastructureSha256,'Canonical infrastructure state and original file bytes have separate pins');
  assert.equal(output.routes[0].urbanity.length,6);
  assert.deepEqual(output.routes[0].urbanity.map((p)=>p.routeMm),[0,100000,200000,300000,400000,500000]);
  assert.ok(output.routes[0].urbanity.every((p)=>p.urbanityBasisPoints>=0&&p.urbanityBasisPoints<=10000));
  assert.equal(sha256(input.infrastructureBytes),before);
  assert.deepEqual(compileSceneRelease(input),output);
});

test('missing actual release, route, platform, scope or byte pin never creates substitute infrastructure',()=> {
  for(const change of [
    (i)=>{i.expectedInfrastructureSha256='0'.repeat(64);},
    (i)=>{i.routeVersionIds=['unknown'];},
    (i)=>{i.stationBindings[0].platformId='unknown';},
    (i)=>{i.stationBindings[0].sourcePlatformId='unknown';},
    (i)=>{i.catalog.coverageBoundsE7={west:0,east:100,south:0,north:100};},
  ]) {
    const input=structuredClone(compilerInput());input.infrastructureBytes=Buffer.from(input.infrastructureBytes);change(input);
    assert.throws(()=>compileSceneRelease(input),/scene_/u);
  }
});
