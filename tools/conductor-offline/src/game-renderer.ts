import characterUrl from "../assets-v2/characters.png";
import environmentUrl from "../assets-v2/environment.png";
import type { InteriorBodyV1, InteriorPointV1, VisiblePassengerV2 } from "../../../packages/runtime-native/src/interior-types.js";
import type { ConductorRenderer, ConductorRendererOptions, ConductorRendererUpdate, ConductorRendererView } from "../../../apps/livemap/src/conductor-renderer.js";

export interface GameRenderer extends Omit<ConductorRenderer,"getStats"> {
  screenPoint(passengerKey:string):{x:number;y:number;visible:boolean}|null;
  getStats():{backend:"canvas2d";logicalPassengers:number;visiblePassengers:number;loadedAtlases:number;zoom:number;frames:number;idleFrames:number;sceneScrollMm:number};
}
const MM=32/1000;
const same=(a:Pick<InteriorPointV1,"vehicleId"|"bodyId"|"deckId">,b:Pick<InteriorPointV1,"vehicleId"|"bodyId"|"deckId">)=>a.vehicleId===b.vehicleId&&a.bodyId===b.bodyId&&a.deckId===b.deckId;
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
const hash=(text:string)=>{let n=2166136261;for(const c of text)n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;};
type Actor={from:InteriorPointV1;to:InteriorPointV1;at:number;duration:number;direction:number;lastMove:number};
const imageFrom=async(source:string)=>{const img=new Image();img.src=source;await img.decode();return img;};
const verify=async(bytes:Uint8Array,expected:string)=>{
  const digest=await crypto.subtle.digest('SHA-256',bytes.slice().buffer);
  if([...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('')!==expected)throw Error('Die Bilddatei stimmt nicht mit dem freigegebenen Atlas überein.');
};

/** Presentation only: interpolation stops at confirmed positions; idle gestures never move collision anchors. */
export async function createGameRenderer(options:ConductorRendererOptions):Promise<GameRenderer>{
  const {host,art}=options, sprites=await imageFrom(characterUrl),environment=await imageFrom(environmentUrl);
  if(sprites.width!==192||sprites.height!==480)throw Error('Die Figurenanimation ist unvollständig.');
  const atlasImages=new Map<string,ImageBitmap>();
  await Promise.all(art.files.map(async file=>{const bytes=await options.fetchAtlas(file.id);await verify(bytes,file.sha256);atlasImages.set(file.id,await createImageBitmap(new Blob([bytes.slice().buffer],{type:'image/png'})));}));
  const assets=new Map(art.assets.map(a=>[a.id,a]));
  const canvas=document.createElement('canvas');canvas.className='game-canvas';canvas.setAttribute('aria-label','Begehbarer Zuginnenraum mit Fahrgästen und vorbeiziehender Landschaft');
  canvas.style.cssText='display:block;width:100%;height:100%;image-rendering:pixelated;touch-action:none;';host.append(canvas);
  const ctx=canvas.getContext('2d',{alpha:false})!;if(!ctx)throw Error('Die Spielgrafik konnte nicht geöffnet werden.');
  let value:ConductorRendererUpdate|null=null,view:ConductorRendererView|null=null,disposed=false,frame=0,idleFrames=0;
  let logicalW=1,logicalH=1,zoom=2,tx=0,ty=0,pan=0,follow=true,visiblePassengers=0;
  let raf=0,lastFrame=performance.now(),sceneFrom=0,sceneTo=0,sceneAt=lastFrame,sceneDuration=1000,sceneScroll=0;
  let geometry:HTMLCanvasElement|null=null,geometryKey='';
  const actors=new Map<string,Actor>(),points=new Map<string,{x:number;y:number;visible:boolean}>();
  const hitboxes:{key:string;x:number;y:number;w:number;h:number}[]=[];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const body=():InteriorBodyV1|undefined=>value?.layout.vehicles.find(v=>v.vehicleId===view?.vehicleId)?.bodies.find(b=>b.bodyId===view?.bodyId);
  function drawRect(x:number,y:number,w:number,h:number,color:string){ctx.fillStyle=color;ctx.fillRect(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
  function drawAsset(id:string,x:number,y:number,w:number,h:number,alpha=1){
    const local=/^environment\.(rural|suburban|urban)\.(building|vegetation)$/.exec(id);
    if(local){const column=['rural','suburban','urban'].indexOf(local[1]!);ctx.globalAlpha=alpha;
      ctx.drawImage(environment,column*64,local[2]==='building'?0:64,64,64,Math.round(x),Math.round(y),w,h);ctx.globalAlpha=1;return;}
    const asset=assets.get(id);if(!asset)return;const image=atlasImages.get(asset.fileId);if(!image)return;
    ctx.globalAlpha=alpha;ctx.drawImage(image,asset.rect.x,asset.rect.y,asset.rect.width,asset.rect.height,Math.round(x),Math.round(y),Math.round(w),Math.round(h));ctx.globalAlpha=1;
  }
  function sample(actor:Actor,now:number):InteriorPointV1{
    if(!same(actor.from,actor.to)||reduced.matches)return actor.to;
    const t=clamp((now-actor.at)/actor.duration,0,1);
    return {...actor.to,xMm:actor.from.xMm+(actor.to.xMm-actor.from.xMm)*t,yMm:actor.from.yMm+(actor.to.yMm-actor.from.yMm)*t};
  }
  function acceptActor(key:string,point:InteriorPointV1,now:number){
    const actor=actors.get(key);
    if(!actor){actors.set(key,{from:point,to:point,at:now,duration:120,direction:0,lastMove:-Infinity});return;}
    if(same(actor.to,point)&&actor.to.xMm===point.xMm&&actor.to.yMm===point.yMm)return;
    const current=sample(actor,now),dx=point.xMm-actor.to.xMm,dy=point.yMm-actor.to.yMm;
    const inSpace=same(actor.to,point);
    actor.from=inSpace?current:point;actor.to=point;actor.duration=clamp(now-actor.at,85,210);actor.at=now;actor.lastMove=now;
    if(inSpace&&(dx||dy))actor.direction=Math.abs(dx)>=Math.abs(dy)?dx>0?3:2:dy>0?0:1;
  }
  function buildGeometry(b:InteriorBodyV1){
    geometry=document.createElement('canvas');geometry.width=Math.ceil(b.lengthMm*MM)+2;geometry.height=Math.ceil(b.widthMm*MM)+2;
    const g=geometry.getContext('2d')!;g.imageSmoothingEnabled=false;
    const fill=(x:number,y:number,w:number,h:number,c:string)=>{g.fillStyle=c;g.fillRect(Math.round(x),Math.round(y),Math.max(1,Math.round(w)),Math.max(1,Math.round(h)));};
    fill(0,0,geometry.width,geometry.height,'#202830');
    // Quiet pixel tiles keep the existing graphite interior readable behind compact sprites.
    for(let x=0;x<geometry.width;x+=16)for(let y=0;y<geometry.height;y+=16){fill(x,y,16,1,'#29323a');fill(x,y,1,16,'#29323a');}
    const seats=new Map(value!.layout.seats.map(s=>[s.obstacleId,s]));
    for(const obstacle of value!.layout.obstacles.filter(o=>same(o,view!))){
      const r=obstacle.rect,x=r.xMm*MM,y=r.yMm*MM,w=r.lengthMm*MM,h=r.widthMm*MM;
      const colors={wall:'#52616e',cab:'#273540',seat:'#9b3e50',toilet:'#39576c',accessible_toilet:'#39576c',stair:'#685e78',bicycle:'#786239',stroller:'#786239',wheelchair:'#786239'};
      fill(x,y,w,h,'#11191f');fill(x+1,y+1,w-2,h-2,colors[obstacle.kind]);
      if(obstacle.kind==='seat'){
        const seat=seats.get(obstacle.obstacleId);const back=seat?.facing==='backward'?x+w-4:x+1;
        fill(back,y+1,3,h-2,'#e19caa');fill(x+4,y+3,w-8,h-6,'#aa4e60');fill(x+4,y+h-4,w-8,1,'#683144');
      }else if(obstacle.kind==='stair'){
        for(let step=3;step<w-2;step+=4){fill(x+step,y+2,2,h-4,'#b7acc3');fill(x+step+2,y+2,1,h-4,'#413e50');}
      }else if(obstacle.kind==='cab'){
        fill(x+3,y+4,Math.max(3,w-6),6,'#425464');fill(x+5,y+5,4,3,'#72cbb2');
      }else if(['toilet','accessible_toilet'].includes(obstacle.kind)){
        g.fillStyle='#eef2f5';g.font='7px monospace';g.fillText('WC',Math.round(x+3),Math.round(y+9));
      }else if(obstacle.kind!=='wall'){
        g.fillStyle='#eadfc5';g.font='6px monospace';g.fillText(obstacle.kind==='bicycle'?'RAD':obstacle.kind==='wheelchair'?'P':'K',Math.round(x+2),Math.round(y+8));
      }
    }
    fill(0,0,geometry.width,2,'#a6b5bf');fill(0,geometry.height-3,geometry.width,3,'#8d9fae');fill(0,0,2,geometry.height,'#a6b5bf');fill(geometry.width-2,0,2,geometry.height,'#a6b5bf');
    // Window and sill decoration changes no walkway, seat or native collision geometry.
    for(let x=24;x<geometry.width-24;x+=62){fill(x,0,30,2,'#b9dcdf');fill(x,geometry.height-3,30,2,'#85adb8');}
    for(const door of value!.layout.doors.filter(d=>same(d,view!))){const r=door.rect,x=r.xMm*MM,y=r.yMm*MM,w=r.lengthMm*MM,h=Math.max(3,r.widthMm*MM);fill(x,y,w,h,'#69bda8');fill(x+w/2,y,1,h,'#18382f');}
    geometryKey=`${value!.layout.layoutHash}/${view!.vehicleId}/${view!.bodyId}/${view!.deckId}`;
  }
  function drawExterior(now:number,b:InteriorBodyV1){
    const scene=value!.scene;
    sceneScroll=reduced.matches?sceneTo:sceneFrom+(sceneTo-sceneFrom)*clamp((now-sceneAt)/sceneDuration,0,1);
    drawRect(0,0,logicalW,logicalH,'#1d2928');
    const y=ty;
    // Every scroll offset comes from two confirmed native scene projections. No local train-speed simulation.
    const offset=sceneScroll*MM;
    const family=scene?scene.environment.urbanBasisPoints>5000?'urban':scene.environment.suburbanBasisPoints>5000?'suburban':'rural':'rural';
    drawRect(0,0,logicalW,Math.max(0,y-12),'#233431');
    drawRect(0,y+b.widthMm*MM+10,logicalW,logicalH,'#233431');
    const tile=(id:string,top:number,size:number,rate:number,spacing:number)=>{
      const scroll=((offset*rate)%spacing+spacing)%spacing;
      for(let x=-spacing-scroll;x<logicalW+spacing;x+=spacing)drawAsset(id,x,top,size,size);
    };
    if(scene){
      tile(`environment.${family}.building`,Math.max(-25,y-153),64,0.24,144);
      tile(`environment.${family}.vegetation`,y-81,64,0.62,110);
      tile(`environment.${family}.vegetation`,y+b.widthMm*MM+20,64,0.9,142);
      if(scene.station&&scene.station.visibilityBasisPoints>500){
        const platform=scene.station.assetIds.find(id=>id.endsWith('.platform'));
        drawRect(0,y-35,logicalW,22,'#67717a');drawRect(0,y-17,logicalW,2,'#e8dfbb');
        if(platform)drawAsset(platform,logicalW*.6,y-71,96,38,scene.station.visibilityBasisPoints/10000);
      }
    }
    for(const trackY of [y-11,y+b.widthMm*MM+8]){
      drawRect(0,trackY-3,logicalW,9,'#30383b');
      const scroll=((offset%16)+16)%16;
      for(let x=-16-scroll;x<logicalW+16;x+=16)drawRect(x,trackY-3,3,9,'#60635c');
      drawRect(0,trackY-2,logicalW,1,'#9da6a5');drawRect(0,trackY+3,logicalW,1,'#9da6a5');
    }
    canvas.dataset.sceneScrollMm=String(Math.round(sceneScroll));
    canvas.dataset.sceneSpeedMmps=String(scene?.speedMmps??0);
  }
  function actorDraw(key:string,person:VisiblePassengerV2|null,now:number){
    const actor=actors.get(key);if(!actor||!view)return;
    if(!same(actor.to,view)){if(person)points.set(key,{x:0,y:0,visible:false});return;}
    // Native points describe the person's place/centre. A constant art pivot
    // keeps compact heads inside the carriage while shoe pixels stay planted.
    const p=sample(actor,now),x=Math.round(tx+p.xMm*MM),y=Math.round(ty+p.yMm*MM+12);
    const visible=x>=-20&&x<=logicalW+20&&y>=-10&&y<=logicalH+40;
    if(person)points.set(key,{x:x*zoom,y:(y-30)*zoom,visible});
    if(!visible)return;
    const id=hash(key),column=person?1+(person.appearanceVariant%5):0;
    const walking=!reduced.matches&&now-actor.lastMove<actor.duration+85;
    const t=now+id%8200,breathPeriod=2600+(id%1100),breathPhase=(t%breathPeriod)/breathPeriod;
    // One logical pixel in the upper body only. Shoe pixels stay at the native anchor.
    const breath=reduced.matches||walking?0:(breathPhase>0.24&&breathPhase<0.73?1:0);
    const blink=!reduced.matches&&t%5100<150;
    const gesture=!reduced.matches&&t%7900>6600;
    let row=0;
    if(walking)row=actor.direction*2+Math.floor(t/150)%2;
    else if(person?.posture==='seated')row=blink?10:11;
    else row=blink?8:gesture?9:actor.direction*2;
    const sx=column*32,sy=row*40,top=y-37;
    // Shadow and interaction markers are interface decoration, never extra occupants.
    drawRect(x-7,y-1,14,3,'#121b22');
    if(person&&value!.selectedPassengerKey===key){
      ctx.strokeStyle='#f5bf65';ctx.lineWidth=1;ctx.strokeRect(x-15,top+1,30,38);
      drawRect(x-2,top-5,5,2,'#f5bf65');drawRect(x-1,top-3,3,1,'#f5bf65');
    }
    ctx.drawImage(sprites,sx,sy,32,31,x-16,top-breath,32,31+breath);
    ctx.drawImage(sprites,sx,sy+31,32,9,x-16,top+31,32,9);
    if(person){visiblePassengers++;hitboxes.push({key,x:(x-16)*zoom,y:(top-2)*zoom,w:32*zoom,h:42*zoom});}
    else{canvas.dataset.playerAnimation=walking?'walk':'idle';canvas.dataset.playerFrame=String(row);canvas.dataset.playerBreath=String(breath);canvas.dataset.playerXmm=String(Math.round(p.xMm));}
    if(!walking)idleFrames++;
  }
  function draw(now:number){
    if(disposed)return;raf=requestAnimationFrame(draw);
    if(!value||!view||document.hidden)return;
    const b=body();if(!b)return;
    const delta=now-lastFrame;lastFrame=now;frame++;
    if(frame%60===0)canvas.dataset.lastFrameMs=String(Math.round(delta));
    ctx.imageSmoothingEnabled=false;
    const player=actors.get('@player'),targetCenter=follow&&player&&same(player.to,view)?sample(player,now).xMm*MM+pan:(view.centerMm??b.lengthMm/2)*MM+pan;
    const half=logicalW/2,width=b.lengthMm*MM;
    const center=width<logicalW?width/2:clamp(targetCenter,half-20,width-half+20);
    tx=Math.round(half-center);ty=Math.round(logicalH*.54-b.widthMm*MM/2);
    drawExterior(now,b);
    const key=`${value.layout.layoutHash}/${view.vehicleId}/${view.bodyId}/${view.deckId}`;if(key!==geometryKey)buildGeometry(b);
    drawRect(tx+3,ty+5,b.lengthMm*MM,b.widthMm*MM,'#10171b');
    if(geometry)ctx.drawImage(geometry,tx,ty);
    visiblePassengers=0;hitboxes.length=0;
    const people=value.passengers.passengers.filter(p=>same(p,view!)).map(p=>({key:p.passengerKey,person:p,y:p.yMm}));
    if(player&&same(player.to,view))people.push({key:'@player',person:null as unknown as VisiblePassengerV2,y:sample(player,now).yMm+1});
    people.sort((a,b)=>a.y-b.y);for(const row of people)actorDraw(row.key,row.person,now);
    canvas.dataset.logicalPassengers=String(value.passengers.passengers.length);canvas.dataset.visiblePassengers=String(visiblePassengers);
    canvas.dataset.deck=view.deckId;canvas.dataset.renderer='canvas2d';canvas.dataset.frames=String(frame);canvas.dataset.idleFrames=String(idleFrames);canvas.dataset.reducedMotion=String(reduced.matches);
  }
  function resize(){if(disposed)return;zoom=view?.zoom??2;logicalW=Math.max(1,Math.floor(host.clientWidth/zoom));logicalH=Math.max(1,Math.floor(host.clientHeight/zoom));canvas.width=logicalW;canvas.height=logicalH;ctx.imageSmoothingEnabled=false;}
  const observer=new ResizeObserver(resize);observer.observe(host);
  const onClick=(event:PointerEvent)=>{
    if(!value||!view)return;const rect=canvas.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    const hit=[...hitboxes].reverse().find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h);
    if(hit){options.onPassengerSelect(hit.key);return;}
    const b=body(),xMm=Math.round((x/zoom-tx)/MM),yMm=Math.round((y/zoom-ty)/MM);
    if(b&&xMm>=0&&xMm<=b.lengthMm&&yMm>=0&&yMm<=b.widthMm)options.onPointSelect?.({...view,xMm,yMm});
  };
  canvas.addEventListener('pointerup',onClick);resize();raf=requestAnimationFrame(draw);
  return {
    update(next){
      if(disposed)return;
      if(next.layout.layoutHash!==next.passengers.sourceLayoutHash||next.layout.binding.artManifestHash!==art.manifestSha256)throw Error('Innenraum und Fahrgaststand passen nicht zusammen.');
      const now=performance.now();
      if(next.scene&&next.scene.environment.scrollMm!==sceneTo){sceneFrom=sceneScroll;sceneTo=next.scene.environment.scrollMm;sceneDuration=clamp(now-sceneAt,120,1300);sceneAt=now;}
      if(!value&&next.scene){sceneFrom=sceneTo=next.scene.environment.scrollMm;sceneScroll=sceneTo;}
      value=next;acceptActor('@player',next.position,now);
      const present=new Set(['@player']);for(const p of next.passengers.passengers){present.add(p.passengerKey);acceptActor(p.passengerKey,p,now);}
      for(const key of actors.keys())if(!present.has(key)){actors.delete(key);points.delete(key);}
      if(!view){view={vehicleId:next.position.vehicleId,bodyId:next.position.bodyId,deckId:next.position.deckId,zoom:2};resize();}
    },
    setView(next){view={...next};follow=false;pan=0;resize();},
    focusPlayer(){if(!value)return;view={vehicleId:value.position.vehicleId,bodyId:value.position.bodyId,deckId:value.position.deckId,zoom:view?.zoom??2};follow=true;pan=0;resize();},
    panBy(pixels){follow=false;view={...view!,centerMm:(view?.centerMm??(value?.position.xMm??0))};pan+=pixels/zoom;},
    resize,
    screenPoint(key){return points.get(key)??null;},
    getStats(){return {backend:'canvas2d',logicalPassengers:value?.passengers.passengers.length??0,visiblePassengers,loadedAtlases:atlasImages.size,zoom,frames:frame,idleFrames,sceneScrollMm:sceneScroll};},
    dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(raf);observer.disconnect();canvas.removeEventListener('pointerup',onClick);canvas.remove();for(const img of atlasImages.values())img.close();atlasImages.clear();actors.clear();points.clear();geometry=null;}
  };
}
