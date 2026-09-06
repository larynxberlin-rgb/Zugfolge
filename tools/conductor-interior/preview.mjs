const $ = (id) => document.getElementById(id);
const state = { catalog: null, layout: null, caseId: null, evidence: {}, images: new Map(), zoom: 1, bodyKey: null, deckId: null, currentNodeId: null, busy: false, movements: 0, rejected: 0, lastIssue: null };
const capacityLabels = { standardSeats: "Sitze · 2. Klasse", premiumSeats: "Sitze · 1. Klasse", standardStanding: "Stehplätze", wheelchairSpaces: "Rollstuhlflächen", bicycleSpaces: "Fahrradflächen", strollerSpaces: "Kinderwagenflächen" };
const deckLabels = { main: "Hauptdeck", lower: "Unterdeck", upper: "Oberdeck" };
const interactionLabels = { passenger: "Fahrgastplatz", door: "Tür", toilet: "WC", accessible_toilet: "Barrierefreies WC", cab: "Führerstand", stair: "Treppe", bicycle: "Fahrradfläche", stroller: "Kinderwagenfläche", wheelchair: "Rollstuhlfläche" };
const SCALE = 32 / 1000, LEFT = 34, TOP = 56;

async function api(path, input) {
  const response = await fetch(path, input === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.issue?.code ?? "preview_request_failed"), { code: value.issue?.code ?? "preview_request_failed" });
  return value;
}
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function option(value, label) { const node = element("option", label); node.value = value; return node; }
function bodyKey(body) { return `${body.vehicleId}/${body.bodyId}`; }
function allBodies() { return state.layout?.vehicles.flatMap((vehicle) => vehicle.bodies) ?? []; }
function selectedBody() { return allBodies().find((body) => bodyKey(body) === state.bodyKey); }
function currentNode() { return state.layout?.nodes.find((node) => node.nodeId === state.currentNodeId); }
function sameDeck(point) { return point.vehicleId === selectedBody()?.vehicleId && point.bodyId === selectedBody()?.bodyId && point.deckId === state.deckId; }
function sameSpace(first, second) { return first.vehicleId === second.vehicleId && first.bodyId === second.bodyId && first.deckId === second.deckId; }
function px(mm) { return Math.round(mm * SCALE); }
function message(text, issue = null) { $("movement").textContent = text; state.lastIssue = issue; $("main").dataset.lastIssue = issue ?? ""; }
function locked(value) { state.busy = value; for (const id of ["walk", "case", "collision", "transition"]) $(id).disabled = value; }

function evidenceRows(value) {
  $("evidence").replaceChildren();
  for (const [key, item] of Object.entries(value)) { $("evidence").append(element("dt", key), element("dd", typeof item === "object" ? JSON.stringify(item) : String(item))); }
}
function renderConfiguration() {
  $("capacity").replaceChildren(); $("vehicle-configs").replaceChildren();
  if (!state.layout) return;
  for (const [key, label] of Object.entries(capacityLabels)) { const node = element("div"); node.append(element("strong", state.layout.capacity[key]), document.createTextNode(label)); $("capacity").append(node); }
  for (const vehicle of state.layout.vehicles) {
    const card = element("article", undefined, "config-card");
    card.append(element("h3", `Fahrzeug ${vehicle.vehicleId}`));
    const config = vehicle.configuration;
    if (config) {
      const { structural, interior } = config;
      card.append(element("p", `${structural.bodyLengthMm.toLocaleString("de-DE")} mm · ${structural.doorCountPerSide} Türen je Seite · ${structural.doorWidthMm} mm Türbreite`));
      card.append(element("p", `${interior.firstClassSeats} + ${interior.secondClassSeats} Sitze · ${interior.multipurpose.standing} Stehplätze · ${interior.toilets} WC, davon ${interior.accessibleToilets} barrierefrei`));
      card.append(element("p", `${({ row: "Reihenbestuhlung", face_to_face: "Vis-à-vis-Bestuhlung", folding: "Klappsitze" })[interior.seatType]} · ${({ dense: "dicht", standard: "Standardabstand", spacious: "großzügig" })[interior.density]}`));
      card.append(element("p", `${vehicle.bodies.length} Wagenkasten/-kästen · ${vehicle.bodies.some((body) => body.deckIds.length > 1) ? "zwei Innenebenen" : "eine Innenebene"}`));
    } else card.append(element("p", "Nicht für Fahrgäste begehbare Fahrzeughülle."));
    $("vehicle-configs").append(card);
  }
}
function renderSelectors() {
  const bodies = allBodies();
  $("body").replaceChildren(...bodies.map((body, index) => option(bodyKey(body), `${index + 1} · Fahrzeug ${body.vehicleId} / ${body.bodyId}`)));
  $("body").value = state.bodyKey;
  renderDecks();
  $("destination").replaceChildren(...state.layout.interactions.map((item, index) => {
    const node = state.layout.nodes.find((node) => node.nodeId === item.nodeId);
    return option(item.nodeId, `${interactionLabels[item.kind] ?? item.kind} ${index + 1} · ${node?.point.bodyId} / ${deckLabels[node?.point.deckId]}`);
  }));
}
function renderDecks() {
  const body = selectedBody();
  if (!body) return;
  if (!body.deckIds.includes(state.deckId)) state.deckId = body.deckIds[0];
  $("deck").replaceChildren(...body.deckIds.map((deck) => option(deck, deckLabels[deck])));
  $("deck").value = state.deckId;
}

function asset(id) { return state.catalog.art.manifest.assets.find((asset) => asset.id === id); }
function drawAsset(context, item, x, y) {
  if (!item) return;
  const image = state.images.get(item.fileId), file = state.catalog.art.manifest.files.find((file) => file.id === item.fileId);
  if (!image || !file) return;
  const { rect } = item;
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, Math.round(x), Math.round(y), rect.width / file.sourceScale, rect.height / file.sourceScale);
}
function draw() {
  const layout = state.layout, body = selectedBody();
  if (!layout || !body) return;
  const canvas = $("layout"), width = px(body.lengthMm), height = px(body.widthMm);
  canvas.width = Math.max(310, width + LEFT * 2); canvas.height = Math.max(220, height + TOP + 65);
  canvas.style.width = `${canvas.width * state.zoom}px`; canvas.style.height = `${canvas.height * state.zoom}px`;
  const ctx = canvas.getContext("2d"); ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#101419"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#b5c0cc"; ctx.font = "11px Segoe UI, sans-serif";
  ctx.fillText(`${body.bodyId} · ${deckLabels[state.deckId]} · ${body.lengthMm.toLocaleString("de-DE")} × ${body.widthMm.toLocaleString("de-DE")} mm`, LEFT, 26);
  ctx.fillStyle = "#93a2b1"; ctx.font = "9px Segoe UI, sans-serif"; ctx.fillText("Längsrichtung x →", LEFT, 42);
  ctx.save(); ctx.beginPath(); ctx.rect(LEFT, TOP, width, height); ctx.clip();
  const floor = asset("interior.floor");
  if (floor) for (let x = 0; x < width; x += 64) for (let y = 0; y < height; y += 64) drawAsset(ctx, floor, LEFT + x, TOP + y);
  ctx.fillStyle = "#10141988"; ctx.fillRect(LEFT, TOP, width, height); ctx.restore();
  for (const obstacle of layout.obstacles.filter(sameDeck)) {
    const rect = obstacle.rect, x = LEFT + px(rect.xMm), y = TOP + px(rect.yMm), w = Math.max(1, px(rect.lengthMm)), h = Math.max(1, px(rect.widthMm));
    const colors = { wall: "#4d5b69", cab: "#33414e", seat: "#aa4d5b", toilet: "#496f88", accessible_toilet: "#496f88", stair: "#7b718d", bicycle: "#8b6e41", stroller: "#8b6e41", wheelchair: "#8b6e41" };
    ctx.fillStyle = colors[obstacle.kind] ?? "#596977"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = obstacle.kind === "seat" ? "#ef9eaa" : "#94a2af"; ctx.strokeRect(x + .5, y + .5, Math.max(0, w - 1), Math.max(0, h - 1));
    if (obstacle.kind === "seat") {
      const seat = layout.seats.find((seat) => seat.obstacleId === obstacle.obstacleId);
      if (seat) { ctx.fillStyle = "#f5c1c9"; ctx.fillRect(seat.facing === "forward" ? x + 1 : x + w - 3, y + 1, 2, Math.max(1, h - 2)); }
    }
    if (["toilet", "accessible_toilet", "stair", "cab"].includes(obstacle.kind)) { ctx.fillStyle = "#fff"; ctx.font = "8px Segoe UI, sans-serif"; ctx.fillText(({ toilet: "WC", accessible_toilet: "WC ♿", stair: "↕", cab: "F" })[obstacle.kind], x + 3, y + Math.min(h - 2, 12)); }
  }
  for (const door of layout.doors.filter(sameDeck)) {
    const rect = door.rect;
    ctx.fillStyle = "#7cddba"; ctx.fillRect(LEFT + px(rect.xMm), TOP + px(rect.yMm), Math.max(1, px(rect.lengthMm)), Math.max(2, px(rect.widthMm)));
  }
  if ($("network").checked) {
    ctx.strokeStyle = "#7cddbaaa"; ctx.lineWidth = 1;
    for (const edge of layout.edges) {
      const first = layout.nodes.find((node) => node.nodeId === edge.fromNodeId), second = layout.nodes.find((node) => node.nodeId === edge.toNodeId);
      if (!first || !second || !sameDeck(first.point) || !sameDeck(second.point)) continue;
      ctx.beginPath(); ctx.moveTo(LEFT + px(first.point.xMm), TOP + px(first.point.yMm)); ctx.lineTo(LEFT + px(second.point.xMm), TOP + px(second.point.yMm)); ctx.stroke();
    }
  }
  for (const place of layout.passengerPlaces.filter(sameDeck)) {
    const x = LEFT + px(place.xMm), y = TOP + px(place.yMm);
    ctx.fillStyle = place.kind === "standing" ? "#aec5d7" : place.comfortClass === "premium" ? "#ffe1a7" : "#ffd8df";
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  for (const bay of layout.specialBays.filter(sameDeck)) {
    ctx.strokeStyle = "#f5bf65"; ctx.strokeRect(LEFT + px(bay.xMm) - 5, TOP + px(bay.yMm) - 5, 10, 10);
  }
  for (const interaction of layout.interactions.filter((item) => item.kind === "door" || item.kind === "stair")) {
    const node = layout.nodes.find((node) => node.nodeId === interaction.nodeId);
    if (!node || !sameDeck(node.point)) continue;
    const x = LEFT + px(node.point.xMm), y = TOP + px(node.point.yMm);
    ctx.fillStyle = interaction.kind === "door" ? "#7cddba" : "#d8bfff"; ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  const current = currentNode();
  if (current && sameDeck(current.point)) {
    const x = LEFT + px(current.point.xMm), y = TOP + px(current.point.yMm);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x - 11, y - 11, 22, 22);
    ctx.strokeStyle = "#e5233d"; ctx.strokeRect(x - 13, y - 13, 26, 26);
    const frame = state.catalog.art.manifest.animations.find((animation) => animation.role === "conductor" && animation.direction === "south" && animation.state === "idle")?.frames[0];
    const item = frame ? asset(frame.assetId) : null;
    if (item) {
      const file = state.catalog.art.manifest.files.find((file) => file.id === item.fileId);
      drawAsset(ctx, item, x - item.pivot.x / file.sourceScale, y - item.pivot.y / file.sourceScale);
    }
  }
  ctx.fillStyle = "#b5c0cc"; ctx.font = "10px Segoe UI, sans-serif";
  const places = layout.passengerPlaces.filter(sameDeck), bays = layout.specialBays.filter(sameDeck);
  ctx.fillText(`${places.filter((p) => p.kind === "seat").length} Sitzplätze · ${places.filter((p) => p.kind === "standing").length} Stehplätze · ${bays.length} Sonderflächen`, LEFT, TOP + height + 25);
  if (!current || !sameDeck(current.point)) { ctx.fillStyle = "#f5bf65"; ctx.fillText("Die Prüffigur befindet sich in einer anderen Innenebene.", LEFT, TOP + height + 42); }
  $("layout-subtitle").textContent = `${body.passengerAccessible ? "Begehbarer" : "Unbegehbarer"} Wagenkasten · ${body.reversed ? "gegen die Formationsrichtung" : "in Formationsrichtung"} · ${deckLabels[state.deckId]}`;
  $("main").dataset.currentNode = state.currentNodeId ?? ""; $("main").dataset.deck = state.deckId; $("main").dataset.movements = String(state.movements);
}
function follow() {
  const node = currentNode();
  if (!node) return;
  state.bodyKey = `${node.point.vehicleId}/${node.point.bodyId}`; state.deckId = node.point.deckId;
  $("body").value = state.bodyKey; renderDecks(); draw();
  $("viewport").scrollLeft = Math.max(0, (LEFT + px(node.point.xMm)) * state.zoom - $("viewport").clientWidth / 2);
  $("viewport").scrollTop = Math.max(0, (TOP + px(node.point.yMm)) * state.zoom - $("viewport").clientHeight / 2);
}

async function loadCase(id) {
  locked(true); $("status").textContent = "Prüfe die committed Fahrzeugkonfiguration.";
  state.caseId = id; state.layout = null; state.movements = 0; state.rejected = 0; state.lastIssue = null;
  $("main").dataset.collisionAllowed = ""; $("collision-details").open = false;
  const definition = state.catalog.cases.find((item) => item.id === id);
  $("case-description").textContent = definition.description; $("layout-title").textContent = definition.label;
  $("layout-subtitle").textContent = "Die Fahrzeugkonfiguration wird geprüft.";
  $("valid-layout").hidden = true; $("blocked").hidden = true;
  try {
    const data = await api(`/api/cases/${id}/layout`);
    state.evidence = data.evidence ?? {}; evidenceRows({ ...state.catalog.evidence, ...state.evidence });
    if (data.issue) {
      $("blocked").hidden = false; $("blocked-code").textContent = data.issue.code; $("blocked-reason").textContent = data.issue.message;
      $("layout-subtitle").textContent = "Es liegt kein freigegebenes betretbares Layout vor.";
      $("layout-badge").textContent = "Einstieg gesperrt"; $("layout-badge").classList.add("pending");
      $("status").textContent = "Der fehlende Nachweis verhindert die Innenraumfreigabe."; $("main").dataset.state = "blocked";
      state.lastIssue = data.issue.code; renderConfiguration(); return;
    }
    if (!data.layout || data.layout.schemaVersion !== "interior-layout/v1") throw Object.assign(new Error(), { code: "preview_layout_invalid" });
    state.layout = data.layout; state.currentNodeId = data.layout.entranceNodeId;
    if (!currentNode()) throw Object.assign(new Error(), { code: "preview_entrance_missing" });
    const start = currentNode().point; state.bodyKey = `${start.vehicleId}/${start.bodyId}`; state.deckId = start.deckId;
    renderConfiguration(); renderSelectors();
    evidenceRows({ ...state.catalog.evidence, ...state.evidence, ...data.layout.binding, layoutHash: data.layout.layoutHash });
    $("valid-layout").hidden = false; $("layout-badge").textContent = "Geometrie geprüft"; $("layout-badge").classList.remove("pending");
    $("status").textContent = `${data.layout.vehicles.length} Fahrzeuge · ${allBodies().length} Kästen · ${data.layout.nodes.length} geprüfte Wegpunkte.`;
    $("main").dataset.state = "ready"; $("main").dataset.layoutHash = data.layout.layoutHash;
    message("Die Prüffigur steht am bestätigten Einstieg."); $("collision-result").textContent = ""; follow();
  } catch (error) {
    $("main").dataset.state = "error"; $("status").textContent = `Der Innenraum ist nicht verfügbar: ${error.code ?? "preview_load_failed"}.`;
  } finally { locked(false); }
}

async function moveTo(nextNodeId, edgeId) {
  const from = currentNode(), to = state.layout.nodes.find((node) => node.nodeId === nextNodeId);
  if (!from || !to) throw Object.assign(new Error(), { code: "preview_node_missing" });
  const result = await api(`/api/cases/${state.caseId}/movement`, { expectedLayoutHash: state.layout.layoutHash, from: from.point, to: to.point, transitionEdgeId: sameSpace(from.point, to.point) ? null : edgeId, wheelchair: $("wheelchair").checked });
  if (!result.allowed) { state.rejected++; throw Object.assign(new Error(), { code: result.issue ?? "interior_movement_blocked" }); }
  state.currentNodeId = nextNodeId; state.movements++; follow();
}
async function routeTo(destination) {
  if (state.busy || !state.layout) return;
  locked(true);
  try {
    const path = await api(`/api/cases/${state.caseId}/path`, { expectedLayoutHash: state.layout.layoutHash, fromNodeId: state.currentNodeId, toNodeId: destination, wheelchair: $("wheelchair").checked });
    if (path.layoutHash !== state.layout.layoutHash || path.nodeIds[0] !== state.currentNodeId || path.edgeIds.length !== path.nodeIds.length - 1) throw Object.assign(new Error(), { code: "preview_path_invalid" });
    for (let index = 1; index < path.nodeIds.length; index++) { message(`Begehe geprüften Wegabschnitt ${index} von ${path.edgeIds.length} …`); await moveTo(path.nodeIds[index], path.edgeIds[index - 1]); }
    message(`Ziel erreicht · ${path.edgeIds.length} nativ geprüfte Wegabschnitte · ${path.lengthMm.toLocaleString("de-DE")} mm.`);
  } catch (error) { message(`Weg abgelehnt: ${error.code ?? "preview_path_failed"}.`, error.code); }
  finally { locked(false); }
}
async function step(direction, transition = false) {
  if (state.busy || !state.layout) return;
  const current = currentNode();
  const connected = state.layout.edges.filter((edge) => edge.fromNodeId === current.nodeId || edge.toNodeId === current.nodeId).map((edge) => ({ edge, node: state.layout.nodes.find((node) => node.nodeId === (edge.fromNodeId === current.nodeId ? edge.toNodeId : edge.fromNodeId)) })).filter((entry) => entry.node);
  const candidates = connected.filter(({ edge, node }) => transition ? edge.kind !== "walk" && !sameSpace(current.point, node.point) : sameSpace(current.point, node.point) && ({ east: node.point.xMm > current.point.xMm, west: node.point.xMm < current.point.xMm, south: node.point.yMm > current.point.yMm, north: node.point.yMm < current.point.yMm })[direction]);
  candidates.sort((a, b) => a.edge.lengthMm - b.edge.lengthMm || a.edge.edgeId.localeCompare(b.edge.edgeId));
  if (!candidates[0]) return message(transition ? "Hier gibt es keine benutzbare Treppe oder Gangway. Gehe zuerst zu ihrem Zugang." : "In dieser Richtung endet der bestätigte Weg.");
  locked(true);
  try { await moveTo(candidates[0].node.nodeId, candidates[0].edge.edgeId); message(`${transition ? "Übergang" : "Wegabschnitt"} nativ geprüft · ${deckLabels[currentNode().point.deckId]}.`); }
  catch (error) { message(`Bewegung abgelehnt: ${error.code ?? "preview_movement_failed"}.`, error.code); }
  finally { locked(false); }
}

$("case").addEventListener("change", () => loadCase($("case").value));
$("body").addEventListener("change", () => { state.bodyKey = $("body").value; renderDecks(); draw(); });
$("deck").addEventListener("change", () => { state.deckId = $("deck").value; draw(); });
$("network").addEventListener("change", draw);
$("zooms").addEventListener("click", (event) => { const button = event.target.closest("[data-zoom]"); if (!button) return; state.zoom = Number(button.dataset.zoom); for (const item of $("zooms").children) item.setAttribute("aria-pressed", String(item === button)); draw(); });
$("follow").addEventListener("click", follow); $("walk").addEventListener("click", () => routeTo($("destination").value));
$("transition").addEventListener("click", () => step(null, true));
for (const button of document.querySelectorAll("[data-direction]")) button.addEventListener("click", () => step(button.dataset.direction));
$("viewport").addEventListener("keydown", (event) => { const direction = { ArrowLeft: "west", ArrowRight: "east", ArrowUp: "north", ArrowDown: "south" }[event.key]; if (direction) { event.preventDefault(); step(direction); } });
$("layout").addEventListener("click", (event) => {
  if (!state.layout) return;
  const rect = $("layout").getBoundingClientRect(), x = (event.clientX - rect.left) / state.zoom - LEFT, y = (event.clientY - rect.top) / state.zoom - TOP;
  const nodes = state.layout.nodes.filter((node) => sameDeck(node.point)).map((node) => ({ node, distance: (px(node.point.xMm) - x) ** 2 + (px(node.point.yMm) - y) ** 2 })).sort((a, b) => a.distance - b.distance);
  if (nodes[0] && nodes[0].distance <= 20 ** 2) routeTo(nodes[0].node.nodeId);
});
$("collision").addEventListener("click", async () => {
  if (state.busy || !state.layout) return;
  const from = currentNode().point;
  const obstacle = state.layout.obstacles.find((item) => sameSpace(from, item) && item.kind === "seat") ?? state.layout.obstacles.find((item) => sameSpace(from, item) && item.kind === "wall");
  if (!obstacle) { $("collision-result").textContent = "In dieser Ebene liegt keine prüfbare Kollisionsfläche vor."; return; }
  const to = { ...from, xMm: obstacle.rect.xMm + Math.floor(obstacle.rect.lengthMm / 2), yMm: obstacle.rect.yMm + Math.floor(obstacle.rect.widthMm / 2) };
  locked(true);
  try {
    const result = await api(`/api/cases/${state.caseId}/movement`, { expectedLayoutHash: state.layout.layoutHash, from, to, transitionEdgeId: null, wheelchair: $("wheelchair").checked });
    $("collision-result").textContent = result.allowed ? "Prüffehler: Kollisionsfläche wurde unerwartet freigegeben." : `Kollision verhindert · ${result.issue}. Die Figur bleibt am bestätigten Punkt.`;
    state.lastIssue = result.issue; if (!result.allowed) state.rejected++; $("main").dataset.collisionAllowed = String(result.allowed);
  } catch (error) { $("collision-result").textContent = `Prüfung abgelehnt: ${error.code ?? "preview_movement_failed"}.`; }
  finally { locked(false); }
});

Object.defineProperty(window, "interiorProofSummary", { get: () => ({ caseId: state.caseId, layoutHash: state.layout?.layoutHash ?? null, currentNodeId: state.currentNodeId, currentPoint: currentNode()?.point ?? null, view: { bodyKey: state.bodyKey, deckId: state.deckId, zoom: state.zoom }, movements: state.movements, rejected: state.rejected, lastIssue: state.lastIssue, capacity: state.layout?.capacity ?? null, artManifestSha256: state.catalog?.art.manifestSha256 ?? null }) });

try {
  state.catalog = await api("/api/cases");
  if (state.catalog.schemaVersion !== "conductor-interior-preview-cases/v1" || !state.catalog.cases.length) throw Object.assign(new Error(), { code: "preview_catalog_invalid" });
  for (const file of state.catalog.art.manifest.files) {
    const image = new Image(); image.src = `/api/art/${file.id}`; await image.decode(); state.images.set(file.id, image);
  }
  $("source-badge").textContent = "M5-Konfiguration → Rust-Geometrie";
  $("case").replaceChildren(...state.catalog.cases.map((item) => option(item.id, item.label)));
  await loadCase(state.catalog.cases[0].id);
} catch (error) { $("main").dataset.state = "error"; $("status").textContent = `Prüfstand nicht verfügbar: ${error.code ?? "preview_initialization_failed"}. Es wird kein Ersatzlayout erzeugt.`; }
