import type { Density } from "@zugfolge/design-system";
import { bindRailwayTabs, mountGameHints } from "@zugfolge/design-system";
import { GAME_HINTS } from "./game-hints.js";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";
import type { PlayerOperatorContextV1 } from "@zugfolge/player-context";

import {
  GameApiClient,
  type CooperationPageView,
  type CooperationResourceCatalog,
  type ContractType,
  type MailboxMessageView,
  type OperatorContractView,
  type OperatorSummary,
  type PublicWorldContractView,
  type PublicTenderView,
  type VehicleAssetView,
  type VehicleHistoryEventView,
  type VehicleMarketListingView,
} from "./api.js";
import {
  ensureAccessToken,
  loadRuntimeConfiguration,
  resetAuthenticationAttempt,
  RuntimeConfigurationError,
  validateRuntimeConfiguration,
} from "./auth.js";
import {
  bindCooperationSurface,
  parseContractOfferFields,
  parseEuroCents,
  formatCents,
  mergeBoundedItems,
  type CooperationSurfaceState,
} from "./cooperation.js";
import { conflictsForTrain, formatSignedShiftS } from "./diagram.js";
import { renderJourney } from "./journey.js";
import {
  cooperationPageViews,
  focusCooperationDeepLink,
  primaryMapDestination,
  resolveJourneySection,
  resolveWorldContext,
} from "./navigation.js";
import { classifyJourneyFailure } from "./recovery.js";
import { renderLoadState, renderProjection } from "./view.js";
import { captureWorkspaceView } from "./workspace-view.js";
import "./styles.css";
import "@zugfolge/design-system/railway.css";
import "./railway-game.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app = root;
mountGameHints(app, GAME_HINTS);
let unmountGlossaryLayer: (() => void) | undefined;

function mountGlossaryForCurrentView(): void {
  const shell = app.querySelector<HTMLElement>(".player-shell");
  if (shell === null) {
    unmountGlossaryLayer = mountGlossaryLayer(document.body);
    return;
  }
  unmountGlossaryLayer = mountGlossaryLayer(shell);
  const host = shell.querySelector<HTMLElement>("[data-zugfolge-glossary]");
  const topbar = shell.querySelector<HTMLElement>(".player-topbar");
  if (host !== null && topbar !== null) topbar.append(host);
}

const parameters = new URLSearchParams(window.location.search);
const requestedDeadlineBeforeS = parameters.get("deadlineBeforeS");
const parsedDeadlineBeforeS = requestedDeadlineBeforeS === null ? undefined : Number(requestedDeadlineBeforeS);
const cooperationDeadlineBeforeS = parsedDeadlineBeforeS !== undefined && Number.isSafeInteger(parsedDeadlineBeforeS) && parsedDeadlineBeforeS >= 0
  ? parsedDeadlineBeforeS
  : undefined;
let runtimeConfiguration = loadRuntimeConfiguration();
const demoMode = parameters.get("demo") === "1";
const requestedView = parameters.get("view");
const journeyMode = !demoMode && requestedView !== "diagram";
const initialCooperationPageViews = cooperationPageViews(parameters);
const activeJourneySection = resolveJourneySection(parameters, window.location.hash);
let { worldId, publicWorldId } = resolveWorldContext(parameters, runtimeConfiguration.publicWorldId);
let livemapUrl = runtimeConfiguration.livemapUrl === "" ? "" : (() => {
  const value = new URL(runtimeConfiguration.livemapUrl, window.location.href);
  value.searchParams.set("world", worldId);
  return value.href;
})();
let operationsCenterUrl = runtimeConfiguration.operationsCenterUrl === ""
  ? ""
  : new URL(runtimeConfiguration.operationsCenterUrl, window.location.href).href;
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
let selectedTrainId = parameters.get("train") ?? "";
let selectedConflictId = "";
let projection: PlanningProjectionV1 | undefined;
let loadError = "";
let message = "";
let messageTone: "status" | "error" = "status";
let bootRecovery: "authenticate" | "configure" | "retry" | undefined;
let applyingAlternativeId = "";
let demoApply: ((current: PlanningProjectionV1, alternativeId: string) => PlanningProjectionV1) | undefined;
type JourneyBusyScope = "initial" | "cooperation" | "mailbox";
const journeyBusyScopes = new Set<JourneyBusyScope>(journeyMode && !demoMode ? ["initial"] : []);
let worldOperators: readonly OperatorSummary[] = [];
let playerOperatorContext: PlayerOperatorContextV1 | undefined;
let ownOperatorIds: readonly string[] = [];
let activeOperatorId = "";
let operatorContracts: readonly OperatorContractView[] = [];
let marketListings: readonly VehicleMarketListingView[] = [];
let ownedVehicles: readonly VehicleAssetView[] = [];
let cooperationResources: CooperationResourceCatalog | undefined;
let selectedVehicleHistory: readonly VehicleHistoryEventView[] | undefined;
let selectedHistoryVehicleId = "";
let contractType: ContractType = "traction";
let marketQuery = "";
let cooperationAtS = 0;
let economyRevision = 0;
let worldEntryConfirmed = false;
let publicTenders: readonly PublicTenderView[] = [];
let tendersUnavailable = false;
let mailboxMessages: readonly MailboxMessageView[] = [];
let publicWorldContracts: readonly PublicWorldContractView[] = [];
let contractPageView: CooperationPageView = initialCooperationPageViews.contractPageView;
let listingPageView: CooperationPageView = initialCooperationPageViews.listingPageView;
let pendingCooperationDeepLink = true;
let contractNextCursor: string | null = null;
let listingNextCursor: string | null = null;
type FormDraft = Readonly<Record<string, readonly string[]>>;
const journeyDrafts = new Map<string, FormDraft>();
const clearedJourneyDrafts = new Set<string>();
let pendingConfirmation: {
  readonly title: string;
  readonly detail: string;
  readonly action: () => Promise<void>;
  readonly returnFocusSelector?: string;
  readonly resolve: () => void;
} | undefined;
const retainedCommandKeys = new Map<string, string>();

function captureJourneyDrafts(): void {
  app.querySelectorAll<HTMLFormElement>("form[data-preserve-draft]").forEach((form) => {
    if (clearedJourneyDrafts.delete(form.id)) {
      journeyDrafts.delete(form.id);
      return;
    }
    const values: Record<string, string[]> = {};
    for (const [name, value] of new FormData(form).entries()) (values[name] ??= []).push(String(value));
    journeyDrafts.set(form.id, values);
  });
}

function restoreJourneyDrafts(): void {
  for (const [formId, draft] of journeyDrafts) {
    const form = app.querySelector<HTMLFormElement>(`#${CSS.escape(formId)}`);
    if (form === null) continue;
    for (const [name, values] of Object.entries(draft)) {
      const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name="${CSS.escape(name)}"]`);
      controls.forEach((control) => {
        if (control instanceof HTMLSelectElement && control.multiple) {
          [...control.options].forEach((option) => { option.selected = values.includes(option.value); });
        } else if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) {
          control.checked = values.includes(control.value);
        } else if (values[0] !== undefined) control.value = values[0];
      });
    }
  }
}

function explicitDemoUrl(): string {
  const demoParameters = new URLSearchParams(window.location.search);
  demoParameters.set("demo", "1");
  return `?${demoParameters.toString()}`;
}

function chooseInitialSelection(current: PlanningProjectionV1): void {
  if (!current.trains.some((train) => train.id === selectedTrainId)) selectedTrainId = current.trains[0]?.id ?? "";
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
  const worldName = publicWorldContracts.find((contract) => contract.worldId === publicWorldId)?.name ?? "ausgewählter Welt";
  const currentProjection = projection;
  const pathAlternatives = currentProjection?.conflicts.flatMap((conflict) => conflict.alternative === null ? [] : [{
    id: conflict.alternative.alternativeId,
    label: `Trassenlage für ${currentProjection.trains.find((train) => train.id === conflict.alternative?.trainId)?.number ?? "Zuglauf"}`,
    shift: formatSignedShiftS(conflict.alternative.departureShiftS),
    compatibility: conflict.alternative.explanation,
    provenance: "Serverbestätigter Planungsstand",
  }]);
  const stationOptions = currentProjection?.stations.map((station) => ({ id: station.id, label: station.name }));
  return {
    worldId: publicWorldId,
    worldName,
    activeOperatorId,
    operators: worldOperators,
    ownOperatorIds,
    contracts: operatorContracts,
    listings: marketListings,
    ownedVehicles,
    resources: cooperationResources,
    selectedVehicleHistory,
    selectedHistoryVehicleId,
    contractType,
    marketQuery,
    contractPageView,
    listingPageView,
    contractNextCursor,
    listingNextCursor,
    atS: cooperationAtS,
    busy: journeyBusyScopes.has("cooperation"),
    ...(pathAlternatives === undefined ? {} : { pathAlternatives }),
    ...(stationOptions === undefined ? {} : { stationOptions }),
    economyRevision,
    tenders: publicTenders,
    tendersUnavailable,
    section: activeJourneySection === "markets" ? "markets"
      : activeJourneySection === "operations" ? "operations" : "all",
  };
}

function render(): void {
  unmountGlossaryLayer?.();
  unmountGlossaryLayer = undefined;
  app.dataset.density = density;
  if (journeyMode) {
    const restoreWorkspaceView = captureWorkspaceView(app);
    captureJourneyDrafts();
    const busyScope = journeyBusyScopes.has("initial") ? "initial"
        : journeyBusyScopes.has("cooperation") ? "cooperation"
          : journeyBusyScopes.has("mailbox") ? "mailbox" : undefined;
    app.innerHTML = renderJourney({
      publicWorldId,
      busy: journeyBusyScopes.size > 0,
      ...(busyScope === undefined ? {} : { busyScope }),
      message,
      messageTone,
      livemapUrl,
      operationsCenterUrl,
      cooperation: cooperationState(),
      mailbox: mailboxMessages,
      worldContracts: publicWorldContracts,
      hasActiveOperator: activeOperatorId !== "",
      entryConfirmed: worldEntryConfirmed,
      activeOperatorId,
      operatorContext: playerOperatorContext,
      activeSection: activeJourneySection,
      confirmation: pendingConfirmation === undefined ? undefined : { title: pendingConfirmation.title, detail: pendingConfirmation.detail },
      bootRecovery,
    });
    bindJourney();
    bindRailwayTabs(app, window.location.hash);
    restoreJourneyDrafts();
    restoreWorkspaceView();
    mountGlossaryForCurrentView();
    if (pendingCooperationDeepLink && focusCooperationDeepLink(
      app,
      window.location.hash,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    )) pendingCooperationDeepLink = false;
    const dialog = app.querySelector<HTMLDialogElement>("#journey-confirmation");
    if (dialog !== null && !dialog.open) dialog.showModal();
    return;
  }
  if (projection === undefined) {
    app.innerHTML = renderLoadState(
      loadError === "" ? "loading" : "error",
      loadError === "" ? "Dein Fahrplan wird geladen …" : loadError,
      loadError === "" ? undefined : explicitDemoUrl(),
    );
    app.querySelector<HTMLButtonElement>("#planner-retry")?.addEventListener("click", () => {
      loadError = "";
      void boot();
    });
    mountGlossaryForCurrentView();
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
    demoMode,
    livemapUrl,
    operationsCenterUrl,
    activeOperatorId,
  });
  bind();
  mountGlossaryForCurrentView();
}

function bindJourney(): void {
  app.querySelector("#journey-retry")?.addEventListener("click", () => {
    const recovery = bootRecovery;
    if (recovery === "authenticate") {
      resetAuthenticationAttempt();
      api = undefined;
    }
    bootRecovery = undefined;
    message = "Deine Spielwelt wird neu verbunden …";
    messageTone = "status";
    void boot();
  });
  app.querySelectorAll<HTMLButtonElement>("[data-mailbox-ack]").forEach((button) => {
    button.addEventListener("click", () => void acknowledgeMailbox(button.dataset.mailboxAck ?? ""));
  });
  app.querySelectorAll<HTMLFormElement>("[data-world-contract-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form).entries());
      void enterPublicWorld(String(fields["worldId"] ?? ""), String(fields["displayName"] ?? ""), String(fields["contractHash"] ?? ""));
    });
  });
  app.querySelector<HTMLSelectElement>("#journey-operator")?.addEventListener("change", (event) => {
    const operatorId = (event.currentTarget as HTMLSelectElement).value;
    if (operatorId !== "") void cooperationAction(async () => refreshCooperation(operatorId), "Dein Unternehmen wurde gewechselt.");
  });
  app.querySelector<HTMLDialogElement>("#journey-confirmation")?.addEventListener("close", (event) => {
    const dialog = event.currentTarget as HTMLDialogElement;
    finishConfirmation(dialog.returnValue === "confirm");
  });
  bindCooperationSurface(app, {
    createOperator: foundOperator,
    submitTenderBid,
    submitPathRequest,
    scheduleMaintenance,
    changeOperator: (operatorId) => cooperationAction(async () => refreshCooperation(operatorId), "Dein Unternehmen wurde gewechselt."),
    changeContractType: (value) => {
      captureJourneyDrafts();
      const existing = journeyDrafts.get("m12-contract-form") ?? {};
      journeyDrafts.set("m12-contract-form", { ...existing, contractType: [value] });
      contractType = value;
      render();
    },
    changeMarketQuery: (value) => { marketQuery = value; render(); },
    changeContractPageView,
    changeListingPageView,
    loadMoreContracts,
    loadMoreListings,
    refresh: () => cooperationAction(async () => refreshCooperation(activeOperatorId), "Deine Angebote und Verträge sind aktuell."),
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

function foundOperator(name: string): Promise<void> {
  if (name.trim() === "") return reportFormError(new Error("Gib deinem Unternehmen einen Namen."));
  return requestConfirmation(
    "Unternehmen gründen?",
    confirmationDetail({ parties: `Dein Konto und ${name.trim()}`, object: "Gründung deiner eigenen Bahn", amount: "Das angezeigte Startkapital", deadline: "sofort", consequence: "Dein Unternehmen wird mit diesem Namen und dem angezeigten Startkapital gegründet." }),
    () => cooperationAction(async () => {
      if (api === undefined || publicWorldId === "") throw new Error("Welt oder Sitzung fehlt.");
      const operator = await api.createOperator(publicWorldId, name.trim());
      clearedJourneyDrafts.add("operator-foundation-form");
      await refreshCooperation(operator.id);
    }, `Dein Unternehmen „${name.trim()}“ ist gegründet. Gute Fahrt!`),
    "#operator-foundation-form input",
  );
}

function submitTenderBid(fields: Readonly<Record<string, string>>): Promise<void> {
  const tenderId = (fields["tenderId"] ?? "").trim();
  const formationChoice = (fields["formationId"] ?? "").trim();
  const resources = cooperationResources;
  const ownFormation = resources?.formations.find((entry) => formationChoice === `own:${entry.id}`);
  const publicFacility = resources?.publicEntryFacilities.find((entry) => formationChoice === `public:${entry.id}`);
  const tender = publicTenders.find((entry) => entry.id === tenderId);
  const formationId = ownFormation?.id ?? publicFacility?.formationId ?? "";
  if (tenderId === "" || formationId === "" || resources?.fleetRevision === null || resources?.fleetRevision === undefined || resources.fleetSnapshotHash === null) {
    return reportFormError(new Error("Für das Angebot fehlen eine offene Ausschreibung oder eine serverbestätigte Formation."));
  }
  if (publicFacility !== undefined && publicFacility.lotId !== tender?.lotId) return reportFormError(new Error("Der öffentliche Anschubvertrag gehört nicht zum gewählten Ausschreibungslos."));
  const fleetRevision = resources.fleetRevision;
  const fleetSnapshotHash = resources.fleetSnapshotHash;
  const orderingFeeCentsPerTrainKm = parseEuroCents(fields["orderingFeeEuros"] ?? "");
  const punctuality = Number((fields["punctualityPercent"] ?? "").replace(",", "."));
  const extraSeats = Number(fields["extraSeats"] ?? "0");
  if (!Number.isFinite(punctuality) || punctuality < 0 || punctuality > 100 || !Number.isSafeInteger(extraSeats) || extraSeats < 0) return reportFormError(new Error("Pünktlichkeit oder Sitzplatzzusage ist ungültig."));
  return requestConfirmation(
    "Angebot verbindlich abgeben?",
    confirmationDetail({ parties: operatorDisplayName(activeOperatorId), object: `Ausschreibung ${tenderId}`, amount: `${formatCents(orderingFeeCentsPerTrainKm)} je Zug-km`, deadline: simulationDeadline(publicTenders.find((tender) => tender.id === tenderId)?.closesAt), consequence: "Das versiegelte Angebot wird serverseitig gegen Flottenstand, Frist und Weltrevision geprüft." }),
    () => cooperationAction(async () => {
      if (api === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
      const commandId = commandKey("tender-bid", `${tenderId}:${formationChoice}:${orderingFeeCentsPerTrainKm}:${punctuality}:${extraSeats}`);
      await api.submitTenderBid(publicWorldId, tenderId, activeOperatorId, {
        expectedRevision: economyRevision,
        commandId,
        bidId: commandId,
        orderingFeeCentsPerTrainKm,
        vehicleReference: {
          fleetRevision,
          snapshotHash: fleetSnapshotHash,
          formationId,
          ...(publicFacility === undefined ? {} : {
            personnelDutyIds: publicFacility.personnelDutyIds,
            pathReservationIds: publicFacility.pathReservationIds,
            entryFacility: {
            schemaVersion: "zugfolge-public-entry-facility/v1" as const,
            providerOperatorId: "public" as const,
            },
          }),
        },
        promises: { extraSeats, punctualityBasisPoints: Math.round(punctuality * 100), additionalStops: 0 },
      });
      completeCommand("tender-bid", `${tenderId}:${formationChoice}:${orderingFeeCentsPerTrainKm}:${punctuality}:${extraSeats}`);
      clearedJourneyDrafts.add("tender-bid-form");
      await refreshCooperation(activeOperatorId);
    }, "Angebot wurde versiegelt eingereicht."),
    "#tender-bid-form button",
  );
}

function positiveIntegerField(value: string | undefined, label: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} muss eine positive ganze Zahl sein.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} liegt ausserhalb des sicheren Zahlenbereichs.`);
  return parsed;
}

function submitPathRequest(kind: "schedule" | "empty-run", fields: Readonly<Record<string, string>>): Promise<void> {
  try {
    const formationId = (fields["formationId"] ?? "").trim();
    const originStationId = (fields["originStationId"] ?? "").trim();
    const destinationStationId = (fields["destinationStationId"] ?? "").trim();
    const departureInMinutes = positiveIntegerField(fields["departureInMinutes"], "Abfahrtsvorlauf");
    if (formationId === "" || originStationId === "" || destinationStationId === "") throw new Error("Formation, Start und Ziel muessen ausgewaehlt werden.");
    if (originStationId === destinationStationId) throw new Error("Start und Ziel muessen verschieden sein.");
    const fingerprint = `${kind}:${formationId}:${originStationId}:${destinationStationId}:${departureInMinutes}`;
    const requestId = commandKey("planning-path", fingerprint);
    const desiredDepartureS = cooperationAtS + departureInMinutes * 60;
    if (!Number.isSafeInteger(desiredDepartureS)) throw new Error("Abfahrtszeit liegt ausserhalb des sicheren Zeitbereichs.");
    const label = kind === "schedule" ? "Fahrplan" : "spontane Leerfahrt";
    let assignedTrainNumber: number | undefined;
    return requestConfirmation(
      `${label === "Fahrplan" ? "Fahrplan" : "Leerfahrt"} verbindlich anmelden?`,
      confirmationDetail({ parties: operatorDisplayName(activeOperatorId), object: `${label} von ${originStationId} nach ${destinationStationId}; Zugnummer wird automatisch vergeben`, amount: "Die geltenden Strecken- und Betriebskosten", deadline: `Abfahrt in ${departureInMinutes} Minuten`, consequence: "Wir prüfen, ob dein Zug einsatzbereit ist und die Fahrt ins Netz passt." }),
      () => cooperationAction(async () => {
        if (api === undefined || activeOperatorId === "") throw new Error("Melde dich an und wähle dein Unternehmen.");
        const submission = await api.submitPlanningPathRequest(publicWorldId, {
          schemaVersion: "planning.player-path-request/v2",
          requestId,
          formationId,
          trainCategory: kind === "schedule" ? "regional" : "supplementary",
          originStationId,
          destinationStationId,
          desiredDepartureS,
          operatingDays: "daily",
          stops: [],
          earlierS: kind === "schedule" ? 600 : 120,
          laterS: kind === "schedule" ? 600 : 300,
          stepS: 60,
          extraRunningTimeS: kind === "schedule" ? 120 : 60,
          maxOperationalStops: 4,
        });
        assignedTrainNumber = submission.trainNumber;
        completeCommand("planning-path", fingerprint);
        clearedJourneyDrafts.add(kind === "schedule" ? "schedule-request-form" : "empty-run-request-form");
      }, () => `${label} wurde als Zug ${assignedTrainNumber ?? "–"} zur konfliktgeprüften Planung eingereicht.`),
      `[data-path-request="${kind}"] button`,
    );
  } catch (error) {
    return reportFormError(error);
  }
}

function scheduleMaintenance(fields: Readonly<Record<string, string>>): Promise<void> {
  try {
    const formationId = (fields["formationId"] ?? "").trim();
    const durationHours = positiveIntegerField(fields["durationHours"], "Werkstattdauer");
    if (formationId === "") throw new Error("Formation fehlt.");
    if (durationHours > 72) throw new Error("Ein Werkstattauftrag darf hoechstens 72 Stunden dauern.");
    const fingerprint = `${formationId}:${durationHours}`;
    const idempotencyKey = commandKey("fleet-maintenance", fingerprint);
    return requestConfirmation(
      "Formation in die Werkstatt schicken?",
      confirmationDetail({ parties: operatorDisplayName(activeOperatorId), object: `Formation ${formationId}`, amount: "Die geltenden Werkstattkosten", deadline: `${durationHours} Stunden Belegung`, consequence: "Während des Werkstattaufenthalts steht dein Zug nicht für Fahrten oder neue Aufträge bereit." }),
      () => cooperationAction(async () => {
        if (api === undefined || activeOperatorId === "") throw new Error("Melde dich an und wähle dein Unternehmen.");
        await api.scheduleMaintenance(publicWorldId, activeOperatorId, { formationId, durationHours, idempotencyKey });
        completeCommand("fleet-maintenance", fingerprint);
        clearedJourneyDrafts.add("maintenance-form");
        await refreshCooperation(activeOperatorId);
      }, "Dein Werkstatttermin ist gebucht."),
      "#maintenance-form button",
    );
  } catch (error) {
    return reportFormError(error);
  }
}

function requestConfirmation(
  title: string,
  detail: string,
  action: () => Promise<void>,
  returnFocusSelector?: string,
): Promise<void> {
  if (pendingConfirmation !== undefined) return Promise.resolve();
  return new Promise((resolve) => {
    pendingConfirmation = { title, detail, action, returnFocusSelector, resolve };
    render();
  });
}

function finishConfirmation(confirmed: boolean): void {
  const pending = pendingConfirmation;
  if (pending === undefined) return;
  pendingConfirmation = undefined;
  if (!confirmed) {
    render();
    if (pending.returnFocusSelector !== undefined) app.querySelector<HTMLElement>(pending.returnFocusSelector)?.focus();
    pending.resolve();
    return;
  }
  render();
  void pending.action().finally(() => {
    if (messageTone !== "error" && pending.returnFocusSelector !== undefined) {
      app.querySelector<HTMLElement>(pending.returnFocusSelector)?.focus();
    }
    pending.resolve();
  });
}

function reportFormError(error: unknown): Promise<void> {
  message = error instanceof Error ? error.message : "Eingaben konnten nicht geprüft werden.";
  messageTone = "error";
  render();
  app.querySelector<HTMLElement>(".journey-message--error")?.focus();
  return Promise.resolve();
}

async function journeyAction(action: () => Promise<void>, success: string | (() => string), scope: JourneyBusyScope = "cooperation"): Promise<void> {
  if (journeyBusyScopes.has(scope) || journeyBusyScopes.has("initial")) return;
  journeyBusyScopes.add(scope);
  message = "Deine Entscheidung wird geprüft …";
  messageTone = "status";
  render();
  try {
    await action();
    message = typeof success === "function" ? success() : success;
    messageTone = "status";
  } catch (error) {
    const failure = classifyJourneyFailure(error, "Deine Spielwelt konnte gerade nicht aktualisiert werden.");
    message = failure.message;
    messageTone = "error";
    bootRecovery = failure.recovery;
  } finally {
    journeyBusyScopes.delete(scope);
    render();
    if (messageTone === "error") app.querySelector<HTMLElement>(".journey-message--error")?.focus();
  }
}

function commandKey(prefix: string, actionFingerprint: string): string {
  const scope = `${publicWorldId}:${activeOperatorId}:${prefix}:${actionFingerprint}`;
  const retained = retainedCommandKeys.get(scope);
  if (retained !== undefined) return retained;
  const created = `${prefix}:${crypto.randomUUID()}`;
  retainedCommandKeys.set(scope, created);
  return created;
}

function completeCommand(prefix: string, actionFingerprint: string): void {
  retainedCommandKeys.delete(`${publicWorldId}:${activeOperatorId}:${prefix}:${actionFingerprint}`);
}

function operatorDisplayName(operatorId: string): string {
  return worldOperators.find((operator) => operator.id === operatorId)?.name ?? operatorId;
}

function simulationDeadline(atS: number | null | undefined): string {
  if (atS === null || atS === undefined) return "keine gesonderte Frist";
  const contract = publicWorldContracts.find((entry) => entry.worldId === publicWorldId);
  if (contract !== undefined) {
    const instant = new Date(Date.parse(contract.timeBasis.epoch) + atS * 1_000);
    return instant.toLocaleString("de-DE", {
      timeZone: contract.timeBasis.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  const secondsOfDay = atS % 86_400;
  const hours = Math.floor(secondsOfDay / 3_600).toString().padStart(2, "0");
  const minutes = Math.floor((secondsOfDay % 3_600) / 60).toString().padStart(2, "0");
  return `Betriebstag ${Math.floor(atS / 86_400) + 1}, ${hours}:${minutes} Uhr`;
}

function confirmationDetail(input: {
  readonly parties: string;
  readonly object: string;
  readonly amount: string;
  readonly deadline: string;
  readonly consequence: string;
}): string {
  return `Welt: ${cooperationState()?.worldName ?? publicWorldId}. Für: ${input.parties}. Vorhaben: ${input.object}. Betrag: ${input.amount}. Frist: ${input.deadline}. Folgen: ${input.consequence}`;
}

function formSecond(fields: Readonly<Record<string, string>>, name: string): number {
  const value = fields[name] ?? "";
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} muss eine nichtnegative ganze Zahl sein.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} liegt außerhalb des sicheren Bereichs.`);
  return parsed;
}

function formDuration(fields: Readonly<Record<string, string>>, name: string, multiplier: number): number {
  const units = formSecond(fields, name);
  const seconds = units * multiplier;
  if (!Number.isSafeInteger(seconds)) throw new Error(`${name} liegt außerhalb des sicheren Zeitbereichs.`);
  return seconds;
}

function addWorldSeconds(atS: number, durationS: number, name: string): number {
  const result = atS + durationS;
  if (!Number.isSafeInteger(result)) throw new Error(`${name} liegt außerhalb des sicheren Zeitbereichs.`);
  return result;
}

async function refreshCooperation(preferredOperatorId = activeOperatorId): Promise<void> {
  const client = api;
  if (client === undefined || publicWorldId === "") return;
  const [operatorContext, atS, roster, listingPage, inbox, economy] = await Promise.all([
    client.loadPlayerOperatorContext(publicWorldId),
    client.loadSimulationTime(publicWorldId),
    client.loadWorldOperators(publicWorldId),
    client.loadVehicleMarket(publicWorldId, listingPageView, undefined, 50, cooperationDeadlineBeforeS),
    client.loadMailbox(publicWorldId),
    client.loadEconomyState(publicWorldId).catch(() => null),
  ]);
  tendersUnavailable = economy === null;
  if (economy !== null) economyRevision = economy.revision;
  publicTenders = economy?.tenders ?? [];
  cooperationAtS = atS;
  try { projection = await client.loadProjection(publicWorldId); }
  catch { projection = undefined; }
  worldOperators = roster;
  playerOperatorContext = operatorContext;
  ownOperatorIds = operatorContext.operators.map((operator) => operator.id);
  const routeOperatorId = parameters.get("operator") ?? "";
  const requestedOperatorId = preferredOperatorId === "" ? routeOperatorId : preferredOperatorId;
  activeOperatorId = ownOperatorIds.includes(requestedOperatorId) ? requestedOperatorId : (ownOperatorIds[0] ?? "");
  marketListings = listingPage.items;
  listingNextCursor = listingPage.nextCursor;
  mailboxMessages = inbox;
  selectedVehicleHistory = undefined;
  selectedHistoryVehicleId = "";
  if (activeOperatorId === "") {
    operatorContracts = [];
    contractNextCursor = null;
    ownedVehicles = [];
    cooperationResources = undefined;
    return;
  }
  const [contractPage, vehicles, resources] = await Promise.all([
    client.loadContracts(publicWorldId, activeOperatorId, contractPageView, undefined, 50, cooperationDeadlineBeforeS),
    client.loadOwnedVehicles(publicWorldId, activeOperatorId),
    client.loadCooperationResources(publicWorldId, activeOperatorId),
  ]);
  operatorContracts = contractPage.items;
  contractNextCursor = contractPage.nextCursor;
  ownedVehicles = vehicles;
  cooperationResources = resources;
}

async function changeContractPageView(view: CooperationPageView): Promise<void> {
  contractPageView = view;
  await cooperationAction(async () => {
    const client = api;
    if (client === undefined || publicWorldId === "" || activeOperatorId === "") return;
    const page = await client.loadContracts(publicWorldId, activeOperatorId, view, undefined, 50, cooperationDeadlineBeforeS);
    operatorContracts = page.items;
    contractNextCursor = page.nextCursor;
  }, view === "archive" ? "Vertragsarchiv wurde geladen." : "Handlungsbedürftige Verträge wurden geladen.");
}

async function changeListingPageView(view: CooperationPageView): Promise<void> {
  listingPageView = view;
  await cooperationAction(async () => {
    const client = api;
    if (client === undefined || publicWorldId === "") return;
    const page = await client.loadVehicleMarket(publicWorldId, view, undefined, 50, cooperationDeadlineBeforeS);
    marketListings = page.items;
    listingNextCursor = page.nextCursor;
  }, view === "archive" ? "Marktarchiv wurde geladen." : "Handlungsbedürftige Marktangebote wurden geladen.");
}

async function loadMoreContracts(): Promise<void> {
  const cursor = contractNextCursor;
  if (cursor === null) return;
  await cooperationAction(async () => {
    const client = api;
    if (client === undefined || publicWorldId === "" || activeOperatorId === "") return;
    const page = await client.loadContracts(publicWorldId, activeOperatorId, contractPageView, cursor, 50, cooperationDeadlineBeforeS);
    const merged = mergeBoundedItems(operatorContracts, page.items);
    operatorContracts = merged.items;
    contractNextCursor = merged.limitReached ? null : page.nextCursor;
  }, "Weitere Verträge wurden geladen.");
}

async function loadMoreListings(): Promise<void> {
  const cursor = listingNextCursor;
  if (cursor === null) return;
  await cooperationAction(async () => {
    const client = api;
    if (client === undefined || publicWorldId === "") return;
    const page = await client.loadVehicleMarket(publicWorldId, listingPageView, cursor, 50, cooperationDeadlineBeforeS);
    const merged = mergeBoundedItems(marketListings, page.items);
    marketListings = merged.items;
    listingNextCursor = merged.limitReached ? null : page.nextCursor;
  }, "Weitere Marktangebote wurden geladen.");
}

function acknowledgeMailbox(messageId: string): Promise<void> {
  return journeyAction(async () => {
    const client = api;
    if (client === undefined || publicWorldId === "" || messageId === "") throw new Error("Postfachnachricht fehlt.");
    await client.acknowledgeMailboxMessage(publicWorldId, messageId);
    mailboxMessages = await client.loadMailbox(publicWorldId);
  }, "Nachricht wurde quittiert.", "mailbox");
}

function enterPublicWorld(worldId: string, displayName: string, contractHash: string): Promise<void> {
  return journeyAction(async () => {
    const client = api;
    if (client === undefined || worldId !== publicWorldId || worldId === "" || contractHash === "" || displayName.trim() === "") {
      throw new Error("Gib deinen Spielernamen ein und bestätige die Spielregeln.");
    }
    await client.enterPublicWorld(worldId, displayName.trim(), contractHash);
    worldEntryConfirmed = true;
    await refreshCooperation(activeOperatorId);
  }, "Willkommen an Bord. Jetzt kannst du dein Unternehmen gründen.", "initial");
}

function cooperationAction(action: () => Promise<void>, success: string | (() => string)): Promise<void> {
  return journeyAction(async () => {
    if (api !== undefined && publicWorldId !== "") cooperationAtS = await api.loadSimulationTime(publicWorldId);
    await action();
  }, success, "cooperation");
}

function offerCooperationContract(fields: Readonly<Record<string, string>>): Promise<void> {
  let preview: ReturnType<typeof parseContractOfferFields>;
  try { preview = parseContractOfferFields(contractType, fields, cooperationAtS); }
  catch (error) { return reportFormError(error); }
  const offeree = worldOperators.find((operator) => operator.id === preview.offereeOperatorId)?.name ?? preview.offereeOperatorId;
  const actionFingerprint = `${contractType}:${JSON.stringify(fields)}`;
  const idempotencyKey = commandKey("contract-offer", actionFingerprint);
  return requestConfirmation(
    "Kooperationsangebot senden?",
    confirmationDetail({ parties: `${operatorDisplayName(activeOperatorId)} an ${offeree}`, object: `Kooperationsvertrag ${contractType}`, amount: formatCents(preview.priceCents), deadline: `Antwort bis ${simulationDeadline(preview.responseDeadlineS)}, Vertrag bis ${simulationDeadline(preview.validUntilS)}`, consequence: "Dein Angebot wird verbindlich an das andere Unternehmen gesendet. Du erhältst die Antwort in deinem Postfach." }),
    () => cooperationAction(async () => {
      const client = api;
      if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
      const parsed = parseContractOfferFields(contractType, fields, cooperationAtS);
      await client.offerContract(publicWorldId, activeOperatorId, { ...parsed, contractType, idempotencyKey });
      await refreshCooperation(activeOperatorId);
      completeCommand("contract-offer", actionFingerprint);
      clearedJourneyDrafts.add("m12-contract-form");
    }, "Vertragsangebot wurde gespeichert und ins Postfach zugestellt."),
    "#m12-contract-form button[type=submit]",
  );
}

function respondToContract(contractId: string, response: "accept" | "reject"): Promise<void> {
  const contract = operatorContracts.find((candidate) => candidate.id === contractId);
  const actionFingerprint = `${contractId}:${response}`;
  const idempotencyKey = commandKey("contract-response", actionFingerprint);
  return requestConfirmation(
    response === "accept" ? "Vertrag verbindlich annehmen?" : "Vertrag ablehnen?",
    confirmationDetail({ parties: contract === undefined ? "Vertragsparteien nicht geladen" : `${operatorDisplayName(contract.offerorOperatorId)} und ${operatorDisplayName(contract.offereeOperatorId)}`, object: contract === undefined ? `Vertrag ${contractId}` : `Kooperationsvertrag ${contract.contractType}`, amount: contract === undefined ? "unbekannt" : formatCents(contract.priceCents), deadline: contract === undefined ? "nicht geladen" : simulationDeadline(contract.responseDeadlineS), consequence: response === "accept" ? "Ledgerbuchung, Leistungspflichten und Vertragsfristen werden verbindlich wirksam." : "Das Angebot endet abgelehnt und beide Parteien werden benachrichtigt." }),
    () => cooperationAction(async () => {
      const client = api;
      if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
      await client.respondToContract(publicWorldId, activeOperatorId, contractId, response, idempotencyKey);
      await refreshCooperation(activeOperatorId);
      completeCommand("contract-response", actionFingerprint);
    }, response === "accept" ? "Vertrag wurde angenommen; Ledger, Postfach und Audit sind aktualisiert." : "Vertrag wurde abgelehnt und beiden Parteien zugestellt."),
    `[data-contract-id="${CSS.escape(contractId)}"][data-contract-response="${response}"]`,
  );
}

function endContract(contractId: string, nonPerformance: boolean, evidenceReference?: string): Promise<void> {
  const contract = operatorContracts.find((candidate) => candidate.id === contractId);
  const reason = nonPerformance ? "Nichterfüllung über Spieleroberfläche gemeldet." : "Ordentliche Kündigung über Spieleroberfläche.";
  const actionFingerprint = `${contractId}:${nonPerformance}:${evidenceReference ?? "kein-beleg"}:${reason}`;
  const idempotencyKey = commandKey("contract-end", actionFingerprint);
  return requestConfirmation(
    nonPerformance ? "Nichterfüllung verbindlich melden?" : "Vertrag kündigen?",
    confirmationDetail({ parties: contract === undefined ? operatorDisplayName(activeOperatorId) : `${operatorDisplayName(contract.offerorOperatorId)} und ${operatorDisplayName(contract.offereeOperatorId)}`, object: contract === undefined ? `Vertrag ${contractId}` : `Kooperationsvertrag ${contract.contractType}`, amount: contract === undefined ? "unbekannt" : formatCents(contract.priceCents), deadline: contract === undefined ? "serverseitige Vertragsfrist" : nonPerformance ? `Betriebsbeleg ${evidenceReference ?? "fehlt"}` : simulationDeadline(cooperationAtS + contract.terminationNoticeS), consequence: nonPerformance ? `Der Server prüft den Tagesbericht exakt gegen Welt, Vertrag, Gegenpartei und Leistungszeit; die Begründung „${reason}“ allein beendet nichts.` : "Die Leistungspflichten bleiben bis zum serverberechneten Ende der Kündigungsfrist vollständig aktiv." }),
    () => cooperationAction(async () => {
      const client = api;
      if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
      await client.endContract(publicWorldId, activeOperatorId, contractId, reason, nonPerformance, idempotencyKey, evidenceReference);
      await refreshCooperation(activeOperatorId);
      completeCommand("contract-end", actionFingerprint);
    }, nonPerformance ? "Nichterfüllung wurde durch einen gebundenen Betriebsbeleg bestätigt und beiden Parteien zugestellt." : "Kündigung wurde vorgemerkt; Leistung und gegebenenfalls Fahrzeughaltung laufen bis zum angezeigten Fristende weiter."),
    nonPerformance ? `[data-contract-non-performance="${CSS.escape(contractId)}"]` : `[data-contract-end="${CSS.escape(contractId)}"]`,
  );
}

function createVehicleListing(fields: Readonly<Record<string, string>>): Promise<void> {
  let listingType: "sale" | "rental";
  let vehicleId: string;
  let priceCents: string;
  try {
    const rawListingType = fields["listingType"];
    if (rawListingType !== "sale" && rawListingType !== "rental") throw new Error("Angebotsart ist ungültig.");
    listingType = rawListingType;
    vehicleId = (fields["vehicleId"] ?? "").trim();
    if (vehicleId === "") throw new Error("Fahrzeug fehlt.");
    priceCents = parseEuroCents(fields["priceEuros"] ?? "");
    formDuration(fields, "expiresInDays", 86_400);
    if (listingType === "rental") formDuration(fields, "rentalDurationDays", 86_400);
  } catch (error) { return reportFormError(error); }
  const vehicle = ownedVehicles.find((candidate) => candidate.vehicleId === vehicleId);
  const expiresAtS = addWorldSeconds(cooperationAtS, formDuration(fields, "expiresInDays", 86_400), "Angebotsende");
  const actionFingerprint = `${vehicleId}:${listingType}:${priceCents}:${expiresAtS}:${fields["rentalDurationDays"] ?? ""}`;
  const idempotencyKey = commandKey("vehicle-listing", actionFingerprint);
  return requestConfirmation(
    listingType === "sale" ? "Fahrzeug verbindlich zum Verkauf anbieten?" : "Fahrzeug verbindlich vermieten?",
    confirmationDetail({ parties: `${operatorDisplayName(activeOperatorId)} und künftige Marktpartei`, object: `${vehicle?.classDesignation ?? "Fahrzeug"} als ${listingType === "sale" ? "Verkauf" : "Vermietung"}`, amount: formatCents(priceCents), deadline: simulationDeadline(expiresAtS), consequence: "Das Angebot wird verbindlich; Zustand, Schäden und Wartungsfristen werden offengelegt." }),
    () => cooperationAction(async () => {
      const client = api;
      if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
      const rentalValidUntilS = listingType === "rental" ? addWorldSeconds(cooperationAtS, formDuration(fields, "rentalDurationDays", 86_400), "Mietende") : undefined;
      await client.createVehicleListing(publicWorldId, activeOperatorId, vehicleId, { listingType, priceCents, ...(rentalValidUntilS === undefined ? {} : { rentalValidUntilS }), expiresAtS, idempotencyKey });
      await refreshCooperation(activeOperatorId);
      completeCommand("vehicle-listing", actionFingerprint);
      clearedJourneyDrafts.add("m12-listing-form");
    }, "Fahrzeugangebot wurde mit Zustand und Fahrzeuglebenslauf veröffentlicht."),
    "#m12-listing-form button[type=submit]",
  );
}

function reserveListing(listingId: string, expectedRevision: number): Promise<void> {
  const listing = marketListings.find((candidate) => candidate.id === listingId);
  const actionFingerprint = `${listingId}:${expectedRevision}`;
  const idempotencyKey = commandKey("vehicle-reserve", actionFingerprint);
  return requestConfirmation("Fahrzeug reservieren?", confirmationDetail({ parties: `${operatorDisplayName(listing?.offeringOperatorId ?? "")} und ${operatorDisplayName(activeOperatorId)}`, object: String(listing?.disclosure["classDesignation"] ?? "Fahrzeug"), amount: listing === undefined ? "unbekannt" : formatCents(listing.priceCents), deadline: listing === undefined ? "zehn Simulationsminuten" : `Reservierung zehn Simulationsminuten, Angebot bis ${simulationDeadline(listing.expiresAtS)}`, consequence: "Das Fahrzeug wird für dich reserviert. Währenddessen können andere Unternehmen es nicht übernehmen." }), () => cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
    await client.reserveVehicleListing(publicWorldId, listingId, activeOperatorId, expectedRevision, idempotencyKey);
    await refreshCooperation(activeOperatorId);
    completeCommand("vehicle-reserve", actionFingerprint);
  }, "Fahrzeug ist für zehn Simulationsminuten reserviert."), `[data-listing-reserve="${CSS.escape(listingId)}"]`);
}

function transferListing(listingId: string, expectedRevision: number): Promise<void> {
  const listing = marketListings.find((candidate) => candidate.id === listingId);
  const actionFingerprint = `${listingId}:${expectedRevision}`;
  const idempotencyKey = commandKey("vehicle-transfer", actionFingerprint);
  return requestConfirmation("Fahrzeugübergabe und Zahlung bestätigen?", confirmationDetail({ parties: `${operatorDisplayName(listing?.offeringOperatorId ?? "")} und ${operatorDisplayName(activeOperatorId)}`, object: String(listing?.disclosure["classDesignation"] ?? "Fahrzeug"), amount: listing === undefined ? "unbekannt" : formatCents(listing.priceCents), deadline: simulationDeadline(listing?.reservedUntilS), consequence: "Eigentum beziehungsweise Halterschaft, Zahlung und Fahrzeuglebenslauf werden atomar geändert." }), () => cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
    await client.transferVehicleListing(publicWorldId, listingId, activeOperatorId, expectedRevision, idempotencyKey);
    await refreshCooperation(activeOperatorId);
    completeCommand("vehicle-transfer", actionFingerprint);
  }, "Übergabe, Ledgerbuchung, Flotten-Single-Writer und Lebenslauf wurden atomar bestätigt."), `[data-listing-transfer="${CSS.escape(listingId)}"]`);
}

function reverseListing(listingId: string, reasonCode: string): Promise<void> {
  const listing = marketListings.find((candidate) => candidate.id === listingId);
  if (listing === undefined || reasonCode.trim() === "") return reportFormError(new Error("Fahrzeugangebot und bestätigter Mangelgrund sind erforderlich."));
  const actionFingerprint = `${listingId}:${reasonCode.trim()}`;
  const idempotencyKey = commandKey("vehicle-reversal", actionFingerprint);
  return requestConfirmation("Rückabwicklung mit Mangelbeleg beantragen?", confirmationDetail({ parties: `${operatorDisplayName(listing.offeringOperatorId)} und ${operatorDisplayName(activeOperatorId)}`, object: `${String(listing.disclosure["classDesignation"] ?? "Fahrzeug")}, Pflichtbegründung: ${reasonCode.trim()}`, amount: formatCents(listing.priceCents), deadline: "serverseitiges Rückabwicklungsfenster von sieben Tagen", consequence: "Eigentum und Zahlung ändern sich nur, wenn der serverseitige Mangelbeleg exakt zu Angebot, Übergabe und Begründung passt." }), () => cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
    await client.reverseVehicleTransfer(publicWorldId, listingId, activeOperatorId, reasonCode.trim(), idempotencyKey);
    await refreshCooperation(activeOperatorId);
    completeCommand("vehicle-reversal", actionFingerprint);
    clearedJourneyDrafts.add(`listing-reversal-${listingId}`);
  }, "Rückabwicklung wurde anhand des bestätigten Mangelbelegs ausgeführt."), `[data-listing-reversal="${CSS.escape(listingId)}"] button[type=submit]`);
}

function cancelListing(listingId: string, expectedRevision: number): Promise<void> {
  const listing = marketListings.find((candidate) => candidate.id === listingId);
  const actionFingerprint = `${listingId}:${expectedRevision}`;
  const idempotencyKey = commandKey("vehicle-cancel", actionFingerprint);
  return requestConfirmation("Fahrzeugangebot zurückziehen?", confirmationDetail({ parties: `${operatorDisplayName(activeOperatorId)} und Marktteilnehmer`, object: String(listing?.disclosure["classDesignation"] ?? "Fahrzeug"), amount: listing === undefined ? "unbekannt" : formatCents(listing.priceCents), deadline: simulationDeadline(listing?.expiresAtS), consequence: "Das offene Angebot wird dauerhaft zurückgezogen; eine aktive Reservierung verhindert die einseitige Ausführung." }), () => cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Wähle zuerst dein Unternehmen.");
    await client.cancelVehicleListing(publicWorldId, activeOperatorId, listingId, expectedRevision, idempotencyKey);
    await refreshCooperation(activeOperatorId);
    completeCommand("vehicle-cancel", actionFingerprint);
  }, "Fahrzeugangebot wurde zurückgezogen."), `[data-listing-cancel="${CSS.escape(listingId)}"]`);
}

function loadVehicleHistory(vehicleId: string): Promise<void> {
  return cooperationAction(async () => {
    const client = api;
    if (client === undefined) throw new Error("Game-API fehlt.");
    selectedVehicleHistory = await client.loadVehicleHistory(publicWorldId, vehicleId);
    selectedHistoryVehicleId = vehicleId;
  }, "Die Geschichte dieses Fahrzeugs ist jetzt geöffnet.");
}

function bind(): void {
  app.querySelector("#density")?.addEventListener("click", () => {
    density = density === "control" ? "document" : "control";
    render();
    app.querySelector<HTMLElement>("#density")?.focus();
  });
  app.querySelector("#steps")?.addEventListener("click", () => {
    showBlockingTimes = !showBlockingTimes;
    render();
    app.querySelector<HTMLElement>("#steps")?.focus();
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
      app.querySelectorAll<HTMLElement>("[data-train]").forEach((candidate) => {
        if (candidate.dataset.train === selectedTrainId) candidate.focus();
      });
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
      app.querySelectorAll<HTMLButtonElement>("[data-conflict]").forEach((candidate) => {
        if (candidate.dataset.conflict === selectedConflictId) candidate.focus();
      });
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
  message = "Alternative wurde eingereiht; die bestätigte Planung wird aktualisiert.";
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
    message = "Der bestätigte Planungsstand wurde geladen.";
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
    app.querySelector<HTMLElement>("#diagram-card")?.focus();
  }
}

async function boot(): Promise<void> {
  bootRecovery = undefined;
  runtimeConfiguration = loadRuntimeConfiguration();
  ({ worldId, publicWorldId } = resolveWorldContext(parameters, runtimeConfiguration.publicWorldId));
  livemapUrl = runtimeConfiguration.livemapUrl === "" ? "" : (() => {
    const value = new URL(runtimeConfiguration.livemapUrl, window.location.href);
    value.searchParams.set("world", worldId);
    return value.href;
  })();
  operationsCenterUrl = runtimeConfiguration.operationsCenterUrl === ""
    ? ""
    : new URL(runtimeConfiguration.operationsCenterUrl, window.location.href).href;
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
    validateRuntimeConfiguration(runtimeConfiguration);
    const accessToken = await ensureAccessToken(runtimeConfiguration);
    if (accessToken === "") return;
    api = new GameApiClient(runtimeConfiguration.gameApiUrl, (forceRefresh) => ensureAccessToken(runtimeConfiguration, forceRefresh));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Anmeldung fehlgeschlagen.";
    if (journeyMode) {
      journeyBusyScopes.clear();
      message = detail;
      messageTone = "error";
      bootRecovery = error instanceof RuntimeConfigurationError ? "configure" : "authenticate";
    }
    else loadError = detail;
    render();
    if (journeyMode) app.querySelector<HTMLElement>(".journey-message--error")?.focus();
    return;
  }
  if (journeyMode) {
    if (api === undefined || publicWorldId === "") {
      journeyBusyScopes.clear();
      message = api === undefined
        ? "Melde dich erneut an, um deine Bahn zu öffnen."
        : "Deine Spielwelt ist gerade nicht erreichbar. Versuche es erneut.";
      messageTone = "error";
      bootRecovery = api === undefined ? "authenticate" : "configure";
      render();
      app.querySelector<HTMLElement>(".journey-message--error")?.focus();
      return;
    }
    journeyBusyScopes.add("initial");
    render();
    try {
      publicWorldContracts = (await api.loadPublicWorldContracts()).filter((contract) => contract.worldId === publicWorldId);
      await refreshCooperation();
    } catch (error) {
      const failure = classifyJourneyFailure(error, "Deine Spielwelt konnte gerade nicht geladen werden.");
      message = failure.message;
      messageTone = "error";
      bootRecovery = failure.recovery;
    } finally {
      journeyBusyScopes.delete("initial");
      render();
      if (messageTone === "error") app.querySelector<HTMLElement>(".journey-message--error")?.focus();
    }
    return;
  }
  if (worldId === "" || api === undefined) {
    loadError =
      "Melde dich erneut an und öffne den Fahrplan aus deiner Spielwelt.";
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
        : "Dein Fahrplan konnte gerade nicht geladen werden.";
  }
  render();
}

if (primaryDestination === undefined) void boot();
