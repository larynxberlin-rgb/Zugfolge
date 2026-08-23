import {
  LIVEMAP_CONFIG_SCHEMA,
  LIVEMAP_OBJECT_DETAIL_SCHEMA,
  OWNER_TRAIN_DETAIL_SCHEMA,
  PASSENGER_INFORMATION_DISPLAY_SCHEMA,
  PUBLIC_TRAIN_DETAIL_SCHEMA,
  STATION_BOARD_SCHEMA,
  verifiedBaseTrainRunId,
  type LivemapObjectKind,
  type LivemapReadModel,
  type LivemapRegistry,
  type StationBoardCall,
  type StationBoardV1,
  type PublicExternalTrain,
  type PublicTrain,
} from "@zugfolge/livemap-stream";
import {
  AccessRevokedError,
  getAccount,
  type IdentityDatabase,
} from "@zugfolge/identity";
import {
  getOperator,
  listOperatorsForAccount,
  OperatorNotFoundError,
} from "@zugfolge/operators";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

export interface LivemapReadRouteDependencies {
  readonly db: IdentityDatabase;
  readonly livemap?: LivemapRegistry;
  readonly readModel?: LivemapReadModel;
  readonly authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

const worldIdParam = {
  type: "object",
  required: ["worldId"],
  additionalProperties: false,
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;

const objectKinds: readonly LivemapObjectKind[] = [
  "track",
  "station",
  "platform",
  "switch",
  "signal",
  "block",
  "facility",
  "operating-point",
  "rail-context",
];

async function requireWorldAccess(
  deps: LivemapReadRouteDependencies,
  request: FastifyRequest,
  reply: FastifyReply,
  worldId: string,
): Promise<boolean> {
  const identity = request.identity;
  if (identity === undefined) {
    await reply.code(401).send({ error: "Keine Identitaet." });
    return false;
  }
  try {
    const account = await getAccount(deps.db, {
      worldId,
      keycloakSubject: identity.keycloakSubject,
    });
    if (account === undefined) {
      await reply.code(403).send({ error: "Kein aktiver Zugang zu dieser Welt." });
      return false;
    }
    return true;
  } catch (error) {
    if (error instanceof AccessRevokedError) {
      await reply.code(403).send({ error: "Kein aktiver Zugang zu dieser Welt." });
      return false;
    }
    throw error;
  }
}

function initializedSnapshot(
  deps: LivemapReadRouteDependencies,
  worldId: string,
  reply: FastifyReply,
) {
  if (deps.livemap === undefined) {
    void reply.code(503).send({ error: "Livemap-Publisher nicht verfuegbar." });
    return undefined;
  }
  const feed = deps.livemap.initializedWorld(worldId);
  if (feed === undefined) {
    void reply.code(503).send({ error: "Livemap besitzt noch keinen autoritativen Rust-Initialsnapshot." });
    return undefined;
  }
  return feed.snapshot();
}

function findTrain(
  trains: readonly PublicTrain[],
  externalTrains: readonly PublicExternalTrain[],
  trainId: string,
): { readonly movement: "network" | "external"; readonly train: PublicTrain | PublicExternalTrain } | undefined {
  const network = trains.find((train) => train.id === trainId);
  if (network !== undefined) return { movement: "network", train: network };
  const external = externalTrains.find((train) => train.id === trainId);
  return external === undefined ? undefined : { movement: "external", train: external };
}

function stationCallStatus(
  callType: "arrival" | "departure",
  train: PublicTrain | PublicExternalTrain | undefined,
): StationBoardCall["status"] {
  if (train === undefined) return "scheduled";
  if (train.status === "cancelled") return "cancelled";
  if (train.status === "completed" || train.status === "completed-outside") {
    return callType === "arrival" ? "arrived" : "departed";
  }
  if (callType === "departure" && train.status === "at_platform") return "boarding";
  if (callType === "arrival" && train.status === "at_platform") return "arrived";
  return "scheduled";
}

function verifiedLiveTrainForScheduleCall(
  callTrainId: string,
  train: PublicTrain | PublicExternalTrain | undefined,
): PublicTrain | PublicExternalTrain | undefined {
  if (train === undefined) return undefined;
  if (!("positionMm" in train)) return callTrainId.includes(":day-") ? undefined : train;
  if (train.baseTrainRunId === undefined) return callTrainId.includes(":day-") ? undefined : train;
  return verifiedBaseTrainRunId(train) === undefined ? undefined : train;
}

function projectStationCalls(
  calls: readonly StationBoardCall[],
  callType: "arrival" | "departure",
  trains: ReadonlyMap<string, PublicTrain | PublicExternalTrain>,
): readonly StationBoardCall[] {
  return Object.freeze(calls.map((call) => {
    const train = verifiedLiveTrainForScheduleCall(call.trainId, trains.get(call.trainId));
    const delay = train?.delaySeconds ?? 0;
    return Object.freeze({
      ...call,
      expectedTimeS: Math.max(0, call.scheduledTimeS + delay),
      status: stationCallStatus(callType, train),
    });
  }).sort((left, right) =>
    left.expectedTimeS - right.expectedTimeS ||
    left.scheduledTimeS - right.scheduledTimeS ||
    (left.trainId < right.trainId ? -1 : left.trainId > right.trainId ? 1 : 0)));
}

export function projectStationBoardWithLiveState(
  board: StationBoardV1,
  trains: readonly PublicTrain[],
  externalTrains: readonly PublicExternalTrain[],
): StationBoardV1 {
  const byId = new Map<string, PublicTrain | PublicExternalTrain>();
  [...trains, ...externalTrains].forEach((train) => byId.set(train.id, train));
  return Object.freeze({
    ...board,
    departures: projectStationCalls(board.departures, "departure", byId),
    arrivals: projectStationCalls(board.arrivals, "arrival", byId),
  });
}

function livePassengerMessages(delaySeconds: number | undefined, status: string): readonly string[] {
  if (status === "cancelled") return Object.freeze(["Diese Fahrt faellt aus."]);
  if (delaySeconds === undefined || delaySeconds === 0) return Object.freeze([]);
  const minutes = Math.max(1, Math.round(Math.abs(delaySeconds) / 60));
  const unit = minutes === 1 ? "Minute" : "Minuten";
  return Object.freeze([`Voraussichtlich ${minutes} ${unit} ${delaySeconds > 0 ? "spaeter" : "frueher"}.`]);
}

function remainingFollowingStops(plan: readonly string[], nextStop: string | undefined): readonly string[] {
  if (nextStop === undefined) return plan;
  const normalized = nextStop.trim().toLocaleLowerCase("de");
  const nextIndex = plan.findIndex((stop) => stop.trim().toLocaleLowerCase("de") === normalized);
  return nextIndex < 0 ? plan : plan.slice(nextIndex + 1);
}

export function registerLivemapReadRoutes(
  app: FastifyInstance,
  deps: LivemapReadRouteDependencies,
): void {
  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/livemap/config",
    { preHandler: deps.authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      if (!(await requireWorldAccess(deps, request, reply, request.params.worldId))) return;
      if (deps.readModel === undefined) return reply.code(503).send({ error: "Livemap-Kartenkonfiguration ist nicht verfuegbar." });
      const config = await deps.readModel.getConfig(request.params.worldId);
      if (config === undefined) return reply.code(404).send({ error: "Keine Livemap-Konfiguration fuer diese Welt." });
      if (
        config.schemaVersion !== LIVEMAP_CONFIG_SCHEMA ||
        config.worldId !== request.params.worldId ||
        config.basemap.selfHosted !== true ||
        config.infrastructure.coverage !== "DE"
      ) {
        return reply.code(503).send({ error: "Livemap-Konfiguration verletzt den produktiven Datenvertrag." });
      }
      return reply.send(config);
    },
  );

  app.get<{ Params: { worldId: string; kind: LivemapObjectKind; objectId: string } }>(
    "/worlds/:worldId/livemap/objects/:kind/:objectId",
    {
      preHandler: deps.authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "kind", "objectId"],
          additionalProperties: false,
          properties: {
            worldId: { type: "string", format: "uuid" },
            kind: { type: "string", enum: objectKinds },
            objectId: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await requireWorldAccess(deps, request, reply, request.params.worldId))) return;
      if (deps.readModel === undefined) return reply.code(503).send({ error: "Livemap-Objektkatalog ist nicht verfuegbar." });
      const [config, detail] = await Promise.all([
        deps.readModel.getConfig(request.params.worldId),
        deps.readModel.getObjectDetail(request.params.worldId, request.params.kind, request.params.objectId),
      ]);
      if (detail === undefined) return reply.code(404).send({ error: "Infrastrukturobjekt nicht gefunden." });
      if (
        detail.schemaVersion !== LIVEMAP_OBJECT_DETAIL_SCHEMA ||
        detail.worldId !== request.params.worldId ||
        detail.kind !== request.params.kind ||
        detail.id !== request.params.objectId ||
        config === undefined ||
        detail.infrastructureReleaseId !== config.infrastructureReleaseId
      ) {
        return reply.code(503).send({ error: "Livemap-Objektdetail gehoert nicht zum aktiven InfraRelease." });
      }
      return reply.send(detail);
    },
  );

  app.get<{ Params: { worldId: string; stationId: string } }>(
    "/worlds/:worldId/livemap/stations/:stationId/board",
    {
      preHandler: deps.authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "stationId"],
          additionalProperties: false,
          properties: {
            worldId: { type: "string", format: "uuid" },
            stationId: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await requireWorldAccess(deps, request, reply, request.params.worldId))) return;
      if (deps.readModel === undefined) return reply.code(503).send({ error: "Livemap-Abfahrtstafel ist nicht verfuegbar." });
      const snapshot = initializedSnapshot(deps, request.params.worldId, reply);
      if (snapshot === undefined) return;
      const board = await deps.readModel.getStationBoard(
        request.params.worldId,
        request.params.stationId,
        { streamId: snapshot.streamId, sequence: snapshot.sequence, atS: snapshot.at },
      );
      if (board === undefined) return reply.code(404).send({ error: "Betriebsstelle nicht gefunden." });
      if (
        board.schemaVersion !== STATION_BOARD_SCHEMA ||
        board.worldId !== request.params.worldId ||
        board.stationId !== request.params.stationId ||
        board.streamId !== snapshot.streamId ||
        board.sequence !== snapshot.sequence ||
        board.atS !== snapshot.at
      ) {
        return reply.code(503).send({ error: "Abfahrtstafel ist nicht mit dem aktuellen Weltzustand synchron." });
      }
      return reply.send(projectStationBoardWithLiveState(board, snapshot.trains, snapshot.externalTrains ?? []));
    },
  );

  app.get<{ Params: { worldId: string; trainId: string } }>(
    "/worlds/:worldId/livemap/trains/:trainId",
    {
      preHandler: deps.authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "trainId"],
          additionalProperties: false,
          properties: {
            worldId: { type: "string", format: "uuid" },
            trainId: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await requireWorldAccess(deps, request, reply, request.params.worldId))) return;
      const snapshot = initializedSnapshot(deps, request.params.worldId, reply);
      if (snapshot === undefined) return;
      const found = findTrain(snapshot.trains, snapshot.externalTrains ?? [], request.params.trainId);
      if (found === undefined) return reply.code(404).send({ error: "Zug ist in dieser Welt nicht sichtbar." });
      const networkTrain = found.movement === "network" ? found.train as PublicTrain : undefined;
      const scheduleTrainId = networkTrain === undefined
        ? request.params.trainId
        : verifiedBaseTrainRunId(networkTrain) ?? request.params.trainId;
      const plan = await deps.readModel?.getPassengerInformation(
        request.params.worldId,
        scheduleTrainId,
      );
      if (plan !== undefined && plan.trainId !== scheduleTrainId) {
        return reply.code(503).send({ error: "Fahrgastinformation gehoert nicht zum angefragten Zug." });
      }
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
      const ownedOperators = (await listOperatorsForAccount(deps.db, identity.keycloakSubject))
        .filter((operator) => operator.worldId === request.params.worldId)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const cursor = { streamId: snapshot.streamId, sequence: snapshot.sequence, atS: snapshot.at };
      const ownerDetails = deps.readModel === undefined
        ? []
        : (await Promise.all(ownedOperators.map((operator) =>
            deps.readModel!.getOwnerTrainDetail(request.params.worldId, operator.id, request.params.trainId, cursor))))
          .filter((detail) => detail !== undefined);
      if (ownerDetails.some((detail) =>
        detail.schemaVersion !== OWNER_TRAIN_DETAIL_SCHEMA ||
        detail.worldId !== request.params.worldId ||
        detail.trainId !== request.params.trainId ||
        detail.streamId !== snapshot.streamId ||
        detail.sequence !== snapshot.sequence ||
        detail.atS !== snapshot.at ||
        !ownedOperators.some((operator) => operator.id === detail.operatorId)
      ) || ownerDetails.length > 1) {
        return reply.code(503).send({ error: "Eigentuemerprojektion verletzt die Welt- oder EVU-Bindung." });
      }
      const passengerMessages = [...new Set([
        ...(plan?.messages ?? []),
        ...livePassengerMessages(found.train.delaySeconds, found.train.status),
      ])];
      return reply.send({
        schemaVersion: PUBLIC_TRAIN_DETAIL_SCHEMA,
        worldId: request.params.worldId,
        streamId: snapshot.streamId,
        sequence: snapshot.sequence,
        atS: snapshot.at,
        movement: found.movement,
        train: found.train,
        ...(ownerDetails[0] === undefined ? {} : { ownerOperatorId: ownerDetails[0].operatorId }),
        fis: {
          schemaVersion: PASSENGER_INFORMATION_DISPLAY_SCHEMA,
          trainId: found.train.id,
          operator: found.train.operator,
          trainNumber: found.train.trainNumber,
          category: found.train.category,
          ...(plan?.destination === undefined ? {} : { destination: plan.destination }),
          ...(networkTrain?.nextOperatingPoint === undefined
            ? {}
            : { nextStop: networkTrain.nextOperatingPoint }),
          followingStops: remainingFollowingStops(plan?.followingStops ?? [], networkTrain?.nextOperatingPoint),
          ...(found.train.delaySeconds === undefined
            ? {}
            : { delaySeconds: found.train.delaySeconds }),
          status: found.train.status,
          messages: passengerMessages,
        },
      });
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string; trainId: string } }>(
    "/worlds/:worldId/operators/:operatorId/livemap/trains/:trainId",
    {
      preHandler: deps.authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "operatorId", "trainId"],
          additionalProperties: false,
          properties: {
            worldId: { type: "string", format: "uuid" },
            operatorId: { type: "string", format: "uuid" },
            trainId: { type: "string", minLength: 1, maxLength: 300 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await requireWorldAccess(deps, request, reply, request.params.worldId))) return;
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
      try {
        const [account, operator] = await Promise.all([
          getAccount(deps.db, {
            worldId: request.params.worldId,
            keycloakSubject: identity.keycloakSubject,
          }),
          getOperator(deps.db, {
            worldId: request.params.worldId,
            operatorId: request.params.operatorId,
          }),
        ]);
        if (account === undefined || account.id !== operator.foundingAccountId) {
          return reply.code(403).send({ error: "Eigentuemersicht ist nur fuer das gruendende EVU-Konto sichtbar." });
        }
      } catch (error) {
        if (error instanceof OperatorNotFoundError) return reply.code(404).send({ error: error.message });
        if (error instanceof AccessRevokedError) return reply.code(403).send({ error: "Kein aktiver Zugang zu dieser Welt." });
        throw error;
      }
      if (deps.readModel === undefined) return reply.code(503).send({ error: "Livemap-Eigentuemersicht ist nicht verfuegbar." });
      const snapshot = initializedSnapshot(deps, request.params.worldId, reply);
      if (snapshot === undefined) return;
      if (findTrain(snapshot.trains, snapshot.externalTrains ?? [], request.params.trainId) === undefined) {
        return reply.code(404).send({ error: "Zug ist in dieser Welt nicht sichtbar." });
      }
      const detail = await deps.readModel.getOwnerTrainDetail(
        request.params.worldId,
        request.params.operatorId,
        request.params.trainId,
        { streamId: snapshot.streamId, sequence: snapshot.sequence, atS: snapshot.at },
      );
      if (detail === undefined) return reply.code(404).send({ error: "Keine Eigentuemerinformationen fuer diesen Zug." });
      if (
        detail.schemaVersion !== OWNER_TRAIN_DETAIL_SCHEMA ||
        detail.worldId !== request.params.worldId ||
        detail.operatorId !== request.params.operatorId ||
        detail.trainId !== request.params.trainId ||
        detail.streamId !== snapshot.streamId ||
        detail.sequence !== snapshot.sequence ||
        detail.atS !== snapshot.at
      ) {
        return reply.code(503).send({ error: "Eigentuemerprojektion verletzt die Welt- oder EVU-Bindung." });
      }
      return reply.send(detail);
    },
  );
}
