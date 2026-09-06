import { chromium } from "../../apps/game-api/node_modules/playwright-core/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const origin=process.env.UI_PREVIEW_ORIGIN??"http://127.0.0.1:4173";
const output=fileURLToPath(new URL("../../docs/ui-redesign/screenshots/",import.meta.url));
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:process.platform==="win32"?{channel:"msedge"}:{})});
const results=[];
const errors=[];
const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:"reduce"});
page.on("pageerror",error=>errors.push(error.message));
try {
  for(const [screen,name,hash] of [["map"],["entry"],["foundation"],["company"],["company","fleet","company-fleet"],["markets"],["markets","vehicles","vehicle-market"],["markets","cooperation","cooperation-contracts"],["mailbox"],["workshop"],["operations"],["program"],["reports"],["planner"]]){
    await page.goto(`${origin}/?screen=${screen}${hash ? "#"+hash : ""}`);
    await page.locator(".zf-brand").waitFor();
    if(hash)await page.locator(`#tab-${hash}[aria-selected="true"]`).waitFor();
    if(screen==="map"){await page.waitForFunction(()=>document.querySelector("#network-active")?.textContent!=="—");await page.locator("#map-state.quiet").waitFor({state:"attached"});}
    await page.screenshot({path:`${output}/${name??screen}.png`,fullPage:false});
    const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,navLinks:[...document.querySelectorAll('.rail-nav__link')].map(link=>({label:link.textContent.trim(),width:link.getBoundingClientRect().width,height:link.getBoundingClientRect().height})),map:document.querySelector('#map')?.getBoundingClientRect().toJSON()}));
    results.push({screen:name??screen,viewport:"desktop",...layout});
  }
  await page.goto(`${origin}/?screen=markets#vehicle-market`);
  await page.getByRole("tab",{name:"Fahrzeuge",exact:true}).waitFor();
  assert.equal(await page.getByRole("tab",{name:"Fahrzeuge",exact:true}).getAttribute("aria-selected"),"true");
  await page.getByText("Eigenes Fahrzeug anbieten",{exact:true}).click();
  await page.locator('#m12-listing-form input[name="priceEuros"]').fill("345,00");
  await page.getByRole("tab",{name:"Aufträge",exact:true}).click();
  await page.getByRole("tab",{name:"Fahrzeuge",exact:true}).click();
  assert.equal(await page.locator('#m12-listing-form input[name="priceEuros"]').inputValue(),"345,00");
  await page.locator('#m12-refresh').click();
  assert.equal(await page.locator('details[data-preserve-disclosure="listing-compose"]').getAttribute("open"),"");
  await page.getByRole("tab",{name:"Fahrzeuge",exact:true}).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.getByRole("tab",{name:"Zusammenarbeit",exact:true}).getAttribute("aria-selected"),"true");
  await page.goto(`${origin}/?screen=map`);
  await page.waitForFunction(()=>document.querySelector("#network-active")?.textContent!=="—");
  const all=Number(await page.locator("#network-active").textContent());
  await page.getByRole("button",{name:"Meine Züge",exact:true}).click();
  assert.ok(Number(await page.locator("#network-active").textContent())<all);
  await page.locator('#train-search').fill("Hannover");
  assert.ok(await page.locator('#map-object-list').getAttribute("open")!==null);
  assert.ok(Number(await page.locator('#train-list-count').textContent())>0);
  await page.locator('[data-watch-train]').first().click();
  await page.locator('#details').waitFor({state:"visible"});
  await page.getByText('Hannover Hbf',{exact:true}).last().waitFor();
  await page.screenshot({path:`${output}/train-details.png`});
  await page.getByRole('button',{name:"Detailansicht schließen"}).click();
  await page.locator('#details').waitFor({state:"hidden"});
  for(const [width,height] of [[1366,768],[1024,768],[390,844],[320,844]]){
    await page.setViewportSize({width,height});
    for(const screen of ["map","company","markets","operations","planner"]){
      await page.goto(`${origin}/?screen=${screen}`);
      await page.locator('.zf-brand').waitFor();
      if(screen==="map"){await page.waitForFunction(()=>document.querySelector("#network-active")?.textContent!=="—");await page.locator("#map-state.quiet").waitFor({state:"attached"});}
      const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,nav:[...document.querySelectorAll('.rail-nav__link')].map(link=>{const r=link.getBoundingClientRect();return {label:link.textContent.trim(),x:r.x,right:r.right,bottom:r.bottom,width:r.width}})}));
      results.push({screen,viewport:width>1100?"notebook":width>760?"tablet":`mobile-${width}`,...layout});
      if(width===390)await page.screenshot({path:`${output}/${screen}-mobile.png`});
      if(width===320) {
        await page.getByRole("button",{name:"Spielhinweise",exact:true}).click();
        await page.keyboard.press("Escape");
        const withHints=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
        assert.ok(withHints.scrollWidth<=withHints.width+1,`${screen}: hints cause horizontal overflow`);
        assert.ok(withHints.scrollHeight<=withHints.height+1,`${screen}: hints cause document scrolling`);
      }
    }
  }
} finally {
  await writeFile(`${output}/qa.json`,JSON.stringify({results,errors},null,2));
  await browser.close();
}
assert.deepEqual(errors,[],"Browser exceptions");
for(const r of results){assert.ok(r.scrollWidth<=r.width+1,`${r.screen}/${r.viewport} overflows horizontally: ${r.scrollWidth}`);assert.ok(r.scrollHeight<=r.height+1,`${r.screen}/${r.viewport} scrolls the document: ${r.scrollHeight}`);if(r.nav)for(const link of r.nav)assert.ok(link.x>=0&&link.right<=r.width+1&&link.bottom<=r.height+1,`${r.screen}/${r.viewport}: hidden navigation ${link.label}`);}
console.log(`${results.length} layouts and interactive map filters, details, keyboard tabs and draft retention passed.`);
