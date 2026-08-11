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
        startsAt: "2026-08-11T12:05:00.000Z",
        endsAt: "2026-08-11T13:00:00.000Z",
        cause: "Weichenantrieb gestoert",
        affectedResourceIds: ["track:4"],
        declaredEffect: {
          schemaVersion: "zugfolge-manual-disruption-effect/v1",
          kind: "traffic-hold",
          causeCode: 26,
          fineCauseId: "switch.drive",
          delaySeconds: 600,
          targets: [{
            resourceId: "track:4",
            regionId: "leipzig",
            positionMm: 1_200_000,
            affectedTrainRunIds: ["run-1"],
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

  it("prueft Vier-Augen-Daten und uebergibt die Wirkung an den Single Writer", async () => {
    const apply = vi.fn(async () => undefined);
    const handler = createManualDisruptionAdminHandler({
      worker: { apply },
      worldEpoch: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    await expect(handler(context())).resolves.toMatchObject({
      state: "completed",
      gameAuditEventId: expect.stringContaining(worldId),
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        worldId,
        regionId: "leipzig",
        commandId: "odoo-manual-disruption:odoo-event-0001:0",
        command: {
          type: "register-disruption",
          disruption: expect.objectContaining({
            kind: "planned",
            causeCode: 26,
            fineCauseId: "switch.drive",
            effect: "traffic-hold",
            affectedResource: "track:4",
            affectedTrainRunIds: ["run-1"],
            delaySeconds: 600,
          }),
        },
      }),
      now,
    );
  });

  it("lehnt Selbstfreigabe, wirkungslose Nutzdaten und nicht aufgeloeste Ressourcen ab", async () => {
    const handler = createManualDisruptionAdminHandler({
      worker: { apply: vi.fn(async () => undefined) },
      worldEpoch: () => new Date("2026-01-01T00:00:00.000Z"),
    });
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
  });
});
