const $ = (id) => document.getElementById(id);
const DIRECTIONS = ["north", "east", "south", "west"];
const DIRECTION_NAMES = { north: "Norden", east: "Osten", south: "Süden", west: "Westen" };
const APPEARANCES = ["passenger-01", "passenger-02", "passenger-03", "passenger-04", "conductor-01"];
const NAMES = { "passenger-01": "Fahrgast · Rot", "passenger-02": "Fahrgast · Petrol", "passenger-03": "Fahrgast · Ocker", "passenger-04": "Fahrgast · Schiefer", "conductor-01": "Dein Schaffner" };
const PART_NAMES = { body: "Innenraum", lower: "Unterdeck", upper: "Oberdeck", roof: "Geschlossenes Dach" };
const state = { data: null, assets: new Map(), files: new Map(), images: new Map(), animations: new Map(), zoom: 1,
  playing: false, elapsed: 0, last: null, activeTab: "scene", actorViews: [], generation: 0 };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function node(tag, text, className) { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; if (className) result.className = className; return result; }
function canvas(width, height) { const result = document.createElement("canvas"); result.width = width; result.height = height; return result; }
function geometry(asset) { const scale = state.files.get(asset.fileId)?.sourceScale ?? 1; return { width: asset.rect.width / scale, height: asset.rect.height / scale, scale }; }
function drawAsset(ctx, id, x, y, { pivot = false, rotated = false } = {}) {
  const asset = state.assets.get(id), image = asset && state.images.get(asset.fileId);
  if (!asset || !image) return false;
  const { width, height, scale } = geometry(asset), rect = asset.rect;
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.translate(Math.round(x), Math.round(y));
  if (rotated) ctx.transform(0, -1, 1, 0, 0, width);
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height,
    pivot ? -asset.pivot.x / scale : 0, pivot ? -asset.pivot.y / scale : 0, width, height);
  ctx.restore(); return true;
}
function frame(appearance, direction, pose) {
  const animation = state.animations.get(`${appearance}.${direction}.${pose}`);
  if (!animation?.frames?.length) return null;
  const total = animation.frames.reduce((sum, row) => sum + row.durationMs, 0);
  let elapsed = state.elapsed % total;
  for (const entry of animation.frames) { if (elapsed < entry.durationMs) return entry.assetId; elapsed -= entry.durationMs; }
  return animation.frames[0].assetId;
}
function paintSprite(target, assetId, zoom = state.zoom) {
  const asset = state.assets.get(assetId); if (!asset) return;
  const { width, height } = geometry(asset);
  target.width = width * zoom; target.height = height * zoom;
  const ctx = target.getContext("2d"); ctx.imageSmoothingEnabled = false; ctx.scale(zoom, zoom);
  drawAsset(ctx, assetId, 0, 0); target.dataset.assetId = assetId;
}
function sprite(assetId, zoom = state.zoom) {
  const viewport = node("div", undefined, "sprite-viewport"); viewport.tabIndex = 0;
  const asset = state.assets.get(assetId);
  if (asset && state.images.has(asset.fileId)) {
    const display = canvas(64, 64); display.setAttribute("role", "img"); display.setAttribute("aria-label", assetId); paintSprite(display, assetId, zoom); viewport.append(display);
  } else viewport.append(node("span", "Noch nicht vorhanden", "missing-frame"));
  return viewport;
}
function setPlaying(value) {
  state.playing = value; state.last = null;
  $("motion").setAttribute("aria-pressed", String(value));
  $("motion").textContent = value ? "Grafikanimation pausieren" : "Grafikanimation starten";
}
reducedMotion.addEventListener("change", (event) => { if (event.matches) setPlaying(false); });

function renderScene() {
  const display = $("scene"), width = 960, height = 832;
  if (display.width !== width * state.zoom || display.height !== height * state.zoom) { display.width = width * state.zoom; display.height = height * state.zoom; }
  const ctx = display.getContext("2d"); ctx.setTransform(state.zoom, 0, 0, state.zoom, 0, 0); ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = "#101419"; ctx.fillRect(0, 0, width, height);
  const station = $("station").value, environment = $("environment").value, missing = new Set();
  const draw = (id, x, y, options) => { if (!drawAsset(ctx, id, x, y, options)) missing.add(id); };
  const label = (text, x, y) => { ctx.fillStyle = "#b5c0cc"; ctx.font = "11px Segoe UI, sans-serif"; ctx.fillText(text, x, y); };
  draw(`environment.${environment}.vegetation`, 26, 25);
  draw(`environment.${environment}.building`, 660, 25);
  for (let index = 0; index < 3; index += 1) draw(`environment.${environment}.road`, 94 + index * 256, 286);
  draw(`station.${station}.hall`, 300, 24);
  draw(`station.${station}.underpass`, 630, 566);
  draw(`station.${station}.stairs`, 28, 640);
  const platform = state.assets.get(`station.${station}.platform`), platformWidth = platform ? geometry(platform).width : 256;
  const platformHeight = platform ? geometry(platform).height : 96;
  const copies = platformWidth <= 256 ? 3 : 2, platformStart = Math.floor((960 - copies * platformWidth) / 2);
  for (let index = 0; index < copies; index += 1) draw(`station.${station}.platform`, platformStart + index * platformWidth, 394);
  if ($("platform-roof").checked) {
    const roof = state.assets.get(`station.${station}.roof`), roofHeight = roof ? geometry(roof).height : 128;
    for (let index = 0; index < copies; index += 1) draw(`station.${station}.roof`, platformStart + index * platformWidth, 394 - roofHeight + 48);
  }
  const vehicle = selectedVehicle(), trainAssetId = vehicleAssetId(vehicle, $("roof").checked ? "roof" : $("deck").value);
  const trainAsset = state.assets.get(trainAssetId), trainLength = trainAsset ? geometry(trainAsset).height : vehicle.id === "legacy" ? 640 : 864;
  const trainX = Math.floor((width - trainLength) / 2), trainY = 394 + platformHeight - 26;
  display.dataset.trainY = String(trainY);
  display.dataset.vehicleAssetId = trainAssetId;
  draw(trainAssetId, trainX, trainY, { rotated: true });
  if (!$("roof").checked && trainAsset && state.images.has(trainAsset.fileId)) {
    for (const [index, appearance] of APPEARANCES.entries()) {
      const direction = index === 4 ? "east" : "south", pose = index === 4 ? "walk" : "idle";
      const selected = frame(appearance, direction, pose);
      if (selected) draw(selected, trainX + 165 + index * 76, trainY + (index % 2 === 0 ? 43 : 67), { pivot: true });
      else missing.add(`actor.${appearance}.${direction}.${pose}`);
    }
  }
  draw("signal.stop", Math.min(width - 48, trainX + trainLength + 4), trainY - 4);
  if (vehicle.id === "legacy") {
    draw("vehicle.front", 300, 686, { rotated: true });
    label("WAGENFRONT · EINZELMODUL", 300, 679);
  }
  label("NATIVE ATLASMONTAGE · POSITIONEN NUR ZUR GRAFIKPRÜFUNG", 28, 812);
  const title = `${$("environment").selectedOptions[0].textContent} · ${$("station").selectedOptions[0].textContent}`;
  $("scene-title").textContent = title; display.dataset.station = station; display.dataset.environment = environment;
  display.dataset.frame = frame("conductor-01", "east", "walk") ?? "missing";
  display.dataset.missing = String(missing.size);
  const signature = [...missing].sort().join(",");
  if ($("scene-missing").dataset.signature !== signature) {
    $("scene-missing").replaceChildren(...[...missing].sort().map((id) => node("li", id))); $("scene-missing").dataset.signature = signature;
    $("scene-missing-summary").textContent = missing.size ? `${missing.size} Szenenmotive noch nicht vorhanden` : "Alle verwendeten Szenenmotive sind vorhanden";
  }
}

function selectedVehicle() { return state.data.catalog.vehicleVariants.find((vehicle) => vehicle.id === $("vehicle").value) ?? { id: "legacy", label: "Generischer Altbestand", decks: ["body"], parts: ["body", "roof"] }; }
function vehicleAssetId(vehicle, part) { return vehicle.id === "legacy" ? `vehicle.${part}` : `vehicle.${vehicle.id}.${part}`; }
function syncVehicleControls() {
  const vehicle = selectedVehicle(), previous = $("deck").value;
  $("deck").replaceChildren(...vehicle.decks.map((part) => { const option = node("option", PART_NAMES[part]); option.value = part; return option; }));
  if (vehicle.decks.includes(previous)) $("deck").value = previous;
  $("deck").disabled = vehicle.decks.length === 1 || $("roof").checked;
  $("vehicle-note").textContent = $("roof").checked ? "Geschlossenes Dach · Innenebene bleibt gespeichert" : vehicle.decks.length > 1 ? "Zwei getrennte Innenebenen" : "Eine Innenebene";
}
function loadVehicleControls() {
  const previous = $("vehicle").value;
  const options = [...state.data.catalog.vehicleVariants, { id: "legacy", label: "Generischer Altbestand" }];
  $("vehicle").replaceChildren(...options.map((vehicle) => { const option = node("option", vehicle.label); option.value = vehicle.id; return option; }));
  if (options.some((vehicle) => vehicle.id === previous)) $("vehicle").value = previous;
  syncVehicleControls();
}
function renderVehicles() {
  const view = $("comparison-view").value;
  $("vehicle-grid").replaceChildren(...state.data.catalog.vehicleVariants.map((vehicle) => {
    const part = view === "roof" ? "roof" : view === "upper" ? vehicle.decks.at(-1) : vehicle.decks[0];
    const id = vehicleAssetId(vehicle, part), card = node("article", undefined, "vehicle-card");
    card.dataset.vehicleId = vehicle.id; card.dataset.part = part;
    card.append(node("h3", vehicle.label), node("p", `${PART_NAMES[part]} · ${vehicle.decks.length === 2 ? "zwei Ebenen" : "eine Ebene"}`, "vehicle-part"));
    const inspect = node("button", "In Szene prüfen", "quiet");
    inspect.addEventListener("click", () => {
      $("vehicle").value = vehicle.id; $("roof").checked = part === "roof"; syncVehicleControls();
      if (vehicle.decks.includes(part)) $("deck").value = part;
      renderScene(); selectTab("scene", true);
    });
    card.append(inspect, sprite(id), node("p", id, "vehicle-asset-id")); return card;
  }));
}

function renderActors() {
  state.actorViews = [];
  $("actor-grid").replaceChildren(...APPEARANCES.map((appearance) => {
    const group = node("article", undefined, "actor-set"); group.append(node("h3", NAMES[appearance]));
    for (const direction of DIRECTIONS) {
      const item = node("div", undefined, "figure-direction"), selected = frame(appearance, direction, $("pose").value);
      const view = sprite(selected ?? `actor.${appearance}.${direction}.${$("pose").value}`);
      item.append(view, node("span", DIRECTION_NAMES[direction])); group.append(item);
      if (selected && view.querySelector("canvas")) state.actorViews.push({ target: view.querySelector("canvas"), appearance, direction });
    }
    return group;
  }));
}
function renderGallery() {
  const query = $("search").value.toLocaleLowerCase("de"), category = $("category").value;
  const all = [...new Set([...state.data.catalog.requiredAssetIds, ...state.assets.keys()])].sort();
  const entries = all.filter((id) => (category === "all" || id.split(".")[0] === category) && id.toLocaleLowerCase("de").includes(query));
  $("result-count").textContent = `${entries.length} Motive`;
  $("gallery").replaceChildren(...entries.map((id) => {
    const asset = state.assets.get(id), card = node("article", undefined, `asset-card${asset ? "" : " is-missing"}`);
    card.dataset.assetId = id; card.append(sprite(id), node("h3", id));
    if (asset) {
      const { width, height } = geometry(asset); card.append(node("p", `${width} × ${height} logische px · ${(asset.worldWidthMm / 1000).toLocaleString("de")} × ${(asset.worldHeightMm / 1000).toLocaleString("de")} m Bildfläche`));
      const button = node("button", "Einzeln ansehen", "asset-open"); button.addEventListener("click", () => showAsset(id)); card.append(button);
    } else card.append(node("p", "Pflichtmotiv noch nicht geliefert"));
    return card;
  }));
}
function showAsset(id) {
  $("asset-title").textContent = id;
  $("asset-detail").replaceChildren(sprite(id)); $("asset-dialog").showModal();
}
function renderEvidence() {
  const manifest = state.data.manifest;
  const entries = [
    ["Prüfansicht", state.data.schemaVersion], ["Vorbereiteter Grafikstand", state.data.prepared.schemaVersion],
    ["Prüfkatalog", state.data.catalog.version],
    ["SHA-256 · prepared.json", state.data.preparedSha256], ["Release", manifest?.releaseId ?? "Noch kein Manifest vorhanden"],
    ["Manifeststatus (Deklaration)", manifest?.status ?? "Noch kein Freigabebeleg"],
    ["SHA-256 · Manifest", state.data.manifestSha256 ?? "Nicht vorhanden"],
    ["Release-Sichtprüfung", manifest?.releaseReview?.status ?? "Nicht belegt"],
    ["Umfang", `${state.assets.size} Bilder/Frames · ${state.animations.size} Animationen · ${state.images.size}/${state.files.size} PNG-Dateien geladen`],
    ["Signatur / produktive Aktivierung", "Diese Galerie prüft keine Signatur und aktiviert keine Welt."],
  ];
  $("evidence").replaceChildren(...entries.flatMap(([label, value]) => [node("dt", label), node("dd", value)]));
  const colors = state.data.prepared.palette ?? [];
  $("palette").replaceChildren(...colors.map((color) => {
    const swatch = node("span", undefined, "swatch"); swatch.title = color; swatch.setAttribute("role", "img"); swatch.setAttribute("aria-label", `Palettenfarbe ${color}`);
    const image = canvas(37, 37); image.getContext("2d").fillStyle = color; image.getContext("2d").fillRect(0, 0, 37, 37); swatch.append(image); return swatch;
  }));
}
function render() {
  if (!state.data) return;
  const missing = state.data.catalog.requiredAssetIds.filter((id) => !state.assets.has(id));
  $("asset-count").textContent = `${state.assets.size} Motive / Frames · ${missing.length} Pflichtmotive offen`;
  $("file-count").textContent = `${state.images.size}/${state.files.size} Atlasdateien geladen · ${state.animations.size} Bildfolgen`;
  $("gallery-count").textContent = String(state.assets.size);
  $("approval").textContent = state.data.manifest ? `Manifest: ${state.data.manifest.status} · ungeprüfte Deklaration` : "Noch kein Freigabebeleg";
  $("revision").textContent = `Grafikstand ${state.data.preparedSha256.slice(0, 12)} · Zoom ${state.zoom}×`;
  renderScene(); renderVehicles(); renderActors(); renderGallery(); renderEvidence();
}
async function load() {
  const generation = ++state.generation; $("reload").disabled = true; $("load-state").textContent = "Lade den lokalen Grafikstand …";
  try {
    const response = await fetch("/api/release", { cache: "no-store" }); if (!response.ok) throw new Error("Der Grafikstand ist noch nicht lesbar.");
    const data = await response.json();
    if (data.schemaVersion !== "conductor-art-preview/v1") throw new Error("Unbekannter Grafikprüfvertrag.");
    const files = new Map(data.prepared.files.map((file) => [file.id, file])), images = new Map();
    const failures = [];
    await Promise.all([...files].map(async ([id, file]) => {
      if (!/^atlases\/[a-zA-Z0-9._-]+\.png$/.test(file.path)) { failures.push(id); return; }
      const image = new Image(); image.src = `/${file.path}?revision=${encodeURIComponent(data.preparedSha256)}`;
      try { await image.decode(); if (image.naturalWidth !== file.widthPx || image.naturalHeight !== file.heightPx) throw new Error("dimensions"); images.set(id, image); }
      catch { failures.push(id); }
    }));
    if (generation !== state.generation) return;
    state.data = data; state.files = files; state.images = images;
    state.assets = new Map(data.prepared.assets.map((asset) => [asset.id, asset]));
    state.animations = new Map(data.prepared.animations.map((animation) => [`${animation.appearanceId}.${animation.direction}.${animation.state}`, animation]));
    loadVehicleControls();
    render();
    $("load-state").textContent = failures.length ? `${failures.length} Atlasdateien fehlen oder passen nicht zum beschriebenen Maß. Kein Ersatzbild geladen.` : "Originale Atlasdateien geladen. Bildbewegung ist ausschließlich eine Grafikvorschau.";
    document.body.dataset.loaded = "true"; document.body.dataset.assetCount = String(state.assets.size);
  } catch (error) { $("load-state").textContent = error.message; }
  finally { if (generation === state.generation) $("reload").disabled = false; }
}
function selectTab(name, focus = false) {
  state.activeTab = name;
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const active = tab.id === `tab-${name}`; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; $(tab.getAttribute("aria-controls")).hidden = !active;
    if (active && focus) tab.focus();
  }
}
for (const tab of document.querySelectorAll('[role="tab"]')) {
  tab.addEventListener("click", () => selectTab(tab.id.slice(4)));
  tab.addEventListener("keydown", (event) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')], index = tabs.indexOf(tab);
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next !== null) { event.preventDefault(); selectTab(tabs[next].id.slice(4), true); }
  });
}
for (const button of document.querySelectorAll("[data-zoom]")) button.addEventListener("click", () => {
  state.zoom = Number(button.dataset.zoom);
  for (const item of document.querySelectorAll("[data-zoom]")) item.setAttribute("aria-pressed", String(item === button));
  render();
});
$("motion").addEventListener("click", () => { setPlaying(!state.playing); renderScene(); });
$("reload").addEventListener("click", load);
for (const id of ["station", "environment", "deck", "platform-roof"]) $(id).addEventListener("change", renderScene);
for (const id of ["vehicle", "roof"]) $(id).addEventListener("change", () => { syncVehicleControls(); renderScene(); });
$("comparison-view").addEventListener("change", renderVehicles);
$("pose").addEventListener("change", renderActors);
$("search").addEventListener("input", renderGallery); $("category").addEventListener("change", renderGallery);
$("asset-close").addEventListener("click", () => $("asset-dialog").close());
$("focus-train").addEventListener("click", () => {
  const viewport = $("scene").parentElement;
  viewport.scrollTo({ left: Math.max(0, 444 * state.zoom - Math.round(viewport.clientWidth / 2)),
    top: Math.max(0, Number($("scene").dataset.trainY) * state.zoom - Math.round(viewport.clientHeight / 3)), behavior: "instant" });
  viewport.focus({ preventScroll: true });
});
$("focus-station").addEventListener("click", () => {
  const viewport = $("scene").parentElement;
  viewport.scrollTo({ left: Math.max(0, 470 * state.zoom - Math.round(viewport.clientWidth / 2)), top: 0, behavior: "instant" });
  viewport.focus({ preventScroll: true });
});
function tick(timestamp) {
  if (state.playing && state.data) {
    if (state.last !== null) state.elapsed += Math.min(100, timestamp - state.last);
    state.last = timestamp;
    if (state.activeTab === "scene") renderScene();
    if (state.activeTab === "actors") for (const view of state.actorViews) {
      const next = frame(view.appearance, view.direction, $("pose").value);
      if (next && view.target.dataset.assetId !== next) paintSprite(view.target, next);
    }
  }
  requestAnimationFrame(tick);
}
setPlaying(false); await load(); requestAnimationFrame(tick);
