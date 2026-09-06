export interface LivemapNavigationDestinations {
  readonly live: string;
  readonly journey: string;
  readonly markets: string;
  readonly planner: string;
  readonly operations: string;
  readonly mailbox: string;
}

export interface MailboxDecisionReference {
  readonly worldId: string;
  readonly messageType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const OIDC_CALLBACK_PARAMETERS = ["code", "state", "session_state", "iss", "error", "error_description"] as const;

/** Only recognized map state crosses applications; tokens and arbitrary return URLs never do. */
export function demandPlanningDestination(gameWebUrl: string, pageUrl: string, worldId: string, trainId?: string, stationId?: string): string {
  const destination = new URL(gameDestination(gameWebUrl, pageUrl, worldId, "diagram"));
  const source = new URL(pageUrl);
  destination.searchParams.set("view", "spfv");
  for (const key of ["operator", "focus", "trainScope", "trainQuery", "demand"] as const) {
    const value = source.searchParams.get(key);
    if (value !== null) destination.searchParams.set(key, value);
  }
  if (trainId !== undefined) destination.searchParams.set("train", trainId);
  if (stationId !== undefined) destination.searchParams.set("station", stationId);
  return destination.href;
}

function withoutOidcCallback(url: URL): URL {
  for (const parameter of OIDC_CALLBACK_PARAMETERS) url.searchParams.delete(parameter);
  return url;
}

function gameDestination(
  gameWebUrl: string,
  pageUrl: string,
  worldId: string,
  view: "journey" | "diagram",
  hash = "",
  context: Readonly<Record<string, string>> = {},
): string {
  const destination = withoutOidcCallback(new URL(gameWebUrl.trim() === "" ? "/" : gameWebUrl, pageUrl));
  destination.searchParams.set("view", view);
  if (worldId !== "") destination.searchParams.set("world", worldId);
  for (const [key, value] of Object.entries(context)) destination.searchParams.set(key, value);
  destination.hash = hash;
  return destination.href;
}

/** Alle Hauptziele tragen denselben expliziten Weltkontext; kein Runtime-Default darf ihn ersetzen. */
export function livemapNavigationDestinations(
  gameWebUrl: string,
  pageUrl: string,
  worldId: string,
  operationsCenterUrl = "",
): LivemapNavigationDestinations {
  const live = withoutOidcCallback(new URL(pageUrl));
  live.searchParams.delete("focus");
  if (worldId !== "") live.searchParams.set("world", worldId);
  const operatorId = live.searchParams.get("operator") ?? "";
  const operatorContext: Readonly<Record<string, string>> = operatorId === "" ? {} : { operator: operatorId };
  return Object.freeze({
    live: live.href,
    journey: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "", { ...operatorContext, section: "world" }),
    markets: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "", { ...operatorContext, section: "markets" }),
    planner: gameDestination(gameWebUrl, pageUrl, worldId, "diagram", "", operatorContext),
    operations: operationsCenterDestination(operationsCenterUrl, gameWebUrl, pageUrl, worldId, operatorId),
    mailbox: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "", { ...operatorContext, section: "mailbox" }),
  });
}

/** Die eigenständige M7-Betriebszentrale gewinnt; ohne EVU-Kontext bleibt der sichere interne Arbeitsraum. */
export function operationsCenterDestination(
  operationsCenterUrl: string,
  gameWebUrl: string,
  pageUrl: string,
  worldId: string,
  operatorId: string,
): string {
  if (operationsCenterUrl.trim() === "" || operatorId === "") {
    const context: Readonly<Record<string, string>> = operatorId === "" ? { section: "operations" } : { operator: operatorId, section: "operations" };
    return gameDestination(gameWebUrl, pageUrl, worldId, "journey", "", context);
  }
  const destination = withoutOidcCallback(new URL(operationsCenterUrl, pageUrl));
  destination.searchParams.set("world", worldId);
  destination.searchParams.set("operator", operatorId);
  destination.searchParams.set("panel", "operations");
  destination.hash = "";
  return destination.href;
}

function payloadIdentifier(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" && value.length <= 128 ? value : undefined;
}

const ARCHIVED_CONTRACT_MESSAGES = new Set([
  "cooperation.contract-rejected",
  "cooperation.contract-terminated",
  "cooperation.contract-non-performance",
  "cooperation.contract-completed",
  "cooperation.contract-expired",
]);
const ARCHIVED_LISTING_MESSAGES = new Set([
  "vehicle-market.transferred",
  "vehicle-market.reversed",
]);

/** Deep-Link from the Live-Lage into the decision surface, always in the same world. */
export function mailboxDecisionDestination(
  gameWebUrl: string,
  pageUrl: string,
  worldId: string,
  message: MailboxDecisionReference,
): string {
  if (message.worldId !== worldId) throw new RangeError("Postfachziel gehört nicht zur gewählten Welt.");
  const activeOperatorId = withoutOidcCallback(new URL(pageUrl)).searchParams.get("operator") ?? "";
  const operatorContext: Readonly<Record<string, string>> = activeOperatorId === "" ? {} : { operator: activeOperatorId };
  const contractId = payloadIdentifier(message.payload, "contractId");
  const listingId = payloadIdentifier(message.payload, "listingId");
  const trainId = payloadIdentifier(message.payload, "trainId");
  if (message.messageType.includes("path") || message.messageType.includes("planning")) {
    const destination = withoutOidcCallback(new URL(gameWebUrl.trim() === "" ? "/" : gameWebUrl, pageUrl));
    destination.searchParams.set("view", "diagram");
    destination.searchParams.set("world", worldId);
    if (activeOperatorId !== "") destination.searchParams.set("operator", activeOperatorId);
    if (trainId !== undefined) destination.searchParams.set("train", trainId);
    destination.hash = "diagram-card";
    return destination.href;
  }
  if (message.messageType.includes("contract") || message.messageType.includes("cooperation")) {
    return gameDestination(
      gameWebUrl,
      pageUrl,
      worldId,
      "journey",
      contractId === undefined ? "cooperation-contracts" : `contract-${encodeURIComponent(contractId)}`,
      { ...operatorContext, section: "markets", contractView: ARCHIVED_CONTRACT_MESSAGES.has(message.messageType) ? "archive" : "actionable" },
    );
  }
  if (message.messageType.includes("vehicle") || message.messageType.includes("market")) {
    return gameDestination(
      gameWebUrl,
      pageUrl,
      worldId,
      "journey",
      listingId === undefined ? "vehicle-market" : `listing-${encodeURIComponent(listingId)}`,
      { ...operatorContext, section: "markets", listingView: ARCHIVED_LISTING_MESSAGES.has(message.messageType) ? "archive" : "actionable" },
    );
  }
  return gameDestination(gameWebUrl, pageUrl, worldId, "journey", "", { ...operatorContext, section: "mailbox" });
}
