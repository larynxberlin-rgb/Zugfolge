import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DemandStore } from "../../apps/game-api/dist/demand-store.js";

const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dispatch = (train, nowMs) => ({ trainId: train.id, interlockingRouteId: train.dispatchInterlockingRouteId,
  committedRank: 0, timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0, networkImpact: 0,
  resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: nowMs });
const nextEvent = (world) => {
  const times = ["scheduledMotionEnds", "scheduledContinuationDue", "scheduledPassengerDepartures"]
    .flatMap((key) => world[key] ?? []).concat(world.fareControlState?.scheduled ?? []).map((row) => row.atMs)
    .filter((atMs) => Number.isSafeInteger(atMs) && atMs >= world.nowMs);
  return times.length === 0 ? null : Math.min(...times);
};

/** Dieser Prüfdriver disponiert ausschließlich den expliziten ursprünglichen Netzkorpus. */
export function createConductorNetworkProofDriver({ fixture: f, command, advanceTo, readSnapshot }) {
  assert.equal(f.network?.schemaVersion, "conductor-network-acceptance/v1");
  const { worldId, trainRunId } = f.access, regionId = f.initialization.regionId;
  const ids = [trainRunId, "regional-follow", "network-empty", "network-shunt"];
  const ends = new Map([[trainRunId, 1_200_000], ["regional-follow", 1_200_000], ["network-empty", 200_000], ["network-shunt", 300_000]]);
  const store = new DemandStore(f.db, f.native.demand);
  const actualTrace = [], actualCompleted = {}, actualCommands = [];
  let fork, forkDemand, baseline, forkPrefix, started = false;
  const readActual = async () => {
    const { rows } = await f.client.query("select state,state_hash,revision,initialization_hash from regional_simulation_states where world_id=$1 and region_id=$2", [worldId, regionId]);
    assert.equal(rows.length, 1);
    const row = rows[0], binding = f.dependencies.regionBindings().find((pin) => pin.regionId === regionId);
    assert.ok(binding); assert.equal(row.initialization_hash, binding.initializationHash);
    const restored = f.native.operational.restore(row.state, binding.initializationHash);
    assert.equal(restored.stateHash, row.state_hash); assert.equal(restored.state.revision, Number(row.revision));
    assert.equal(restored.state.world.worldId, worldId);
    return restored;
  };
  const observe = (restored, trace, completed) => {
    const world = restored.state.world;
    const trains = ids.flatMap((id) => {
      const train = world.trains[id]; if (!train) return [];
      if (train.headRouteMm === ends.get(id) && train.speedMmps === 0 && train.motionSegment === null && train.authority === null) {
        completed[id] ??= { atMs: world.nowMs, formationVersionId: train.formationVersionId,
          passengerStops: train.passengerStops ?? null, headRouteMm: train.headRouteMm };
      }
      return [{ id, headRouteMm: train.headRouteMm, tailRouteMm: train.tailRouteMm, speedMmps: train.speedMmps,
        motionState: train.motionState, waitingReason: train.waitingReason, occupiedBlocks: train.occupiedBlocks,
        formationVersionId: train.formationVersionId }];
    });
    trace.push({ atMs: world.nowMs, stateHash: restored.stateHash, revision: restored.state.revision, trains,
      waitingByResource: world.waitingByResource });
    return world;
  };
  const initialCommands = (nowMs) => {
    const list = [];
    for (const id of ["regional-follow", "network-empty"]) {
      const train = f.initialization.trains.find((row) => row.id === id); assert.ok(train);
      list.push({ type: "materialize", train }, { type: "dispatch", requests: [dispatch(train, nowMs)] });
    }
    const shunting = f.initialization.trains.find((row) => row.id === "network-shunt"); assert.ok(shunting);
    const { dispatchInterlockingRouteId: _dispatch, protectionModeSelectionRuns: _protection, ...successor } = shunting;
    list.push({ type: "queue-movement-continuation", continuation: { id: "test-network:empty-to-shunt",
      predecessorTrainId: "network-empty", predecessorBaseRouteVersionId: "test-network:cross-route", successor,
      successorDispatch: dispatch(shunting, nowMs), notBeforeMs: nowMs, minimumDwellMs: 0, continuity: "same-direction" } });
    return list;
  };
  const realCommand = async (payload) => {
    await command(payload); const restored = await readActual();
    actualCommands.push({ atMs: restored.state.world.nowMs, command: payload, stateHash: restored.stateHash });
    observe(restored, actualTrace, actualCompleted); return restored;
  };
  const prefix = (evaluation) => evaluation.manifests.filter((manifest) => manifest.trainRunId === trainRunId
    && forkPrefix.includes(manifest.segmentId)).map((manifest) => ({ ...manifest, revision: 0 })).sort((a, b) => a.segmentId.localeCompare(b.segmentId));

  async function counterfactual(start, payloads) {
    let current = f.native.operational.restore(start.state, start.initializationHash), serial = 0;
    const trace = [], completed = {}, commands = [], events = [];
    const apply = async (payload) => {
      const result = await f.native.operational.apply(current.state, { schemaVersion: "zugfolge-operational-simulation-command/v2",
        worldId, regionId, commandId: `test-network:counterfactual:${++serial}`, expectedStateHash: current.stateHash,
        expectedRevision: current.state.revision, expectedPublisherSequence: current.state.publisherSequence, command: payload });
      commands.push({ atMs: result.state.world.nowMs, command: payload, stateHash: result.stateHash });
      events.push(...result.events); current = result;
      observe(current, trace, completed);
    };
    const hold = current.state.world.fareControlState.holds[trainRunId];
    await apply({ type: "resolve-fare-control-hold", resolution: { trainId: trainRunId, holdId: hold.holdId,
      expectedRevision: hold.revision, modelHash: hold.modelHash, outcome: "unavailable", causalityId: "explicit-test:immediate-release-counterfactual" } });
    for (const payload of payloads) await apply(payload);
    for (let step = 0; step < 250; step++) {
      const world = observe(current, trace, completed);
      for (const id of [trainRunId, "regional-follow", "network-shunt"]) if (world.trains[id] && completed[id]) await apply({ type: "retire", trainId: id });
      if (ids.every((id) => !current.state.world.trains[id])) break;
      const atMs = nextEvent(current.state.world);
      assert.ok(atMs !== null, `Gegenlauf hat keine reale Fortsetzung: ${JSON.stringify(trace.at(-1))}`);
      await apply({ type: "advance-to", atMs });
      assert.ok(step < 249, "Der native Gegenlauf überschreitet seine feste Ereignisgrenze.");
    }
    assert.ok(completed[trainRunId] && completed["regional-follow"] && completed["network-shunt"]);
    // Derselbe Befehlsstrom wird ausschließlich über native Restore-/Apply-Grenzen wiederholt.
    let replay = f.native.operational.restore(start.state, start.initializationHash);
    for (let index = 0; index < commands.length; index++) {
      replay = await f.native.operational.apply(replay.state, { schemaVersion: "zugfolge-operational-simulation-command/v2",
        worldId, regionId, commandId: `test-network:counterfactual:${index + 1}`, expectedStateHash: replay.stateHash,
        expectedRevision: replay.state.revision, expectedPublisherSequence: replay.state.publisherSequence, command: commands[index].command });
      assert.equal(replay.stateHash, commands[index].stateHash);
    }
    return { mode: "same-active-hold-immediate-native-unavailable-release", finalStateHash: current.stateHash,
      replayStateHash: replay.stateHash, completed, commands, trace, nativeEvents: events };
  }

  return {
    async startAtActiveHold() {
      assert.equal(started, false); started = true;
      fork = await readActual();
      const world = observe(fork, actualTrace, actualCompleted), hold = world.fareControlState.holds[trainRunId];
      assert.equal(hold.status, "active");
      assert.equal(hold.targetStopId, f.initialization.trains[0].stopPlan.stops[1].stopId);
      assert.equal(world.trains[trainRunId].headRouteMm, 400_000);
      assert.equal(world.trains[trainRunId].speedMmps, 0);
      for (const id of ids.slice(1)) assert.equal(world.trains[id], undefined);
      forkDemand = await store.latest(worldId); assert.ok(forkDemand);
      const firstStopId = f.initialization.trains[0].stopPlan.stops[0].stopId;
      forkPrefix = forkDemand.result.allocations.filter((row) => row.trainRunId === trainRunId && row.fromStopId === firstStopId).map((row) => row.segmentId);
      assert.equal(forkPrefix.length, 1);
      const payloads = initialCommands(world.nowMs);
      baseline = await counterfactual(fork, payloads);
      for (const payload of payloads) await realCommand(payload);
      return { schemaVersion: "conductor-network-active-hold-proof/v1", testOnly: true, forkStateHash: fork.stateHash,
        forkDemandStateHash: forkDemand.result.stateHash, actualPrefixSha256: sha(prefix(forkDemand.result)),
        source: f.network.evidence, holdId: hold.holdId, targetStopId: hold.targetStopId, atMs: world.nowMs,
        baseline, actualTrace: structuredClone(actualTrace) };
    },
    async finishAfterRelease() {
      assert.equal(started, true);
      const released = await readActual(), hold = released.state.world.fareControlState.holds[trainRunId];
      assert.equal(hold.status, "released"); assert.ok(hold.releasedAtMs > hold.activatedAtMs);
      for (let step = 0; step < 250; step++) {
        let restored = await readActual();
        const world = observe(restored, actualTrace, actualCompleted);
        for (const id of [trainRunId, "regional-follow", "network-shunt"]) if (world.trains[id] && actualCompleted[id]) {
          // Ein letzter echter Sitzungssnapshot bindet den Fahrtabschluss vor dem normalen Retirement.
          if (id === trainRunId && readSnapshot) assert.equal((await readSnapshot()).snapshot.status, "ended");
          restored = await realCommand({ type: "retire", trainId: id });
        }
        if (ids.every((id) => !restored.state.world.trains[id])) break;
        const atMs = nextEvent(restored.state.world);
        assert.ok(atMs !== null, `Tatsächlicher Netzlauf hat keine reale Fortsetzung: ${JSON.stringify(actualTrace.at(-1))}`);
        await advanceTo(atMs); observe(await readActual(), actualTrace, actualCompleted);
        assert.ok(step < 249, "Der tatsächliche Netzlauf überschreitet seine feste Ereignisgrenze.");
      }
      assert.ok(actualCompleted[trainRunId] && actualCompleted["regional-follow"] && actualCompleted["network-shunt"]);
      // Der originale M10-Consumer verarbeitet die sichere Uhrschranke now−1.
      await advanceTo((await readActual()).state.world.nowMs + 1);
      const demand = await store.latest(worldId); assert.ok(demand);
      assert.deepEqual(prefix(demand.result), prefix(forkDemand.result));
      assert.ok(demand.result.revision > forkDemand.result.revision);
      const arrival = (completed, id) => completed[id].passengerStops.receipts.at(-1).actualArrivalMs;
      const leaderDelayMs = arrival(actualCompleted, trainRunId) - arrival(baseline.completed, trainRunId);
      const followerDelayMs = arrival(actualCompleted, "regional-follow") - arrival(baseline.completed, "regional-follow");
      assert.ok(leaderDelayMs > 0); assert.ok(followerDelayMs > 0);
      const matched = new Map(forkDemand.result.choices.map((choice) => [`${choice.cohortId}:${choice.ordinalStart}`, choice]));
      const replanned = demand.result.choices.filter((choice) => choice.trains.some((train) => train.trainRunId === "network-later")
        && matched.get(`${choice.cohortId}:${choice.ordinalStart}`)?.trains.some((train) => train.trainRunId === "network-onward"));
      const replannedPassengers = replanned.reduce((sum, choice) => sum + choice.passengers, 0);
      assert.ok(replannedPassengers > 0, "Der Original-M10-Consumer muss einen tatsächlich verpassten geplanten Anschluss neu wählen.");
      assert.equal(actualCompleted["network-shunt"].formationVersionId, f.initialization.trains.find((train) => train.id === "network-empty").formationVersionId);
      const final = await readActual();
      const resourceId = f.network.evidence.crossingResourceId;
      const resourceWaits = ["regional-follow", "network-empty"].map((id) => {
        const evidence = actualTrace.find((row) => row.waitingByResource?.[resourceId]?.includes(id)
          && row.trains.some((train) => train.id === id && train.speedMmps === 0 && train.waitingReason === "waiting-for-route-lock"));
        assert.ok(evidence, `Die tatsächliche Ressourcenwarteschlange für ${id} muss belegt sein.`);
        return { trainRunId: id, resourceId, atMs: evidence.atMs, operationalStateHash: evidence.stateHash };
      });
      const journal = await f.client.query("select sequence,event_type,payload from domain_events where world_id=$1 and event_type in ('operational.movement-continued','operations.passenger-stop-arrival','operations.passenger-stop-departure','operations.fare-control-hold-activated','operations.fare-control-hold-released') order by sequence", [worldId]);
      const continuation = journal.rows.filter((row) => row.event_type === "operational.movement-continued" && row.payload.subjectId === "network-shunt");
      assert.equal(continuation.length, 1);
      assert.equal(continuation[0].payload.detail, "chain=test-network:empty-to-shunt;from=network-empty;to=network-shunt;continuity=same-direction");
      const receipt = final.state.world.completedMovementContinuations["test-network:empty-to-shunt"];
      assert.ok(receipt); assert.equal(receipt.completedAtMs, continuation[0].payload.simulationTimeMs);
      assert.equal(receipt.completionSequence, continuation[0].payload.nativeEventSequence);
      return { schemaVersion: "conductor-network-duration-consequence/v1", testOnly: true, forkStateHash: fork.stateHash,
        comparison: baseline.mode, leaderDelayMs, followerDelayMs, holdDurationMs: hold.releasedAtMs - hold.activatedAtMs,
        actualCompleted, actualTrace, actualCommands, resourceWaits, continuationReceipt: receipt,
        journal: journal.rows.map((row) => ({ worldSequence: Number(row.sequence), eventType: row.event_type, payload: row.payload })),
        baselineStateHash: baseline.finalStateHash,
        actualStateHash: final.stateHash, restoredStateHash: f.native.operational.restore(final.state, final.initializationHash).stateHash,
        demand: { beforeStateHash: forkDemand.result.stateHash, afterStateHash: demand.result.stateHash,
          beforeRevision: forkDemand.result.revision, afterRevision: demand.result.revision, preservedActualPrefixSha256: sha(prefix(demand.result)),
          replannedPassengers, replannedChoiceIdsSha256: sha(replanned.map((choice) => choice.connectionId)), stopFlows: demand.result.stopFlows },
        limits: ["Gegenlauf ist die explizite sofortige unavailable-Testfreigabe desselben aktiven Holds; keine Fahrt ohne Polizeianforderung.",
          "Die Anschlussangebote bleiben Prognosen. Nur der tatsächliche Zweig darf den bestehenden M6-/Ledgerpfad speisen."] };
    },
  };
}
