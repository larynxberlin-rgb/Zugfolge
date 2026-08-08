import { describe, expect, it } from "vitest";

import { retentionDeadline, retentionPolicy, RETENTION_POLICIES, UnknownRetentionCategoryError } from "./retention.js";

describe("retentionPolicy", () => {
  it("kennt eine Frist für jede definierte Kategorie", () => {
    for (const policy of RETENTION_POLICIES) {
      expect(retentionPolicy(policy.category)).toBe(policy);
    }
  });

  it("meldet eine unbekannte Kategorie", () => {
    // @ts-expect-error absichtlich außerhalb des Typs, um die Laufzeitprüfung zu treffen
    expect(() => retentionPolicy("unbekannt")).toThrow(UnknownRetentionCategoryError);
  });
});

describe("retentionDeadline", () => {
  it("rechnet die Frist einer befristeten Kategorie ab dem Bezugsdatum", () => {
    const deadline = retentionDeadline("account", new Date("2026-01-01T00:00:00Z"));
    expect(deadline?.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("liefert keine Frist für eine unbefristete Kategorie", () => {
    expect(retentionDeadline("ledger", new Date("2026-01-01T00:00:00Z"))).toBeNull();
    expect(retentionDeadline("domainEvent", new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });
});
