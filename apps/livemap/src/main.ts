import "@zugfolge/design-system/styles.css";
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
import {
  formatAvailableFinance,
  formatEuroCents,
  type PlayerOperatorContextV1,
} from "@zugfolge/player-context";

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
  installPlayerMapIcons,
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
  appendRenderSample,
  LivemapConnection,
  operatorLabel,
  renderTrains,
  type LiveState,
  type PublicExternalTrain,
  type RenderSamples,
} from "./protocol.js";
import { livemapNavigationDestinations, mailboxDecisionDestination, operationsCenterDestination } from "./navigation.js";
import { externalStatusLabel, localizeMapControls, operatingStatusLabel, railwayPlaceLabel, setMapViewButtons, visibleExternalTrains, type MapView } from "./presentation.js";
import { rzueMarkup } from "./rzue.js";
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
      <details id="operator-context" class="operator-context">
        <summary aria-label="EVU- und Finanzkontext öffnen">
          <span class="operator-context__company"><span class="eyebrow">EVU</span><strong id="operator-label">wird geladen</strong></span>
          <span class="operator-context__finance"><span class="eyebrow">VERFÜGBAR</span><strong id="finance-label">—</strong></span>
        </summary>
        <div class="operator-context__popover">
          <label id="operator-selector-field" hidden><span>Handelndes EVU</span><select id="operator-selector"></select></label>
          <p id="operator-context-note" class="operator-context__note" hidden></p>
          <dl id="finance-breakdown">
            <div><dt>Kontostand</dt><dd id="ledger-balance">—</dd></div>
            <div><dt>Vorgemerkt</dt><dd id="pending-debits">—</dd></div>
            <div class="operator-context__available"><dt>Verfügbar</dt><dd id="available-balance">—</dd></div>
          </dl>
          <a id="finance-link" href="/">Finanzen öffnen</a>
        </div>
      </details>
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
        <div class="mode-switch" role="group" aria-label="Lagedarstellung">
          <button id="mode-livemap" type="button" aria-pressed="true">LiveMap</button>
          <button id="mode-rzue" type="button" aria-pressed="false">RZÜ</button>
          <button id="rzue-level" type="button" aria-pressed="false" hidden>Expertenebene</button>
        </div>
        <div id="map" role="application" aria-label="Weltkarte mit deutscher Eisenbahninfrastruktur und Live-Betrieb"></div>
        <section id="rzue" class="rzue" aria-label="Lesende schematische Betriebsübersicht" hidden></section>
        <div id="map-state" class="map-state" role="status" aria-live="polite">Kartenstand wird geprüft …</div>
        <div class="map-tools" aria-label="Kartenwerkzeuge">
          <button id="fit-playable" data-map-view="playable" type="button" aria-pressed="true">Spielgebiet</button>
          <button id="show-germany" data-map-view="germany" type="button" aria-pressed="false">Deutschland</button>
          <button id="show-world" data-map-view="world" type="button" aria-pressed="false">Weltkarte</button>
        </div>
        <section id="selection-menu" class="selection-menu" aria-label="Überlagerte Kartenobjekte" hidden></section>
        <section id="external-runs" aria-label="Zugfahrten ohne darstellbare Kartenlage und Außenläufe"></section>
        <div class="legend" aria-label="Legende">
          <span><i class="legend-line active"></i> aktive Infrastruktur</span>
          <span><i class="legend-line context"></i> Kontext</span>
          <span><i class="legend-line restriction"></i> Langsamfahrt/Störung</span>
          <span><i class="legend-line closure"></i> gesperrt</span>
          <span><i class="legend-line construction"></i> Bauarbeiten</span>
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
const navigation = livemapNavigationDestinations(runtime.gameWebUrl, window.location.href, worldId, runtime.operationsCenterUrl);
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
const operatorContextElement = document.querySelector<HTMLDetailsElement>("#operator-context")!;
const operatorNameLabel = document.querySelector<HTMLElement>("#operator-label")!;
const financeLabel = document.querySelector<HTMLElement>("#finance-label")!;
const operatorSelectorField = document.querySelector<HTMLElement>("#operator-selector-field")!;
const operatorSelector = document.querySelector<HTMLSelectElement>("#operator-selector")!;
const operatorContextNote = document.querySelector<HTMLElement>("#operator-context-note")!;
const financeBreakdown = document.querySelector<HTMLElement>("#finance-breakdown")!;
const ledgerBalance = document.querySelector<HTMLElement>("#ledger-balance")!;
const pendingDebits = document.querySelector<HTMLElement>("#pending-debits")!;
const availableBalance = document.querySelector<HTMLElement>("#available-balance")!;
const financeLink = document.querySelector<HTMLAnchorElement>("#finance-link")!;
const externalRuns = document.querySelector<HTMLElement>("#external-runs")!;
const objectList = document.querySelector<HTMLElement>("#object-list-content")!;
const selectionMenu = document.querySelector<HTMLElement>("#selection-menu")!;
const mapViewButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-map-view]")];
const modeLivemap = document.querySelector<HTMLButtonElement>("#mode-livemap")!;
const modeRzue = document.querySelector<HTMLButtonElement>("#mode-rzue")!;
const rzueLevel = document.querySelector<HTMLButtonElement>("#rzue-level")!;
const rzue = document.querySelector<HTMLElement>("#rzue")!;
const mapElement = document.querySelector<HTMLElement>("#map")!;

let map: MapLibreMap | undefined;
let api: LivemapApiClient | undefined;
let connection: LivemapConnection | undefined;
let mapConfig: LivemapConfigV2 | undefined;
let renderSamples: RenderSamples | undefined;
let renderSampleStartedAtMs = 0;
let selected: MapSelection | undefined;
let previousSelected: MapSelection | undefined;
let appliedObjectStates = new Map<string, PublicObjectState>();
let renderFrame: number | undefined;
let liveRenderingFrozen = false;
let currentLiveState: LiveState | undefined;
let rzueExpert = false;

function setOperatingView(view: "livemap" | "rzue"): void {
  const isRzue = view === "rzue";
  modeLivemap.setAttribute("aria-pressed", String(!isRzue));
  modeRzue.setAttribute("aria-pressed", String(isRzue));
  rzue.hidden = !isRzue;
  mapElement.hidden = isRzue;
  rzueLevel.hidden = !isRzue;
  document.querySelector<HTMLElement>(".map-tools")!.hidden = isRzue;
  document.querySelector<HTMLElement>(".legend")!.hidden = isRzue;
  mapState.hidden = isRzue;
  if (isRzue && currentLiveState !== undefined) {
    rzue.innerHTML = rzueMarkup(
      [...currentLiveState.trains.values()],
      [...currentLiveState.operationalRegions.values()],
      rzueExpert,
    );
  } else if (!isRzue) {
    map?.resize();
  }
}

modeLivemap.addEventListener("click", () => setOperatingView("livemap"));
modeRzue.addEventListener("click", () => setOperatingView("rzue"));
rzueLevel.addEventListener("click", () => {
  rzueExpert = !rzueExpert;
  rzueLevel.setAttribute("aria-pressed", String(rzueExpert));
  rzueLevel.textContent = rzueExpert ? "Übersicht" : "Expertenebene";
  setOperatingView("rzue");
});

function gameWebDestination(section: "world" | "company", operatorId?: string): string {
  const destination = new URL(runtime.gameWebUrl.trim() === "" ? "/" : runtime.gameWebUrl, window.location.href);
  destination.searchParams.set("view", "journey");
  destination.searchParams.set("world", worldId);
  destination.searchParams.set("section", section);
  if (operatorId !== undefined) destination.searchParams.set("operator", operatorId);
  return destination.href;
}

function renderPlayerContext(context: PlayerOperatorContextV1): void {
  const requestedOperatorId = parameters.get("operator");
  const selected = context.operators.find((operator) => operator.id === requestedOperatorId) ?? context.operators[0];
  operatorSelector.replaceChildren(...context.operators.map((operator) => {
    const option = document.createElement("option");
    option.value = operator.id;
    option.textContent = operator.name;
    option.selected = operator.id === selected?.id;
    return option;
  }));
  operatorSelectorField.hidden = context.operators.length < 2;
  operatorContextNote.hidden = true;
  financeBreakdown.hidden = false;
  if (selected === undefined) {
    operatorNameLabel.textContent = "Kein EVU";
    financeLabel.textContent = "—";
    financeBreakdown.hidden = true;
    operatorContextNote.textContent = "Gründen Sie zuerst ein EVU in dieser Welt.";
    operatorContextNote.hidden = false;
    financeLink.textContent = "EVU gründen";
    financeLink.href = gameWebDestination("world");
    return;
  }
  operatorNameLabel.textContent = selected.name;
  financeLabel.textContent = formatAvailableFinance(selected.finance);
  financeLink.textContent = "Finanzen öffnen";
  financeLink.href = gameWebDestination("company", selected.id);
  document.querySelector<HTMLAnchorElement>("#operations-link")!.href = operationsCenterDestination(
    runtime.operationsCenterUrl,
    runtime.gameWebUrl,
    window.location.href,
    worldId,
    selected.id,
  );
  if (selected.finance.mode === "unlimited") {
    ledgerBalance.textContent = "Unbegrenzt";
    pendingDebits.textContent = "Nicht anwendbar";
    availableBalance.textContent = "Unbegrenzt";
  } else {
    ledgerBalance.textContent = formatEuroCents(selected.finance.ledgerBalanceCents);
    pendingDebits.textContent = selected.finance.pendingDebitCents === "0"
      ? "Keine"
      : `− ${formatEuroCents(selected.finance.pendingDebitCents)}`;
    availableBalance.textContent = formatEuroCents(selected.finance.availableCents);
  }
}

function renderPlayerContextUnavailable(): void {
  operatorNameLabel.textContent = "Nicht verfügbar";
  financeLabel.textContent = "—";
  operatorSelectorField.hidden = true;
  financeBreakdown.hidden = true;
  operatorContextNote.textContent = "EVU- und Finanzdaten konnten nicht geladen werden. Es wird kein Nullsaldo angenommen.";
  operatorContextNote.hidden = false;
  financeLink.textContent = "In der Spielwelt erneut versuchen";
  financeLink.href = gameWebDestination("company");
}

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
      : { source: INFRASTRUCTURE_SOURCE_ID, sourceLayer: previousSelected.sourceLayer ?? SOURCE_LAYER_BY_KIND[previousSelected.kind], id: previousSelected.id };
    try { map.setFeatureState(previousTarget, { selected: false }); } catch { /* noch nicht sichtbare Tile */ }
  }
  if (selected !== undefined) {
    const nextTarget = selected.kind === "train"
      ? { source: TRAIN_SOURCE_ID, id: selected.id }
      : { source: INFRASTRUCTURE_SOURCE_ID, sourceLayer: selected.sourceLayer ?? SOURCE_LAYER_BY_KIND[selected.kind], id: selected.id };
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
  const kindLabel: Readonly<Record<MapSelection["kind"], string>> = {
    train: "Zug",
    track: "Strecke",
    station: "Bahnhof",
    signal: "Signal",
    platform: "Bahnsteig",
    switch: "Weiche",
    block: "Blockabschnitt",
    facility: "Betriebsanlage",
    "operating-point": "Betriebsstelle",
    "rail-context": "Kartenkontext",
  };
  selectionMenu.replaceChildren(text("p", "Was liegt an dieser Stelle?", "eyebrow"));
  selections.forEach((selection) => {
    const button = document.createElement("button");
    button.type = "button";
    button.append(text("strong", selection.label), text("span", kindLabel[selection.kind]));
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
  const positionless = [...state.trains.values()].filter((train) => train.mapPosition === undefined);
  const external = [...visibleExternalTrains(state.externalTrains.values())];
  if (positionless.length === 0 && external.length === 0) {
    externalRuns.replaceChildren();
    return;
  }
  const nodes: HTMLElement[] = [];
  if (positionless.length > 0) {
    nodes.push(
      text("p", "OHNE KARTENLAGE", "eyebrow"),
      text("p", "Ohne exakte releasegebundene Lage wird kein Kartenpunkt erfunden. Der sichere Zustand bleibt in der Liste sichtbar.", "position-note"),
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
    external.forEach((train: PublicExternalTrain) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "external-run";
      button.append(text("strong", train.trainNumber), text("span", `${railwayPlaceLabel(train.fromPortalId)} → ${railwayPlaceLabel(train.toPortalId)} · ${externalStatusLabel(train.status)}`));
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
      const positionLabel = train.nextOperatingPoint
        ?? (train.mapPosition === undefined ? "sicher eingefroren" : "exakte Position");
      button.append(text("strong", train.trainNumber), text("span", `${operatorLabel(train)} · ${operatingStatusLabel(train.status)} · ${positionLabel}`));
      button.addEventListener("click", () => void selectObject({ kind: "train", id: train.id, label: train.trainNumber }));
      item.append(button);
      list.append(item);
    });
  objectList.replaceChildren(list);
}

function scheduleLiveRender(state: LiveState): void {
  liveRenderingFrozen = false;
  currentLiveState = state;
  renderSamples = appendRenderSample(renderSamples, state);
  renderSampleStartedAtMs = performance.now();
  sequenceLabel.textContent = `Sequenz ${state.sequence}`;
  sequenceLabel.classList.remove("connection-error");
  renderExternalRuns(state);
  renderObjectList(state);
  if (!rzue.hidden) setOperatingView("rzue");
  const currentMap = map;
  if (currentMap !== undefined && currentMap.isStyleLoaded()) {
    applyLiveObjectStates(currentMap, state.objectStates);
    updateSelectionState();
  }
  if (renderFrame === undefined) renderFrame = requestAnimationFrame(renderLiveMapFrame);
}

function freezeLiveRender(): void {
  liveRenderingFrozen = true;
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  renderFrame = undefined;
}

function renderLiveMapFrame(nowMs: number): void {
  renderFrame = undefined;
  const samples = renderSamples;
  const currentMap = map;
  const currentConfig = mapConfig;
  if (liveRenderingFrozen || samples === undefined || currentMap === undefined || currentConfig === undefined || !currentMap.isStyleLoaded()) return;
  const elapsedS = Math.max(0, (nowMs - renderSampleStartedAtMs) / 1_000);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const latestAuthorizedAt = Math.max(
    samples.current.at,
    ...[...samples.current.operationalRegions.values()].map((frame) => frame.staleAfterMs / 1_000),
  );
  const renderAt = reduceMotion
    ? samples.current.at
    : Math.min(latestAuthorizedAt, samples.current.at + elapsedS);
  const source = currentMap.getSource(TRAIN_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(trainFeatureCollection(
    renderTrains(samples, renderAt),
    currentConfig.infrastructureReleaseId,
  ) as never);
  if (!liveRenderingFrozen && !reduceMotion && renderAt < latestAuthorizedAt) {
    renderFrame = requestAnimationFrame(renderLiveMapFrame);
  }
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
  localizeMapControls(document.querySelector("#map")!);

  await new Promise<void>((resolve, reject) => {
    currentMap.once("load", () => resolve());
    currentMap.once("error", (event: ErrorEvent) => {
      if (!currentMap.loaded()) reject(event.error);
    });
  });
  installPlayerMapIcons(currentMap);
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
  const selectView = (view: MapView, action: () => void): void => {
    setMapViewButtons(mapViewButtons, view);
    action();
  };
  document.querySelector<HTMLButtonElement>("#close-details")?.addEventListener("click", () => closePanel());
  document.querySelector<HTMLButtonElement>("#fit-playable")?.addEventListener("click", () => {
    const bounds = mapConfig === undefined ? undefined : playableBounds(mapConfig);
    if (bounds !== undefined) selectView("playable", () => map?.fitBounds(bounds, { padding: 54, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 }));
  });
  document.querySelector<HTMLButtonElement>("#show-germany")?.addEventListener("click", () => {
    selectView("germany", () => map?.fitBounds([[5.5, 47.0], [15.6, 55.2]], { padding: 34, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 }));
  });
  document.querySelector<HTMLButtonElement>("#show-world")?.addEventListener("click", () => {
    selectView("world", () => map?.fitBounds([[-179, -70], [179, 75]], { padding: 20, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650 }));
  });
  operatorSelector.addEventListener("change", () => {
    const destination = new URL(window.location.href);
    destination.searchParams.set("operator", operatorSelector.value);
    window.location.assign(destination);
  });
  operatorContextElement.addEventListener("toggle", () => {
    if (operatorContextElement.open && !operatorSelectorField.hidden) operatorSelector.focus({ preventScroll: true });
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
    const tokenProvider = (forceRefresh?: boolean) => ensureAccessToken(runtime, forceRefresh);
    api = new LivemapApiClient(runtime.gameApiUrl, tokenProvider);
    void api.playerContext(worldId).then(renderPlayerContext).catch(renderPlayerContextUnavailable);
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
    connection = new LivemapConnection(runtime.gameApiUrl, worldId, tokenProvider, scheduleLiveRender, {
      onFreeze: freezeLiveRender,
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
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  connection?.close();
  map?.remove();
  removeProtocol("pmtiles");
});

void boot();
