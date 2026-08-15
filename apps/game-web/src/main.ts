import type { Density } from "@zugfolge/design-system";
import "@zugfolge/design-system/styles.css";
import { mountGlossaryLayer } from "@zugfolge/glossary";
import "@zugfolge/glossary/styles.css";
import type { PlanningProjectionV1 } from "@zugfolge/planning-projection";

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
  type TutorialAction,
  type TutorialSessionView,
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
  resolveWorldContext,
} from "./navigation.js";
import { classifyJourneyFailure } from "./recovery.js";
import { renderLoadState, renderProjection } from "./view.js";
import { parseTutorialBidInput } from "./tutorial-input.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("App-Wurzel fehlt");
const app = root;
mountGlossaryLayer(document.body);

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
let { worldId, publicWorldId } = resolveWorldContext(parameters, runtimeConfiguration.publicWorldId);
const tutorialReference = parameters.get("tutorial");
let livemapUrl = runtimeConfiguration.livemapUrl === "" ? "" : (() => {
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
let selectedTrainId = parameters.get("train") ?? "";
let selectedConflictId = "";
let projection: PlanningProjectionV1 | undefined;
let loadError = "";
let message = "";
let messageTone: "status" | "error" = "status";
let bootRecovery: "authenticate" | "configure" | "retry" | undefined;
let applyingAlternativeId = "";
let demoApply: ((current: PlanningProjectionV1, alternativeId: string) => PlanningProjectionV1) | undefined;
let tutorialSession: TutorialSessionView | undefined;
type JourneyBusyScope = "initial" | "tutorial" | "cooperation" | "mailbox";
const journeyBusyScopes = new Set<JourneyBusyScope>(journeyMode && !demoMode ? ["initial"] : []);
let coachDismissed = false;
let whyOpen = false;
let tutorialPoll: ReturnType<typeof setTimeout> | undefined;
let worldOperators: readonly OperatorSummary[] = [];
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
let publicTenders: readonly PublicTenderView[] = [];
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
  };
}

function render(): void {
  app.dataset.density = density;
  if (journeyMode) {
    captureJourneyDrafts();
    const busyScope = journeyBusyScopes.has("initial") ? "initial"
      : journeyBusyScopes.has("tutorial") ? "tutorial"
        : journeyBusyScopes.has("cooperation") ? "cooperation"
          : journeyBusyScopes.has("mailbox") ? "mailbox" : undefined;
    app.innerHTML = renderJourney({
      publicWorldId,
      tutorial: tutorialSession,
      busy: journeyBusyScopes.size > 0,
      ...(busyScope === undefined ? {} : { busyScope }),
      message,
      coachDismissed,
      whyOpen,
      messageTone,
      livemapUrl,
      cooperation: cooperationState(),
      mailbox: mailboxMessages,
      worldContracts: publicWorldContracts,
      confirmation: pendingConfirmation === undefined ? undefined : { title: pendingConfirmation.title, detail: pendingConfirmation.detail },
      bootRecovery,
      tutorialStartAvailable: api !== undefined && publicWorldId !== "",
    });
    bindJourney();
    restoreJourneyDrafts();
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
      loadError === "" ? "Planner-Ergebnis wird geladen …" : loadError,
      loadError === "" ? undefined : explicitDemoUrl(),
    );
    app.querySelector<HTMLButtonElement>("#planner-retry")?.addEventListener("click", () => {
      loadError = "";
      void boot();
    });
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
  });
  bind();
}

function bindJourney(): void {
  app.querySelector("#journey-retry")?.addEventListener("click", () => {
    const recovery = bootRecovery;
    if (recovery === "authenticate") {
      resetAuthenticationAttempt();
      api = undefined;
    }
    bootRecovery = undefined;
    message = "Spielerreise wird erneut verbunden …";
    messageTone = "status";
    void boot();
  });
  app.querySelector("#tutorial-start")?.addEventListener("click", () => void startTutorial());
  app.querySelector("#tutorial-restart")?.addEventListener("click", () => {
    if (window.confirm("Die bisherige Tutorialwelt wird archiviert. Möchten Sie wirklich neu beginnen?")) void restartTutorial();
  });
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
    try {
      if (tutorialSession === undefined) throw new Error("Der Tutorialvertrag ist nicht geladen.");
      void applyTutorialAction(parseTutorialBidInput({
        orderingFeeEuro: String(data.get("orderingFeeEuro") ?? ""),
        punctualityPercent: String(data.get("punctualityPercent") ?? ""),
        extraSeats: String(data.get("extraSeats") ?? ""),
      }, tutorialSession.presentation.tender.limits));
    } catch (error) { void reportFormError(error); }
  });
  app.querySelector<HTMLFormElement>("#tutorial-program-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const thresholdText = String(data.get("thresholdMinutes") ?? "").replace(",", ".");
    void applyTutorialAction({ type: "activate-program", templateId: String(data.get("templateId")) as "connections" | "punctuality", changedRule: String(data.get("changedRule")) as "hold-connections" | "prioritize-punctuality" | "activate-reserve", thresholdSeconds: Math.round(Number(thresholdText) * 60) });
  });
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-offer]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "accept-lease", offerId: button.dataset.tutorialOffer ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-path]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "confirm-path", alternativeId: button.dataset.tutorialPath ?? "" })));
  app.querySelectorAll<HTMLButtonElement>("[data-tutorial-dispatch]").forEach((button) => button.addEventListener("click", () => void applyTutorialAction({ type: "dispatch", action: button.dataset.tutorialDispatch as "short_turn" | "request_reroute" | "trigger_rail_replacement" })));
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
  app.querySelector<HTMLDialogElement>("#journey-confirmation")?.addEventListener("close", (event) => {
    const dialog = event.currentTarget as HTMLDialogElement;
    finishConfirmation(dialog.returnValue === "confirm");
  });
  bindCooperationSurface(app, {
    createOperator: foundOperator,
    submitTenderBid,
    submitPathRequest,
    scheduleMaintenance,
    changeOperator: (operatorId) => cooperationAction(async () => refreshCooperation(operatorId), "Handelndes EVU wurde gewechselt."),
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

function foundOperator(name: string): Promise<void> {
  if (name.trim() === "") return reportFormError(new Error("Bitte wählen Sie einen Namen für Ihr EVU."));
  return requestConfirmation(
    "EVU verbindlich gründen?",
    confirmationDetail({ parties: `Ihr Konto und ${name.trim()}`, object: "Gründung eines Eisenbahnverkehrsunternehmens", amount: "Startkapital gemäß Weltvertrag", deadline: "sofort", consequence: "Name, Gründerkonto und Startkapital werden serverseitig dauerhaft angelegt." }),
    () => cooperationAction(async () => {
      if (api === undefined || publicWorldId === "") throw new Error("Welt oder Sitzung fehlt.");
      const operator = await api.createOperator(publicWorldId, name.trim());
      clearedJourneyDrafts.add("operator-foundation-form");
      await refreshCooperation(operator.id);
    }, `EVU „${name.trim()}“ wurde gegründet.`),
    "#operator-foundation-form input",
  );
}

function submitTenderBid(fields: Readonly<Record<string, string>>): Promise<void> {
  const tenderId = (fields["tenderId"] ?? "").trim();
  const formationId = (fields["formationId"] ?? "").trim();
  const resources = cooperationResources;
  if (tenderId === "" || formationId === "" || resources?.fleetRevision === null || resources?.fleetRevision === undefined || resources.fleetSnapshotHash === null) {
    return reportFormError(new Error("Für das Angebot fehlen eine offene Ausschreibung oder eine serverbestätigte Formation."));
  }
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
      if (api === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
      const commandId = commandKey("tender-bid", `${tenderId}:${formationId}:${orderingFeeCentsPerTrainKm}:${punctuality}:${extraSeats}`);
      await api.submitTenderBid(publicWorldId, tenderId, activeOperatorId, {
        expectedRevision: economyRevision,
        commandId,
        bidId: commandId,
        orderingFeeCentsPerTrainKm,
        vehicleReference: {
          fleetRevision,
          snapshotHash: fleetSnapshotHash,
          formationId,
          ...(resources.personnelDuties.length === 0 ? {} : { personnelDutyIds: resources.personnelDuties.map((entry) => entry.id) }),
          entryFacility: {
            schemaVersion: "zugfolge-public-entry-facility/v1" as const,
            providerOperatorId: "public" as const,
          },
        },
        promises: { extraSeats, punctualityBasisPoints: Math.round(punctuality * 100), additionalStops: 0 },
      });
      completeCommand("tender-bid", `${tenderId}:${formationId}:${orderingFeeCentsPerTrainKm}:${punctuality}:${extraSeats}`);
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
    const trainNumber = positiveIntegerField(fields["trainNumber"], "Zugnummer");
    const departureInMinutes = positiveIntegerField(fields["departureInMinutes"], "Abfahrtsvorlauf");
    if (formationId === "" || originStationId === "" || destinationStationId === "") throw new Error("Formation, Start und Ziel muessen ausgewaehlt werden.");
    if (originStationId === destinationStationId) throw new Error("Start und Ziel muessen verschieden sein.");
    const fingerprint = `${kind}:${formationId}:${trainNumber}:${originStationId}:${destinationStationId}:${departureInMinutes}`;
    const requestId = commandKey("planning-path", fingerprint);
    const desiredDepartureS = cooperationAtS + departureInMinutes * 60;
    if (!Number.isSafeInteger(desiredDepartureS)) throw new Error("Abfahrtszeit liegt ausserhalb des sicheren Zeitbereichs.");
    const label = kind === "schedule" ? "Fahrplan" : "spontane Leerfahrt";
    return requestConfirmation(
      `${label === "Fahrplan" ? "Fahrplan" : "Leerfahrt"} verbindlich anmelden?`,
      confirmationDetail({ parties: operatorDisplayName(activeOperatorId), object: `${label} ${trainNumber} von ${originStationId} nach ${destinationStationId}`, amount: "Trassen- und Betriebskosten laut Weltvertrag", deadline: `Abfahrt in ${departureInMinutes} Minuten`, consequence: "Der Planner prueft Formation, Eigentum, Fahrweg und Konflikte serverseitig; unzulaessige Anmeldungen werden abgelehnt." }),
      () => cooperationAction(async () => {
        if (api === undefined || activeOperatorId === "") throw new Error("Welt, Sitzung oder EVU fehlt.");
        await api.submitPlanningPathRequest(publicWorldId, {
          schemaVersion: "planning.player-path-request/v1",
          requestId,
          formationId,
          trainId: `${kind}-${trainNumber}-${requestId.slice(-12)}`,
          trainCategory: kind === "schedule" ? "regional" : "supplementary",
          trainNumber,
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
        completeCommand("planning-path", fingerprint);
        clearedJourneyDrafts.add(kind === "schedule" ? "schedule-request-form" : "empty-run-request-form");
      }, `${label} wurde zur konfliktgeprueften Planung eingereicht.`),
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
      confirmationDetail({ parties: operatorDisplayName(activeOperatorId), object: `Formation ${formationId}`, amount: "Werkstattkosten laut Weltvertrag", deadline: `${durationHours} Stunden Belegung`, consequence: "Die Formation steht waehrend der serverseitig reservierten Werkstattzeit nicht fuer Betrieb oder Ausschreibungsnachweise bereit." }),
      () => cooperationAction(async () => {
        if (api === undefined || activeOperatorId === "") throw new Error("Welt, Sitzung oder EVU fehlt.");
        await api.scheduleMaintenance(publicWorldId, activeOperatorId, { formationId, durationHours, idempotencyKey });
        completeCommand("fleet-maintenance", fingerprint);
        clearedJourneyDrafts.add("maintenance-form");
        await refreshCooperation(activeOperatorId);
      }, "Werkstattauftrag wurde im autoritativen Flottenzustand gebucht."),
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
  if (client === undefined || session === undefined || journeyBusyScopes.has("tutorial") || journeyBusyScopes.has("initial")) { scheduleTutorialPoll(); return; }
  try {
    const next = await client.loadTutorial(session.tutorialWorldId);
    const changed = next.currentChapter !== session.currentChapter || next.lifecycle !== session.lifecycle || next.dialogue.id !== session.dialogue.id;
    setTutorialSession(next);
    if (changed) { render(); focusCoach(); }
  } catch { /* Die sichtbare Aktion liefert weiterhin erklaerbare Fehler; Polling bleibt still. */ }
  scheduleTutorialPoll();
}

async function journeyAction(action: () => Promise<void>, success: string, scope: JourneyBusyScope = "tutorial"): Promise<void> {
  if (journeyBusyScopes.has(scope) || journeyBusyScopes.has("initial")) return;
  journeyBusyScopes.add(scope);
  message = "Der bestätigte Weltzustand wird aktualisiert …";
  messageTone = "status";
  render();
  try {
    await action();
    message = success;
    messageTone = "status";
  } catch (error) {
    const failure = classifyJourneyFailure(error, "Spielerreise konnte nicht aktualisiert werden.");
    message = failure.message;
    messageTone = "error";
    bootRecovery = failure.recovery;
  } finally {
    journeyBusyScopes.delete(scope);
    render();
    if (messageTone === "error") app.querySelector<HTMLElement>(".journey-message--error")?.focus();
    else if (tutorialSession !== undefined) focusCoach();
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
  return `Welt: ${cooperationState()?.worldName ?? publicWorldId}. Parteien: ${input.parties}. Objekt: ${input.object}. Betrag: ${input.amount}. Frist: ${input.deadline}. Folgen: ${input.consequence}`;
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
  const [own, atS, roster, listingPage, inbox, economy] = await Promise.all([
    client.loadOwnOperators(),
    client.loadSimulationTime(publicWorldId),
    client.loadWorldOperators(publicWorldId),
    client.loadVehicleMarket(publicWorldId, listingPageView, undefined, 50, cooperationDeadlineBeforeS),
    client.loadMailbox(publicWorldId),
    client.loadEconomyState(publicWorldId).catch(() => ({ revision: 0, tenders: [] as readonly PublicTenderView[] })),
  ]);
  economyRevision = economy.revision;
  publicTenders = economy.tenders;
  cooperationAtS = atS;
  try { projection = await client.loadProjection(publicWorldId); }
  catch { projection = undefined; }
  worldOperators = roster;
  ownOperatorIds = own.filter((operator) => operator.worldId === publicWorldId).map((operator) => operator.id);
  activeOperatorId = ownOperatorIds.includes(preferredOperatorId) ? preferredOperatorId : (ownOperatorIds[0] ?? "");
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
    if (client === undefined || worldId === "" || contractHash === "" || displayName.trim() === "") {
      throw new Error("Weltvertrag und Anzeigename müssen vollständig bestätigt werden.");
    }
    await client.enterPublicWorld(worldId, displayName.trim(), contractHash);
    if (worldId !== publicWorldId) {
      const next = new URL(window.location.href);
      next.searchParams.set("world", worldId);
      next.searchParams.delete("publicWorld");
      window.location.assign(next);
      return;
    }
    await refreshCooperation(activeOperatorId);
  }, "Weltvertrag bestätigt. Der öffentliche Betrieb ist geöffnet.", "initial");
}

function cooperationAction(action: () => Promise<void>, success: string): Promise<void> {
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
    confirmationDetail({ parties: `${operatorDisplayName(activeOperatorId)} an ${offeree}`, object: `Kooperationsvertrag ${contractType}`, amount: formatCents(preview.priceCents), deadline: `Antwort bis ${simulationDeadline(preview.responseDeadlineS)}, Vertrag bis ${simulationDeadline(preview.validUntilS)}`, consequence: "Das Angebot wird verbindlich und im Postfach des empfangenden EVU zugestellt; alle Fristen werden serverseitig erneut geprüft." }),
    () => cooperationAction(async () => {
      const client = api;
      if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
      if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
      if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
      if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
  return requestConfirmation("Fahrzeug reservieren?", confirmationDetail({ parties: `${operatorDisplayName(listing?.offeringOperatorId ?? "")} und ${operatorDisplayName(activeOperatorId)}`, object: String(listing?.disclosure["classDesignation"] ?? "Fahrzeug"), amount: listing === undefined ? "unbekannt" : formatCents(listing.priceCents), deadline: listing === undefined ? "zehn Simulationsminuten" : `Reservierung zehn Simulationsminuten, Angebot bis ${simulationDeadline(listing.expiresAtS)}`, consequence: "Das Angebot wird für andere EVU vorübergehend blockiert; Insolvenz- und Kaufsperren werden serverseitig geprüft." }), () => cooperationAction(async () => {
    const client = api;
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
    if (client === undefined || activeOperatorId === "") throw new Error("Handelndes EVU fehlt.");
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
  }, "Der unveränderliche Fahrzeuglebenslauf wurde geladen.");
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
  return journeyAction(async () => setTutorialSession(await client.tutorialAction(session.tutorialWorldId, action)), "Entscheidung bestätigt. Das nächste Kapitel ist bereit.");
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
        ? "Angemeldete Sitzung fehlt. Produktivdaten werden nicht durch Beispieldaten ersetzt."
        : "Die öffentliche Weltkennung fehlt in der Laufzeitkonfiguration.";
      messageTone = "error";
      bootRecovery = api === undefined ? "authenticate" : "configure";
      render();
      app.querySelector<HTMLElement>(".journey-message--error")?.focus();
      return;
    }
    journeyBusyScopes.add("initial");
    render();
    try {
      publicWorldContracts = await api.loadPublicWorldContracts();
      const requestedTutorialWorld = tutorialReference === null ? undefined : worldId;
      const tutorial = await (requestedTutorialWorld === undefined ? api.loadActiveTutorial(publicWorldId) : api.loadTutorial(requestedTutorialWorld));
      if (tutorial !== undefined) {
        setTutorialSession(tutorial);
      } else {
        try {
          await refreshCooperation();
        } catch (error) {
          const failure = classifyJourneyFailure(error, "Kooperation und Fahrzeugmarkt konnten nicht geladen werden.");
          message = failure.message;
          messageTone = "error";
          bootRecovery = failure.recovery;
        }
      }
    } catch (error) {
      const failure = classifyJourneyFailure(error, "Spielerreise konnte nicht geladen werden.");
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
