import {
  createPlanningAlternativeCommand,
  parsePlanningAlternativeCommand,
  parsePlanningProjectionEnvelope,
  type PlanningAlternativeCommandV1,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

export interface AlternativeApplicationOptions {
  readonly queueAttempts?: number;
  readonly queueRetryDelayMs?: number;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export type WaitImplementation = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface TutorialJourney {
  readonly chapter: number;
  readonly chapterState: "ready" | "in-progress" | "blocked" | "completed";
  readonly evidence: Readonly<Record<string, { readonly completed: boolean; readonly references: readonly string[] }>>;
  readonly explanation: string;
  readonly explanationCode: string;
  readonly resetCount: number;
  readonly chapters: readonly { readonly chapter: number; readonly code: string; readonly title: string; readonly goal: string }[];
}

export interface StartPackageGrant {
  readonly grant: {
    readonly id: string;
    readonly operatorId: string;
    readonly emergencyLotId: string;
    readonly vehicleId: string;
    readonly pathReceiptId: string;
    readonly personnelPoolId: string;
    readonly operatingProgramId: string;
    readonly expiresAtS: string | number;
  };
  readonly idempotentReplay: boolean;
}

export interface CapacityHeatmapCell {
  readonly resourceId: string;
  readonly intervalStartS: number;
  readonly intervalEndS: number;
  readonly usedSeconds: number;
  readonly capacitySeconds: number;
  readonly qualityClass: "A" | "B" | "C";
  readonly orderable: boolean;
  readonly utilizationBasisPoints: number;
  readonly stateLabel: string;
  readonly pattern: "diagonal-hatch" | "dense-dots" | "none";
}

export interface OnboardingAssistant {
  readonly ready: boolean;
  readonly facts: Readonly<Record<string, boolean>>;
  readonly warnings: readonly { readonly code: string; readonly severity: "info" | "warning" | "blocking"; readonly message: string }[];
}

export type ContractType = "traction" | "vehicle-rental" | "connection" | "disruption-assistance";
export type ContractStatus = "offered" | "accepted" | "rejected" | "active" | "terminated" | "non-performance" | "completed" | "expired";

export interface OperatorSummary {
  readonly id: string;
  readonly worldId: string;
  readonly name: string;
  readonly foundingAccountId?: string;
}

export interface OperatorContractView {
  readonly id: string;
  readonly worldId: string;
  readonly offerorOperatorId: string;
  readonly offereeOperatorId: string;
  readonly contractType: ContractType;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly termsHash: string;
  readonly priceCents: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly responseDeadlineS: number;
  readonly terminationNoticeS: number;
  readonly status: ContractStatus;
  readonly offeredAtS: number;
  readonly revision: number;
  readonly endReason?: string | null;
}

export interface VehicleAssetView {
  readonly worldId: string;
  readonly vehicleId: string;
  readonly classDesignation: string;
  readonly ownerOperatorId: string;
  readonly holderOperatorId: string;
  readonly odometerMetres: string;
  readonly conditionBasisPoints: number;
  readonly damages: readonly Readonly<Record<string, unknown>>[];
  readonly maintenanceDeadlines: readonly Readonly<Record<string, unknown>>[];
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly valueCents: string;
  readonly revision: number;
  readonly historyHash: string;
}

export interface VehicleMarketListingView {
  readonly id: string;
  readonly worldId: string;
  readonly vehicleId: string;
  readonly offeringOperatorId: string;
  readonly listingType: "sale" | "rental";
  readonly priceCents: string;
  readonly rentalValidUntilS?: number | null;
  readonly disclosure: Readonly<Record<string, unknown>>;
  readonly disclosureHash: string;
  readonly listedAtS: number;
  readonly expiresAtS: number;
  readonly status: "open" | "reserved" | "transferred" | "cancelled" | "expired" | "reversed";
  readonly reservedByOperatorId?: string | null;
  readonly reservedUntilS?: number | null;
  readonly contractId?: string | null;
  readonly revision: number;
}

export interface VehicleHistoryEventView {
  readonly id: string;
  readonly worldId: string;
  readonly vehicleId: string;
  readonly eventType: "registered" | "condition-updated" | "sale" | "rental-start" | "rental-return" | "reversal";
  readonly atS: number;
  readonly priorHistoryHash: string | null;
  readonly resultingHistoryHash: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ContractOfferPayload {
  readonly offereeOperatorId: string;
  readonly contractType: ContractType;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly terms: Readonly<Record<string, unknown>>;
  readonly priceCents: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly responseDeadlineS: number;
  readonly terminationNoticeS: number;
  readonly offeredAtS: number;
  readonly idempotencyKey: string;
}

class GameApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "GameApiError";
  }
}

const wait: WaitImplementation = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Vorgang abgebrochen."));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Vorgang abgebrochen."));
      },
      { once: true },
    );
  });

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} muss eine positive ganze Zahl sein.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} muss eine nichtnegative ganze Zahl sein.`);
  }
  return resolved;
}

/** Authentifizierter Client fuer die serverautoritaere Planner-Projektion. */
export class GameApiClient {
  readonly #baseUrl: string;
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;
  readonly #wait: WaitImplementation;

  constructor(
    baseUrl: string,
    accessToken: string,
    fetchImplementation: typeof fetch = fetch,
    waitImplementation: WaitImplementation = wait,
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#accessToken = accessToken;
    this.#fetch = fetchImplementation;
    this.#wait = waitImplementation;
  }

  async #journeyJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = `Spielerreise nicht verfügbar (HTTP ${response.status}).`;
      try {
        const problem = await response.json() as { error?: unknown };
        if (typeof problem.error === "string") message = problem.error;
      } catch { /* HTTP-Status bleibt die erklaerbare Rueckmeldung. */ }
      throw new GameApiError(message, response.status >= 500);
    }
    try { return await response.json() as T; }
    catch { throw new GameApiError("Spielerreise lieferte kein gültiges JSON.", false); }
  }

  loadTutorial(worldId: string): Promise<TutorialJourney> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/tutorial`);
  }

  resetTutorial(worldId: string): Promise<TutorialJourney> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/tutorial/reset`, { method: "POST" });
  }

  claimStartPackage(worldId: string): Promise<StartPackageGrant> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/onboarding/start-package`, { method: "POST" });
  }

  async loadStartPackage(worldId: string): Promise<StartPackageGrant | undefined> {
    const response = await this.#fetch(`${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/onboarding/start-package`, {
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new GameApiError(`Startpaketstatus nicht verfügbar (HTTP ${response.status}).`, response.status >= 500);
    return response.json() as Promise<StartPackageGrant>;
  }

  loadCapacityHeatmap(worldId: string, fromS?: number, untilS?: number): Promise<readonly CapacityHeatmapCell[]> {
    const query = fromS === undefined || untilS === undefined ? "" : `?fromS=${fromS}&untilS=${untilS}`;
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/capacity-heatmap${query}`);
  }

  loadOnboardingAssistant(worldId: string): Promise<OnboardingAssistant> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/onboarding/assistant`);
  }

  loadOwnOperators(): Promise<readonly OperatorSummary[]> {
    return this.#journeyJson("/me/operators");
  }

  async loadSimulationTime(worldId: string): Promise<number> {
    const value = await this.#journeyJson<unknown>(`/worlds/${encodeURIComponent(worldId)}/simulation-time`);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GameApiError("Weltzeit ist kein Objekt.", false);
    const atS = (value as Record<string, unknown>)["atS"];
    if (!Number.isSafeInteger(atS) || (atS as number) < 0) throw new GameApiError("Weltzeit ist keine sichere Simulationssekunde.", false);
    return atS as number;
  }

  loadWorldOperators(worldId: string): Promise<readonly OperatorSummary[]> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators`);
  }

  loadContracts(worldId: string, operatorId: string): Promise<readonly OperatorContractView[]> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts`);
  }

  offerContract(worldId: string, operatorId: string, payload: ContractOfferPayload): Promise<OperatorContractView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts`, {
      method: "POST", body: JSON.stringify(payload),
    });
  }

  respondToContract(worldId: string, operatorId: string, contractId: string, response: "accept" | "reject", atS: number): Promise<OperatorContractView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts/${encodeURIComponent(contractId)}/respond`, {
      method: "POST", body: JSON.stringify({ response, atS }),
    });
  }

  endContract(worldId: string, operatorId: string, contractId: string, atS: number, reason: string, nonPerformance: boolean): Promise<OperatorContractView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/contracts/${encodeURIComponent(contractId)}/end`, {
      method: "POST", body: JSON.stringify({ atS, reason, nonPerformance }),
    });
  }

  loadVehicleMarket(worldId: string): Promise<readonly VehicleMarketListingView[]> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings`);
  }

  loadOwnedVehicles(worldId: string, operatorId: string): Promise<readonly VehicleAssetView[]> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicles`);
  }

  createVehicleListing(worldId: string, operatorId: string, vehicleId: string, payload: {
    readonly listingType: "sale" | "rental"; readonly priceCents: string; readonly rentalValidUntilS?: number;
    readonly listedAtS: number; readonly expiresAtS: number; readonly idempotencyKey: string;
  }): Promise<VehicleMarketListingView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicles/${encodeURIComponent(vehicleId)}/listings`, {
      method: "POST", body: JSON.stringify(payload),
    });
  }

  reserveVehicleListing(worldId: string, listingId: string, buyerOperatorId: string, atS: number, reservedUntilS: number, expectedRevision: number): Promise<VehicleMarketListingView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/reserve`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, atS, reservedUntilS, expectedRevision }),
    });
  }

  transferVehicleListing(worldId: string, listingId: string, buyerOperatorId: string, atS: number, expectedRevision: number, idempotencyKey: string): Promise<unknown> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/transfer`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, atS, expectedRevision, idempotencyKey }),
    });
  }

  reverseVehicleTransfer(worldId: string, listingId: string, buyerOperatorId: string, atS: number, reasonCode: string, idempotencyKey: string): Promise<unknown> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/reverse`, {
      method: "POST", body: JSON.stringify({ buyerOperatorId, atS, reasonCode, idempotencyKey }),
    });
  }

  cancelVehicleListing(worldId: string, operatorId: string, listingId: string, atS: number, expectedRevision: number): Promise<VehicleMarketListingView> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/vehicle-market/listings/${encodeURIComponent(listingId)}/cancel`, {
      method: "POST", body: JSON.stringify({ atS, expectedRevision }),
    });
  }

  loadVehicleHistory(worldId: string, vehicleId: string): Promise<readonly VehicleHistoryEventView[]> {
    return this.#journeyJson(`/worlds/${encodeURIComponent(worldId)}/vehicles/${encodeURIComponent(vehicleId)}/history`);
  }

  async loadProjection(worldId: string, signal?: AbortSignal): Promise<PlanningProjectionV1> {
    const response = await this.#fetch(
      `${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/diagram`,
      {
        headers: { authorization: `Bearer ${this.#accessToken}` },
        signal,
      },
    );
    if (!response.ok) {
      throw new GameApiError(
        `Planner-Projektion nicht verfuegbar (HTTP ${response.status}).`,
        response.status >= 500,
      );
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new GameApiError("Planner-Projektion ist kein gueltiges JSON.", false);
    }
    try {
      const projection = parsePlanningProjectionEnvelope(envelope).data;
      if (projection.worldId !== worldId) {
        throw new Error("Die Planner-Projektion gehoert zu einer anderen Welt.");
      }
      return projection;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unbekannter Vertragsfehler";
      throw new GameApiError(`Planner-Projektion hat ein ungueltiges Format: ${message}`, false);
    }
  }

  async queueAlternative(
    worldId: string,
    commandValue: PlanningAlternativeCommandV1,
    options: AlternativeApplicationOptions = {},
  ): Promise<void> {
    const command = parsePlanningAlternativeCommand(commandValue);
    const attempts = positiveInteger(options.queueAttempts, 3, "queueAttempts");
    const retryDelayMs = nonNegativeInteger(
      options.queueRetryDelayMs,
      250,
      "queueRetryDelayMs",
    );
    const body = JSON.stringify(command);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.#fetch(
          `${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/alternatives`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#accessToken}`,
              "content-type": "application/json",
            },
            body,
            signal: options.signal,
          },
        );
        if (response.ok) return;
        if (response.status < 500 || attempt === attempts) {
          throw new GameApiError(
            `Alternative wurde nicht angenommen (HTTP ${response.status}).`,
            false,
          );
        }
      } catch (error) {
        if (options.signal?.aborted === true) throw error;
        if (error instanceof GameApiError && !error.retryable) throw error;
        if (attempt === attempts) {
          const message = error instanceof Error ? error.message : "Netzwerkfehler";
          throw new GameApiError(`Alternative konnte nicht eingereiht werden: ${message}`, false);
        }
      }
      if (retryDelayMs > 0) await this.#wait(retryDelayMs, options.signal);
    }
  }

  async waitForNewerProjection(
    worldId: string,
    previousRevision: number,
    options: AlternativeApplicationOptions = {},
  ): Promise<PlanningProjectionV1> {
    const attempts = positiveInteger(options.pollAttempts, 40, "pollAttempts");
    const intervalMs = nonNegativeInteger(options.pollIntervalMs, 250, "pollIntervalMs");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const projection = await this.loadProjection(worldId, options.signal);
        if (projection.projectionRevision < previousRevision) {
          throw new GameApiError(
            `Planner-Projektion ist von Revision ${previousRevision} auf ${projection.projectionRevision} zurueckgefallen.`,
            false,
          );
        }
        if (projection.projectionRevision > previousRevision) return projection;
      } catch (error) {
        if (!(error instanceof GameApiError) || !error.retryable || attempt === attempts) {
          throw error;
        }
      }
      if (attempt < attempts && intervalMs > 0) {
        await this.#wait(intervalMs, options.signal);
      }
    }
    throw new GameApiError(
      `Der Planner hat nach ${attempts} Abrufen noch keine neuere Projektion als Revision ${previousRevision} geliefert.`,
      false,
    );
  }

  async applyAlternative(
    worldId: string,
    projectionRevision: number,
    alternativeId: string,
    options: AlternativeApplicationOptions = {},
  ): Promise<PlanningProjectionV1> {
    const command = createPlanningAlternativeCommand(projectionRevision, alternativeId);
    await this.queueAlternative(worldId, command, options);
    return this.waitForNewerProjection(worldId, projectionRevision, options);
  }
}
