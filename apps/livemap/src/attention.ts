export const ATTENTION_ITEM_LIMIT = 8;

export type MailboxPriority = "overdue" | "due-soon" | "action-required" | "information" | "acknowledged";

export interface MailboxAttentionMessage {
  readonly id: string;
  readonly worldId: string;
  readonly messageType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sentAt: string;
  readonly deadlineAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly priority: MailboxPriority;
  readonly overdue: boolean;
}

const PRIORITY_RANK: Readonly<Record<MailboxPriority, number>> = Object.freeze({
  overdue: 0,
  "due-soon": 1,
  "action-required": 2,
  information: 3,
  acknowledged: 4,
});

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} ist kein Objekt.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new TypeError(`${name} ist kein gültiger Textwert.`);
  }
  return value;
}

function nullableInstant(value: unknown, name: string): string | null {
  if (value === null) return null;
  const instant = nonEmptyString(value, name);
  if (!Number.isFinite(Date.parse(instant))) throw new TypeError(`${name} ist kein gültiger Zeitpunkt.`);
  return instant;
}

function priority(value: unknown, name: string): MailboxPriority {
  if (value === "overdue" || value === "due-soon" || value === "action-required" || value === "information" || value === "acknowledged") {
    return value;
  }
  throw new TypeError(`${name} ist keine bekannte Priorität.`);
}

function compareServerOrder(left: MailboxAttentionMessage, right: MailboxAttentionMessage): number {
  const priorityDifference = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (priorityDifference !== 0) return priorityDifference;
  const deadlineDifference = (left.deadlineAt === null ? Number.MAX_SAFE_INTEGER : Date.parse(left.deadlineAt))
    - (right.deadlineAt === null ? Number.MAX_SAFE_INTEGER : Date.parse(right.deadlineAt));
  if (deadlineDifference !== 0) return deadlineDifference;
  const sentDifference = Date.parse(right.sentAt) - Date.parse(left.sentAt);
  return sentDifference !== 0 ? sentDifference : left.id.localeCompare(right.id);
}

/**
 * Fail-closed decoder for the authenticated mailbox projection. The server is
 * authoritative for recipient selection, priority and ordering; the Livemap
 * accepts only that complete, world-bound projection and never repairs it.
 */
export function decodeAttentionMessages(value: unknown, expectedWorldId: string): readonly MailboxAttentionMessage[] {
  if (!Array.isArray(value)) throw new TypeError("Postfachprojektion ist keine Liste.");
  const seen = new Set<string>();
  const messages = value.map((entry, index): MailboxAttentionMessage => {
    const name = `Postfachprojektion[${index}]`;
    const item = record(entry, name);
    const id = nonEmptyString(item["id"], `${name}.id`);
    const worldId = nonEmptyString(item["worldId"], `${name}.worldId`);
    if (worldId !== expectedWorldId) throw new TypeError(`${name} gehört nicht zur gewählten Welt.`);
    if (seen.has(id)) throw new TypeError(`${name}.id ist nicht eindeutig.`);
    seen.add(id);

    const payload = record(item["payload"], `${name}.payload`);
    const payloadWorldId = payload["worldId"];
    if (typeof payloadWorldId === "string" && payloadWorldId !== expectedWorldId) {
      throw new TypeError(`${name}.payload.worldId gehört nicht zur gewählten Welt.`);
    }
    const sentAt = nullableInstant(item["sentAt"], `${name}.sentAt`);
    if (sentAt === null) throw new TypeError(`${name}.sentAt fehlt.`);
    const deadlineAt = nullableInstant(item["deadlineAt"], `${name}.deadlineAt`);
    const acknowledgedAt = nullableInstant(item["acknowledgedAt"], `${name}.acknowledgedAt`);
    const messagePriority = priority(item["priority"], `${name}.priority`);
    if (typeof item["overdue"] !== "boolean") throw new TypeError(`${name}.overdue ist kein Wahrheitswert.`);
    const overdue = item["overdue"];
    if ((messagePriority === "overdue") !== overdue || (acknowledgedAt !== null) !== (messagePriority === "acknowledged")) {
      throw new TypeError(`${name} enthält widersprüchliche Prioritätsangaben.`);
    }

    return Object.freeze({
      id,
      worldId,
      messageType: nonEmptyString(item["messageType"], `${name}.messageType`),
      payload,
      sentAt,
      deadlineAt,
      acknowledgedAt,
      priority: messagePriority,
      overdue,
    });
  });
  for (let index = 1; index < messages.length; index += 1) {
    if (compareServerOrder(messages[index - 1]!, messages[index]!) > 0) {
      throw new TypeError("Postfachprojektion ist nicht serverseitig priorisiert.");
    }
  }
  return Object.freeze(messages);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function title(message: MailboxAttentionMessage): string {
  const payloadTitle = message.payload["title"] ?? message.payload["summary"] ?? message.payload["reason"];
  if (typeof payloadTitle === "string" && payloadTitle.trim() !== "") return payloadTitle.trim();
  const labels: Readonly<Record<string, string>> = {
    "cooperation.contract-offer": "Neues Kooperationsangebot",
    "cooperation.contract-offered": "Neues Kooperationsangebot",
    "cooperation.contract-accepted": "Kooperationsangebot angenommen",
    "cooperation.contract-rejected": "Kooperationsangebot abgelehnt",
    "cooperation.contract-termination-scheduled": "Kündigung vorgemerkt",
    "cooperation.contract-terminated": "Kooperationsvertrag beendet",
    "cooperation.contract-non-performance": "Nichterfüllung gemeldet",
    "cooperation.contract-completed": "Kooperationsvertrag erfüllt",
    "cooperation.contract-expired": "Kooperationsangebot abgelaufen",
    "vehicle-market.reserved": "Fahrzeugangebot reserviert",
    "vehicle-market.transferred": "Fahrzeug übergeben",
    "vehicle-market.reversed": "Fahrzeugübertragung rückabgewickelt",
  };
  return labels[message.messageType] ?? message.messageType.replaceAll(/[._-]+/g, " ");
}

function stateWord(message: MailboxAttentionMessage): string {
  if (message.priority === "overdue") return "Überfällig";
  if (message.priority === "due-soon") return "Bald fällig";
  if (message.priority === "acknowledged") return "Gelesen";
  if (message.priority === "information") return "Information";
  return "Handlungsbedarf";
}

function instantLabel(value: string): string {
  return new Date(value).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

function timing(message: MailboxAttentionMessage): string {
  if (message.acknowledgedAt !== null) return `Gelesen am ${instantLabel(message.acknowledgedAt)}`;
  if (message.deadlineAt === null) return "Ohne Frist";
  return message.overdue
    ? `Überfällig seit ${instantLabel(message.deadlineAt)}`
    : `Frist ${instantLabel(message.deadlineAt)}`;
}

export type AttentionDestination = (message: MailboxAttentionMessage) => string;

/** Bounded, semantic markup; input ordering is deliberately preserved. */
export function attentionRailMarkup(
  messages: readonly MailboxAttentionMessage[],
  destination: AttentionDestination,
): string {
  const shown = messages.slice(0, ATTENTION_ITEM_LIMIT);
  const open = messages.filter((message) => message.acknowledgedAt === null).length;
  const summary = messages.length > shown.length
    ? `${open} offen · ${shown.length} von ${messages.length} sichtbar`
    : `${open} offen`;
  const items = shown.map((message) => {
    const messageTitle = title(message);
    const state = stateWord(message);
    return `<li class="attention-card${message.acknowledgedAt === null ? " is-open" : " is-acknowledged"}" data-priority="${message.priority}"><span class="attention-state">${state}</span><strong>${escapeHtml(messageTitle)}</strong><small>${escapeHtml(timing(message))}</small><a href="${escapeHtml(destination(message))}">Öffnen<span class="sr-only">: ${escapeHtml(messageTitle)}</span></a></li>`;
  }).join("");
  const content = items === ""
    ? '<p class="attention-empty">Alles erledigt. Neue Aufgaben erscheinen hier.</p>'
    : `<div class="attention-scroll" role="region" aria-label="Priorisierte Nachrichten" tabindex="0"><ol>${items}</ol></div>`;
  return `<div class="attention-heading"><div><p class="eyebrow">DEIN POSTFACH</p><h2 id="attention-title">Das steht an</h2></div><span class="attention-summary">${summary}</span></div>${content}`;
}

export function renderAttentionRail(
  container: HTMLElement,
  messages: readonly MailboxAttentionMessage[],
  destination: AttentionDestination,
): void {
  container.innerHTML = attentionRailMarkup(messages, destination);
  container.hidden = false;
}

export function renderAttentionUnavailable(container: HTMLElement): void {
  container.innerHTML = '<div class="attention-heading"><div><p class="eyebrow">DEIN POSTFACH</p><h2 id="attention-title">Das steht an</h2></div></div><p class="attention-unavailable" role="status">Deine Nachrichten sind gerade nicht erreichbar.</p>';
  container.hidden = false;
}
