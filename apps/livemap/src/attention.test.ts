import { describe, expect, it } from "vitest";

import {
  ATTENTION_ITEM_LIMIT,
  attentionRailMarkup,
  decodeAttentionMessages,
  type MailboxAttentionMessage,
} from "./attention.js";

const WORLD = "welt-a";

function message(overrides: Partial<MailboxAttentionMessage> = {}): MailboxAttentionMessage {
  return {
    id: "meldung-1",
    worldId: WORLD,
    messageType: "cooperation.contract-offer",
    payload: { contractId: "vertrag-1", title: "Traktion Halle–Erfurt" },
    sentAt: "2026-08-13T08:00:00.000Z",
    deadlineAt: "2026-08-13T09:00:00.000Z",
    acknowledgedAt: null,
    priority: "action-required",
    overdue: false,
    ...overrides,
  };
}

describe("Aufmerksamkeitsschiene der Live-Lage", () => {
  it("übernimmt die serverseitige Reihenfolge und bindet jede Nachricht an die gewählte Welt", () => {
    const decoded = decodeAttentionMessages([
      message({ id: "ueberfaellig", priority: "overdue", overdue: true, deadlineAt: "2026-08-13T07:00:00.000Z" }),
      message({ id: "entscheidung" }),
      message({ id: "quittiert", priority: "acknowledged", acknowledgedAt: "2026-08-13T08:30:00.000Z", deadlineAt: null }),
    ], WORLD);
    expect(decoded.map((entry) => entry.id)).toEqual(["ueberfaellig", "entscheidung", "quittiert"]);
    expect(() => decodeAttentionMessages([message({ worldId: "fremde-welt" })], WORLD)).toThrow(/gewählten Welt/);
    expect(() => decodeAttentionMessages([
      message({ id: "spaet", priority: "information", deadlineAt: null }),
      message({ id: "wichtig", priority: "overdue", overdue: true }),
    ], WORLD)).toThrow(/serverseitig priorisiert/);
  });

  it("verwirft unvollständige, widersprüchliche und doppelte Projektionen", () => {
    expect(() => decodeAttentionMessages([{ ...message(), priority: "dringend" }], WORLD)).toThrow(/Priorität/);
    expect(() => decodeAttentionMessages([{ ...message(), overdue: true }], WORLD)).toThrow(/widersprüchliche/);
    expect(() => decodeAttentionMessages([message(), message()], WORLD)).toThrow(/nicht eindeutig/);
    expect(() => decodeAttentionMessages([{ ...message(), payload: { worldId: "fremd" } }], WORLD)).toThrow(/payload.worldId/);
  });

  it("begrenzt den sichtbaren Umfang, nennt Zustand in Worten und entschärft Nutztext", () => {
    const messages = Array.from({ length: ATTENTION_ITEM_LIMIT + 3 }, (_, index) => message({
      id: `meldung-${index}`,
      payload: { title: index === 0 ? "<script>fremd</script>" : `Meldung ${index}` },
      sentAt: new Date(Date.parse("2026-08-13T08:00:00.000Z") - index * 1_000).toISOString(),
    }));
    messages[0] = message({
      id: "ueberfaellig",
      priority: "overdue",
      overdue: true,
      deadlineAt: "2026-08-13T07:00:00.000Z",
      payload: { title: "<script>fremd</script>" },
    });
    messages[1] = message({
      id: "quittiert",
      priority: "acknowledged",
      acknowledgedAt: "2026-08-13T08:30:00.000Z",
      deadlineAt: null,
    });

    const markup = attentionRailMarkup(messages, (entry) => `https://spiel.example/?world=${entry.worldId}#${entry.id}`);
    expect(markup.match(/class="attention-card/g)).toHaveLength(ATTENTION_ITEM_LIMIT);
    expect(markup).toContain("Überfällig");
    expect(markup).toContain("Quittiert");
    expect(markup).toContain(`${ATTENTION_ITEM_LIMIT} von ${messages.length} sichtbar`);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;fremd&lt;/script&gt;");
    expect(markup).toContain('role="region"');
    expect(markup).toContain('tabindex="0"');
  });

  it("benennt jeden vom Kooperationsdienst erzeugten Mailtyp verstaendlich", () => {
    const labels = new Map([
      ["cooperation.contract-offer", "Neues Kooperationsangebot"],
      ["cooperation.contract-accepted", "Kooperationsangebot angenommen"],
      ["cooperation.contract-rejected", "Kooperationsangebot abgelehnt"],
      ["cooperation.contract-terminated", "Kooperationsvertrag beendet"],
      ["cooperation.contract-non-performance", "Nichterfüllung gemeldet"],
      ["vehicle-market.transferred", "Fahrzeug übergeben"],
      ["vehicle-market.reversed", "Fahrzeugübertragung rückabgewickelt"],
    ]);
    for (const [messageType, label] of labels) {
      const markup = attentionRailMarkup([
        message({ messageType, payload: messageType.startsWith("vehicle") ? { listingId: "angebot-1" } : { contractId: "vertrag-1" } }),
      ], () => "/ziel");
      expect(markup, messageType).toContain(`<strong>${label}</strong>`);
    }
  });
});
