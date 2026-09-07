//! Gegenlauf ohne und mit Kontrollhalt: ausschließlich echte Kernbewegung und M10.
use super::{Fixture, interior, operational};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use zugfolge_conductor::*;
use zugfolge_demand::*;
use zugfolge_sim::operational::*;

fn dispatch(train: &str, route: &str, now: i64) -> DispatchRequest {
    DispatchRequest {
        train_id: train.into(),
        interlocking_route_id: route.into(),
        committed_rank: 0,
        timetable_deviation_ms: 0,
        passenger_impact: 0,
        contractual_impact: 0,
        network_impact: 0,
        resource_consequence: 0,
        recovery_rank: 0,
        waiting_since_ms: now,
    }
}
fn until_standing(world: &mut OperationalWorld) {
    for _ in 0..1000 {
        let Some(segment) = world.trains["regional-1"].motion_segment.as_ref() else {
            return;
        };
        world.advance_to(segment.valid_until_ms).unwrap();
        world.verify_invariants().unwrap();
    }
    panic!("Bewegungsgrenze überschritten");
}
pub struct NetworkResult {
    pub world: OperationalWorld,
    pub receipts: BTreeMap<String, OperationalPassengerStopProgress>,
}
pub fn network(wait: i64, partitioned: bool) -> NetworkResult {
    let fixture = Fixture::for_configuration(2);
    let mut world = fixture.source.operational_world;
    let mut policy = FareControlPolicyV1 {
        schema: FARE_CONTROL_POLICY_SCHEMA.into(),
        policy_id: "test-only-network-policy".into(),
        revision: 1,
        world_id: world.world_id.clone(),
        schedule_period_id: "period-1".into(),
        content_hash: String::new(),
        max_police_holds_per_train_run: 1,
        eligible_reasons: BTreeSet::from([
            FareControlReasonV1::IdentityRefusal,
            FareControlReasonV1::ConcreteDanger,
        ]),
        target_rule: "next_unreached_scheduled_passenger_stop".into(),
        provider_by_stop_id: BTreeMap::from([("regional-halle".into(), "test-provider".into())]),
        max_wait_ms: 600_000,
        police_response_model_id: "test-model".into(),
        police_response_model_hash: "a".repeat(64),
        public_cause: FARE_CONTROL_CAUSE.into(),
    };
    if wait > 0 {
        policy.max_wait_ms = wait;
    }
    policy.content_hash = fare_control_policy_hash(&policy);
    world.set_fare_control_policy(policy).unwrap();
    if wait > 0 {
        world
            .request_fare_control_hold(&RequestFareControlHoldInputV1 {
                train_id: "regional-1".into(),
                case_id: "test-case".into(),
                reason: FareControlReasonV1::IdentityRefusal,
                causality_id: "test-control-cause".into(),
            })
            .unwrap();
    }
    until_standing(&mut world);
    world
        .submit_dispatch_requests(&[dispatch("regional-1", "interlocking:train:b", world.now_ms)])
        .unwrap();
    until_standing(&mut world);
    assert!(
        world.trains["regional-1"]
            .passenger_stops
            .as_ref()
            .unwrap()
            .receipts[1]
            .actual_arrival_ms
            .is_some()
    );
    world
        .register_vehicle(operational::vehicle(
            "test-follow-vehicle",
            "type:session-test",
        ))
        .unwrap();
    world
        .create_formation(
            "test-follow-formation",
            None,
            vec!["test-follow-vehicle".into()],
        )
        .unwrap();
    let mut follower = fixture.materialization;
    follower.id = "regional-follow".into();
    follower.train_number = "RB 2".into();
    follower.formation_version_id = "test-follow-formation".into();
    let plan = follower.stop_plan.as_mut().unwrap();
    plan.train_run_id = follower.id.clone();
    plan.service_id = follower.id.clone();
    plan.service_run_id = "test-follow-service".into();
    for stop in &mut plan.stops {
        stop.stop_id = format!("follow-{}", stop.stop_id);
    }
    world.materialize(follower).unwrap();
    world
        .submit_dispatch_requests(&[dispatch(
            "regional-follow",
            "interlocking:train",
            world.now_ms,
        )])
        .unwrap();
    if partitioned {
        world = OperationalWorld::restore(&world.checkpoint()).unwrap();
    }
    let mut receipts = BTreeMap::new();
    for _ in 0..10_000 {
        let completed = world
            .trains
            .values()
            .filter(|t| {
                t.passenger_stops
                    .as_ref()
                    .unwrap()
                    .receipts
                    .last()
                    .unwrap()
                    .actual_arrival_ms
                    .is_some()
            })
            .map(|t| t.id.clone())
            .collect::<Vec<_>>();
        for id in completed {
            receipts.insert(
                id.clone(),
                world.trains[&id].passenger_stops.as_ref().unwrap().clone(),
            );
            world.retire_train(&id).unwrap();
        }
        if world.trains.is_empty() {
            world.verify_invariants().unwrap();
            return NetworkResult { world, receipts };
        }
        let mut next = Vec::new();
        for train in world.trains.values() {
            if let Some(segment) = &train.motion_segment {
                next.push(segment.valid_until_ms);
            }
            if let Some(hold) = world
                .fare_control_hold(&train.id)
                .filter(|h| h.status == FareControlHoldStatusV1::Active)
            {
                next.push(hold.deadline_ms.unwrap());
            }
            let progress = train.passenger_stops.as_ref().unwrap();
            if let Some(arrival) = progress.receipts[progress.next_stop_index].actual_arrival_ms {
                let stop = &progress.plan.stops[progress.next_stop_index];
                next.push((arrival + stop.minimum_dwell_ms).max(stop.scheduled_departure_ms));
            }
        }
        let at = next
            .into_iter()
            .filter(|at| *at > world.now_ms)
            .min()
            .expect("reales Folgeereignis");
        if partitioned && at - world.now_ms > 1 {
            world
                .advance_to(world.now_ms + (at - world.now_ms) / 2)
                .unwrap();
            world.verify_invariants().unwrap();
        }
        world.advance_to(at).unwrap();
        world.verify_invariants().unwrap();
    }
    panic!("Netzlauf überschreitet Ereignisgrenze");
}

pub fn report() -> Value {
    let baseline = network(0, false);
    let held = network(600_000, false);
    let replay = network(600_000, true);
    assert_eq!(held.world.state_hash(), replay.world.state_hash());
    assert_eq!(held.receipts, replay.receipts);
    let arrival = |result: &NetworkResult, id: &str| {
        result.receipts[id]
            .receipts
            .last()
            .unwrap()
            .actual_arrival_ms
            .unwrap()
    };
    let leader_delay = arrival(&held, "regional-1") - arrival(&baseline, "regional-1");
    let follower_delay = arrival(&held, "regional-follow") - arrival(&baseline, "regional-follow");
    assert_eq!(leader_delay, 600_000);
    assert!(follower_delay > 0);
    let demand = connection_demand(&baseline, &held);
    json!({"testOnly":true,"trains":2,"holdMs":600000,"leaderDelayMs":leader_delay,"followerDelayMs":follower_delay,
        "baselineOperationalHash":baseline.world.state_hash().to_hex(),"heldOperationalHash":held.world.state_hash().to_hex(),"replayOperationalHash":replay.world.state_hash().to_hex(),
        "actualStopReceipts":held.receipts,"nativeEvents":held.world.events,"demand":demand})
}

fn connection_demand(baseline: &NetworkResult, held: &NetworkResult) -> Value {
    let layout = build_interior_layout(&interior::fixture(2)).unwrap();
    let mut input = interior::demand(&layout);
    input.release.profiles.truncate(1);
    input.release.zones[0].population = 80;
    for zone in input.release.zones.iter_mut().skip(1) {
        zone.population = 0;
        zone.workplaces = 0;
    }
    let mut destination = input.release.zones[2].clone();
    destination.id = "test-destination".into();
    destination.workplaces = 40;
    destination.stations[0].station_id = "test-destination-station".into();
    input.release.zones.push(destination);
    let base = &baseline.receipts["regional-1"];
    for (stop, fact) in input.services[0].stops.iter_mut().zip(&base.receipts) {
        stop.arrival_ms = fact.actual_arrival_ms.unwrap();
        stop.departure_ms = fact.actual_departure_ms.unwrap_or(stop.arrival_ms);
    }
    let feeder = input.services[0].clone();
    let arrival = feeder.stops.last().unwrap().arrival_ms;
    let mut onward = feeder.clone();
    onward.train_run_id = "test-onward".into();
    onward.stops = vec![
        TrainStopV1 {
            stop_id: "test-transfer".into(),
            station_id: feeder.stops.last().unwrap().station_id.clone(),
            arrival_ms: arrival + 120_000,
            departure_ms: arrival + 120_000,
            passenger_stop: true,
        },
        TrainStopV1 {
            stop_id: "test-destination".into(),
            station_id: "test-destination-station".into(),
            arrival_ms: arrival + 720_000,
            departure_ms: arrival + 720_000,
            passenger_stop: true,
        },
    ];
    let mut later = onward.clone();
    later.train_run_id = "test-later".into();
    for stop in &mut later.stops {
        stop.stop_id = format!("later-{}", stop.stop_id);
        stop.arrival_ms += 900_000;
        stop.departure_ms += 900_000;
    }
    input.services.extend([onward, later]);
    let before = evaluate_demand(&input).unwrap();
    assert!(before.totals.rail > 0);
    assert!(
        before
            .choices
            .iter()
            .all(|c| c.trains.iter().any(|t| t.train_run_id == "test-onward"))
    );
    let old_services = input.services.clone();
    input.revision += 1;
    input.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
        result: before.clone(),
        services: old_services,
    }));
    let actual = &held.receipts["regional-1"];
    input.now_ms = actual.receipts.last().unwrap().actual_arrival_ms.unwrap();
    for (stop, fact) in input.services[0].stops.iter_mut().zip(&actual.receipts) {
        stop.arrival_ms = fact.actual_arrival_ms.unwrap();
        stop.departure_ms = fact.actual_departure_ms.unwrap_or(stop.arrival_ms);
    }
    input.operational_progress = Some(DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: input.world_id.clone(),
        as_of_ms: input.now_ms,
        receipt_id: held.world.state_hash().to_hex(),
        trains: vec![TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops: actual
                .plan
                .stops
                .iter()
                .zip(&actual.receipts)
                .map(|(s, r)| StopOperationalProgressV1 {
                    stop_id: s.stop_id.clone(),
                    actual_arrival_ms: r.actual_arrival_ms,
                    actual_departure_ms: r.actual_departure_ms,
                })
                .collect(),
        }],
    });
    let after = evaluate_demand(&input).unwrap();
    let restored: DemandEvaluationInputV1 =
        serde_json::from_slice(&serde_json::to_vec(&input).unwrap()).unwrap();
    assert_eq!(after, evaluate_demand(&restored).unwrap());
    let rerouted = after
        .choices
        .iter()
        .filter(|c| c.trains.iter().any(|t| t.train_run_id == "test-later"))
        .map(|c| c.passengers)
        .sum::<u32>();
    assert_eq!(rerouted, before.totals.rail);
    assert_eq!(after.totals.stranded, 0);
    let prefix = |r: &DemandEvaluationV1| {
        r.manifests
            .iter()
            .filter(|m| m.train_run_id == "regional-1")
            .cloned()
            .map(|mut m| {
                m.revision = 0;
                m
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(prefix(&before), prefix(&after));
    json!({"forecastHash":before.state_hash,"actualHash":after.state_hash,"rail":after.totals.rail,"reroutedPassengers":rerouted,"stranded":after.totals.stranded,"actualPrefixUnchanged":true,"remainingConnection":"test-later","remainingConnectionStatus":"forecast"})
}
