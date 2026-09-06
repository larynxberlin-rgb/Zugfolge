import { Application, Container, Graphics, ImageSource, Rectangle, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import type { InteriorBodyV1, InteriorDeckId, InteriorLayoutV1, InteriorPointV1, PassengerProjectionV2, VisiblePassengerV2 } from "@zugfolge/runtime-native";

export type ConductorArtDirection = "north" | "east" | "south" | "west";
export interface ConductorArtViewV1 {
  readonly schemaVersion: "conductor-art-view/v1";
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly pixelsPerMetre: 32;
  readonly files: readonly { readonly id: string; readonly sha256: string; readonly widthPx: number; readonly heightPx: number; readonly sourceScale: 1 | 2 | 3 | 4 }[];
  readonly assets: readonly { readonly id: string; readonly fileId: string; readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly pivot: { readonly x: number; readonly y: number }; readonly worldWidthMm: number; readonly worldHeightMm: number }[];
  readonly appearanceVariants: readonly { readonly variant: number; readonly appearanceId: string }[];
  readonly animations: readonly { readonly appearanceId: string; readonly direction: ConductorArtDirection; readonly state: "idle" | "walk" | "sitting";
    readonly frames: readonly { readonly assetId: string; readonly durationMs: number }[] }[];
  readonly accessoryBindings: readonly { readonly spaceNeeds: "wheelchair" | "bicycle" | "stroller"; readonly direction: ConductorArtDirection;
    readonly assetId: string; readonly appearanceIds: readonly string[] }[];
  readonly conductorAppearanceId: string;
}

/** Structural subset of SceneProjectionV1; all actual motion is already sampled by Rust. */
export interface ConductorSceneViewV1 {
  readonly schemaVersion: "conductor-scene-projection/v1";
  readonly binding: { readonly worldId: string; readonly periodId: string; readonly artReleaseId: string; readonly artManifestHash: string; readonly trainRunId: string };
  readonly routeMm: number; readonly speedMmps: number; readonly atMs: number; readonly visualOnly: boolean;
  readonly environment: { readonly scrollMm: number; readonly ruralBasisPoints: number; readonly suburbanBasisPoints: number; readonly urbanBasisPoints: number; readonly assetIds: readonly string[] };
  readonly lighting: { readonly daylightBasisPoints: number; readonly windowLightBasisPoints: number };
  readonly station: { readonly name: string; readonly platformLabel: string | null; readonly visibilityBasisPoints: number; readonly assetIds: readonly string[] } | null;
  readonly signals: readonly { readonly signalId: string; readonly aspect: string; readonly distanceMm: number; readonly assetId: string | null }[];
}

export interface ConductorRendererUpdate {
  readonly layout: InteriorLayoutV1;
  readonly passengers: PassengerProjectionV2;
  readonly position: InteriorPointV1;
  /** Confirmed session simulation time; never a client wall-clock sample. */
  readonly atMs?: number;
  readonly scene?: ConductorSceneViewV1 | null;
  readonly selectedPassengerKey?: string | null;
}
export interface ConductorRendererView {
  readonly vehicleId: string; readonly bodyId: string; readonly deckId: InteriorDeckId;
  readonly zoom: 1 | 2 | 3 | 4;
  readonly centerMm?: number;
}
export interface ConductorRendererOptions {
  readonly host: HTMLElement;
  readonly art: ConductorArtViewV1;
  readonly fetchAtlas: (fileId: string) => Promise<Uint8Array>;
  readonly onPassengerSelect: (passengerKey: string) => void;
  readonly onPointSelect?: (point: InteriorPointV1) => void;
}
export interface ConductorRenderer {
  update(value: ConductorRendererUpdate): void;
  setView(view: ConductorRendererView): void;
  focusPlayer(): void;
  panBy(pixels: number): void;
  resize(): void;
  getStats(): { readonly backend: "webgl"; readonly logicalPassengers: number; readonly visiblePassengers: number; readonly loadedAtlases: number; readonly zoom: number };
  dispose(): void;
}

const PIXELS_PER_MM = 32 / 1000;
const px = (millimetres: number): number => Math.round(millimetres * PIXELS_PER_MM);
const sameSpace = (a: Pick<InteriorPointV1, "vehicleId" | "bodyId" | "deckId">, b: Pick<InteriorPointV1, "vehicleId" | "bodyId" | "deckId">): boolean =>
  a.vehicleId === b.vehicleId && a.bodyId === b.bodyId && a.deckId === b.deckId;
const ensure = (condition: unknown, code: string): void => { if (!condition) throw new Error(code); };
const hashPattern = /^[a-f0-9]{64}$/u;
interface PassengerSprite { readonly container: Container; readonly sprite: Sprite; readonly ring: Graphics }

/** WebGL view only: all geometry, people and accepted player positions come from the server. */
export async function createConductorRenderer(options: ConductorRendererOptions): Promise<ConductorRenderer> {
  const { host, art } = options;
  ensure(art.schemaVersion === "conductor-art-view/v1" && art.pixelsPerMetre === 32 && hashPattern.test(art.manifestSha256), "conductor_art_view_invalid");
  const files = new Map(art.files.map((file) => [file.id, file]));
  const assets = new Map(art.assets.map((asset) => [asset.id, asset]));
  const appearances = new Map(art.appearanceVariants.map((entry) => [entry.variant, entry.appearanceId]));
  ensure(files.size === art.files.length && assets.size === art.assets.length && appearances.size === 256
    && Array.from({ length: 256 }, (_, index) => appearances.has(index)).every(Boolean), "conductor_art_view_invalid");
  for (const file of files.values()) ensure(hashPattern.test(file.sha256) && [1, 2, 3, 4].includes(file.sourceScale)
    && Number.isInteger(file.widthPx) && file.widthPx > 0 && file.widthPx <= 8192
    && Number.isInteger(file.heightPx) && file.heightPx > 0 && file.heightPx <= 8192, "conductor_art_file_invalid");
  for (const asset of assets.values()) {
    const file = files.get(asset.fileId), r = asset.rect;
    ensure(file && [r.x, r.y, r.width, r.height, asset.pivot.x, asset.pivot.y].every(Number.isInteger)
      && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
      && r.x + r.width <= file.widthPx && r.y + r.height <= file.heightPx
      && r.width * 1000 === asset.worldWidthMm * 32 * file.sourceScale
      && r.height * 1000 === asset.worldHeightMm * 32 * file.sourceScale, "conductor_art_rect_invalid");
  }

  const app = new Application();
  const sources = new Map<string, ImageSource>();
  const bitmaps: ImageBitmap[] = [];
  const textures = new Map<string, Texture>();
  let disposed = false;
  try {
    await app.init({ preference: "webgl", width: Math.max(1, host.clientWidth), height: Math.max(280, host.clientHeight),
      background: 0x101419, antialias: false, resolution: 1, autoDensity: false, roundPixels: true, autoStart: false });
    // Explicit preference plus the real context gate prevents a silent canvas fallback.
    ensure("gl" in app.renderer, "conductor_webgl_unavailable");
    const loads = await Promise.allSettled(art.files.map(async (file) => {
      const bytes = new Uint8Array(await options.fetchAtlas(file.id));
      ensure(bytes.byteLength > 0 && bytes.byteLength <= 64 * 1024 * 1024, "conductor_art_file_bounds");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const actualHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      ensure(actualHash === file.sha256, "conductor_art_file_hash_mismatch");
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { imageOrientation: "none", colorSpaceConversion: "none" });
      bitmaps.push(bitmap);
      ensure(bitmap.width === file.widthPx && bitmap.height === file.heightPx, "conductor_art_file_size_mismatch");
      sources.set(file.id, new ImageSource({ resource: bitmap, scaleMode: "nearest", autoGenerateMipmaps: false }));
    }));
    ensure(loads.every((load) => load.status === "fulfilled"), "conductor_atlas_load_failed");
    for (const asset of assets.values()) {
      const source = sources.get(asset.fileId);
      ensure(source, "conductor_art_file_missing");
      textures.set(asset.id, new Texture({ source, frame: new Rectangle(asset.rect.x, asset.rect.y, asset.rect.width, asset.rect.height) }));
    }
  } catch (error) {
    for (const texture of textures.values()) texture.destroy(false);
    for (const source of sources.values()) source.destroy();
    for (const bitmap of bitmaps) bitmap.close();
    if (app.renderer) app.destroy({ removeView: true }, { children: true });
    throw error;
  }
  const canvas = app.canvas;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.maxWidth = "100%";
  canvas.style.imageRendering = "pixelated";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Schaffnermodus: tatsächlicher Fahrzeuginnenraum und Fahrgäste. Bedienelemente stehen daneben.");
  host.append(canvas);
  const exterior = new Container();
  const train = new Container();
  const geometry = new Container();
  const people = new Container();
  const overlay = new Container();
  train.addChild(geometry, people);
  app.stage.addChild(exterior, train, overlay);
  people.sortableChildren = true;
  const passengerSprites = new Map<string, PassengerSprite>();
  const accessorySprites = new Map<string, Sprite>();
  const conductor = new Sprite();
  conductor.eventMode = "none";
  people.addChild(conductor);
  let value: ConductorRendererUpdate | null = null;
  let view: ConductorRendererView | null = null;
  let cameraMm: number | null = null;
  let playerDirection: ConductorArtDirection = "south";
  let playerWalkUntilMs: number | null = null;
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const motionPreferenceChanged = () => render();
  motionPreference.addEventListener("change", motionPreferenceChanged);
  let visiblePassengers = 0;
  let geometryKey = "";

  function clear(container: Container): void {
    for (const child of container.removeChildren()) child.destroy({ children: true });
  }
  function bodyFor(selection: ConductorRendererView): InteriorBodyV1 | undefined {
    return value?.layout.vehicles.find((vehicle) => vehicle.vehicleId === selection.vehicleId)?.bodies.find((body) => body.bodyId === selection.bodyId);
  }
  function selectedBody(): InteriorBodyV1 {
    ensure(view, "conductor_view_missing");
    const body = bodyFor(view!);
    ensure(body && body.deckIds.includes(view!.deckId), "conductor_view_invalid");
    return body!;
  }
  function textureFor(id: string): Texture {
    const texture = textures.get(id);
    ensure(texture, "conductor_art_motif_missing");
    return texture!;
  }
  function placeSprite(sprite: Sprite, id: string, x: number, y: number): void {
    const asset = assets.get(id);
    ensure(asset, "conductor_art_motif_missing");
    const file = files.get(asset!.fileId)!;
    sprite.texture = textureFor(id);
    sprite.anchor.set(asset!.pivot.x / asset!.rect.width, asset!.pivot.y / asset!.rect.height);
    sprite.scale.set(1 / file.sourceScale);
    sprite.position.set(Math.round(x), Math.round(y));
    sprite.roundPixels = true;
  }
  function nativeSprite(id: string, x: number, y: number): Sprite {
    const sprite = new Sprite();
    placeSprite(sprite, id, x, y);
    sprite.eventMode = "none";
    return sprite;
  }
  function actorFrame(appearance: string, direction: ConductorArtDirection, posture: "seated" | "standing", walkingAtMs?: number): string {
    const animation = art.animations.find((entry) => entry.appearanceId === appearance && entry.direction === direction
      && entry.state === (posture === "seated" ? "sitting" : walkingAtMs === undefined ? "idle" : "walk"));
    ensure(animation && animation.frames.length > 0 && animation.frames.every((frame) => Number.isSafeInteger(frame.durationMs)
      && frame.durationMs > 0 && assets.has(frame.assetId)), "conductor_art_actor_frame_missing");
    const total = animation!.frames.reduce((sum, frame) => sum + frame.durationMs, 0);
    let remaining = walkingAtMs === undefined ? 0 : walkingAtMs % total;
    const frame = animation!.frames.find((item) => { if (remaining < item.durationMs) return true; remaining -= item.durationMs; return false; });
    ensure(frame, "conductor_art_actor_frame_missing");
    return frame!.assetId;
  }
  function label(text: string, x: number, y: number, color: number, fontSize = 10, wrapWidth?: number): Text {
    const item = new Text({ text, style: { fontFamily: "system-ui, sans-serif", fontSize, fill: color,
      ...(wrapWidth === undefined ? {} : { wordWrap: true, breakWords: true, wordWrapWidth: Math.max(1, wrapWidth) }) },
      resolution: 1, textureStyle: { scaleMode: "nearest" } });
    item.position.set(Math.round(x), Math.round(y));
    item.eventMode = "none";
    return item;
  }
  function drawGeometry(body: InteriorBodyV1): void {
    clear(geometry);
    const width = px(body.lengthMm), height = px(body.widthMm);
    // Atlas frames may contain transparent padding. The actual vehicle floor
    // is an opaque interior surface, so exterior scenes cannot show through it.
    const floorBase = new Graphics().rect(0, 0, width, height).fill(0x202830);
    floorBase.eventMode = "none";
    geometry.addChild(floorBase);
    const floorAsset = assets.get("interior.floor");
    ensure(floorAsset, "conductor_art_floor_missing");
    const floorScale = files.get(floorAsset!.fileId)!.sourceScale;
    const floor = new TilingSprite({ texture: textureFor("interior.floor"), width, height,
      tileScale: { x: 1 / floorScale, y: 1 / floorScale } });
    floor.eventMode = "static";
    floor.on("pointertap", (event) => {
      if (!value || !view || !options.onPointSelect) return;
      const point = train.toLocal(event.global);
      const xMm = Math.round(point.x / PIXELS_PER_MM), yMm = Math.round(point.y / PIXELS_PER_MM);
      if (xMm >= 0 && xMm <= body.lengthMm && yMm >= 0 && yMm <= body.widthMm)
        options.onPointSelect({ vehicleId: view.vehicleId, bodyId: view.bodyId, deckId: view.deckId, xMm, yMm });
    });
    geometry.addChild(floor);
    const shapes = new Graphics();
    shapes.eventMode = "none";
    geometry.addChild(shapes);
    const seatIndex = new Map(value!.layout.seats.map((seat) => [seat.obstacleId, seat]));
    const premium = new Set(value!.layout.passengerPlaces.filter((place) => place.comfortClass === "premium").map((place) => place.placeId));
    for (const obstacle of value!.layout.obstacles.filter((item) => sameSpace(item, view!))) {
      const x = px(obstacle.rect.xMm), y = px(obstacle.rect.yMm), w = Math.max(1, px(obstacle.rect.lengthMm)), h = Math.max(1, px(obstacle.rect.widthMm));
      const seat = seatIndex.get(obstacle.obstacleId);
      const colors = { wall: 0x52616e, cab: 0x273540, seat: seat && premium.has(seat.placeId) ? 0x9a7042 : 0x9b3e50,
        toilet: 0x39576c, accessible_toilet: 0x39576c, stair: 0x685e78, bicycle: 0x786239, stroller: 0x786239, wheelchair: 0x786239 };
      shapes.rect(x, y, w, h).fill(colors[obstacle.kind]).stroke({ color: obstacle.kind === "seat" ? 0xe19caa : 0x9babb9, width: 1 });
      if (seat) {
        // A backrest belongs to each actual M5 seat; no multi-seat sprite invents capacity.
        const back = seat.facing === "forward" ? x + 1 : x + Math.max(1, w - 3);
        shapes.rect(back, y + 1, 2, Math.max(1, h - 2)).fill(0xf0cad2);
      } else if (obstacle.kind === "stair") {
        for (let step = 4; step < w; step += 5) shapes.rect(x + step, y + 1, 1, Math.max(1, h - 2)).fill(0xd0c4db);
      } else {
        const text = ({ toilet: "WC", accessible_toilet: "WC ♿", cab: "F", wheelchair: "♿", bicycle: "Rad", stroller: "Ki" } as Partial<Record<typeof obstacle.kind, string>>)[obstacle.kind];
        if (text) geometry.addChild(label(text, x + 2, y + 1, 0xf1f3f6, 8));
      }
    }
    for (const door of value!.layout.doors.filter((item) => sameSpace(item, view!))) {
      const x = px(door.rect.xMm), y = px(door.rect.yMm), w = px(door.rect.lengthMm), h = Math.max(2, px(door.rect.widthMm));
      shapes.rect(x, y, w, h).fill(0x69bda8);
      shapes.rect(x + Math.floor(w / 2), y, 1, h).fill(0x18382f);
    }
    // Draw only graph-approved gangways at this deck; a gap never becomes an invisible link.
    const nodes = new Map(value!.layout.nodes.map((node) => [node.nodeId, node.point]));
    for (const edge of value!.layout.edges.filter((edge) => edge.kind === "gangway")) {
      const a = nodes.get(edge.fromNodeId), b = nodes.get(edge.toNodeId);
      const endpoint = a && sameSpace(a, view!) ? a : b && sameSpace(b, view!) ? b : null;
      if (endpoint) shapes.rect(px(endpoint.xMm) - 3, px(endpoint.yMm) - 9, 6, 18).fill(0x72cbb2);
    }
    shapes.rect(0, 0, width, height).stroke({ color: 0xa6b5bf, width: 1 });
  }

  function drawExterior(): void {
    clear(exterior); clear(overlay);
    const scene = value?.scene;
    if (!scene || !view) return;
    const weights = { rural: scene.environment.ruralBasisPoints, suburban: scene.environment.suburbanBasisPoints, urban: scene.environment.urbanBasisPoints };
    const sceneScale = view.zoom;
    const stripHeight = Math.max(1, Math.round(app.screen.height / sceneScale));
    for (const family of ["rural", "suburban", "urban"] as const) {
      if (weights[family] === 0) continue;
      const layer = new Container(); layer.alpha = weights[family] / 10000; layer.scale.set(sceneScale);
      for (const [index, part] of ["building", "vegetation", "road"].entries()) {
        const id = `environment.${family}.${part}`;
        ensure(scene.environment.assetIds.includes(id), "conductor_scene_art_binding_invalid");
        const asset = assets.get(id); ensure(asset, "conductor_art_motif_missing");
        const tileWidth = asset!.worldWidthMm * PIXELS_PER_MM;
        const scroll = motionPreference.matches ? 0 : px(scene.environment.scrollMm) % tileWidth;
        for (let x = -tileWidth - scroll; x < app.screen.width / sceneScale + tileWidth; x += tileWidth) {
          const sprite = nativeSprite(id, x + tileWidth / 2, stripHeight / 2 + (index - 1) * 32);
          sprite.tint = Math.round(255 * scene.lighting.daylightBasisPoints / 10000) * 0x010101;
          layer.addChild(sprite);
        }
      }
      exterior.addChild(layer);
    }
    if (scene.station) {
      const station = new Container(); station.alpha = scene.station.visibilityBasisPoints / 10000;
      // Generic modules retain their original pixel scale; their layout asserts no real building footprint.
      for (const [part, offsetX, offsetY] of [["hall", -140, -70], ["roof", 70, -55], ["underpass", -130, 120],
        ["stairs", 100, 100], ["platform", 0, 70]] as const) {
        const module = scene.station.assetIds.find((id) => id.endsWith(`.${part}`));
        ensure(module, "conductor_scene_station_modules_missing");
        const sprite = nativeSprite(module!, app.screen.width / 2 + offsetX * sceneScale, app.screen.height / 2 + offsetY * sceneScale);
        sprite.scale.set(sceneScale / files.get(assets.get(module!)!.fileId)!.sourceScale);
        sprite.tint = Math.round(255 * scene.lighting.daylightBasisPoints / 10000) * 0x010101;
        station.addChild(sprite);
      }
      const sign = label(scene.station.name, 12, 10, 0xffffff, 16, app.screen.width - 24);
      const platformText = scene.station.platformLabel ? label(`Bahnsteig ${scene.station.platformLabel}`, 12, sign.height + 19, 0xc9d5dd, 11, app.screen.width - 24) : null;
      const backing = new Graphics().rect(4, 4, Math.max(1, app.screen.width - 8), sign.height + (platformText ? platformText.height + 25 : 16)).fill({ color: 0x181e25, alpha: 0.95 });
      const signGroup = new Container(); signGroup.alpha = station.alpha; signGroup.addChild(backing, sign);
      if (platformText) signGroup.addChild(platformText);
      overlay.addChild(signGroup);
      exterior.addChild(station);
    }
    for (const [index, signal] of scene.signals.entries()) {
      if (signal.assetId) {
        const sprite = nativeSprite(signal.assetId, app.screen.width - 24 - index * 40, app.screen.height - 18);
        exterior.addChild(sprite);
      } else overlay.addChild(label(signal.aspect === "failed" ? "Signal gestört" : "Rangierbegriff", 10, app.screen.height - 20 - index * 15, 0xf7c06a, 11));
    }
  }
  function passengerDirection(passenger: VisiblePassengerV2): ConductorArtDirection {
    if (passenger.posture === "standing" || passenger.spaceNeeds === "wheelchair") return "south";
    return value!.layout.seats.find((seat) => seat.placeId === passenger.placeId)?.facing === "backward" ? "west" : "east";
  }
  function drawPassengers(): void {
    if (!value || !view) return;
    const all = new Set(value.passengers.passengers.map((passenger) => passenger.passengerKey));
    for (const [key, rendered] of passengerSprites) if (!all.has(key)) { rendered.container.destroy({ children: true }); passengerSprites.delete(key); }
    for (const [key, rendered] of accessorySprites) if (!all.has(key)) { rendered.destroy(); accessorySprites.delete(key); }
    for (const rendered of passengerSprites.values()) rendered.container.visible = false;
    for (const rendered of accessorySprites.values()) rendered.visible = false;
    visiblePassengers = 0;
    for (const passenger of value.passengers.passengers) {
      const appearance = appearances.get(passenger.appearanceVariant); ensure(appearance, "conductor_passenger_appearance_missing");
      const direction = passengerDirection(passenger);
      if (passenger.spaceNeeds !== "ordinary") {
        const binding = art.accessoryBindings.find((entry) => entry.spaceNeeds === passenger.spaceNeeds && entry.direction === direction && entry.appearanceIds.includes(appearance!));
        ensure(binding, "conductor_passenger_accessory_missing");
        const bay = value.layout.specialBays.find((candidate) => candidate.spaceId === passenger.spaceId);
        // M15.4 binds both resources to one vehicle, but a bicycle bay may be on another deck/body.
        ensure(bay && bay.vehicleId === passenger.vehicleId && bay.spaceNeed === passenger.spaceNeeds, "conductor_passenger_bay_mismatch");
        if (bay && sameSpace(bay, view)) {
          const bayScreenX = train.x + px(bay.xMm) * view.zoom;
          const bayScreenY = train.y + px(bay.yMm) * view.zoom;
          if (bayScreenX >= -64 * view.zoom && bayScreenX <= app.screen.width + 64 * view.zoom
            && bayScreenY >= -64 * view.zoom && bayScreenY <= app.screen.height + 64 * view.zoom) {
            let accessory = accessorySprites.get(passenger.passengerKey);
            if (!accessory) { accessory = new Sprite(); accessory.eventMode = "none"; people.addChild(accessory); accessorySprites.set(passenger.passengerKey, accessory); }
            placeSprite(accessory, binding!.assetId, px(bay.xMm), px(bay.yMm));
            accessory.visible = true; accessory.zIndex = px(bay.yMm) + 99;
          }
        }
      }
      if (!sameSpace(passenger, view)) continue;
      const screenX = train.x + px(passenger.xMm) * view.zoom;
      const screenY = train.y + px(passenger.yMm) * view.zoom;
      // Only viewport omission is allowed. The complete authoritative array remains in `value`.
      if (screenX < -64 * view.zoom || screenX > app.screen.width + 64 * view.zoom
        || screenY < -64 * view.zoom || screenY > app.screen.height + 64 * view.zoom) continue;
      let rendered = passengerSprites.get(passenger.passengerKey);
      if (!rendered) {
        const container = new Container(); const sprite = new Sprite(); const ring = new Graphics();
        container.addChild(ring, sprite); people.addChild(container);
        sprite.eventMode = "static"; sprite.cursor = "pointer";
        const key = passenger.passengerKey;
        sprite.on("pointertap", (event) => { event.stopPropagation(); options.onPassengerSelect(key); });
        rendered = { container, sprite, ring }; passengerSprites.set(key, rendered);
      }
      rendered.container.visible = true; rendered.container.zIndex = px(passenger.yMm) + 100;
      placeSprite(rendered.sprite, actorFrame(appearance!, direction, passenger.posture), px(passenger.xMm), px(passenger.yMm));
      const file = files.get(assets.get(actorFrame(appearance!, direction, passenger.posture))!.fileId)!;
      rendered.sprite.hitArea = new Rectangle(-12 * file.sourceScale, -28 * file.sourceScale, 24 * file.sourceScale, 32 * file.sourceScale);
      rendered.ring.clear();
      if (value.selectedPassengerKey === passenger.passengerKey)
        rendered.ring.roundRect(px(passenger.xMm) - 14, px(passenger.yMm) - 30, 28, 34, 3).stroke({ color: 0xffcf75, width: 2 });
      visiblePassengers += 1;
    }
    conductor.visible = sameSpace(value.position, view);
    if (conductor.visible) {
      const atMs = value.atMs ?? value.scene?.atMs;
      const walking = !motionPreference.matches && atMs !== undefined && playerWalkUntilMs !== null && atMs < playerWalkUntilMs;
      // Only confirmed simulation samples advance the gait. There is no browser motion clock or position extrapolation.
      placeSprite(conductor, actorFrame(art.conductorAppearanceId, playerDirection, "standing", walking ? atMs : undefined), px(value.position.xMm), px(value.position.yMm));
      canvas.dataset.playerAnimation = walking ? "walk" : "idle";
      canvas.dataset.reducedMotion = String(motionPreference.matches);
      conductor.zIndex = px(value.position.yMm) + 101;
    }
  }
  function render(): void {
    if (disposed || !value || !view) return;
    const body = selectedBody(), zoom = view.zoom;
    const width = px(body.lengthMm), height = px(body.widthMm);
    const center = cameraMm ?? (sameSpace(value.position, view) ? value.position.xMm : Math.floor(body.lengthMm / 2));
    const minimum = Math.min(app.screen.width / 2, width * zoom / 2);
    const centerPx = Math.min(Math.max(px(center) * zoom, minimum), Math.max(minimum, width * zoom - app.screen.width / 2));
    train.scale.set(zoom);
    train.position.set(Math.round(app.screen.width / 2 - centerPx), Math.round(app.screen.height / 2 - height * zoom / 2));
    const nextGeometryKey = `${value.layout.layoutHash}|${view.vehicleId}|${view.bodyId}|${view.deckId}`;
    if (nextGeometryKey !== geometryKey) { drawGeometry(body); geometryKey = nextGeometryKey; }
    drawExterior(); drawPassengers();
    app.render();
    canvas.dataset.logicalPassengers = String(value.passengers.passengers.length);
    canvas.dataset.visiblePassengers = String(visiblePassengers);
    canvas.dataset.deck = view.deckId;
    canvas.dataset.renderer = "webgl";
    canvas.dataset.reducedMotion = String(motionPreference.matches);
  }
  const observer = new ResizeObserver(() => resize());
  function resize(): void {
    if (disposed) return;
    app.renderer.resize(Math.max(1, host.clientWidth), Math.max(280, host.clientHeight));
    render();
  }
  observer.observe(host);
  return {
    update(next): void {
      ensure(!disposed, "conductor_renderer_disposed");
      ensure(next.atMs === undefined || Number.isSafeInteger(next.atMs) && next.atMs >= 0, "conductor_renderer_time_invalid");
      ensure(next.layout.layoutHash === next.passengers.sourceLayoutHash
        && next.layout.binding.worldId === next.passengers.binding.worldId
        && next.layout.binding.periodId === next.passengers.binding.periodId
        && next.layout.binding.artReleaseId === art.releaseId && next.layout.binding.artManifestHash === art.manifestSha256,
      "conductor_renderer_binding_mismatch");
      ensure(new Set(next.passengers.passengers.map((passenger) => passenger.passengerKey)).size === next.passengers.passengers.length,
        "conductor_renderer_duplicate_passenger");
      if (next.scene) ensure(next.scene.visualOnly && next.scene.binding.worldId === next.layout.binding.worldId
        && next.scene.binding.periodId === next.layout.binding.periodId && next.scene.binding.trainRunId === next.passengers.binding.trainRunId
        && next.scene.binding.artReleaseId === art.releaseId && next.scene.binding.artManifestHash === art.manifestSha256, "conductor_renderer_scene_binding_mismatch");
      if (value && sameSpace(value.position, next.position)) {
        const dx = next.position.xMm - value.position.xMm, dy = next.position.yMm - value.position.yMm;
        if (dx !== 0 || dy !== 0) {
          playerDirection = Math.abs(dx) >= Math.abs(dy) ? dx > 0 ? "east" : "west" : dy > 0 ? "south" : "north";
          const atMs = next.atMs ?? next.scene?.atMs;
          const animation = art.animations.find((entry) => entry.appearanceId === art.conductorAppearanceId && entry.direction === playerDirection && entry.state === "walk");
          playerWalkUntilMs = atMs === undefined ? null : atMs + (animation?.frames.reduce((sum, frame) => sum + frame.durationMs, 0) ?? 0);
        }
      } else playerWalkUntilMs = null;
      value = next;
      if (!view || !bodyFor(view)?.deckIds.includes(view.deckId)) { view = { ...next.position, zoom: view?.zoom ?? 1 }; cameraMm = null; }
      render();
    },
    setView(next): void {
      ensure([1, 2, 3, 4].includes(next.zoom) && bodyFor(next)?.deckIds.includes(next.deckId), "conductor_view_invalid");
      view = next; cameraMm = next.centerMm ?? null; render();
    },
    focusPlayer(): void {
      if (!value) return;
      view = { ...value.position, zoom: view?.zoom ?? 1 }; cameraMm = null; render();
    },
    panBy(pixels): void {
      ensure(Number.isFinite(pixels), "conductor_pan_invalid");
      if (!value || !view) return;
      const base = cameraMm ?? (sameSpace(value.position, view) ? value.position.xMm : selectedBody().lengthMm / 2);
      cameraMm = Math.max(0, Math.min(selectedBody().lengthMm, Math.round(base + pixels / view.zoom / PIXELS_PER_MM))); render();
    },
    resize,
    getStats: () => ({ backend: "webgl", logicalPassengers: value?.passengers.passengers.length ?? 0, visiblePassengers,
      loadedAtlases: sources.size, zoom: view?.zoom ?? 1 }),
    dispose(): void {
      if (disposed) return;
      disposed = true; observer.disconnect(); motionPreference.removeEventListener("change", motionPreferenceChanged); app.destroy({ removeView: true }, { children: true });
      for (const texture of textures.values()) texture.destroy(false);
      for (const source of sources.values()) source.destroy();
      for (const bitmap of bitmaps) bitmap.close();
      textures.clear(); sources.clear(); passengerSprites.clear(); accessorySprites.clear(); value = null;
    },
  };
}
