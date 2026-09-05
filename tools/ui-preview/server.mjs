import { createServer } from "../../apps/game-web/node_modules/vite/dist/node/index.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { worldId, operatorId, playerContext, trains, mailbox, cities, corridors } from "./fixtures.mjs";

const root = fileURLToPath(new URL("../../",import.meta.url));
const port = Number(process.env.UI_PREVIEW_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
const emptyArchive = Buffer.alloc(130);
emptyArchive.write("PMTiles");emptyArchive[7]=3;
for(const [offset,value] of [[8,127],[16,1],[24,128],[32,2],[40,130],[56,130]]) emptyArchive.writeBigUInt64LE(BigInt(value),offset);
emptyArchive[97]=1;emptyArchive[98]=1;emptyArchive[99]=1;emptyArchive[100]=0;emptyArchive[101]=14;
for(const [offset,value] of [[102,5e7],[106,47e7],[110,16e7],[114,56e7],[119,10e7],[123,51e7]])emptyArchive.writeInt32LE(value,offset);
emptyArchive[118]=5;emptyArchive.write("{}",128);
const fc = features => ({type:"FeatureCollection",features});
const feature=(geometry,properties={})=>({type:"Feature",properties,geometry});
const germany=[[6.1,50.1],[6.0,51.0],[6.8,51.9],[7.0,53.3],[8.5,53.6],[8.7,54.7],[9.5,54.85],[10.1,54.8],[10.2,54.1],[11.1,54.4],[12.3,54.5],[13.4,54.6],[14.3,53.9],[14.6,53.1],[14.5,52.0],[14.9,51.0],[14.5,50.8],[13.4,50.6],[12.2,50.2],[12.5,49.5],[13.8,48.8],[13.0,47.7],[12.1,47.6],[11.0,47.4],[10.2,47.4],[9.5,47.6],[8.4,47.6],[7.7,47.5],[7.6,48.1],[8.2,49.0],[7.1,49.1],[6.4,49.5],[6.1,50.1]];
const previewStyle={version:8,sources:{country:{type:"geojson",data:fc([feature({type:"Polygon",coordinates:[germany]})])},routes:{type:"geojson",data:fc(corridors.map(([a,b])=>feature({type:"LineString",coordinates:[cities[a].p,cities[b].p]})))},cities:{type:"geojson",data:fc(cities.map(city=>feature({type:"Point",coordinates:city.p},{name:city.name})))}},layers:[{id:"background",type:"background",paint:{"background-color":"#111e28"}},{id:"country",type:"fill",source:"country",paint:{"fill-color":"#1b2c32"}},{id:"boundary",type:"line",source:"country",paint:{"line-color":"#596868","line-width":1,"line-opacity":.7}},{id:"routes-casing",type:"line",source:"routes",paint:{"line-color":"#101d26","line-width":6}},{id:"routes",type:"line",source:"routes",paint:{"line-color":"#68827e","line-width":1.5}},{id:"city-dots",type:"circle",source:"cities",paint:{"circle-color":"#c3d3cc","circle-radius":3,"circle-stroke-color":"#17232c","circle-stroke-width":2}},{id:"city-labels",type:"symbol",source:"cities",layout:{"text-field":["get","name"],"text-font":["Segoe UI"],"text-size":12,"text-anchor":"top","text-offset":[0,1]},paint:{"text-color":"#d4e0e3","text-halo-color":"#17232c","text-halo-width":2}}]};
let server;
server=await createServer({root,appType:"custom",server:{host:"127.0.0.1",port,strictPort:true},plugins:[{name:"zugfolge-ui-preview",configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url,origin);
  const json=(body)=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(body));};
  if (["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"].some(name => url.pathname === "/node_modules/.vite/deps/" + name)) {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(new URL("../../apps/livemap/node_modules/maplibre-gl/dist/" + url.pathname.split("/").at(-1), import.meta.url)));
    return;
  }
  if(url.pathname.endsWith("/livemap/config"))return json({schemaVersion:"zugfolge-livemap-config/v2",worldId,worldName:"Deutschland · Vorschau",infrastructureReleaseId:"preview-infra",basemap:{styleUrl:"/artifacts/preview/style.json",attribution:"Illustrative Vorschaukarte · keine Betriebsdaten",selfHosted:true},infrastructure:{pmtilesUrl:"/artifacts/preview/empty.pmtiles",attribution:"Vorschau",coverage:"DE"},initialView:{latitudeE7:51e7,longitudeE7:10e7,zoomMilli:5000},playableArea:{label:"Deutschland",boundsE7:{west:55e6,east:156e6,south:47e7,north:552e6}}});
  if(url.pathname.endsWith("/operator-context"))return json(playerContext);
  if(url.pathname.endsWith("/mailbox"))return json(mailbox);
  if(url.pathname.endsWith("/livemap/snapshot"))return json({worldId,streamId:"preview",sequence:1,at:4000,trains});
  if(url.pathname.endsWith("/livemap/events")){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});res.write(": preview fixture\n\n");const timer=setInterval(()=>res.write(": keepalive\n\n"),3000);req.on("close",()=>clearInterval(timer));return;}
  if(url.pathname.includes("/livemap/trains/")){const train=trains.find(t=>url.pathname.endsWith('/'+t.id));if(!train||url.pathname.includes("/operators/")){res.statusCode=404;return json({error:"not-found"});}return json({schemaVersion:"zugfolge-public-train-detail/v1",worldId,atS:4000,movement:"network",train,fis:{category:train.category,trainNumber:train.trainNumber,destination:train.nextOperatingPoint,nextStop:train.nextOperatingPoint,followingStops:[],messages:[],delaySeconds:train.delaySeconds}});}
  if(url.pathname==="/artifacts/preview/style.json")return json(previewStyle);
  if(url.pathname==="/artifacts/preview/empty.pmtiles"){const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range??"");let begin=0,end=emptyArchive.length-1;if(match){begin=Number(match[1]);end=Math.min(end,Number(match[2]||end));res.statusCode=206;res.setHeader("Content-Range",`bytes ${begin}-${end}/${emptyArchive.length}`);}res.setHeader("Content-Type","application/octet-stream");res.setHeader("Accept-Ranges","bytes");res.end(emptyArchive.subarray(begin,end+1));return;}
  if(url.pathname==="/assets/railway/departure.png"){res.setHeader("Content-Type","image/png");res.end(await readFile(new URL("../../apps/game-web/public/assets/railway/departure.png",import.meta.url)));return;}
  if(url.pathname==="/"){
    const section=url.searchParams.get("section");
    const screen=url.searchParams.get("screen")??(url.searchParams.get("view")==="diagram"?"planner":section==="operations"?"workshop":section==="world"?"entry":section??"map");
    const runtime={gameApiUrl:origin,keycloakUrl:origin+"/auth",publicWorldId:worldId,gameWebUrl:origin+"/",operationsCenterUrl:origin+"/?screen=operations",livemapUrl:origin+"/?screen=map"};
    const html=`<!doctype html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zugfolge · UI-Vorschau</title><style>.preview-label{position:fixed;left:12px;bottom:8px;z-index:60;font:8px system-ui;color:#b9c6d2;pointer-events:none}@media(max-width:760px){.preview-label{bottom:68px;left:auto;right:115px}}</style><script>globalThis.__ZUGFOLGE_RUNTIME_CONFIG__=${JSON.stringify(runtime)};for(const client of ['livemap','game-web','operations-center']){sessionStorage.setItem('zugfolge.oidc.'+client+'.accessToken','preview-only');sessionStorage.setItem('zugfolge.oidc.'+client+'.accessTokenExpiresAt',String(Date.now()+3600000));}localStorage.setItem('zugfolge:game-hints:v1',JSON.stringify({enabled:false,visited:[]}));</script></head><body><div id="root"></div><span class="preview-label">VORSCHAU · BEISPIELDATEN</span><script type="module" src="${screen==='map'?'/apps/livemap/src/main.ts':'/tools/ui-preview/main.ts'}"></script></body></html>`;
    res.setHeader("Content-Type","text/html");res.end(await vite.transformIndexHtml(url.pathname,html));return;
  }
  next();
});}}]});
await server.listen();
console.log(`Zugfolge UI preview: ${origin}/?screen=map`);
