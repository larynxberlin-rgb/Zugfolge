import {
  alphaFeedback,
  alphaWorldProfiles,
  dailyOperationReports,
  disruptionProviderStates,
  domainEvents,
  economyOutbox,
  odooCommandQueue,
  odooProjectionOutbox,
  odooReconciliationTasks,
  operatorContracts,
  regionalSimulationStates,
  simulationCommands,
  vehicleMarketListings,
  vehicleMarketTransfers,
  worlds,
} from "@zugfolge/db";
import { loadEconomyWorldState } from "@zugfolge/economy";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import type { AlphaDatabase } from "./world.js";
import { regionalMonitoringSummary } from "./monitoring-regional.js";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function dateAgeSeconds(date: Date | undefined, now: Date): number | null { return date === undefined ? null : Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1_000)); }
function counts<T extends string>(values: readonly T[]): Readonly<Record<T, number>> {
  const result = {} as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

/** Ausschliesslich lesende, zeitgestempelte Odoo-Monitoringprojektion. */
export class AlphaMonitoringService {
  constructor(private readonly db: AlphaDatabase) {}

  async snapshot(worldId: string, now = new Date()) {
    const [worldRows, profileRows, regions, events, pendingSimulation, pendingEconomy, projectionRows, commandRows, reconciliations, providerRows, listings, transfers, contracts, feedback, reports] = await Promise.all([
      this.db.select().from(worlds).where(eq(worlds.id, worldId)).limit(1),
      this.db.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, worldId)).limit(1),
      this.db.select().from(regionalSimulationStates).where(eq(regionalSimulationStates.worldId, worldId)).orderBy(asc(regionalSimulationStates.regionId)),
      this.db.select().from(domainEvents).where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(2_000),
      this.db.select().from(simulationCommands).where(and(eq(simulationCommands.worldId, worldId), eq(simulationCommands.status, "pending"))),
      this.db.select().from(economyOutbox).where(and(eq(economyOutbox.worldId, worldId), isNull(economyOutbox.processedAt))),
      this.db.select().from(odooProjectionOutbox).where(eq(odooProjectionOutbox.worldId, worldId)),
      this.db.select().from(odooCommandQueue).where(eq(odooCommandQueue.worldId, worldId)),
      this.db.select().from(odooReconciliationTasks).where(eq(odooReconciliationTasks.worldId, worldId)),
      this.db.select().from(disruptionProviderStates).where(eq(disruptionProviderStates.worldId, worldId)),
      this.db.select().from(vehicleMarketListings).where(eq(vehicleMarketListings.worldId, worldId)),
      this.db.select().from(vehicleMarketTransfers).where(eq(vehicleMarketTransfers.worldId, worldId)),
      this.db.select().from(operatorContracts).where(eq(operatorContracts.worldId, worldId)),
      this.db.select().from(alphaFeedback).where(eq(alphaFeedback.worldId, worldId)),
      this.db.select().from(dailyOperationReports).where(eq(dailyOperationReports.worldId, worldId)).orderBy(desc(dailyOperationReports.generatedAt)).limit(31),
    ]);
    const world = worldRows[0];
    const profile = profileRows[0];
    if (world === undefined || profile === undefined) throw new Error("Alpha-Monitoring findet Welt oder Release-Pins nicht.");
    const economy = await loadEconomyWorldState(this.db as never, worldId);
    const regional = regionalMonitoringSummary(regions.map((row) => row.state));
    const eventKinds = counts(events.map((event) => event.eventType));
    const latestEvent = events[0];
    const pendingProjections = projectionRows.filter((row) => row.deliveredAt === null);
    const failedProjections = projectionRows.filter((row) => row.lastErrorCode !== null);
    const lastProjection = projectionRows.filter((row) => row.deliveredAt !== null).sort((a, b) => b.deliveredAt!.getTime() - a.deliveredAt!.getTime())[0];
    const publicLotCount = economy?.publicOperations.size ?? 0;
    const playerLotCount = economy?.contracts.size ?? 0;
    const liveEventCount = events.filter((event) => now.getTime() - event.occurredAt.getTime() <= 60_000).length;
    return {
      schemaVersion: "zugfolge-alpha-monitoring/v1",
      projectionClass: "delayed-read-only" as const,
      projectedAt: now.toISOString(),
      world: {
        worldId, name: world.name, status: profile.state, lifecycleStatus: world.lifecycleStatus,
        simulationTimeS: regional.simulationTimeS,
        authoritativeTimeAvailable: regional.authoritativeTimeAvailable,
        schedulePeriodWeeks: world.schedulePeriodWeeks, currentPeriod: profile.currentPeriod, periodCount: profile.periodCount,
        releases: { infra: profile.infraReleaseHash, timetable: profile.timetableReleaseHash, fleet: profile.fleetReleaseHash, economy: profile.economyReleaseHash },
      },
      live: {
        projectionClass: "live-state" as const,
        runningTrains: regional.runningTrains,
        delayedTrains: regional.delayedTrains,
        cancelledTrains: regional.cancelledTrains,
        disruptions: regional.disruptions,
        replacementConcepts: eventKinds["dispatch.major-event"] ?? 0,
        eventRatePerMinute: liveEventCount,
      },
      operationShares: { publicLots: publicLotCount, playerLots: playerLotCount, totalLots: publicLotCount + playerLotCount },
      workers: {
        regionalWriters: regions.map((row) => ({ regionId: row.regionId, revision: row.revision, publisherSequence: row.publisherSequence })),
        planningQueueDepth: pendingSimulation.length,
        economyOutboxDepth: pendingEconomy.length,
        odooCommandQueue: counts(commandRows.map((row) => row.status)),
      },
      bridges: {
        odooProjection: { pending: pendingProjections.length, failed: failedProjections.length, lastSuccessfulAt: lastProjection?.deliveredAt?.toISOString() ?? null },
        provider: providerRows.map((row) => ({ providerId: row.providerSetId, status: row.enabled === "enabled" && row.rightsStatus === "approved" ? "healthy" : "degraded", lastSuccessfulAtS: row.lastSafeAtS, failureCode: row.lastFailure })),
        reconciliation: counts(reconciliations.map((row) => row.status)),
      },
      economy: {
        conflicts: Object.entries(eventKinds).filter(([type]) => type.includes("conflict")).reduce((sum, [, count]) => sum + count, 0),
        capacityBottlenecks: Object.entries(eventKinds).filter(([type]) => type.includes("capacity")).reduce((sum, [, count]) => sum + count, 0),
        penaltiesAndDeductions: Object.entries(eventKinds).filter(([type]) => type.includes("penalty") || type.includes("deduction")).reduce((sum, [, count]) => sum + count, 0),
        anomalies: Object.entries(eventKinds).filter(([type]) => type.includes("anomaly") || type.includes("insolvency")).reduce((sum, [, count]) => sum + count, 0),
      },
      market: {
        projectionClass: "derived-metric" as const,
        listings: counts(listings.map((row) => row.status)),
        transfers: counts(transfers.map((row) => row.transferType)),
        contracts: counts(contracts.map((row) => `${row.contractType}:${row.status}`)),
      },
      history: {
        projectionClass: "historical-report" as const,
        dailyReports: reports.map((row) => ({ id: row.id, serviceDay: row.serviceDay, reportHash: record(row.projection)["reportHash"] ?? null })),
        feedback: counts(feedback.map((row) => row.status)),
      },
      freshness: {
        regionAgeSeconds: regions.length === 0 ? null : Math.max(...regions.map((row) => dateAgeSeconds(row.updatedAt, now) ?? 0)),
        eventAgeSeconds: dateAgeSeconds(latestEvent?.occurredAt, now),
        projectionAgeSeconds: dateAgeSeconds(lastProjection?.deliveredAt ?? undefined, now),
        providerAgeSeconds: providerRows.length === 0 ? null : Math.max(...providerRows.map((row) => dateAgeSeconds(row.checkedAt, now) ?? Number.MAX_SAFE_INTEGER)),
      },
      drillDown: {
        latestAuthoritativeEvents: events.slice(0, 100).map((event) => ({ id: event.id, sequence: event.sequence, type: event.eventType, occurredAt: event.occurredAt.toISOString() })),
        reportIds: reports.map((report) => report.id),
        auditReferences: commandRows.map((row) => ({ commandId: row.id, correlationId: row.correlationId, status: row.status })),
      },
    };
  }
}
