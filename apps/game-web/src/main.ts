import type { Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";

import {
  GameApiClient,
  type ContractType,
  type OperatorContractView,
  type OperatorSummary,
  type TutorialAction,
  type TutorialSessionView,
  type VehicleAssetView,
  type VehicleHistoryEventView,
  type VehicleMarketListingView,
} from "./api.js";
import { ensureAccessToken, loadRuntimeConfiguration } from "./auth.js";
import {
  bindCooperationSurface,
  parseContractOfferFields,
  parseEuroCents,
  type CooperationSurfaceState,
} from "./cooperation.js";
import { conflictsForTrain } from "./diagram.js";
import { renderJourney } from "./journey.js";
import { primaryMapDestination } from "./navigation.js";
import { renderLoadState, renderProjection } from "./view.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app = root;
mountGlossaryLayer(document.body);

const parameters = new URLSearchParams(window.location.search);
const runtimeConfiguration = loadRuntimeConfiguration();
const demoMode = parameters.get("demo") === "1";
const requestedView = parameters.get("view");
const journeyMode = !demoMode && requestedView !== "diagram";
const worldId = parameters.get("world") ?? runtimeConfiguration.publicWorldId;
const publicWorldId = parameters.get("publicWorld") ?? runtimeConfiguration.publicWorldId;
const tutorialReference = parameters.get("tutorial");
const livemapUrl = runtimeConfiguration.livemapUrl === "" ? "" : (() => {
  const value = new URL(runtimeConfiguration.livemapUrl, window.location.href);
  value.searchParams.set("world", worldId);
  return value.href;
})();
const primaryDestination = primaryMapDestination({
  requestedView,
  demoMode,
  livemapUrl: runtimeConfiguration.livemapUrl,
  worldId,
  pageUrl: window.location.href,
});
if (primaryDestination !== undefined) window.location.replace(primaryDestination);
let api: GameApiClient | undefined;

let density: Density = "control";
let showBlockingTimes = true;
let selectedTrainId = "";
let selectedConflictId = "";
let projection: PlanningProjectionV1 | undefined;
let loadError = "";
let message = "";
let messageTone: "status" | "error" = "status";
let applyingAlternativeId = "";
let demoApply: ((current: PlanningProjectionV1, alternativeId: string) => PlanningProjectionV1) | undefined;
let tutorialSession: TutorialSessionView | undefined;
let journeyBusy = journeyMode && !demoMode;
let coachDismissed = false;
let whyOpen = false;
let tutorialPoll: ReturnType<typeof setTimeout> | undefined;
let worldOperators: readonly OperatorSummary[] = [];
let ownOperatorIds: readonly string[] = [];
let activeOperatorId = "";
let operatorContracts: readonly OperatorContractView[] = [];
let marketListings: readonly VehicleMarketListingView[] = [];
let ownedVehicles: readonly VehicleAssetView[] = [];
let selectedVehicleHistory: readonly VehicleHistoryEventView[] | undefined;
let selectedHistoryVehicleId = "";
let contractType: ContractType = "traction";
let marketQuery = "";
let cooperationAtS = 0;

function explicitDemoUrl(): string {
  const demoParameters = new URLSearchParams(window.location.search);
  demoParameters.set("demo", "1");
  return `?${demoParameters.toString()}`;
}

function chooseInitialSelection(current: PlanningProjectionV1): void {
  selectedTrainId = current.trains[0]?.id ?? "";
  selectedConflictId = conflictsForTrain(current, selectedTrainId)[0]?.id ?? "";
}

function reconcileSelection(current: PlanningProjectionV1): void {
  if (!current.trains.some((train) => train.id === selectedTrainId)) {
    selectedTrainId = current.trains[0]?.id ?? "";
  }
  const available = conflictsForTrain(current, selectedTrainId);
  if (!available.some((conflict) => conflict.id === selectedConflictId)) {
    selectedConflictId = available[0]?.id ?? "";
  }
}

function cooperationState(): CooperationSurfaceState | undefined {
  if (publicWorldId === "") return undefined;
  return {
    worldId: publicWorldId,
    activeOperatorId,
    operators: worldOperators,
    ownOperatorIds,
    contracts: operatorContracts,
    listings: marketListings,
    ownedVehicles,
    selectedVehicleHistory,
    selectedHistoryVehicleId,
    contractType,
    marketQuery,
    atS: cooperationAtS,
    busy: journeyBusy,
  };
}

function render(): void {
  app.dataset.density = density;
  if (journeyMode) {
    app.innerHTML = renderJourney({
      publicWorldId,
      tutorial: tutorialSession,
      busy: journeyBusy,
      message,
      coachDismissed,
      whyOpen,
      messageTone,
      livemapUrl,
      cooperation: cooperationState(),
    });
    bindJourney();
    return;
  }
  if (projection === undefined) {
    app.innerHTML = renderLoadState(
      loadError === "" ? "loading" : "error",
      loadError === "" ? "Planner-Ergebnis wird geladen …" : loadError,
      loadError === "" ? undefined : explicitDemoUrl(),
    );
    return;
  }
  app.innerHTML = renderProjection(projection, {
    density,
    showBlockingTimes,
    selectedTrainId,
    selectedConflictId,
    message,
    messageTone,
    applyingAlternativeId: applyingAlternativeId === "" ? undefined : applyingAlternativeId,
  });
  bind();
}

function bindJourney(): void {
  app.querySelector("#tutorial-start")?.addEventListener("click", () => void startTutorial());
  app.querySelector("#tutorial-restart")?.addEventListener("click", () => void restartTutorial());
  app.querySelector("#tutorial-summary-confirm")?.addEventListener("click", () => void confirmTutorialSummary());
  app.querySelector("#tutorial-hint")?.addEventListener("click", () => void openTutorialHint());
  app.querySelector("#tutorial-dismiss")?.addEventListener("click", () => void dismissTutorialDialogue());
  app.querySelector("#tutorial-coach-reopen")?.addEventListener("click", () => { coachDismissed = false; render(); focusCoach(); });
  app.querySelector("#tutorial-why")?.addEventListener("click", () => { whyOpen = !whyOpen; render(); app.querySelector<HTMLButtonElement>("#tutorial-why")?.focus(); });
  const focusButton = app.querySelector<HTMLButtonElement>("#tutorial-focus-target");
  focusButton?.addEventListener("click", () => focusTarget(focusButton.dataset.target));
  app.querySelector<HTMLFormElement>("#tutorial-tender-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void applyTutorialAction({ type: "submit-bid", orderingFeeCentsPerTrainKm: String(data.get("orderingFeeCentsPerTrainKm") ?? ""), punctualityBasisPoints: Number(data.get("punctualityBasisPoints")), extraSeats: Number(data.get("extraSeats")) });
  });
  app.querySelector<HTMLFormElement>("#tutorial-program-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void applyTutorialAction({ type: "activate-program", templateId: String(data.get("templateId")) as "connections" | "punctuality", changedRule: String(data.get("changedRule")) as "hold-connections" | "prioritize-punctuality" | "activate-reserve", thresholdSeconds: Number(data.get("thresholdSeconds")) });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-offer]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "accept-lease", offerId: button.dataset.tutorialOffer ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-path]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "confirm-path", alternativeId: button.dataset.tutorialPath ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-dispatch]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "dispatch", action: button.dataset.tutorialDispatch as "short_turn" | "request_reroute" | "trigger_rail_replacement" })));
  bindCooperationSurface(app, {
    changeOperator: (operatorId) => cooperationAction(async () => refreshCooperation(operatorId), "Handelndes EVU wurde gewechselt."),
    changeContractType: (value) => { contractType = value; render(); },
    changeMarketQuery: (value) => { marketQuery = value; render(); },
    refresh: () => cooperationAction(async () => refreshCooperation(activeOperatorId), "Kooperation und Fahrzeugmarkt sind aktuell."),
    offerContract: offerCooperationContract,
    respondToContract,
    endContract,
    createListing: createVehicleListing,
    reserveListing,
    transferListing,
    reverseListing,
    cancelListing,
    loadHistory: loadVehicleHistory,
  });
}

function focusTarget(target: string | undefined): void {
  if (target === undefined || target === "") return;
  const element = app.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
  element?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  element?.focus({ preventScroll: true });
}

function focusCoach(): void {
  app.querySelector<HTMLElement>("#lutz-name")?.focus({ preventScroll: true });
}

function setTutorialSession(next: TutorialSessionView, updateUrl = true): void {
  const previousDialogue = tutorialSession?.dialogue.id;
  tutorialSession = next;
  if (previousDialogue !== next.dialogue.id) {
    coachDismissed = false;
    whyOpen = false;
  }
  if (updateUrl) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("world", next.tutorialWorldId);
    nextUrl.searchParams.set("publicWorld", next.publicWorldId);
    nextUrl.searchParams.set("tutorial", next.reference);
    history.replaceState({ tutorial: next.reference }, "", nextUrl);
  }
  scheduleTutorialPoll();
}

function scheduleTutorialPoll(): void {
  if (tutorialPoll !== undefined) clearTimeout(tutorialPoll);
  if (tutorialSession?.lifecycle !== "running" && tutorialSession?.lifecycle !== "summary") return;
  tutorialPoll = setTimeout(() => void silentRefreshTutorial(), 2_000);
}

async function silentRefreshTutorial(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined || journeyBusy) { scheduleTutorialPoll(); return; }
  try {
    const next = await client.loadTutorial(session.tutorialWorldId);
    const changed = next.currentChapter !== session.currentChapter || next.lifecycle !== session.lifecycle || next.dialogue.id !== session.dialogue.id;
    setTutorialSession(next);
    if (changed) { render(); focusCoach(); }
  } catch { /* Die sichtbare Aktion liefert weiterhin erklaerbare Fehler; Polling bleibt still. */ }
  scheduleTutorialPoll();
}

async function journeyAction(action: () => Promise<void>, success: string): Promise<void> {
  if (journeyBusy) return;
  journeyBusy = true;
  message = "Autoritativer Weltzustand wird aktualisiert …";
  messageTone = "status";
  render();
  try {
    await action();
    message = success;
    messageTone = "status";
  } catch (error) {
    message = error instanceof Error ? error.message : "Spielerreise konnte nicht aktualisiert werden.";
    messageTone = "error";
  } finally {
    journeyBusy = false;
    render();
    if (tutorialSession !== undefined) focusCoach();
  }
}

function commandKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function formSecond(fields: Readonly<Record<string, string>>, name: string): number {
  const value = fields[name] ?? "";
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} muss eine nichtnegative ganze Simulationssekunde sein.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} liegt außerhalb des sicheren Bereichs.`);
  return parsed;
}

function addSeconds(atS: number, seconds: number): number {
  const result = atS + seconds;
  if (!Number.isSafeInteger(result)) throw new Error("Simulationszeit liegt außerhalb des sicheren Bereichs.");
  return result;
}

async function refreshCooperation(preferredOperatorId = activeOperatorId): Promise<void> {
  const client = api;
  if (client === undefined || publicWorldId === "") return;
  const [own, atS, roster, listings] = await Promise.all([
    client.loadOwnOperators(),
    client.loadSimulationTime(publicWorldId),
    client.loadWorldOperators(publicWorldId),
    client.loadVehicleMarket(publicWorldId),
  ]);
  cooperationAtS = atS;
  worldOperators = roster;
  ownOperatorIds = own.filter((operator) => operator.worldId === publicWorldId).map((operator) => operator.id);
  activeOperatorId = ownOperatorIds.includes(preferredOperatorId) ? preferredOperatorId : (ownOperatorIds[0] ?? "");
  marketListings = listings;
  selectedVehicleHistory = undefined;
  selectedHistoryVehicleId = "";
  if (activeOperatorId === "") {
    operatorContracts = [];
    ownedVehicles = [];
    return;
  }
  [operatorContracts, ownedVehicles] = await Promise.all([
    client.loadContracts(publicWorldId, activeOperatorId),
    client.loadOwnedVehicles(publicWorldId, activeOperatorId),
  ]);
}

function cooperationAction(action: () => Promise<void>, success: string): Promise<void> {
  return journeyAction(async () => {
    if (api !== undefined && publicWorldId !== "") cooperationAtS = await api.loadSimulationTime(publicWorldId);
    await action();
  }, success);
}

function offerCooperationContract(fields: Readonly<Record<string, string>>): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    const parsed = parseContractOfferFields(contractType, fields, cooperationAtS);
    await client.offerContract(publicWorldId, activeOperatorId, {
      ...parsed,
      contractType,
      offeredAtS: cooperationAtS,
      idempotencyKey: commandKey("contract-offer"),
    });
    await refreshCooperation(activeOperatorId);
  }, "Vertragsangebot wurde autoritativ gespeichert und ins Postfach zugestellt.");
}

function respondToContract(contractId: string, response: "accept" | "reject"): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.respondToContract(publicWorldId, activeOperatorId, contractId, response, cooperationAtS);
    await refreshCooperation(activeOperatorId);
  }, response === "accept" ? "Vertrag wurde angenommen; Ledger, Postfach und Audit sind aktualisiert." : "Vertrag wurde abgelehnt und beiden Parteien zugestellt.");
}

function endContract(contractId: string, nonPerformance: boolean): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.endContract(
      publicWorldId,
      activeOperatorId,
      contractId,
      cooperationAtS,
      nonPerformance ? "Nichterfüllung über Spieleroberfläche gemeldet." : "Ordentliche Kündigung über Spieleroberfläche.",
      nonPerformance,
    );
    await refreshCooperation(activeOperatorId);
  }, nonPerformance ? "Nichterfüllung wurde auditiert und beiden Parteien zugestellt." : "Vertrag wurde mit Fristprüfung beendet.");
}

function createVehicleListing(fields: Readonly<Record<string, string>>): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    const listingType = fields["listingType"];
    if (listingType !== "sale" && listingType !== "rental") throw new Error("Angebotsart ist ungültig.");
    const vehicleId = (fields["vehicleId"] ?? "").trim();
    if (vehicleId === "") throw new Error("Fahrzeug fehlt.");
    const expiresAtS = formSecond(fields, "expiresAtS");
    const rentalValidUntilS = listingType === "rental" ? formSecond(fields, "rentalValidUntilS") : undefined;
    await client.createVehicleListing(publicWorldId, activeOperatorId, vehicleId, {
      listingType,
      priceCents: parseEuroCents(fields["priceEuros"] ?? ""),
      ...(rentalValidUntilS === undefined ? {} : { rentalValidUntilS }),
      listedAtS: cooperationAtS,
      expiresAtS,
      idempotencyKey: commandKey("vehicle-listing"),
    });
    await refreshCooperation(activeOperatorId);
  }, "Fahrzeugangebot wurde mit Zustands- und Historienoffenlegung veröffentlicht.");
}

function reserveListing(listingId: string, expectedRevision: number): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.reserveVehicleListing(publicWorldId, listingId, activeOperatorId, cooperationAtS, addSeconds(cooperationAtS, 600), expectedRevision);
    await refreshCooperation(activeOperatorId);
  }, "Fahrzeug ist für zehn Simulationsminuten reserviert.");
}

function transferListing(listingId: string, expectedRevision: number): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.transferVehicleListing(publicWorldId, listingId, activeOperatorId, cooperationAtS, expectedRevision, commandKey("vehicle-transfer"));
    await refreshCooperation(activeOperatorId);
  }, "Übergabe, Ledgerbuchung, Flotten-Single-Writer und Lebenslauf wurden atomar bestätigt.");
}

function reverseListing(listingId: string): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.reverseVehicleTransfer(publicWorldId, listingId, activeOperatorId, cooperationAtS, "undisclosed-player-reported", commandKey("vehicle-reversal"));
    await refreshCooperation(activeOperatorId);
  }, "Rückabwicklung und Gegenbuchung wurden autoritativ ausgeführt.");
}

function cancelListing(listingId: string, expectedRevision: number): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
    await client.cancelVehicleListing(publicWorldId, activeOperatorId, listingId, cooperationAtS, expectedRevision);
    await refreshCooperation(activeOperatorId);
  }, "Fahrzeugangebot wurde zurückgezogen.");
}

function loadVehicleHistory(vehicleId: string): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined) throw new Error("Game-API fehlt.");
    selectedVehicleHistory = await client.loadVehicleHistory(publicWorldId, vehicleId);
    selectedHistoryVehicleId = vehicleId;
  }, "Unveränderlicher Fahrzeuglebenslauf wurde geladen.");
}

async function startTutorial(): Promise<void> {
  const client = api;
  if (client === undefined || publicWorldId === "") return;
  return journeyAction(async () => setTutorialSession(await client.startTutorial(publicWorldId)), "Ihre private Tutorialwelt ist bereit.");
}

async function restartTutorial(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.restartTutorial(session.tutorialWorldId)), "Die alte Welt wurde archiviert; eine neue Tutorialwelt ist bereit.");
}

async function applyTutorialAction(action: TutorialAction): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.tutorialAction(session.tutorialWorldId, action)), "Autoritativer Nachweis erbracht. Das nächste Kapitel ist bereit.");
}

async function openTutorialHint(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.openTutorialHint(session.tutorialWorldId)), "Lutz hat einen zusätzlichen Hinweis eingeblendet.");
}

async function dismissTutorialDialogue(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  try {
    setTutorialSession(await client.dismissTutorialDialogue(session.tutorialWorldId, session.dialogue.id));
    coachDismissed = true;
    render();
  } catch (error) {
    message = error instanceof Error ? error.message : "Hinweis konnte nicht ausgeblendet werden.";
    messageTone = "error";
    render();
  }
}

async function confirmTutorialSummary(): Promise<void> {
  const client = api;
  const session = tutorialSession;
  if (client === undefined || session === undefined) return;
  return journeyAction(async () => setTutorialSession(await client.confirmTutorialSummary(session.tutorialWorldId)), "Die Tutorialwelt wurde geschlossen. Ihre öffentliche Welt blieb unverändert.");
}

function bind(): void {
  app.querySelector("#density")?.addEventListener("click", () => {
    density = density === "control" ? "document" : "control";
    render();
  });
  app.querySelector("#steps")?.addEventListener("click", () => {
    showBlockingTimes = !showBlockingTimes;
    render();
  });
  app.querySelectorAll<HTMLElement>("[data-train]").forEach((node) => {
    const select = (): void => {
      selectedTrainId = node.dataset.train ?? "";
      selectedConflictId =
        projection === undefined
          ? ""
          : (conflictsForTrain(projection, selectedTrainId)[0]?.id ?? "");
      message = "";
      render();
    };
    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-conflict]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedConflictId = node.dataset.conflict ?? "";
      message = "";
      render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-apply-alternative]").forEach((node) => {
    node.addEventListener("click", () => {
      const alternativeId = node.dataset.applyAlternative ?? "";
      if (alternativeId !== "") void applyAlternative(alternativeId);
    });
  });
}

async function applyAlternative(alternativeId: string): Promise<void> {
  if (projection === undefined || applyingAlternativeId !== "") return;
  const previousRevision = projection.projectionRevision;
  applyingAlternativeId = alternativeId;
  message = "Alternative wurde eingereiht; der Client wartet auf die neue Planner-Projektion.";
  messageTone = "status";
  render();
  try {
    if (demoMode && demoApply !== undefined) {
      projection = demoApply(projection, alternativeId);
    } else if (api !== undefined && worldId !== "") {
      projection = await api.applyAlternative(worldId, previousRevision, alternativeId);
    } else {
      throw new Error("Weltkennung oder angemeldete Sitzung fehlt.");
    }
    reconcileSelection(projection);
    message = `Serverautoritäre Planner-Projektion Revision ${projection.projectionRevision} wurde geladen.`;
    messageTone = "status";
  } catch (error) {
    message =
      error instanceof Error
        ? error.message
        : "Alternative konnte nicht angewendet werden.";
    messageTone = "error";
  } finally {
    applyingAlternativeId = "";
    render();
  }
}

async function boot(): Promise<void> {
  render();
  if (demoMode) {
    const demo = await import("./demo.js");
    demoApply = demo.applyDemoAlternative;
    projection = demo.demoProjection;
    chooseInitialSelection(projection);
    render();
    return;
  }
  try {
    const accessToken = await ensureAccessToken(runtimeConfiguration);
    if (accessToken === "") return;
    api = new GameApiClient(runtimeConfiguration.gameApiUrl, accessToken);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Anmeldung fehlgeschlagen.";
    if (journeyMode) {
      journeyBusy = false;
      message = detail;
      messageTone = "error";
    }
    else loadError = detail;
    render();
    return;
  }
  if (journeyMode) {
    if (api === undefined || publicWorldId === "") {
      journeyBusy = false;
      message = "Öffentliche Weltkennung oder angemeldete Sitzung fehlt. Produktivdaten werden nicht durch Beispieldaten ersetzt.";
      messageTone = "error";
      render();
      return;
    }
    journeyBusy = true;
    render();
    try {
      const requestedTutorialWorld = tutorialReference === null ? undefined : worldId;
      const tutorial = await (requestedTutorialWorld === undefined ? api.loadActiveTutorial(publicWorldId) : api.loadTutorial(requestedTutorialWorld));
      if (tutorial !== undefined) {
        setTutorialSession(tutorial);
      } else {
        try {
          await refreshCooperation();
        } catch (error) {
          message = error instanceof Error ? error.message : "Kooperation und Fahrzeugmarkt konnten nicht geladen werden.";
          messageTone = "error";
        }
      }
    } catch (error) {
      message = error instanceof Error ? error.message : "Spielerreise konnte nicht geladen werden.";
      messageTone = "error";
    } finally {
      journeyBusy = false;
      render();
    }
    return;
  }
  if (worldId === "" || api === undefined) {
    loadError =
      "Weltkennung oder angemeldete Sitzung fehlt. Im Produktivmodus werden keine Beispieldaten eingesetzt.";
    render();
    return;
  }
  try {
    projection = await api.loadProjection(worldId);
    chooseInitialSelection(projection);
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "Planner-Ergebnis konnte nicht geladen werden.";
  }
  render();
}

if (primaryDestination === undefined) void boot();
