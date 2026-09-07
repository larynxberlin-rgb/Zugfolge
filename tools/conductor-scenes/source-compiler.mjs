// zugfolge:quelle=db-infrago-infrastrukturdaten-open-data
// zugfolge:quelle=openstation
// zugfolge:quelle=bkg-vg250-ew-2024
import { createHash } from 'node:crypto';
import { operationalInfrastructureV2StateHash } from '../region-import/operational-infrastructure-binding.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_IDS = ['db-infrago-infrastrukturdaten-open-data', 'openstation', 'bkg-vg250-ew-2024'];
const fail = (code) => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const canonicalBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
export const readJsonSequence = (bytes) => bytes.toString('utf8').split('\x1e').filter((s) => s.trim()).map((s) => JSON.parse(s));

function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'scene_source_integer_invalid');
  return value;
}
function coordinate(point) {
  return { latitudeE7: integer(point.latitudeE7 ?? point.latitude, -900000000, 900000000),
    longitudeE7: integer(point.longitudeE7 ?? point.longitude, -1800000000, 1800000000) };
}
function isqrt(value) {
  check(typeof value === 'bigint' && value >= 0n, 'scene_source_integer_invalid');
  if (value < 2n) return value;
  let x = value; let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
function distanceMetres(a, b) {
  const dy = BigInt(a.latitudeE7 - b.latitudeE7) * 11132n / 1000000n;
  const dx = BigInt(a.longitudeE7 - b.longitudeE7) * 11132n * 61n / 100000000n;
  return isqrt(dx * dx + dy * dy);
}

/** Grobe, nur visuelle Population-Policy; keine Vermessung oder Betriebsregel. */
export function populationUrbanity(point, settlements) {
  point = coordinate(point);
  let maximum = 0n;
  for (const settlement of settlements) {
    const root = isqrt(BigInt(integer(settlement.population)));
    const radius = root * 15n < 500n ? 500n : root * 15n > 12000n ? 12000n : root * 15n;
    const strength = root * 70n > 10000n ? 10000n : root * 70n;
    const distance = distanceMetres(point, coordinate(settlement));
    const contribution = distance >= radius ? 0n : strength * (radius - distance) / radius;
    if (contribution > maximum) maximum = contribution;
  }
  return Number(maximum);
}

/** Reale Quellenauswahl ohne künstliche Gleise, Fahrstraßen oder Betriebsrechte. */
export function buildSceneSourceCatalog({ infraGo, openStation, population, rightsRegistry, sourcePins, rl100Codes, coverageBoundsE7 }) {
  check(Array.isArray(rl100Codes) && rl100Codes.length > 0 && new Set(rl100Codes).size === rl100Codes.length, 'scene_selection_invalid');
  check(population.schemaVersion === 'zugfolge-settlement-population/v1' && Array.isArray(population.settlements), 'scene_population_schema_invalid');
  const sources = SOURCE_IDS.map((sourceId) => {
    const rights = rightsRegistry.quellen.find((r) => r.id === sourceId);
    check(rights?.status === 'freigegeben' && rights.lizenz && rights.entscheidung?.datum && rights.entscheidung?.pruefer, 'scene_source_rights_not_approved');
    const pin = sourcePins.find((s) => s.sourceId === sourceId);
    check(pin && HASH.test(pin.sourceSha256) && HASH.test(pin.normalizedSha256), 'scene_source_pin_missing');
    return { sourceId, sourceSha256: pin.sourceSha256, normalizedSha256: pin.normalizedSha256,
      rightsEvidenceSha256: sha256(canonicalBytes(rights)), provenance: 'observed',
      license: rights.lizenz, attribution: rights.attribution, sourceUrl: pin.sourceUrl };
  });
  check(coverageBoundsE7 && coverageBoundsE7.west < coverageBoundsE7.east && coverageBoundsE7.south < coverageBoundsE7.north, 'scene_source_coverage_invalid');
  const settlements = population.settlements.map((p) => ({ id: p.id, name: p.name, ...coordinate(p), population: integer(p.population) }))
    .filter((p) => p.longitudeE7 >= coverageBoundsE7.west && p.longitudeE7 <= coverageBoundsE7.east
      && p.latitudeE7 >= coverageBoundsE7.south && p.latitudeE7 <= coverageBoundsE7.north).sort((a,b) => order(a.id,b.id));
  check(settlements.length > 0, 'scene_population_coverage_empty');
  const excluded = []; const stations = [];
  for (const rl100 of [...rl100Codes].sort(order)) {
    const points = infraGo.filter((s) => s.rl100 === rl100 && s.operatingStates.some((state) => state.kind === 'active'));
    const enriched = openStation.filter((s) => s.identity.rl100Codes.includes(rl100));
    if (points.length !== 1 || enriched.length !== 1) { excluded.push({rl100, reason:'station_join_not_unique'}); continue; }
    const point = points[0]; const station = enriched[0];
    const category = station.categories.station;
    // Parent quays and their children must not be double-counted as platform edges.
    const parents = new Set(station.quays.map((q) => q.parentQuayRef).filter(Boolean));
    const platforms = station.quays.filter((q) => !parents.has(q.sourceQuayRef) && q.type === 'railPlatform')
      .map((q) => ({ platformId:q.platformId, name:q.name, lengthMm:q.dimensionsMm.length, coordinateE7:q.coordinateE7 }));
    if (!Number.isInteger(category) || category < 1 || category > 7 || platforms.length === 0) {
      excluded.push({rl100,reason:'station_classification_or_platforms_missing'}); continue;
    }
    const kind = point.types.some((t) => t.code === 'Bf' || t.code === 'Bft') ? 'station'
      : point.types.some((t) => t.code === 'Hp') ? 'halt' : null;
    if (!kind) { excluded.push({rl100,reason:'station_kind_unresolved'}); continue; }
    stations.push({ operatingPointId:point.operatingPlaceId, rl100, name:station.name, kind, category,
      categorySourceId:'openstation', platformCount:platforms.length, dailyCalls:null,
      sourceIds:['db-infrago-infrastrukturdaten-open-data','openstation'], coordinateE7:coordinate(point.coordinateE7),
      sourceStationId:station.stationId, platforms, routeBindings:point.routeBindings,
      urbanityBasisPoints:populationUrbanity(coordinate(point.coordinateE7),settlements), urbanityProvenance:'derived' });
  }
  return { schemaVersion:'conductor-scene-source-catalog/v1', policyId:'conductor-urbanity-population/v1',
    coverage:'release-subset', coverageBoundsE7, sources, stations, settlements, excluded,
    limitations:['population-centres-are-not-built-up-boundaries','station-platform-route-binding-requires-operational-release',
      'no-operational-infrastructure-created','no-production-activation'] };
}

function interpolate(a, b, numerator, denominator) {
  return Number(BigInt(a) + (BigInt(b) - BigInt(a)) * BigInt(numerator) / BigInt(denominator));
}
function routeCoordinate(infrastructure, route, routeMm) {
  const leg = route.legs.find((l) => routeMm >= l.routeStartMm && routeMm <= l.routeStartMm + Math.abs(l.edgeExitMm-l.edgeEntryMm));
  check(leg, 'scene_route_geometry_missing');
  const offset = leg.edgeEntryMm + (leg.direction === 'along' ? 1 : -1) * (routeMm - leg.routeStartMm);
  const geometry = infrastructure.edgeGeometries[leg.edgeId];
  check(Array.isArray(geometry), 'scene_route_geometry_missing');
  for (let index=1;index<geometry.length;index+=1) {
    const a=geometry[index-1],b=geometry[index];
    if(offset<a.edgeOffsetMm||offset>b.edgeOffsetMm) continue;
    return {latitudeE7:interpolate(a.latitudeE7,b.latitudeE7,offset-a.edgeOffsetMm,b.edgeOffsetMm-a.edgeOffsetMm),
      longitudeE7:interpolate(a.longitudeE7,b.longitudeE7,offset-a.edgeOffsetMm,b.edgeOffsetMm-a.edgeOffsetMm)};
  }
  fail('scene_route_geometry_missing');
}
function platformIntervals(route, platform) {
  const intervals=[];
  for(const leg of route.legs) {
    if(leg.edgeId!==platform.edgeId||leg.direction!==platform.direction) continue;
    const from=Math.max(platform.fromMm,Math.min(leg.edgeEntryMm,leg.edgeExitMm));
    const to=Math.min(platform.toMm,Math.max(leg.edgeEntryMm,leg.edgeExitMm));
    if(from>=to) continue;
    const start=leg.routeStartMm+(leg.direction==='along'?from-leg.edgeEntryMm:leg.edgeEntryMm-to);
    const end=leg.routeStartMm+(leg.direction==='along'?to-leg.edgeEntryMm:leg.edgeEntryMm-from);
    if(intervals.at(-1)?.[1]===start) intervals.at(-1)[1]=end; else intervals.push([start,end]);
  }
  return intervals.filter(([start,end])=>end-start===platform.toMm-platform.fromMm);
}

/** Bindet ausschließlich vorhandene autoritative Routen. Keine Quellnamen als Gleisgeometrie. */
export function compileSceneRelease({catalog,infrastructure,infrastructureBytes,expectedInfrastructureSha256,releaseId,routeVersionIds,stationBindings,calendar}) {
  check(catalog.schemaVersion==='conductor-scene-source-catalog/v1'&&catalog.coverage==='release-subset','scene_source_catalog_invalid');
  check(HASH.test(expectedInfrastructureSha256)&&sha256(infrastructureBytes)===expectedInfrastructureSha256,'scene_infrastructure_hash_mismatch');
  check(JSON.stringify(JSON.parse(infrastructureBytes.toString('utf8')))===JSON.stringify(infrastructure),'scene_infrastructure_bytes_mismatch');
  let infrastructureStateHash;
  try { infrastructureStateHash = operationalInfrastructureV2StateHash(infrastructure); }
  catch { fail('scene_infrastructure_contract_invalid'); }
  check(routeVersionIds.length>0&&new Set(routeVersionIds).size===routeVersionIds.length,'scene_route_selection_invalid');
  const stationIndex=new Map(catalog.stations.map((s)=>[s.operatingPointId,s]));
  const usedStations=new Set();
  const routes=routeVersionIds.map((routeId)=> {
    const route=infrastructure.routeVersions[routeId];check(route,'scene_route_missing_in_infrastructure');
    const last=route.legs.at(-1);const lengthMm=last.routeStartMm+Math.abs(last.edgeExitMm-last.edgeEntryMm);
    const samplePositions=new Set([0,lengthMm]);
    for(let at=0;at<lengthMm;at+=100000)samplePositions.add(at);
    for(const leg of route.legs)for(const point of infrastructure.edgeGeometries[leg.edgeId]??[]) {
      const offset=leg.direction==='along'?point.edgeOffsetMm-leg.edgeEntryMm:leg.edgeEntryMm-point.edgeOffsetMm;
      if(offset>=0&&offset<=Math.abs(leg.edgeExitMm-leg.edgeEntryMm))samplePositions.add(leg.routeStartMm+offset);
    }
    const urbanity=[...samplePositions].sort((a,b)=>a-b).map((routeMm)=> {
      const point=routeCoordinate(infrastructure,route,routeMm),box=catalog.coverageBoundsE7;
      // 12 km maximum influence radius with a conservative integer geographic margin.
      check(point.longitudeE7>=box.west+1800000&&point.longitudeE7<=box.east-1800000
        &&point.latitudeE7>=box.south+1100000&&point.latitudeE7<=box.north-1100000,'scene_population_route_coverage_missing');
      return {routeMm,urbanityBasisPoints:populationUrbanity(point,catalog.settlements)};
    });
    const stations=stationBindings.filter((b)=>b.routeVersionId===routeId).map((binding)=> {
      const station=stationIndex.get(binding.operatingPointId);check(station,'scene_station_source_missing');
      const sourcePlatform=station.platforms.find((p)=>p.platformId===binding.sourcePlatformId);
      check(sourcePlatform,'scene_platform_source_missing');
      const platform=infrastructure.platformIntervals[binding.platformId];check(platform,'scene_platform_missing_in_infrastructure');
      const spans=platformIntervals(route,platform);check(spans.length===1,'scene_platform_route_binding_not_unique');
      if(sourcePlatform.lengthMm!==null)check(platform.toMm-platform.fromMm===sourcePlatform.lengthMm,'scene_platform_source_length_mismatch');
      usedStations.add(station.operatingPointId);
      return {operatingPointId:station.operatingPointId,platformId:binding.platformId,platformLabel:sourcePlatform.name,
        fromRouteMm:spans[0][0],toRouteMm:spans[0][1]};
    }).sort((a,b)=>order(a.operatingPointId,b.operatingPointId)||order(a.platformId,b.platformId));
    const signals=Object.values(infrastructure.interlockingRoutes).filter((r)=>r.routeTemplateId===route.templateId)
      .map((r)=>({signalId:r.signalId,routeMm:r.authorityStartRouteMm}));
    const uniqueSignals=[...new Map(signals.map((s)=>[`${s.signalId}:${s.routeMm}`,s])).values()].sort((a,b)=>order(a.signalId,b.signalId));
    return {routeVersionId:routeId,lengthMm,sourceIds:['bkg-vg250-ew-2024','derived:conductor-urbanity-population/v1'],urbanity,stations,signals:uniqueSignals};
  }).sort((a,b)=>order(a.routeVersionId,b.routeVersionId));
  const sources=catalog.sources.map(({sourceId,sourceSha256,rightsEvidenceSha256,provenance})=>({sourceId,sourceSha256,rightsEvidenceSha256,provenance}));
  sources.push({sourceId:'derived:conductor-urbanity-population/v1',sourceSha256:sha256(canonicalBytes(catalog)),
    rightsEvidenceSha256:catalog.sources.find((s)=>s.sourceId==='bkg-vg250-ew-2024').rightsEvidenceSha256,provenance:'derived'});
  return {schemaVersion:'conductor-scene-release/v1',releaseId,infraReleaseId:infrastructure.id,infraReleaseHash:infrastructureStateHash,
    policyId:'conductor-scenes/v1',coverage:'release-subset',sources:sources.sort((a,b)=>order(a.sourceId,b.sourceId)),
    stations:[...usedStations].sort(order).map((id)=> {
      const {operatingPointId,name,kind,category,categorySourceId,platformCount,dailyCalls,sourceIds}=stationIndex.get(id);
      return {operatingPointId,name,kind,category,categorySourceId,platformCount,dailyCalls,sourceIds};
    }),routes,calendar};
}
