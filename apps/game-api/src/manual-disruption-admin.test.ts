import { describe, expect, it, vi } from "vitest";

import {
  MANUAL_DISRUPTION_ADMIN_CAPABILITY,
  createManualDisruptionAdminHandler,
  type ManualDisruptionAdminContext,
} from "./manual-disruption-admin.js";

const worldId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-08-11T12:00:00.000Z");

function context(): ManualDisruptionAdminContext {
  return {
    commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    eventId: "odoo-event-0001",
    correlationId: "correlation-0001",
    receivedAt: now,
    now,
    payload: {
      kind: "admin.manual_disruption_create",
      worldId,
      actionType: "manual_disruption_create",
      riskClass: "high",
      requesterReference: "requester-1",
      approverReference: "approver-2",
      reason: "Akute Weichenstoerung mit betrieblicher Wirkung",
      manualDisruption: {
        startsAt: "2026-08-11T11:55:00.000Z",
        endsAt: "2026-08-11T13:00:00.000Z",
        cause: "Weichenantrieb gestoert",
        affectedResourceIds: ["track:4"],
        declaredEffect: {
          schemaVersion: "zugfolge-manual-disruption-effect/v1",
          kind: "closure",
          causeCode: 26,
          fineCauseId: "switch.drive",
          targets: [{
            resourceId: "track:4",
            regionId: "leipzig",
          }],
        },
      },
    },
  };
}

describe("M8.3 Odoo-Administrationshandler", () => {
  it("meldet die Capability erst mit vorhandenem fachlichen Handler als verfuegbar", () => {
    expect(MANUAL_DISRUPTION_ADMIN_CAPABILITY).toMatchObject({
      actionType: "manual_disruption_create",
      availability: "available",
    });
  });

  it("prueft Vier-Augen-Daten und uebergibt Wirkung sowie beide Zeitgrenzen an den dauerhaften Scheduler", async () => {
    const schedule = vi.fn(async () => ({ state: "completed" as const, gameAuditEventId: "audit-1" }));
    const handler = createManualDisruptionAdminHandler({ schedule });
    await expect(handler(context())).resolves.toMatchObject({
      state: "completed",
      gameAuditEventId: "audit-1",
    });
    expect(schedule).toHaveBeenCalledWith({ context: context(), startsAt: new Date("2026-08-11T11:55:00.000Z"),
      endsAt: new Date("2026-08-11T13:00:00.000Z"), targets: [{ regionId: "leipzig", effect: { "resource-closed": { resourceId: "track:4" } } }] });
  });

  it("lehnt Selbstfreigabe, wirkungslose Nutzdaten und nicht aufgeloeste Ressourcen ab", async () => {
    const schedule = vi.fn(async () => ({ state: "completed" as const, gameAuditEventId: "audit-1" }));
    const handler = createManualDisruptionAdminHandler({ schedule });
    const selfApproved = context();
    await expect(handler({
      ...selfApproved,
      payload: { ...selfApproved.payload, approverReference: "requester-1" },
    })).rejects.toMatchObject({ code: "authorization" });

    const missingEffect = context();
    await expect(handler({
      ...missingEffect,
      payload: {
        ...missingEffect.payload,
        manualDisruption: {
          ...missingEffect.payload.manualDisruption!,
          declaredEffect: { kind: "radio-unavailable" },
        },
      },
    })).rejects.toMatchObject({ code: "effect" });

    const wrongResource = context();
    await expect(handler({
      ...wrongResource,
      payload: {
        ...wrongResource.payload,
        manualDisruption: {
          ...wrongResource.payload.manualDisruption!,
          affectedResourceIds: ["track:999"],
        },
      },
    })).rejects.toMatchObject({ code: "resources" });

    const inventedSpeed = context();
    await expect(handler({
      ...inventedSpeed,
      payload: {
        ...inventedSpeed.payload,
        manualDisruption: {
          ...inventedSpeed.payload.manualDisruption!,
          declaredEffect: {
            ...inventedSpeed.payload.manualDisruption!.declaredEffect,
            kind: "speed-restriction",
          },
        },
      },
    })).rejects.toMatchObject({ code: "effect" });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("plant zukuenftige Eingriffe und deutet weder Scopes noch andere Wirkungen um", async () => {
    const schedule = vi.fn(async () => ({ state: "completed" as const, gameAuditEventId: "audit-1" }));
    const handler = createManualDisruptionAdminHandler({ schedule });
    const original = context();
    await handler({ ...original, payload: { ...original.payload, manualDisruption: { ...original.payload.manualDisruption!, startsAt: "2026-08-11T12:05:00.000Z" } } });
    expect(schedule).toHaveBeenCalledOnce();
    schedule.mockClear();
    for (const declaredEffect of [
      { ...original.payload.manualDisruption!.declaredEffect, kind: "traffic-hold" },
      { ...original.payload.manualDisruption!.declaredEffect, kind: "single-track" },
      { ...original.payload.manualDisruption!.declaredEffect, kind: "route-deviation" },
      { ...original.payload.manualDisruption!.declaredEffect, scope: { direction: "regular-direction" } },
      { ...original.payload.manualDisruption!.declaredEffect, targets: [{ resourceId: "track:4", regionId: "leipzig", trainIds: ["train-1"] }] },
    ]) await expect(handler({ ...original, payload: { ...original.payload, manualDisruption: { ...original.payload.manualDisruption!, declaredEffect } } })).rejects.toThrow();
    expect(schedule).not.toHaveBeenCalled();
  });
});
