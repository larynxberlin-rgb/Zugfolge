import { artifact, outputPath, browserLaunchOptions } from "./paths.mjs";
import assert from 'node:assert/strict';
import {chromium} from '../../apps/game-api/node_modules/playwright-core/index.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),out=outputPath('animation');
await mkdir(out,{recursive:true});
const html=artifact,htmlSha256=createHash('sha256').update(await readFile(html)).digest('hex');
const browser=await chromium.launch(await browserLaunchOptions());
const context=await browser.newContext({viewport:{width:1440,height:960},hasTouch:true,offline:true});
const page=await context.newPage(),errors=[],network=[],checks=[],screenshots=[];let passed=false;
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^(https?|wss?):/u.test(r.url()))network.push(r.url());});
const snapshot=()=>page.evaluate(()=>window.__zugfolgeOfflineDemo.snapshot());
const log=(name,data)=>{checks.push({name,...data});console.log(JSON.stringify(checks.at(-1)));};
async function ready(){await page.waitForFunction(()=>document.documentElement.dataset.offlineReady==='true');}
async function opened(){await page.waitForFunction(()=>document.querySelector('.game-canvas')?.dataset.renderer==='canvas2d');}
async function waitState(test,timeout=80000){const end=Date.now()+timeout;while(Date.now()<end){const s=await snapshot();if(test(s))return s;await page.waitForTimeout(250);}throw Error('State timeout');}
async function capture(name){const bytes=await page.screenshot({path:resolve(out,name)});screenshots.push({file:name,sha256:createHash('sha256').update(bytes).digest('hex')});}
async function measure(duration,region){return page.evaluate(async({duration,region})=>{
 const c=document.querySelector('.game-canvas'),ctx=c.getContext('2d'),dt=[],samples=new Map(),start=performance.now();let previous=start,breathing=null;
 await new Promise(done=>{function frame(now){dt.push(now-previous);previous=now;
  if(region&&c.dataset.playerAnimation==='idle'){
   const key=c.dataset.playerFrame,breath=c.dataset.playerBreath,pixels=ctx.getImageData(region.x,region.y,32,41).data;
   const prior=samples.get(key);if(prior&&prior.breath!==breath&&!breathing){let upper=0,feet=0;for(let i=0;i<pixels.length;i++)if(pixels[i]!==prior.pixels[i]){if(Math.floor(i/128)<32)upper++;else feet++;}breathing={frame:key,upperChangedChannels:upper,footChangedChannels:feet};}
   if(!prior)samples.set(key,{breath,pixels});
  }
  if(now-start>=duration)done();else requestAnimationFrame(frame);
 }requestAnimationFrame(frame);});
 const sorted=dt.slice(1).sort((a,b)=>a-b);return {frames:dt.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),over50:sorted.filter(n=>n>50).length,breathing,idleFrameVariants:[...samples.keys()],dataset:{...c.dataset}};
},{duration,region});}
try{
 await page.goto(pathToFileURL(html).href);await ready();await page.getByTestId('demo-start').click();await opened();await page.waitForTimeout(1600);
 const before=await snapshot();const region=await page.locator('.game-canvas').evaluate((c,s)=>{
  const p=s.snapshot.position,b=s.layout.vehicles.find(v=>v.vehicleId===p.vehicleId).bodies.find(b=>b.bodyId===p.bodyId),half=c.width/2,w=b.lengthMm*.032;
  const center=w<c.width?w/2:Math.max(half-20,Math.min(w-half+20,p.xMm*.032));
  return {x:Math.round(half-center)+Math.round(p.xMm*.032)-16,y:Math.round(c.height*.54-b.widthMm*.032/2)+Math.round(p.yMm*.032+12)-38};
 },before);
 const firstScroll=Number(await page.locator('.game-canvas').getAttribute('data-scene-scroll-mm'));
 const idle=await measure(6800,region);const after=await snapshot();
 assert.deepEqual(after.snapshot.position,before.snapshot.position);assert.ok(idle.breathing?.upperChangedChannels>0);assert.equal(idle.breathing.footChangedChannels,0);assert.ok(idle.idleFrameVariants.length>1);assert.ok(Number(idle.dataset.sceneScrollMm)>firstScroll);assert.ok(idle.p95<50);
 log('idle-body-pixels-change-with-fixed-feet-and-native-position',{...idle,initialSceneScrollMm:firstScroll,position:after.snapshot.position});await capture('01-idle-desktop.png');
 await page.getByTestId('game-stage').focus();await page.keyboard.down('ArrowRight');const moving=await measure(3000);await page.keyboard.up('ArrowRight');await page.waitForTimeout(400);
 const walked=await snapshot();assert.ok(walked.snapshot.position.xMm>after.snapshot.position.xMm);assert.ok(moving.p95<50);log('held-walking-and-render-cadence',{...moving,from:after.snapshot.position,to:walked.snapshot.position});
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(200);const reduced=await measure(1000,undefined);assert.equal(reduced.dataset.playerBreath,'0');assert.equal(reduced.dataset.reducedMotion,'true');log('reduced-motion',{dataset:reduced.dataset});await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);
 const touchBefore=(await snapshot()).snapshot.position;const button=await page.locator('[data-direction="right"]').boundingBox();const cdp=await context.newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:button.x+button.width/2,y:button.y+button.height/2}]});await page.waitForTimeout(1200);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350);
 const touchAfter=(await snapshot()).snapshot.position;assert.ok(touchAfter.xMm>touchBefore.xMm);log('actual-held-touch-walking',{from:touchBefore,to:touchAfter});await capture('02-mobile-idle.png');
 await page.getByTestId('game-practice').selectOption({index:1});await waitState(s=>s.snapshot.activeEncounter?.status==='active');await page.getByTestId('game-passenger-text').waitFor();await page.waitForTimeout(350);
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});await page.waitForTimeout(200);
  const bounds=await page.evaluate(()=>{
   const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
   return {width:innerWidth,scroll:document.documentElement.scrollWidth,speech:box('.game-speech'),conversation:box('.game-conversation'),buttons:[...document.querySelectorAll('.game-answers button')].map(b=>({text:b.innerText,height:b.getBoundingClientRect().height})),text:document.querySelector('.game-speech').innerText};
  });
  assert.equal(bounds.width,bounds.scroll);assert.ok(bounds.speech.x>=0&&bounds.speech.right<=width&&bounds.speech.y>=0&&bounds.speech.bottom<=844);assert.ok(bounds.conversation.x>=0&&bounds.conversation.right<=width);assert.ok(bounds.buttons.every(b=>b.height>=38));log('mobile-conversation-layout',{...bounds});await capture(`03-mobile-${width}-speech.png`);
 }
 await page.setViewportSize({width:1440,height:960});await page.waitForTimeout(300);
 const end=Date.now()+30000;while(await page.locator('.game-answers button[data-option-id="check"]').isDisabled()){if(Date.now()>end)throw Error('Check not ready');await page.waitForTimeout(200);}
 await page.locator('.game-answers button[data-option-id="check"]').click();await waitState(s=>s.snapshot.activeEncounter?.hints.documentStatus==='verified_valid');
 await page.locator('.game-answers button[data-option-id="close"]').click();await page.waitForTimeout(500);
 if(await page.getByTestId('game-continue').isVisible())await page.getByTestId('game-continue').click();
 // Capture actual browser frames; GIF assembly only converts the recorded images.
 const p=(await snapshot()).snapshot.position;assert.equal(p.deckId,'upper');
 await mkdir(resolve(out,'frames'),{recursive:true});
 const frameTimes=[];
 for(let i=0;i<32;i++){frameTimes.push(Date.now());await page.screenshot({path:resolve(out,'frames',`${String(i).padStart(2,'0')}.png`),clip:{x:380,y:310,width:680,height:430}});await page.waitForTimeout(160);}
 await writeFile(resolve(out,'frames','timing.json'),JSON.stringify({htmlSha256,times:frameTimes}));
 const still=(await snapshot()).snapshot.position;assert.deepEqual(still,p);log('actual-idle-recording',{frames:32,clip:{x:380,y:310,width:680,height:430},nativeAnchorUnchanged:true});
 assert.deepEqual(errors,[]);assert.deepEqual(network,[]);assert.deepEqual(await page.locator('.game-error:visible,.demo-error:visible').allTextContents(),[]);passed=true;
}catch(e){await capture('failure.png').catch(()=>{});throw e;}finally{
 await writeFile(resolve(out,'animation-browser-report.json'),JSON.stringify({schemaVersion:'conductor-offline-animation-browser/v1',htmlSha256,offline:true,passed,checks,screenshots,errors,network},null,2)+'\n');await browser.close();
}
