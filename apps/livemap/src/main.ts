import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import { railwayBrand, railwayNavigation, icon, mountGameHints } from "@zugfolge/design-system";
import { MAP_HINTS } from "./game-hints.js";
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
import { ConductorApi } from "./conductor-api.js";
import { appendConductorEntry as appendSharedConductorEntry } from "./conductor-entry.js";
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
  latestTrainRenderAt,
  nextTrainFreezeAt,
  LivemapConnection,
  operatorLabel,
  renderTrains,
  type LiveState,
  type PublicExternalTrain,
  type PublicTrain,
  type RenderSamples,
} from "./protocol.js";
import { livemapNavigationDestinations, mailboxDecisionDestination, operationsCenterDestination, demandPlanningDestination } from "./navigation.js";
import { demandOverviewMarkup, demandGeoJson, trainDemandMarkup, passengerManifestMarkup, type DemandOverview } from "./demand.js";
import { externalStatusLabel, localizeMapControls, operatingStatusLabel, railwayPlaceLabel, setMapViewButtons, visibleExternalTrains, type MapView } from "./presentation.js";
import { rzueMarkup } from "./rzue.js";
import "./style.css";
import "./external-runs.css";
import "@zugfolge/design-system/railway.css";
import "./railway-map.css";
import "./demand.css";
import { filterTrains, liveOverview, watchMarkup, trainSituation, type TrainScope } from "./live-overview.js";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt.");

root.innerHTML = `
  <a class="skip-link" href="#map-object-list">Zur Zugübersicht</a>
  <main class="app-shell railway-map">
    <header class="topbar">
      ${railwayBrand("/")}
      <a id="journey-link" class="world-context" href="/"><span class="eyebrow">DEINE SPIELWELT</span><strong id="world-label">Deutschland</strong></a>
      <span class="map-topbar-spacer"></span>
      <details id="operator-context" class="operator-context">
        <summary aria-label="Unternehmen und Kontostand öffnen">
          <span class="operator-context__company"><span class="eyebrow">DEINE BAHN</span><strong id="operator-label">wird geladen</strong></span>
          <span class="operator-context__finance"><span class="eyebrow">VERFÜGBAR</span><strong id="finance-label">—</strong></span>
        </summary>
        <div class="operator-context__popover">
          <label id="operator-selector-field" hidden><span>Dein Unternehmen</span><select id="operator-selector"></select></label>
          <p id="operator-context-note" class="operator-context__note" hidden></p>
          <dl id="finance-breakdown"><div><dt>Kontostand</dt><dd id="ledger-balance">—</dd></div><div><dt>Vorgemerkt</dt><dd id="pending-debits">—</dd></div><div class="operator-context__available"><dt>Verfügbar</dt><dd id="available-balance">—</dd></div></dl>
          <a id="finance-link" href="/">Finanzen öffnen</a>
        </div>
      </details>
      <a id="mailbox-link" class="map-mail" href="/" aria-label="Postfach öffnen">${icon("mail")}</a>
      <span id="glossary-slot"></span>
    </header>
    ${railwayNavigation([{page:"map",href:"/",id:"live-link"},{page:"planner",href:"/",id:"planner-link"},{page:"operations",href:"/",id:"operations-link"},{page:"markets",href:"/",id:"market-link"},{page:"company",href:"/",id:"company-link"}], "map")}
    <section class="map-command" aria-labelledby="live-map-title">
      <div><p class="eyebrow">DAS NETZ LEBT</p><h1 id="live-map-title">Deine Welt. In Bewegung.</h1><p>Ganz Deutschland. Jeder Zug zählt.</p></div>
      <div class="network-stats" aria-label="Aktueller Stand der empfangenen Zugfahrten"><div><strong id="network-active">—</strong><span>aktive Züge</span></div><div><strong id="network-moving">—</strong><span>unterwegs</span></div><div><strong id="network-delayed">—</strong><span>ab +1 min</span></div></div>
      <button id="toggle-insights" class="map-panel-toggle" aria-controls="map-insights" aria-expanded="false">${icon("layers")} Überblick</button>
    </section>
    <section class="workspace">
      <section class="map-frame" aria-label="LiveMap Deutschland">
        <div id="map" role="application" aria-label="Deutschlandkarte mit Eisenbahnnetz und aktuellen Zügen"></div>
        <section id="rzue" class="rzue" aria-label="Schematische Betriebsübersicht" hidden></section>
        <div class="map-toolbar">
          <div class="train-scope" role="group" aria-label="Züge auf der Karte filtern"><button data-train-scope="all" aria-pressed="true">Alle Züge</button><button data-train-scope="own" aria-pressed="false">Meine Züge</button><button id="toggle-demand" type="button" aria-pressed="false" aria-controls="details">Nachfrage</button></div>
          <div class="mode-switch" role="group" aria-label="Kartenansicht"><button id="mode-livemap" type="button" aria-pressed="true">Karte</button><button id="mode-rzue" type="button" aria-pressed="false">Gleisbild</button><button id="rzue-level" type="button" aria-pressed="false" hidden>Details</button></div>
        </div>
        <div id="map-state" class="map-state" role="status" aria-live="polite">Das Schienennetz wird geladen …</div>
        <div class="map-tools" aria-label="Kartenausschnitt"><button id="show-germany" data-map-view="germany" type="button" aria-pressed="true">Deutschland</button><button id="fit-playable" data-map-view="playable" type="button" aria-pressed="false">Gesamtes Spielnetz</button><button id="show-world" data-map-view="world" type="button" aria-pressed="false">Umgebung</button></div>
        <section id="selection-menu" class="selection-menu" aria-label="Kartenobjekt auswählen" hidden></section>
        <div id="demand-map-key" class="demand-map-key" hidden><strong>Einsteiger · aktuelle Seite</strong><span><i class="demand-dot served"></i> vorhanden <i class="demand-dot unserved"></i> null <i class="demand-dot unknown"></i> unbekannt</span><small id="demand-map-period"></small></div>
        <section id="external-runs" aria-label="Weitere Zugfahrten"></section>
        <div class="legend" aria-label="Legende"><span><i class="legend-line active"></i> Bahnnetz</span><span><i class="legend-line restriction"></i> Einschränkung</span><span><i class="legend-line closure"></i> Gesperrt</span><span><i class="legend-line construction"></i> Bauarbeiten</span></div>
      </section>
      <aside id="details" aria-label="Details zur Auswahl" hidden><button id="close-details" class="close-details" type="button" aria-label="Detailansicht schließen">${icon("close")}</button><div id="details-content"></div></aside>
    </section>
    <aside class="map-insights" id="map-insights" aria-label="Dein Überblick">
      <div class="insights-heading"><div><p class="eyebrow">DEIN ÜBERBLICK</p><h2>Jetzt im Blick</h2></div><span class="rail-live" id="insight-status">Verbinde</span></div>
      <label class="train-search">${icon("train")}<input id="train-search" type="search" placeholder="Zug, Unternehmen, nächster Halt …" aria-label="Zug, Unternehmen oder nächsten Halt suchen" maxlength="100"></label>
      <p id="scope-note" class="scope-note">Die gemeinsame Welt im Überblick.</p>
      <div id="watch-trains" class="watch-trains"><p class="live-empty">Aktuelle Fahrten werden geladen …</p></div>
      <section id="attention-rail" class="attention-rail" aria-labelledby="attention-title" hidden></section>
      <section class="map-next-step"><p class="eyebrow">DEIN NÄCHSTER SCHRITT</p><h3 id="next-step-title">Bring deine Bahn voran.</h3><p id="next-step-copy">Plane Verbindungen und behalte ihre Fahrten auf der Karte im Blick.</p><a id="next-step-link" class="rail-primary" href="/">Fahrt planen ${icon("chevron")}</a></section>
    </aside>
    <details id="map-object-list" class="object-list train-drawer"><summary><span>${icon("train")} Zugübersicht <strong id="train-list-count">—</strong></span><span>Suchen & auswählen ${icon("chevron")}</span></summary><div id="object-list-content"></div></details>
    <footer class="map-footer"><span>DEUTSCHLAND <i aria-hidden="true">·</i> <span id="network-note">Live-Betrieb</span></span><time id="sequence-label" role="status">Verbindung wird aufgebaut …</time></footer>
  </main>`;

const parameters = new URLSearchParams(window.location.search);
const runtime = loadRuntimeConfiguration();
const worldId = runtime.publicWorldId;
const navigation = livemapNavigationDestinations(runtime.gameWebUrl, window.location.href, worldId, runtime.operationsCenterUrl);
document.querySelector<HTMLAnchorElement>("#live-link")!.href = navigation.live;
document.querySelector<HTMLAnchorElement>(".zf-brand")!.href = navigation.live;
document.querySelector<HTMLAnchorElement>("#journey-link")!.href = navigation.journey;
document.querySelector<HTMLAnchorElement>("#market-link")!.href = navigation.markets;
document.querySelector<HTMLAnchorElement>("#planner-link")!.href = navigation.planner;
document.querySelector<HTMLAnchorElement>("#operations-link")!.href = navigation.operations;
document.querySelector<HTMLAnchorElement>("#mailbox-link")!.href = navigation.mailbox;
document.querySelector<HTMLAnchorElement>("#company-link")!.href = gameWebDestination("company");
const nextStepUrl = new URL(navigation.journey);
nextStepUrl.searchParams.set("section", "operations");
document.querySelector<HTMLAnchorElement>("#next-step-link")!.href = nextStepUrl.href;
mountGlossaryLayer(document.body);
mountGameHints(document.querySelector<HTMLElement>("#root")!, MAP_HINTS);
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
let latestAuthorizedRenderAt = 0;
let lastRenderedTrains: readonly PublicTrain[] = [];
let selected: MapSelection | undefined;
let previousSelected: MapSelection | undefined;
let appliedObjectStates = new Map<string, PublicObjectState>();
let renderFrame: number | undefined;
let renderWakeup: ReturnType<typeof setTimeout> | undefined;
let liveRenderingFrozen = false;
let currentLiveState: LiveState | undefined;
let rzueExpert = false;
let trainScope: TrainScope = parameters.get("trainScope") === "own" ? "own" : "all";
let ownOperatorId = "";
let trainQuery = (parameters.get("trainQuery") ?? "").slice(0, 100);
let trainListLimit = 80;
let detailReturnFocus: HTMLElement | undefined;
let demandEnabled = false;
let demandPage: DemandOverview | undefined;
let demandRequest = 0;

function retainMapFilters(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("trainScope", trainScope);
  if (trainQuery === "") url.searchParams.delete("trainQuery"); else url.searchParams.set("trainQuery", trainQuery);
  if (demandEnabled) url.searchParams.set("demand", "1"); else url.searchParams.delete("demand");
  window.history.replaceState({}, "", url);
  const planner = new URL(document.querySelector<HTMLAnchorElement>("#planner-link")!.href);
  for (const key of ["focus", "trainScope", "trainQuery", "demand"] as const) {
    const value = url.searchParams.get(key);
    if (value === null) planner.searchParams.delete(key); else planner.searchParams.set(key, value);
  }
  if (selected?.kind === "train") planner.searchParams.set("train", selected.id);
  document.querySelector<HTMLAnchorElement>("#planner-link")!.href = planner.href;
}

function renderDemandLayer(): void {
  document.querySelector<HTMLElement>("#demand-map-key")!.hidden = !demandEnabled || demandPage === undefined;
  document.querySelector<HTMLElement>("#demand-map-period")!.textContent = demandPage === undefined ? "" : `${demandPage.source === "observed" ? "Messwert" : demandPage.source === "assumption" ? "Modellannahme" : "Prognose"} · ${demandPage.periodId} · Stand ${demandPage.asOfS} Weltsekunden`;
  if (map === undefined) return;
  const data = demandGeoJson(demandEnabled ? demandPage?.items ?? [] : []);
  const source = map.getSource<GeoJSONSource>("passenger-demand");
  if (source !== undefined) { source.setData(data); return; }
  map.addSource("passenger-demand", { type: "geojson", data });
  map.addLayer({ id: "passenger-demand-points", type: "circle", source: "passenger-demand", paint: { "circle-radius": 8, "circle-color": ["match", ["get", "tone"], "unserved", "#b5a6ff", "served", "#75d4ef", "#596575"], "circle-opacity": 0.6, "circle-stroke-color": "#f5f7fa", "circle-stroke-width": 1 } }, map.getLayer("trains") !== undefined ? "trains" : undefined);
}

function planningLink(trainId?: string, stationId?: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "demand-plan-link";
  link.textContent = "Fernverkehr: Linie, Tarif & Plätze planen";
  link.href = demandPlanningDestination(runtime.gameWebUrl, window.location.href, worldId, trainId, stationId);
  return link;
}

async function showDemand(cursor?: string, openPanel = true): Promise<void> {
  if (api === undefined) return;
  const request = ++demandRequest;
  demandEnabled = true;
  retainMapFilters();
  document.querySelector("#toggle-demand")!.setAttribute("aria-pressed", "true");
  if (openPanel) setPanel(loadingPanel("Nachfrage"));
  try {
    const page = await api.demandOverview(worldId, cursor);
    if (request !== demandRequest || !demandEnabled) return;
    demandPage = page;
    renderDemandLayer();
    if (!openPanel) return;
    const section = document.createElement("div");
    section.innerHTML = demandOverviewMarkup(page);
    section.querySelector("[data-demand-next]")?.addEventListener("click", () => void showDemand(page.nextCursor ?? undefined));
    section.querySelector("[data-demand-first]")?.addEventListener("click", () => void showDemand());
    section.querySelectorAll<HTMLButtonElement>("[data-demand-station]").forEach((button) => button.addEventListener("click", () => {
      const station = page.items.find((item) => item.stationId === button.dataset["demandStation"]);
      if (station !== undefined) void selectObject({ kind: "station", id: station.stationId, label: station.label });
    }));
    section.append(planningLink());
    setPanel(section);
  } catch (error) {
    if (request !== demandRequest) return;
    demandPage = undefined;
    renderDemandLayer();
    if (openPanel) setPanel(messagePanel(`Nachfrage nicht verfügbar. ${error instanceof Error ? error.message : "Versuche es erneut."}`, "error"));
  }
}

async function appendTrainDemand(trainId: string, ownerOperatorId?: string): Promise<void> {
  const section = document.createElement("section");
  section.className = "train-demand";
  section.textContent = "Fahrgastdaten werden geladen …";
  detailsContent.append(section);
  try {
    const data = await api!.trainDemand(worldId, trainId);
    if (selected?.id !== trainId || selected.kind !== "train" || !section.isConnected) return;
    section.innerHTML = trainDemandMarkup(data);
  } catch { if (section.isConnected) section.textContent = "Fahrgastdaten nicht verfügbar. Eine fehlende Nachfrageangabe bedeutet keinen leeren Zug."; }
  if (selected?.id !== trainId || selected.kind !== "train" || !section.isConnected) return;
  if (ownerOperatorId !== undefined) {
    const manifest = document.createElement("details");
    manifest.className = "passenger-manifest";
    manifest.append(text("summary", "Fahrgastliste deines Unternehmens"));
    const body = document.createElement("div"); manifest.append(body);
    let loaded = false;
    const loadManifest = async (cursor?: string): Promise<void> => {
      body.textContent = "Fahrgastliste wird geladen …";
      try {
        const page = await api!.passengerManifest(worldId, ownerOperatorId, trainId, cursor);
        if (!manifest.isConnected) return;
        body.innerHTML = passengerManifestMarkup(page);
        body.querySelector("[data-manifest-next]")?.addEventListener("click", () => void loadManifest(page.nextCursor ?? undefined));
        loaded = true;
      } catch { body.textContent = "Die berechtigte Fahrgastliste ist gerade nicht verfügbar."; loaded = false; }
    };
    manifest.addEventListener("toggle", () => { if (manifest.open && !loaded) void loadManifest(); });
    section.append(manifest);
  }
  section.append(planningLink(trainId));
}

function scopedTrains(trains: readonly PublicTrain[]): readonly PublicTrain[] {
  return filterTrains(trains, trainScope, ownOperatorId, trainQuery);
}

function updateOverview(): void {
  if (currentLiveState === undefined) return;
  const trains = scopedTrains([...currentLiveState.trains.values()]);
  const overview = liveOverview(trains);
  document.querySelector("#network-active")!.textContent = String(overview.active);
  document.querySelector("#network-moving")!.textContent = String(overview.moving);
  document.querySelector("#network-delayed")!.textContent = String(overview.delayed);
  document.querySelector("#network-note")!.textContent = `${trainScope === "own" ? "Deine Bahn" : "Alle empfangenen Fahrten"}${overview.unknownDelay > 0 ? ` · ${overview.unknownDelay} ohne Verspätungsangabe` : ""}`;
  document.querySelector("#scope-note")!.textContent = trainScope === "own" && ownOperatorId === "" ? "Gründe dein Unternehmen, um hier deine Züge zu sehen." : `${trains.length} Fahrten · ${trainScope === "own" ? "dein Unternehmen" : "alle Unternehmen"}${trainQuery === "" ? "" : " · Suche aktiv"}`;
  const watch = document.querySelector<HTMLElement>("#watch-trains")!;
  const focusedTrain = watch.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset["watchTrain"] : undefined;
  watch.innerHTML = watchMarkup(trains);
  watch.querySelectorAll<HTMLButtonElement>("[data-watch-train]").forEach((button) => button.addEventListener("click", () => {
    const train = currentLiveState?.trains.get(button.dataset["watchTrain"] ?? "");
    if (train !== undefined) void selectObject({ kind: "train", id: train.id, label: train.trainNumber });
  }));
  if (focusedTrain !== undefined) [...watch.querySelectorAll<HTMLButtonElement>("[data-watch-train]")].find((button) => button.dataset["watchTrain"] === focusedTrain)?.focus({ preventScroll: true });
}

function applyTrainFilter(): void {
  updateOverview();
  if (currentLiveState !== undefined) renderObjectList(currentLiveState);
  const source = map?.getSource(TRAIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (mapConfig !== undefined) source?.setData(trainFeatureCollection(scopedTrains(lastRenderedTrains), mapConfig.infrastructureReleaseId, liveRenderingFrozen) as never);
  if (!rzue.hidden) setOperatingView("rzue");
}

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
      scopedTrains([...currentLiveState.trains.values()]),
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
  ownOperatorId = selected?.id ?? "";
  document.querySelectorAll<HTMLAnchorElement>(".rail-nav a, .zf-brand, #next-step-link").forEach((link) => {
    const destination = new URL(link.href);
    if (ownOperatorId !== "") destination.searchParams.set("operator", ownOperatorId);
    else destination.searchParams.delete("operator");
    link.href = destination.href;
  });
  applyTrainFilter();
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
    document.querySelector("#next-step-title")!.textContent = "Nächster Halt: deine eigene Bahn.";
    document.querySelector("#next-step-copy")!.textContent = "Gründe dein Unternehmen und bring deine ersten Züge auf die Schiene.";
    const entryLink = document.querySelector<HTMLAnchorElement>("#next-step-link")!;
    entryLink.textContent = "Unternehmen gründen";
    entryLink.href = gameWebDestination("world");
    operatorNameLabel.textContent = "Dein Einstieg";
    financeLabel.textContent = "—";
    financeBreakdown.hidden = true;
    operatorContextNote.textContent = "Gründe dein Unternehmen, um eigene Züge auf die Schiene zu bringen.";
    operatorContextNote.hidden = false;
    financeLink.textContent = "Unternehmen gründen";
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
  operatorContextNote.textContent = "Dein Kontostand ist gerade nicht verfügbar. Versuche es gleich noch einmal.";
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
  details.hidden = false;
  details.classList.add("open");
}

function closePanel(updateUrl = true): void {
  ++demandRequest;
  selected = undefined;
  updateSelectionState();
  details.classList.remove("open");
  details.hidden = true;
  if (updateUrl) {
    const trainId = detailReturnFocus?.dataset["watchTrain"] ?? detailReturnFocus?.dataset["listTrain"];
    const replacement = trainId === undefined ? undefined : [...document.querySelectorAll<HTMLButtonElement>("[data-watch-train], [data-list-train]")].find((button) => (button.dataset["watchTrain"] ?? button.dataset["listTrain"]) === trainId && button.getClientRects().length > 0);
    const target = detailReturnFocus?.isConnected && detailReturnFocus.getClientRects().length > 0 ? detailReturnFocus : replacement ?? map?.getCanvas();
    target?.focus({ preventScroll: true });
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.delete("focus");
    window.history.replaceState({}, "", url);
    retainMapFilters();
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
  retainMapFilters();
}

async function selectObject(selection: MapSelection): Promise<void> {
  ++demandRequest;
  if (document.activeElement instanceof HTMLElement && !details.contains(document.activeElement)) detailReturnFocus = document.activeElement;
  selected = selection;
  updateSelectionState();
  updateFocusUrl(selection);
  selectionMenu.hidden = true;
  setPanel(loadingPanel(selection.label));
  document.querySelector<HTMLButtonElement>("#close-details")?.focus({ preventScroll: true });
  const trainPosition = selection.kind === "train" ? currentLiveState?.trains.get(selection.id)?.mapPosition : undefined;
  if (trainPosition !== undefined && trainPosition.infrastructureReleaseId === mapConfig?.infrastructureReleaseId) map?.easeTo({ center: [trainPosition.longitudeE7 / 10_000_000, trainPosition.latitudeE7 / 10_000_000], duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450 });
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
      if (selected?.id === selection.id && selected.kind === "train") {
        setPanel(trainPanel(publicDetail, ownerDetail));
        if (ownerDetail !== undefined && operatorId !== undefined) void appendConductorEntry(selection, operatorId);
        void appendTrainDemand(selection.id, ownerDetail === undefined ? undefined : operatorId);
      }
      return;
    }
    const objectDetail = await client.object(worldId, selection.kind, selection.id);
    if (selection.kind === "station") {
      const board = await client.stationBoard(worldId, selection.id);
      if (selected?.id === selection.id && selected.kind === "station") {
        const panel = stationPanel(objectDetail, board); panel.append(planningLink(undefined, selection.id)); setPanel(panel);
      }
    } else if (selected?.id === selection.id && selected.kind === selection.kind) {
      const panel = objectDetailPanel(objectDetail); if (selection.kind === "track") panel.append(planningLink()); setPanel(panel);
    }
  } catch (error) {
    if (selected?.id !== selection.id) return;
    setPanel(messagePanel(error instanceof Error ? error.message : "Detail konnte nicht geladen werden.", "error"));
  }
}

async function appendConductorEntry(selection: MapSelection, operatorId: string): Promise<void> {
  const configuration = loadRuntimeConfiguration();
  const conductor = new ConductorApi(configuration.gameApiUrl, worldId, operatorId, selection.id,
    (refresh) => ensureAccessToken(configuration, refresh));
  const company = [...operatorSelector.options].find((option) => option.value === operatorId)?.textContent;
  await appendSharedConductorEntry({ host: detailsContent, api: conductor, trainLabel: selection.label,
    ...(worldLabel.textContent === null ? {} : { worldLabel: worldLabel.textContent }),
    ...(company == null ? {} : { operatorLabel: company }),
    isCurrent: () => selected?.kind === "train" && selected.id === selection.id });
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
  const focusedTrain = (document.activeElement as HTMLElement | null)?.dataset["listTrain"];
  const trains = scopedTrains([...state.trains.values()]).toSorted((a, b) => a.trainNumber.localeCompare(b.trainNumber, "de") || a.id.localeCompare(b.id));
  document.querySelector("#train-list-count")!.textContent = String(trains.length);
  const list = document.createElement("ul");
  trains.slice(0, trainListLimit).forEach((train) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["listTrain"] = train.id;
    button.append(text("strong", train.trainNumber), text("span", `${operatorLabel(train)} · ${train.nextOperatingPoint ?? operatingStatusLabel(train.status)}`), text("small", trainSituation(train)));
    button.addEventListener("click", () => void selectObject({ kind: "train", id: train.id, label: train.trainNumber }));
    item.append(button);
    list.append(item);
  });
  objectList.replaceChildren(list);
  if (trains.length === 0) objectList.append(text("p", "Keine passenden Züge. Ändere den Filter oder versuche eine andere Suche.", "live-empty"));
  if (trains.length > trainListLimit) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "load-more-trains";
    more.textContent = `Weitere Züge anzeigen (${trainListLimit} von ${trains.length})`;
    more.addEventListener("click", () => { trainListLimit += 80; renderObjectList(state); });
    objectList.append(more);
  }
  if (focusedTrain !== undefined) [...objectList.querySelectorAll<HTMLButtonElement>("[data-list-train]")].find((button) => button.dataset["listTrain"] === focusedTrain)?.focus({ preventScroll: true });
}

function scheduleLiveRender(state: LiveState): void {
  if (renderWakeup !== undefined) clearTimeout(renderWakeup);
  renderWakeup = undefined;
  liveRenderingFrozen = false;
  currentLiveState = state;
  renderSamples = appendRenderSample(renderSamples, state);
  latestAuthorizedRenderAt = latestTrainRenderAt(state);
  renderSampleStartedAtMs = performance.now();
  sequenceLabel.textContent = "Live · gerade aktualisiert";
  sequenceLabel.title = `Datenstand ${state.sequence}`;
  document.querySelector("#insight-status")!.textContent = "Live";
  document.querySelector("#insight-status")!.classList.remove("is-stale");
  updateOverview();
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
  document.querySelector("#insight-status")!.textContent = "Letzter Stand";
  document.querySelector("#insight-status")!.classList.add("is-stale");
  if (renderFrame !== undefined) cancelAnimationFrame(renderFrame);
  renderFrame = undefined;
  if (renderWakeup !== undefined) clearTimeout(renderWakeup);
  renderWakeup = undefined;
  const source = map?.getSource(TRAIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (mapConfig !== undefined) {
    source?.setData(trainFeatureCollection(scopedTrains(lastRenderedTrains), mapConfig.infrastructureReleaseId, true) as never);
  }
}

function renderLiveMapFrame(nowMs: number): void {
  renderFrame = undefined;
  const samples = renderSamples;
  const currentMap = map;
  const currentConfig = mapConfig;
  if (liveRenderingFrozen || samples === undefined || currentMap === undefined || currentConfig === undefined) return;
  // Die Zugquelle existiert vor dem Streamstart. Ausstehende Basiskacheln
  // oder GeoJSON-Worker dürfen weder Animation noch Freeze-Termin verschlucken.
  const source = currentMap.getSource(TRAIN_SOURCE_ID) as GeoJSONSource | undefined;
  if (source === undefined) return;
  const elapsedS = Math.max(0, (nowMs - renderSampleStartedAtMs) / 1_000);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderAt = samples.current.at + elapsedS;
  lastRenderedTrains = renderTrains(samples, reduceMotion ? samples.current.at : renderAt, renderAt);
  source.setData(trainFeatureCollection(
    scopedTrains(lastRenderedTrains),
    currentConfig.infrastructureReleaseId,
  ) as never);
  if (!liveRenderingFrozen && !reduceMotion && renderAt < latestAuthorizedRenderAt) {
    renderFrame = requestAnimationFrame(renderLiveMapFrame);
  } else {
    const wakeAt = nextTrainFreezeAt(samples.current, renderAt);
    if (wakeAt !== undefined) {
      renderWakeup = setTimeout(() => {
        renderWakeup = undefined;
        if (!liveRenderingFrozen && renderFrame === undefined) renderFrame = requestAnimationFrame(renderLiveMapFrame);
      }, Math.ceil((wakeAt - renderAt) * 1_000));
    }
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
  currentMap.fitBounds([[5.5, 47.0], [15.6, 55.2]], { padding: { top: 80, bottom: 75, left: 45, right: 45 }, duration: 0 });

  await new Promise<void>((resolve, reject) => {
    currentMap.once("load", () => resolve());
    currentMap.once("error", (event: ErrorEvent) => {
      if (!currentMap.loaded()) reject(event.error);
    });
  });
  installPlayerMapIcons(currentMap);
  addZugfolgeLayers(currentMap, config);
  mapState.textContent = "Dein Schienennetz ist bereit. Wähle einen Zug oder Bahnhof.";
  mapState.title = `Kartenstand ${config.infrastructureReleaseId}`;
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
  document.querySelector<HTMLInputElement>("#train-search")!.value = trainQuery;
  document.querySelectorAll<HTMLElement>("[data-train-scope]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset["trainScope"] === trainScope)));
  document.querySelector<HTMLButtonElement>("#toggle-demand")!.addEventListener("click", () => {
    detailReturnFocus = document.querySelector<HTMLButtonElement>("#toggle-demand")!;
    if (demandEnabled && detailsContent.querySelector(".demand-view:not(.train-demand)") !== null) {
      demandEnabled = false; ++demandRequest; retainMapFilters(); renderDemandLayer();
      document.querySelector("#toggle-demand")!.setAttribute("aria-pressed", "false"); closePanel();
    } else void showDemand();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-train-scope]").forEach((button) => button.addEventListener("click", () => {
    trainScope = button.dataset["trainScope"] === "own" ? "own" : "all";
    trainListLimit = 80;
    retainMapFilters();
    document.querySelectorAll("[data-train-scope]").forEach((item) => item.setAttribute("aria-pressed", String((item as HTMLElement).dataset["trainScope"] === trainScope)));
    applyTrainFilter();
  }));
  document.querySelector<HTMLInputElement>("#train-search")!.addEventListener("input", (event) => {
    trainQuery = (event.currentTarget as HTMLInputElement).value;
    retainMapFilters();
    trainListLimit = 80;
    applyTrainFilter();
    (document.querySelector("#map-object-list") as HTMLDetailsElement).open = trainQuery.trim() !== "";
  });
  document.querySelector(".skip-link")!.addEventListener("click", () => {
    (document.querySelector("#map-object-list") as HTMLDetailsElement).open = true;
    document.querySelector<HTMLElement>("#map-object-list summary")!.focus();
  });
  document.querySelector<HTMLButtonElement>("#toggle-insights")!.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    document.querySelector("#map-insights")!.classList.toggle("is-open", open);
  });
  const selectView = (view: MapView, action: () => void): void => {
    setMapViewButtons(mapViewButtons, view);
    action();
  };
  document.querySelector<HTMLButtonElement>("#close-details")?.addEventListener("click", () => closePanel());
  document.querySelector<HTMLDetailsElement>("#map-object-list")?.addEventListener("toggle", () => map?.resize());
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
      if (!details.hidden) closePanel();
      document.querySelector("#map-insights")!.classList.remove("is-open");
      document.querySelector("#toggle-insights")!.setAttribute("aria-expanded", "false");
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
    retainMapFilters();
    const focus = parseFocusParameter(parameters.get("focus"));
    if (focus !== undefined) {
      void selectObject(focus);
      if (parameters.get("demand") === "1") void showDemand(undefined, false);
    }
    else if (parameters.get("demand") === "1") void showDemand();
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
