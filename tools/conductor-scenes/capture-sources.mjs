// Offline capture of already downloaded, independently pinned original sources.
// zugfolge:quelle=db-infrago-infrastrukturdaten-open-data
// zugfolge:quelle=openstation
// zugfolge:quelle=bkg-vg250-ew-2024
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSceneSourceCatalog, canonicalBytes, readJsonSequence, sha256 } from './source-compiler.mjs';

const ROOT=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const [cacheDirectory,populationPath,outputDirectory]=process.argv.slice(2);
if(!cacheDirectory||!populationPath||!outputDirectory)throw new Error('capture-sources CACHE_DIRECTORY POPULATION_JSON OUTPUT_DIRECTORY');
const selected=['LL','LSEH','LLPDH','LBOR','LGE','LMAC','LALT','LWZW','LWZ'];
const bounds={west:118000000,east:130000000,south:510000000,north:517000000};
const config=[
  {sourceId:'db-infrago-infrastrukturdaten-open-data',original:'infrago-2026-05.gpkg',normalized:'normalized/db-infrago-operating-places.jsonseq',
    sourceSha256:'79f8227e889769d87dcc77301f58adbc93a31839febb0cd1bdb16679e25453fe',
    sourceUrl:'https://mobilithek.info/mdp-api/files/aux/922109165921083392/Infrastrukturdaten.gpkg'},
  {sourceId:'openstation',original:'openstation-2026-09-06.xml',normalized:'openstation/openstation-stations.jsonseq',
    sourceSha256:'f1df5067758e9c25d0129b033ec963012fbb2aaffca3abf4b61cfeba534a35cb',sourceUrl:'https://bahnhof.de/daten/netex'},
];
const sourcePins=[];const normalized=[];
for(const source of config) {
  const original=await readFile(join(cacheDirectory,source.original));
  if(sha256(original)!==source.sourceSha256)throw new Error('scene_capture_original_hash_mismatch');
  const bytes=await readFile(join(cacheDirectory,source.normalized));
  sourcePins.push({sourceId:source.sourceId,sourceSha256:source.sourceSha256,sourceUrl:source.sourceUrl,sourceBytes:original.length,normalizedSha256:sha256(bytes)});
  normalized.push(readJsonSequence(bytes));
}
const populationBytes=await readFile(populationPath);
if(sha256(populationBytes)!=='46388da8822295a15df02c9fc11f04c54f15bbf4c4be5cc3879925b63c030fa6')throw new Error('scene_capture_population_hash_mismatch');
const populationArchive=await readFile(join(dirname(populationPath),'vg250-ew-2024-excel.zip'));
if(sha256(populationArchive)!=='d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3')throw new Error('scene_capture_population_original_hash_mismatch');
sourcePins.push({sourceId:'bkg-vg250-ew-2024',sourceSha256:'d5564af137d2dde65c23ceb8336f6c35fdf67260ba48058ced9004a2c5c000b3',
  sourceUrl:'https://daten.gdz.bkg.bund.de/produkte/vg/vg250-ew_ebenen_1231/2024/vg250-ew_12-31.ee.excel.ebenen.zip',sourceBytes:populationArchive.length,normalizedSha256:sha256(populationBytes)});
const population=JSON.parse(populationBytes.toString('utf8'));
const rightsRegistry=JSON.parse(await readFile(join(ROOT,'tools/guards/quellenregister.json'),'utf8'));
const args={infraGo:normalized[0],openStation:normalized[1],population,rightsRegistry,sourcePins,rl100Codes:selected,coverageBoundsE7:bounds};
const catalog=buildSceneSourceCatalog(args);
const selection={schemaVersion:'conductor-scene-source-selection/v1',rl100Codes:selected,coverageBoundsE7:bounds,sourcePins,
  infraGo:normalized[0].filter((s)=>selected.includes(s.rl100)),
  openStation:normalized[1].filter((s)=>s.identity.rl100Codes.some((id)=>selected.includes(id))),
  population:{...population,settlements:catalog.settlements},
  rightsRegistry:{version:rightsRegistry.version,quellen:rightsRegistry.quellen.filter((r)=>sourcePins.some((s)=>s.sourceId===r.id))}};
const selectionBytes=canonicalBytes(selection),catalogBytes=canonicalBytes(catalog);
const evidence={schemaVersion:'conductor-scene-source-proof/v1',coverage:'release-subset',selectionSha256:sha256(selectionBytes),catalogSha256:sha256(catalogBytes),
  sourcePins,sourceCounts:{infraGo:normalized[0].length,openStation:normalized[1].length,population:population.settlements.length},
  selectedCounts:{stations:catalog.stations.length,settlements:catalog.settlements.length,excluded:catalog.excluded.length},
  categories:[...new Set(catalog.stations.map((s)=>s.category))].sort((a,b)=>a-b),
  operationalReleaseAttached:false,limitations:catalog.limitations};
await mkdir(outputDirectory,{recursive:true});
for(const [name,bytes] of [['selection.json',selectionBytes],['catalog.json',catalogBytes],['evidence.json',canonicalBytes(evidence)]])
  await writeFile(join(outputDirectory,name),bytes);
console.log(JSON.stringify(evidence));
