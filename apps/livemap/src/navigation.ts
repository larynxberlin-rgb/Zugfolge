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

function gameDestination(
  gameWebUrl: string,
  pageUrl: string,
  worldId: string,
  view: "journey" | "diagram",
  hash = "",
  context: Readonly<Record<string, string>> = {},
): string {
  const destination = new URL(gameWebUrl.trim() === "" ? "/" : gameWebUrl, pageUrl);
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
): LivemapNavigationDestinations {
  const live = new URL(pageUrl);
  live.searchParams.delete("focus");
  if (worldId !== "") live.searchParams.set("world", worldId);
  return Object.freeze({
    live: live.href,
    journey: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "world-contract-title"),
    markets: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "vehicle-market"),
    planner: gameDestination(gameWebUrl, pageUrl, worldId, "diagram"),
    operations: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "betrieb"),
    mailbox: gameDestination(gameWebUrl, pageUrl, worldId, "journey", "postfach"),
  });
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
  const contractId = payloadIdentifier(message.payload, "contractId");
  const listingId = payloadIdentifier(message.payload, "listingId");
  const trainId = payloadIdentifier(message.payload, "trainId");
  if (message.messageType.includes("path") || message.messageType.includes("planning")) {
    const destination = new URL(gameWebUrl.trim() === "" ? "/" : gameWebUrl, pageUrl);
    destination.searchParams.set("view", "diagram");
    destination.searchParams.set("world", worldId);
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
      { contractView: ARCHIVED_CONTRACT_MESSAGES.has(message.messageType) ? "archive" : "actionable" },
    );
  }
  if (message.messageType.includes("vehicle") || message.messageType.includes("market")) {
    return gameDestination(
      gameWebUrl,
      pageUrl,
      worldId,
      "journey",
      listingId === undefined ? "vehicle-market" : `listing-${encodeURIComponent(listingId)}`,
      { listingView: ARCHIVED_LISTING_MESSAGES.has(message.messageType) ? "archive" : "actionable" },
    );
  }
  return gameDestination(gameWebUrl, pageUrl, worldId, "journey", "postfach");
}
