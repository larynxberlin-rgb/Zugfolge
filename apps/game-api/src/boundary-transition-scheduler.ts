import type { RegionalSimulationCommandPayload, RegionalTrainInput } from "@zugfolge/runtime-native";

export interface RegionalScheduledCommand {
  readonly transitionId: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly atS: number;
  readonly command: RegionalSimulationCommandPayload;
}

export interface RegionalBoundaryTransition extends RegionalScheduledCommand {
  readonly transitionId: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly atS: number;
  readonly command: Extract<RegionalSimulationCommandPayload,
    { readonly type: "enter-external-zone" | "reenter-from-external" }>;
}

function compare(left: RegionalBoundaryTransition, right: RegionalBoundaryTransition): number {
  return left.atS - right.atS || Buffer.from(left.transitionId).compare(Buffer.from(right.transitionId));
}

export class BoundaryTransitionCatalog {
  readonly #byRegion = new Map<string, readonly RegionalBoundaryTransition[]>();

  constructor(transitions: readonly RegionalBoundaryTransition[]) {
    const ids = new Set<string>();
    for (const transition of transitions) {
      if (transition.transitionId.trim() === "" || ids.has(transition.transitionId)) throw new Error("Grenzuebergang besitzt keine eindeutige Kennung.");
      if (transition.worldId.trim() === "" || transition.regionId.trim() === "") throw new Error("Grenzuebergang verletzt Welt- oder Regionsbindung.");
      if (!Number.isSafeInteger(transition.atS) || transition.atS < 0) throw new Error("Grenzuebergang besitzt keine gueltige Weltsekunde.");
      ids.add(transition.transitionId);
      const key = `${transition.worldId}\u0000${transition.regionId}`;
      const existing = this.#byRegion.get(key) ?? [];
      this.#byRegion.set(key, [...existing, transition]);
    }
    for (const [key, values] of this.#byRegion) this.#byRegion.set(key, [...values].sort(compare));
  }

  due(worldId: string, regionId: string, afterS: number, throughS: number): readonly RegionalBoundaryTransition[] {
    if (!Number.isSafeInteger(afterS) || !Number.isSafeInteger(throughS) || throughS < afterS) throw new RangeError("Grenzuebergangsfenster ist ungueltig.");
    return (this.#byRegion.get(`${worldId}\u0000${regionId}`) ?? [])
      .filter((transition) => transition.atS > afterS && transition.atS <= throughS);
  }

  at(worldId: string, regionId: string, atS: number): readonly RegionalBoundaryTransition[] {
    if (!Number.isSafeInteger(atS) || atS < 0) throw new RangeError("Grenzuebergangszeit ist ungueltig.");
    return (this.#byRegion.get(`${worldId}\u0000${regionId}`) ?? [])
      .filter((transition) => transition.atS === atS);
  }
}

function shiftedTrainId(trainRunId: string, serviceDay: number): string {
  return serviceDay === 0 ? trainRunId : `${trainRunId}:day-${serviceDay}`;
}

function shiftTransition(transition: RegionalBoundaryTransition, serviceDay: number, shiftS: number): RegionalBoundaryTransition {
  const command = transition.command.type === "reenter-from-external"
    ? { ...transition.command, trainRunId: shiftedTrainId(transition.command.trainRunId, serviceDay) }
    : {
        ...transition.command,
        trainRunId: shiftedTrainId(transition.command.trainRunId, serviceDay),
        externalLeg: {
          ...transition.command.externalLeg,
          scheduledStartS: transition.command.externalLeg.scheduledStartS + shiftS,
          scheduledEndS: transition.command.externalLeg.scheduledEndS + shiftS,
          reentryEarliestS: transition.command.externalLeg.reentryEarliestS === null ? null : transition.command.externalLeg.reentryEarliestS + shiftS,
          reentryLatestS: transition.command.externalLeg.reentryLatestS === null ? null : transition.command.externalLeg.reentryLatestS + shiftS,
          reentryRoute: transition.command.externalLeg.reentryRoute.map((point) => ({
            ...point,
            arrivalS: point.arrivalS + shiftS,
            departureS: point.departureS + shiftS,
          })),
        },
      };
  return {
    ...transition,
    transitionId: serviceDay === 0 ? transition.transitionId : `${transition.transitionId}:day-${serviceDay}`,
    atS: transition.atS + shiftS,
    command,
  };
}

export class RegionalServiceCatalog {
  readonly #baseTransitions: readonly RegionalBoundaryTransition[];

  constructor(
    private readonly worldId: string,
    private readonly regionId: string,
    private readonly repeatEveryS: number,
    private readonly trains: readonly RegionalTrainInput[],
    transitions: readonly RegionalBoundaryTransition[],
  ) {
    if (!Number.isSafeInteger(repeatEveryS) || repeatEveryS < 3_600) throw new Error("Wiederholungsperiode des Betriebsprogramms ist ungueltig.");
    if (trains.length === 0 || new Set(trains.map((train) => train.trainRunId)).size !== trains.length) throw new Error("Betriebsprogramm besitzt keine eindeutigen Zuglaeufe.");
    this.#baseTransitions = new BoundaryTransitionCatalog(transitions).due(worldId, regionId, -1, Number.MAX_SAFE_INTEGER);
  }

  at(worldId: string, regionId: string, atS: number): readonly RegionalBoundaryTransition[] {
    if (worldId !== this.worldId || regionId !== this.regionId) return [];
    return this.#baseTransitions.filter((transition) => transition.atS === atS);
  }

  due(worldId: string, regionId: string, afterS: number, throughS: number): readonly RegionalScheduledCommand[] {
    if (worldId !== this.worldId || regionId !== this.regionId) return [];
    if (!Number.isSafeInteger(afterS) || !Number.isSafeInteger(throughS) || throughS < afterS) throw new RangeError("Betriebsprogrammfenster ist ungueltig.");
    const commands: RegionalScheduledCommand[] = [];
    const firstServiceDay = Math.max(1, Math.floor(afterS / this.repeatEveryS) + 1);
    const lastServiceDay = Math.floor(throughS / this.repeatEveryS);
    for (let serviceDay = firstServiceDay; serviceDay <= lastServiceDay; serviceDay += 1) {
      const shiftS = serviceDay * this.repeatEveryS;
      commands.push({
        transitionId: `dematerialize-before:day-${serviceDay}`,
        worldId,
        regionId,
        atS: shiftS,
        command: { type: "dematerialize-before", beforeS: Math.max(0, shiftS - this.repeatEveryS) },
      });
      for (const train of this.trains) commands.push({
        transitionId: `materialize:${train.trainRunId}:day-${serviceDay}`,
        worldId,
        regionId,
        atS: shiftS,
        command: {
          type: "materialize",
          train: {
            ...train,
            trainRunId: shiftedTrainId(train.trainRunId, serviceDay),
            route: train.route.map((point) => ({
              ...point,
              arrivalS: point.arrivalS + shiftS,
              departureS: point.departureS + shiftS,
            })),
          },
        },
      });
    }
    for (const transition of this.#baseTransitions) {
      const firstOccurrence = Math.max(0, Math.floor((afterS - transition.atS) / this.repeatEveryS) + 1);
      const lastOccurrence = Math.floor((throughS - transition.atS) / this.repeatEveryS);
      for (let serviceDay = firstOccurrence; serviceDay <= lastOccurrence; serviceDay += 1) {
        commands.push(shiftTransition(transition, serviceDay, serviceDay * this.repeatEveryS));
      }
    }
    return commands.sort((left, right) => left.atS - right.atS || Buffer.from(left.transitionId).compare(Buffer.from(right.transitionId)));
  }
}
