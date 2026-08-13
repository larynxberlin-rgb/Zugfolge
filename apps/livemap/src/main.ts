import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import {
  addProtocol,
  AttributionControl,
  type ErrorEvent,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  Map as MapLibreMap,
  type MapLayerMouseEvent,
  type GeoJSONSourceSpecification,
  NavigationControl,
  removeProtocol,
  ScaleControl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import type {
  LivemapConfigV2,
  PublicObjectState,
} from "@zugfolge/livemap-stream";

import { LivemapApiClient } from "./api.js";
import { renderAttentionRail, renderAttentionUnavailable } from "./attention.js";
import { ensureAccessToken, loadRuntimeConfiguration } from "./auth.js";
import {
  assertSelfHostedConfig,
  emptyDarkStyle,
  focusParameter,
  INFRASTRUCTURE_SOURCE_ID,
  infrastructureLayers,
  installMissingBasemapImageResolver,
  INTERACTION_LAYER_IDS,
  loadSelfHostedStyle,
  parseFocusParameter,
  PLAYABLE_AREA_SOURCE_ID,
  selectionFromFeature,
  sortAndDeduplicateSelections,
  SOURCE_LAYER_BY_KIND,
  TRAIN_SOURCE_ID,
  trainFeatureCollection,
  trainLayers,
  type MapSelection,
} from "./map-contract.js";
import {
  loadingPanel,
  messagePanel,
  objectDetailPanel,
  stationPanel,
  trainPanel,
} from "./panels.js";
import {
  LivemapConnection,
  operatorLabel,
  type LiveState,
  type PublicExternalTrain,
} from "./protocol.js";
import { livemapNavigationDestinations, mailboxDecisionDestination } from "./navigation.js";
import "./style.css";
import "./external-runs.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt.");

root.innerHTML = `
  <a class="skip-link" href="#map-object-list">Zur zugänglichen Objektliste</a>
  <main class="app-shell">
    <header class="topbar">
      <a class="wordmark" href="/" aria-label="Zugfolge Live-Lage">ZUGFOLGE</a>
      <div class="world-context">
        <span class="eyebrow">LIVE-LAGE</span>
        <strong id="world-label">Welt wird geladen</strong>
      </div>
      <nav aria-label="Hauptnavigation">
        <a id="live-link" aria-current="page" href="/">Live-Lage</a>
        <a id="journey-link" href="/">Welt</a>
        <a id="market-link" href="/#maerkte">Märkte</a>
        <a id="planner-link" href="/">Fahrplan</a>
        <a id="operations-link" href="/#betrieb">Betrieb</a>
        <a id="mailbox-link" href="/#postfach">Postfach</a>
        <span id="glossary-slot"></span>
      </nav>
      <time id="sequence-label">verbinde …</time>
    </header>
    <section id="attention-rail" class="attention-rail" aria-labelledby="attention-title" aria-live="polite" hidden></section>
    <section class="workspace">
      <section class="map-frame" aria-labelledby="live-map-title">
        <h1 id="live-map-title" class="sr-only">Interaktive Live-Lage</h1>
        <div id="map" role="application" aria-label="Weltkarte mit deutscher Eisenbahninfrastruktur und Live-Betrieb"></div>
        <div id="map-state" class="map-state" role="status" aria-live="polite">Kartenstand wird geprüft …</div>
        <div class="map-tools" aria-label="Kartenwerkzeuge">
          <button id="fit-playable" type="button">Spielgebiet</button>
          <button id="show-germany" type="button">Deutschland</button>
          <button id="toggle-context" type="button" aria-pressed="true">Weltkarte</button>
        </div>
        <section id="selection-menu" class="selection-menu" aria-label="Überlagerte Kartenobjekte" hidden></section>
        <section id="external-runs" aria-label="Zugfahrten ohne darstellbare Kartenlage und Außenläufe"></section>
        <div class="legend" aria-label="Legende">
          <span><i class="legend-line active"></i> aktive Infrastruktur</span>
          <span><i class="legend-line context"></i> Kontext</span>
          <span><i class="legend-line restriction"></i> Langsamfahrt/Störung</span>
          <span><i class="legend-line closure"></i> gesperrt</span>
          <span><i class="legend-line construction"></i> Bauarbeiten</span>
          <span><i class="legend-line quality-c"></i> Klasse C</span>
          <span><i class="legend-train-estimated">≈</i> <button type="button" class="zf-glossary-term" data-glossary-code="PublicMapEstimate">Zugposition geschätzt</button></span>
        </div>
      </section>
      <aside id="details" aria-label="Details zum ausgewählten Kartenobjekt">
        <button id="close-details" class="close-details" type="button" aria-label="Detailansicht schließen">×</button>
        <div id="details-content"></div>
      </aside>
    </section>
    <section id="map-object-list" class="object-list" tabindex="-1" aria-labelledby="object-list-title">
      <div>
        <p class="eyebrow">TASTATURANSICHT</p>
        <h2 id="object-list-title">Aktuelle Zugfahrten</h2>
      </div>
      <div id="object-list-content"></div>
    </section>
  </main>`;

const parameters = new URLSearchParams(window.location.search);
const runtime = loadRuntimeConfiguration();
const worldId = parameters.get("world")?.trim() || runtime.publicWorldId;
const navigation = livemapNavigationDestinations(runtime.gameWebUrl, window.location.href, worldId);
document.querySelector<HTMLAnchorElement>("#live-link")!.href = navigation.live;
document.querySelector<HTMLAnchorElement>("#journey-link")!.href = navigation.journey;
document.querySelector<HTMLAnchorElement>("#market-link")!.href = navigation.markets;
document.querySelector<HTMLAnchorElement>("#planner-link")!.href = navigation.planner;
document.querySelector<HTMLAnchorElement>("#operations-link")!.href = navigation.operations;
document.querySelector<HTMLAnchorElement>("#mailbox-link")!.href = navigation.mailbox;
mountGlossaryLayer(document.body);
document.querySelector<HTMLElement>("#glossary-slot")!
  .append(document.querySelector<HTMLElement>("[data-zugfolge-glossary]")!);
const details = document.querySelector<HTMLElement>("#details")!;
const attentionRail = document.querySelector<HTMLElement>("#attention-rail")!;
const detailsContent = document.querySelector<HTMLElement>("#details-content")!;
const sequenceLabel = document.querySelector<HTMLTimeElement>("#sequence-label")!;
const worldLabel = document.querySelector<HTMLElement>("#world-label")!;
const mapState = document.querySelector<HTMLElement>("#map-state")!;
const externalRuns = document.querySelector<HTMLElement>("#external-runs")!;
const objectList = document.querySelector<HTMLElement>("#object-list-content")!;
const selectionMenu = document.querySelector<HTMLElement>("#selection-menu")!;
const contextButton = document.querySelector<HTMLButtonElement>("#toggle-context")!;

let map: MapLibreMap | undefined;
let api: LivemapApiClient | undefined;
let connection: LivemapConnection | undefined;
let mapConfig: LivemapConfigV2 | undefined;
let liveState: LiveState | undefined;
let selected: MapSelection | undefined;
let previousSelected: MapSelection | undefined;
let appliedObjectStates = new Map<string, PublicObjectState>();
let renderQueued = false;

function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className !== undefined) node.className = className;
  return node;
}

function setPanel(content: Node): void {
  detailsContent.replaceChildren(content);
  details.classList.add("open");
}

function closePanel(updateUrl = true): void {
  selected = undefined;
  updateSelectionState();
  details.classList.remove("open");
  setPanel(messagePanel("Gleis, Bahnhof, Signal, Weiche oder Zug auswählen."));
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.delete("focus");
    window.history.replaceState({}, "", url);
  }
}

function updateSelectionState(): void {
  if (map === undefined) return;
  if (previousSelected !== undefined) {
    const previousTarget = previousSelected.kind === "train"
      ? { source: TRAIN_SOURCE_ID, id: previousSelected.id }
      : { source: INFRASTRUCTURE_SOURCE_ID, sourceLayer: SOURCE_LAYER_BY_KIND[previousSelected.kind], id: previousSelected.id };
    try { map.setFeatureState(previousTarget, { selected: false }); } catch { /* noch nicht sichtbare Tile */ }
  }
  if (selected !== undefined) {
    const nextTarget = selected.kind === "train"
      ? { source: TRAIN_SOURCE_ID, id: selected.id }
      : { source: INFRASTRUCTURE_SOURCE_ID, sourceLayer: SOURCE_LAYER_BY_KIND[selected.kind], id: selected.id };
    try { map.setFeatureState(nextTarget, { selected: true }); } catch { /* Detail-Deep-Link darf ohne geladene Tile funktionieren. */ }
  }
  previousSelected = selected;
}

function updateFocusUrl(selection: MapSelection): void {
  const url = new URL(window.location.href);
  url.searchParams.set("focus", focusParameter(selection));
  window.history.replaceState({}, "", url);
}

async function selectObject(selection: MapSelection): Promise<void> {
  selected = selection;
  updateSelectionState();
  updateFocusUrl(selection);
  selectionMenu.hidden = true;
  setPanel(loadingPanel(selection.label));
  const client = api;
  if (client === undefined) {
    setPanel(messagePanel("Detaildienst ist nicht verbunden.", "error"));
    return;
  }
  try {
    if (selection.kind === "train") {
      const publicDetail = await client.publicTrain(worldId, selection.id);
      const operatorId = publicDetail.ownerOperatorId;
      const ownerDetail = operatorId === undefined
        ? undefined
        : await client.ownerTrain(worldId, operatorId, selection.id);
      if (selected?.id === selection.id && selected.kind === "train") setPanel(trainPanel(publicDetail, ownerDetail));
      return;
    }
    const objectDetail = await client.object(worldId, selection.kind, selection.id);
    if (selection.kind === "station") {
      const board = await client.stationBoard(worldId, selection.id);
      if (selected?.id === selection.id && selected.kind === "station") setPanel(stationPanel(objectDetail, board));
    } else if (selected?.id === selection.id && selected.kind === selection.kind) {
      setPanel(objectDetailPanel(objectDetail));
    }
  } catch (error) {
    if (selected?.id !== selection.id) return;
    setPanel(messagePanel(error instanceof Error ? error.message : "Detail konnte nicht geladen werden.", "error"));
  }
}

function showSelectionMenu(selections: readonly MapSelection[], left: number, top: number): void {
  selectionMenu.replaceChildren(text("p", "Welches Objekt möchten Sie öffnen?", "eyebrow"));
  selections.forEach((selection) => {
    const button = document.createElement("button");
    button.type = "button";
    button.append(text("strong", selection.label), text("span", selection.kind));
    button.addEventListener("click", () => void selectObject(selection));
    selectionMenu.append(button);
  });
  selectionMenu.style.left = `${left}px`;
  selectionMenu.style.top = `${top}px`;
  selectionMenu.hidden = false;
  selectionMenu.querySelector<HTMLButtonElement>("button")?.focus();
}

function selectionsAt(features: readonly MapGeoJSONFeature[]): readonly MapSelection[] {
  return sortAndDeduplicateSelections(
    features.flatMap((feature) => {
      const selection = selectionFromFeature(feature);
      return selection === undefined ? [] : [selection];
    }),
  );
}

function playableBounds(config: LivemapConfigV2): [[number, number], [number, number]] | undefined {
  const bounds = config.playableArea?.boundsE7;
  if (bounds === undefined) return undefined;
  return [
    [bounds.west / 10_000_000, bounds.south / 10_000_000],
    [bounds.east / 10_000_000, bounds.north / 10_000_000],
  ];
}

function playableGeoJson(config: LivemapConfigV2): GeoJSONSourceSpecification["data"] {
  const bounds = config.playableArea?.boundsE7;
  if (bounds === undefined) return { type: "FeatureCollection", features: [] };
  const west = bounds.west / 10_000_000;
  const south = bounds.south / 10_000_000;
  const east = bounds.east / 10_000_000;
  const north = bounds.north / 10_000_000;
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { label: config.playableArea?.label ?? "Spielgebiet" },
      geometry: { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    }],
  };
}

function absolutePmtilesUrl(value: string): string {
  return `pmtiles://${new URL(value, window.location.href).href}`;
}

function addZugfolgeLayers(currentMap: MapLibreMap, config: LivemapConfigV2): void {
  currentMap.addSource(INFRASTRUCTURE_SOURCE_ID, {
    type: "vector",
    url: absolutePmtilesUrl(config.infrastructure.pmtilesUrl),
    promoteId: "feature_id",
    attribution: config.infrastructure.attribution,
  });
  currentMap.addSource(PLAYABLE_AREA_SOURCE_ID, { type: "geojson", data: playableGeoJson(config) });
  currentMap.addLayer({
    id: "playable-area-fill",
    type: "fill",
    source: PLAYABLE_AREA_SOURCE_ID,
    minzoom: 4,
    paint: { "fill-color": "#9fb8e8", "fill-opacity": 0.035 },
  });
  currentMap.addLayer({
    id: "playable-area-boundary",
    type: "line",
    source: PLAYABLE_AREA_SOURCE_ID,
    minzoom: 4,
    paint: { "line-color": "#9fb8e8", "line-width": 1.4, "line-dasharray": [2, 2], "line-opacity": 0.72 },
  });
  infrastructureLayers().forEach((layer) => currentMap.addLayer(layer));
  currentMap.addSource(TRAIN_SOURCE_ID, {
    type: "geojson",
    data: trainFeatureCollection([], config.infrastructureReleaseId) as never,
    promoteId: "objectId",
  });
  trainLayers.forEach((layer) => currentMap.addLayer(layer));
}

function applyLiveObjectStates(currentMap: MapLibreMap, states: ReadonlyMap<string, PublicObjectState>): void {
  for (const [key, previous] of appliedObjectStates) {
    if (states.has(key)) continue;
    try {
      currentMap.removeFeatureState({
        source: INFRASTRUCTURE_SOURCE_ID,
        sourceLayer: SOURCE_LAYER_BY_KIND[previous.objectKind],
        id: previous.objectId,
      }, "operationalState");
    } catch { /* Tile kann zwischenzeitlich entladen sein. */ }
  }
  for (const [key, state] of states) {
    if (appliedObjectStates.get(key)?.state === state.state) continue;
    try {
      currentMap.setFeatureState({
        source: INFRASTRUCTURE_SOURCE_ID,
        sourceLayer: SOURCE_LAYER_BY_KIND[state.objectKind],
        id: state.objectId,
      }, { operationalState: state.state });
    } catch { /* Zustand wird beim nächsten Feed-Render erneut gesetzt. */ }
  }
  appliedObjectStates = new Map(states);
}

function renderExternalRuns(state: LiveState): void {
  const positionless = [...state.trains.values()].filter((train) =>
    train.mapPosition === undefined && train.mapEstimate === undefined
  );
  const external = [...state.externalTrains.values()];
  if (positionless.length === 0 && external.length === 0) {
    externalRuns.replaceChildren();
    return;
  }
  const nodes: HTMLElement[] = [];
  if (positionless.length > 0) {
    nodes.push(
      text("p", "OHNE KARTENLAGE", "eyebrow"),
      text("p", "Hier fehlt auch eine belastbare Schätzlage. Die Fahrt bleibt anklickbar, ohne einen Kartenpunkt zu erfinden.", "position-note"),
    );
    positionless.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, "de")).forEach((train) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "external-run";
      button.append(text("strong", train.trainNumber), text("span", `${operatorLabel(train)} · ${train.nextOperatingPoint}`));
      button.addEventListener("click", () => void selectObject({ kind: "train", id: train.id, label: train.trainNumber }));
      nodes.push(button);
    });
  }
  if (external.length > 0) {
    nodes.push(
      text("p", "AUSSENLÄUFE", "eyebrow"),
      text("p", "Diese Fahrt läuft außerhalb des modellierten Gebiets weiter und bleibt bewusst in der Liste.", "position-note"),
    );
    external.sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, "de")).forEach((train: PublicExternalTrain) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "external-run";
      button.append(text("strong", train.trainNumber), text("span", `${train.fromPortalId} → ${train.toPortalId ?? "Außenziel"} · ${train.status}`));
      button.addEventListener("click", () => {
        setPanel(messagePanel(`${train.trainNumber} fährt als derselbe Zug außerhalb des modellierten Gebiets. Es wird bewusst keine Kartenposition erzeugt.`));
      });
      nodes.push(button);
    });
  }
  externalRuns.replaceChildren(...nodes);
}

function renderObjectList(state: LiveState): void {
  const list = document.createElement("ul");
  [...state.trains.values()]
    .sort((a, b) => a.trainNumber.localeCompare(b.trainNumber, "de") || a.id.localeCompare(b.id))
    .forEach((train) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const positionLabel = train.mapPosition !== undefined
        ? train.nextOperatingPoint
        : train.mapEstimate?.method === "anchor-hold"
          ? "letzte belastbare Lage"
          : train.mapEstimate !== undefined
            ? "Position geschätzt"
            : "ohne Kartenlage";
      button.append(text("strong", train.trainNumber), text("span", `${operatorLabel(train)} · ${train.status} · ${positionLabel}`));
      button.addEventListener("click", () => void selectObject({ kind: "train", id: train.id, label: train.trainNumber }));
      item.append(button);
      list.append(item);
    });
  objectList.replaceChildren(list);
}

function scheduleLiveRender(state: LiveState): void {
  liveState = state;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const latest = liveState;
    if (latest === undefined) return;
    sequenceLabel.textContent = `Sequenz ${latest.sequence}`;
    sequenceLabel.classList.remove("connection-error");
    renderExternalRuns(latest);
    renderObjectList(latest);
    const currentMap = map;
    const currentConfig = mapConfig;
    if (currentMap !== undefined && currentConfig !== undefined && currentMap.isStyleLoaded()) {
      const source = currentMap.getSource(TRAIN_SOURCE_ID) as GeoJSONSource | undefined;
      // Derselbe Zug behaelt fuer exakt/geschaetzt dieselbe Feature-ID. Der
      // Zielpunkt wird direkt ersetzt: keine irrefuehrende Luftlinienanimation.
      source?.setData(trainFeatureCollection(latest.trains.values(), currentConfig.infrastructureReleaseId) as never);
      applyLiveObjectStates(currentMap, latest.objectStates);
      updateSelectionState();
    }
  });
}

async function createMap(config: LivemapConfigV2): Promise<MapLibreMap> {
  assertSelfHostedConfig(config, window.location.href);
  let style;
  try {
    style = await loadSelfHostedStyle(config.basemap.styleUrl, window.location.href);
  } catch (error) {
    mapState.textContent = error instanceof Error ? error.message : "Selbst gehostete Basiskarte fehlt.";
    mapState.classList.add("error");
    style = emptyDarkStyle();
  }

  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  const currentMap = new MapLibreMap({
    container: "map",
    style,
    center: [config.initialView.longitudeE7 / 10_000_000, config.initialView.latitudeE7 / 10_000_000],
    zoom: config.initialView.zoomMilli / 1_000,
    minZoom: 2,
    maxZoom: 20,
    attributionControl: false,
  });
  installMissingBasemapImageResolver(currentMap);
  currentMap.addControl(new NavigationControl({ visualizePitch: true }), "top-left");
  currentMap.addControl(new ScaleControl({ unit: "metric", maxWidth: 140 }), "bottom-left");
  currentMap.addControl(new AttributionControl({ compact: true, customAttribution: [config.basemap.attribution, config.infrastructure.attribution] }), "bottom-right");

  await new Promise<void>((resolve, reject) => {
    currentMap.once("load", () => resolve());
    currentMap.once("error", (event: ErrorEvent) => {
      if (!currentMap.loaded()) reject(event.error);
    });
  });
  addZugfolgeLayers(currentMap, config);
  mapState.textContent = `Infrastruktur ${config.infrastructure.coverage} · Stand ${config.infrastructureReleaseId}`;
  mapState.classList.remove("error");
  window.setTimeout(() => mapState.classList.add("quiet"), 3_000);

  currentMap.on("click", (event: MapLayerMouseEvent) => {
    const features = currentMap.queryRenderedFeatures(event.point, { layers: [...INTERACTION_LAYER_IDS] });
    const selections = selectionsAt(features);
    if (selections.length === 0) {
      selectionMenu.hidden = true;
      return;
    }
    if (selections.length === 1) void selectObject(selections[0]!);
    else showSelectionMenu(selections, event.point.x, event.point.y);
  });
  currentMap.on("mousemove", (event: MapLayerMouseEvent) => {
    const found = currentMap.queryRenderedFeatures(event.point, { layers: [...INTERACTION_LAYER_IDS] }).length > 0;
    currentMap.getCanvas().style.cursor = found ? "pointer" : "";
  });
  currentMap.on("move", () => { selectionMenu.hidden = true; });
  currentMap.on("error", (event: ErrorEvent) => {
    mapState.textContent = `Kartenartefakt konnte nicht gelesen werden: ${event.error.message}`;
    mapState.classList.add("error");
  });
  return currentMap;
}

function bindShell(): void {
  document.querySelector<HTMLButtonElement>("#close-details")?.addEventListener("click", () => closePanel());
  document.querySelector<HTMLButtonElement>("#fit-playable")?.addEventListener("click", () => {
    const bounds = mapConfig === undefined ? undefined : playableBounds(mapConfig);
    if (bounds !== undefined) map?.fitBounds(bounds, { padding: 54, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 });
  });
  document.querySelector<HTMLButtonElement>("#show-germany")?.addEventListener("click", () => {
    map?.fitBounds([[5.5, 47.0], [15.6, 55.2]], { padding: 34, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 });
  });
  contextButton.addEventListener("click", () => {
    const current = contextButton.getAttribute("aria-pressed") === "true";
    contextButton.setAttribute("aria-pressed", String(!current));
    const basemapLayers = map?.getStyle().layers.filter((layer) => !layer.id.startsWith("playable-") && !infrastructureLayers().some((own) => own.id === layer.id) && !trainLayers.some((own) => own.id === layer.id)) ?? [];
    basemapLayers.forEach((layer) => map?.setLayoutProperty(layer.id, "visibility", current ? "none" : "visible"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      selectionMenu.hidden = true;
      closePanel();
    }
  });
}

async function boot(): Promise<void> {
  bindShell();
  closePanel(false);
  if (worldId === "") {
    worldLabel.textContent = "keine Welt gewählt";
    mapState.textContent = "Weltkennung fehlt.";
    mapState.classList.add("error");
    return;
  }
  worldLabel.textContent = "Welt wird geladen";
  try {
    const accessToken = await ensureAccessToken(runtime);
    if (accessToken === "") return;
    api = new LivemapApiClient(runtime.gameApiUrl, accessToken);
    void api.mailbox(worldId)
      .then((messages) => renderAttentionRail(
        attentionRail,
        messages,
        (message) => mailboxDecisionDestination(runtime.gameWebUrl, window.location.href, worldId, message),
      ))
      .catch(() => renderAttentionUnavailable(attentionRail));
    mapConfig = await api.config(worldId);
    worldLabel.textContent = mapConfig.worldName;
    map = await createMap(mapConfig);
    const focus = parseFocusParameter(parameters.get("focus"));
    if (focus !== undefined) void selectObject(focus);
    connection = new LivemapConnection(runtime.gameApiUrl, worldId, accessToken, scheduleLiveRender, {
      onError: () => {
        sequenceLabel.textContent = "Verbindung unterbrochen · neuer Versuch";
        sequenceLabel.classList.add("connection-error");
      },
    });
    await connection.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live-Lage konnte nicht gestartet werden.";
    mapState.textContent = message;
    mapState.classList.add("error");
    setPanel(messagePanel(message, "error"));
  }
}

window.addEventListener("beforeunload", () => {
  connection?.close();
  map?.remove();
  removeProtocol("pmtiles");
});

void boot();
