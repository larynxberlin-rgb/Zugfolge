//! Kontrollhaltbeweise verwenden die echten gemeinsamen Operational-Testproduzenten.
#[path = "support/passenger_stops.rs"]
mod support;
use std::collections::{BTreeMap, BTreeSet};
use support::*;
use zugfolge_sim::operational::*;

fn request(case_id: &str) -> RequestFareControlHoldInputV1 {
    RequestFareControlHoldInputV1 {
        train_id: "train:stops".into(),
        case_id: case_id.into(),
        reason: FareControlReasonV1::IdentityRefusal,
        causality_id: format!("test-{case_id}"),
    }
}
fn active_world(wait: i64) -> OperationalWorld {
    let (infra, input) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    world
        .set_fare_control_policy(control_policy(&world, wait))
        .unwrap();
    world.request_fare_control_hold(&request("case-1")).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    world.advance_to(1000).unwrap();
    advance_stop_train_until_standing(&mut world);
    world.advance_to(world.now_ms + 17_000).unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    world.advance_to(world.now_ms + 5000).unwrap();
    world.verify_invariants().unwrap();
    world
}

#[test]
fn infrastructure_release_does_not_bypass_active_hold_or_cancelled_stop_plan() {
    for cancel in [false, true] {
        let mut world = active_world(60_000);
        let resources = world.trains["train:stops"].occupied_blocks.clone();
        let resource = resources.first().unwrap().clone();
        world
            .activate_disruption(
                "test-infrastructure-closure",
                OperationalDisruption::ResourceClosed {
                    resource_id: resource,
                },
            )
            .unwrap();
        if cancel {
            let expected_stop_plan_hash = world.trains["train:stops"]
                .passenger_stops
                .as_ref()
                .unwrap()
                .plan_hash
                .clone();
            world
                .cancel_passenger_stop_plan(&CancelPassengerStopPlanInputV1 {
                    train_id: "train:stops".into(),
                    expected_stop_plan_hash,
                    causality_id: "test-disposition-cancel".into(),
                })
                .unwrap();
        }
        world
            .clear_disruption("test-infrastructure-closure", "test-technical-release")
            .unwrap();
        assert!(matches!(
            world.trains["train:stops"].motion_state,
            MotionState::SafeStop { .. }
        ));
        assert!(world.trains["train:stops"].authority.is_none());
        assert_eq!(world.trains["train:stops"].occupied_blocks, resources);
        if !cancel {
            assert_eq!(
                world.fare_control_hold("train:stops").unwrap().status,
                FareControlHoldStatusV1::Active
            );
        }
        world.verify_invariants().unwrap();
    }
}

#[test]
fn infrastructure_and_hold_release_order_both_allow_only_rechecked_departure() {
    for infrastructure_first in [false, true] {
        let mut world = active_world(60_000);
        let head = world.trains["train:stops"].head_route_mm;
        let resource = world.trains["train:stops"]
            .occupied_blocks
            .first()
            .unwrap()
            .clone();
        world
            .activate_disruption(
                "overlap",
                OperationalDisruption::ResourceClosed {
                    resource_id: resource,
                },
            )
            .unwrap();
        if infrastructure_first {
            world
                .clear_disruption("overlap", "test-technical-release")
                .unwrap();
            assert!(matches!(
                world.trains["train:stops"].motion_state,
                MotionState::SafeStop { .. }
            ));
        }
        let hold = world.fare_control_hold("train:stops").unwrap().clone();
        world
            .resolve_fare_control_hold(&ResolveFareControlHoldInputV1 {
                train_id: hold.train_run_id,
                hold_id: hold.hold_id,
                expected_revision: hold.revision,
                model_hash: hold.model_hash,
                outcome: ResolveFareControlHoldOutcomeV1::IdentityConfirmed,
                causality_id: "test-real-model-result".into(),
            })
            .unwrap();
        if !infrastructure_first {
            assert!(matches!(
                world.trains["train:stops"].motion_state,
                MotionState::SafeStop { .. }
            ));
            world
                .clear_disruption("overlap", "test-technical-release")
                .unwrap();
        }
        assert_eq!(world.trains["train:stops"].head_route_mm, head);
        assert_eq!(
            world.fare_control_hold("train:stops").unwrap().status,
            FareControlHoldStatusV1::Released
        );
        if world.trains["train:stops"].authority.is_none() {
            assert_eq!(
                world.trains["train:stops"].motion_state,
                MotionState::Standing
            );
            assert_eq!(
                world
                    .submit_dispatch_requests(&[dispatch_request(
                        "train:stops",
                        "interlocking:train:b",
                        world.now_ms
                    )])
                    .unwrap(),
                vec!["train:stops"]
            );
        }
        assert_eq!(
            world.trains["train:stops"].motion_state,
            MotionState::Moving
        );
        assert!(world.trains["train:stops"].authority.is_some());
        world.verify_invariants().unwrap();
        let restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
        assert_eq!(world.state_hash(), restored.state_hash());
    }
}

#[test]
fn policy_welt_quote_buendelung_und_polizeiaufloesung_bleiben_gebunden() {
    let (infra, input) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    assert!(world.request_fare_control_hold(&request("case-1")).is_err());
    for index in 0..4 {
        let mut policy = control_policy(&world, 1000);
        match index {
            0 => policy.world_id = "foreign".into(),
            1 => policy.max_wait_ms = 0,
            2 => policy.max_police_holds_per_train_run = 2,
            _ => policy.provider_by_stop_id.clear(),
        };
        policy.content_hash = fare_control_policy_hash(&policy);
        let hash = world.state_hash();
        assert!(world.set_fare_control_policy(policy).is_err());
        assert_eq!(hash, world.state_hash());
    }
    world
        .set_fare_control_policy(control_policy(&world, 1000))
        .unwrap();
    let first = world.request_fare_control_hold(&request("case-1")).unwrap();
    let replay = world.request_fare_control_hold(&request("case-1")).unwrap();
    assert_eq!(first, replay);
    let bundled = world.request_fare_control_hold(&request("case-2")).unwrap();
    assert_eq!(bundled.case_ids.len(), 2);
    assert_eq!(bundled.hold_id, first.hold_id);
    let mut world = active_world(10_000);
    let hold = world.fare_control_hold("train:stops").unwrap().clone();
    let mut next = control_policy(&world, 60_000);
    next.schedule_period_id = "test-period-2".into();
    next.content_hash = fare_control_policy_hash(&next);
    world.set_fare_control_policy(next).unwrap();
    assert_eq!(world.fare_control_hold("train:stops").unwrap(), &hold);
    assert!(
        world
            .request_fare_control_hold(&request("case-late"))
            .is_err()
    );
    let mut resolution = ResolveFareControlHoldInputV1 {
        train_id: hold.train_run_id.clone(),
        hold_id: hold.hold_id.clone(),
        expected_revision: hold.revision,
        model_hash: "b".repeat(64),
        outcome: ResolveFareControlHoldOutcomeV1::IdentityNotConfirmed,
        causality_id: "test-resolved".into(),
    };
    assert!(world.resolve_fare_control_hold(&resolution).is_err());
    resolution.model_hash = hold.model_hash;
    world.advance_to(world.now_ms + 1000).unwrap();
    let released = world.resolve_fare_control_hold(&resolution).unwrap();
    assert_eq!(
        released.outcome,
        Some(FareControlHoldOutcomeV1::IdentityNotConfirmed)
    );
    assert!(world.resolve_fare_control_hold(&resolution).is_err());
    world.verify_invariants().unwrap();
}

#[test]
fn hoechstfristen_sind_partitionierungsunabhaengig_und_restore_prueft_holdstruktur() {
    for wait in [1, 2, 17, 1000, 30_000, 60_000] {
        let mut world = active_world(wait);
        let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
        let at = world.now_ms;
        let final_at = at + wait;
        world.advance_to(final_at).unwrap();
        for tick in 1..=7 {
            restored.advance_to(at + wait * tick / 7).unwrap();
            restored.verify_invariants().unwrap();
        }
        assert_eq!(world.state_hash(), restored.state_hash(), "{wait}");
        world.verify_invariants().unwrap();
    }
    let world = active_world(10_000);
    let value = serde_json::to_value(&world).unwrap();
    for index in 0..5 {
        let mut bad = value.clone();
        let hold = &mut bad["fareControlState"]["holds"]["train:stops"];
        match index {
            0 => hold["worldId"] = "foreign".into(),
            1 => hold["deadlineMs"] = (world.now_ms + 100_000).into(),
            2 => hold["caseIds"] = serde_json::json!([]),
            3 => hold["targetStopId"] = "missing".into(),
            _ => hold["status"] = "requested".into(),
        };
        let invalid: OperationalWorld = serde_json::from_value(bad).unwrap();
        assert!(invalid.verify_invariants().is_err(), "{index}");
    }
}

#[test]
fn regionaler_handover_uebertraegt_die_eine_aktive_wartefolge() {
    let mut source = active_world(10_000);
    let (infra, _) = passenger_stop_fixture();
    let mut target = OperationalWorld::new("world:1", "region:b", source.now_ms, infra).unwrap();
    let mut handover = source
        .begin_handover(
            "fare-control-transfer",
            "train:stops",
            "region:b",
            BTreeSet::from(["boundary:west".into()]),
        )
        .unwrap();
    let original = source.fare_control_hold("train:stops").unwrap().clone();
    target.accept_handover(&mut handover).unwrap();
    source.finish_handover(&handover).unwrap();
    assert!(source.fare_control_hold("train:stops").is_none());
    assert_eq!(target.fare_control_hold("train:stops"), Some(&original));
    target.verify_invariants().unwrap();
    source.verify_invariants().unwrap();
    target.advance_to(original.deadline_ms.unwrap()).unwrap();
    target.verify_invariants().unwrap();
    assert_eq!(
        target.fare_control_hold("train:stops").unwrap().outcome,
        Some(FareControlHoldOutcomeV1::Timeout)
    );
}

fn control_policy(
    world: &OperationalWorld,
    max_wait_ms: i64,
) -> zugfolge_sim::operational::FareControlPolicyV1 {
    use zugfolge_sim::operational::*;
    let mut policy = FareControlPolicyV1 {
        schema: FARE_CONTROL_POLICY_SCHEMA.into(),
        policy_id: "test-only-policy".into(),
        revision: 1,
        world_id: world.world_id.clone(),
        schedule_period_id: "test-period-1".into(),
        content_hash: String::new(),
        max_police_holds_per_train_run: 1,
        eligible_reasons: BTreeSet::from([
            FareControlReasonV1::IdentityRefusal,
            FareControlReasonV1::ConcreteDanger,
        ]),
        target_rule: "next_unreached_scheduled_passenger_stop".into(),
        provider_by_stop_id: BTreeMap::from([
            ("train:stops:1".into(), "test-provider".into()),
            ("train:stops:2".into(), "test-provider".into()),
        ]),
        max_wait_ms,
        police_response_model_id: "test-model".into(),
        police_response_model_hash: "a".repeat(64),
        public_cause: FARE_CONTROL_CAUSE.into(),
    };
    policy.content_hash = fare_control_policy_hash(&policy);
    policy
}

#[test]
fn mehrzug_folge_kreuzung_und_rangieren_nutzen_dieselben_konfliktressourcen() {
    for wait in [1000, 10_000, 60_000] {
        let (mut infra, input) = passenger_stop_fixture();
        infra.directed_edges.insert("edge:cross".into(), 60_000);
        infra
            .edge_geometries
            .insert("edge:cross".into(), infra.edge_geometries["edge:a"].clone());
        let mut leg = infra.route_versions["route:v1"].legs[0].clone();
        leg.edge_id = "edge:cross".into();
        leg.edge_entry_mm = 0;
        leg.edge_exit_mm = 60_000;
        leg.route_start_mm = 0;
        leg.block_ids = BTreeSet::from(["block:stop:2".into()]);
        infra.route_versions.insert(
            "route:cross".into(),
            RouteVersion {
                id: "route:cross".into(),
                template_id: "route-template:cross".into(),
                predecessor_id: None,
                transition_route_mm: None,
                legs: vec![leg],
            },
        );
        for (kind, id) in [
            (MovementKind::Train, "cross"),
            (MovementKind::Shunting, "yard"),
        ] {
            let mut template = infra.interlocking_routes["interlocking:train:b"].clone();
            template.id = format!("interlocking:{id}");
            template.route_template_id = "route-template:cross".into();
            template.signal_id = format!("signal:{id}");
            template.authority_start_route_mm = 0;
            template.authority_end_route_mm = 60_000;
            template.release_after_tail_route_mm = 60_000;
            template.movement_kind = kind;
            template.path_resources = BTreeSet::from(["block:stop:2".into()]);
            template.switch_positions.clear();
            infra.signals.insert(template.signal_id.clone());
            infra
                .interlocking_routes
                .insert(template.id.clone(), template);
        }
        let mut world = world_with_release(infra);
        world.materialize(input).unwrap();
        world
            .set_fare_control_policy(control_policy(&world, wait))
            .unwrap();
        world.request_fare_control_hold(&request("case-1")).unwrap();
        world
            .lock_route("train:stops", "interlocking:train")
            .unwrap();
        world.advance_to(1000).unwrap();
        advance_stop_train_until_standing(&mut world);
        world.advance_to(world.now_ms + 17_000).unwrap();
        world
            .submit_dispatch_requests(&[dispatch_request(
                "train:stops",
                "interlocking:train:b",
                world.now_ms,
            )])
            .unwrap();
        advance_stop_train_until_standing(&mut world);
        world.advance_to(world.now_ms + 5000).unwrap();
        world
            .register_vehicle(vehicle("vehicle:4", "type:short"))
            .unwrap();
        world
            .create_formation("formation:4", None, vec!["vehicle:4".into()])
            .unwrap();
        for (id, number, kind, route, formation, head) in [
            (
                "train:follower",
                "RB 2",
                MovementKind::Train,
                "route:v1",
                "formation:2",
                10_000,
            ),
            (
                "train:cross",
                "G 3",
                MovementKind::Train,
                "route:cross",
                "formation:3",
                0,
            ),
            (
                "train:yard",
                "Rf 4",
                MovementKind::Shunting,
                "route:cross",
                "formation:4",
                0,
            ),
        ] {
            world
                .materialize(TrainMaterialization {
                    stop_plan: None,
                    service_outcome: None,
                    id: id.into(),
                    train_number: number.into(),
                    operator_id: "operator:1".into(),
                    movement_kind: kind,
                    route_version_id: route.into(),
                    formation_version_id: formation.into(),
                    head_route_mm: head,
                    scheduled_departure_ms: None,
                    public_passenger_stop: false,
                })
                .unwrap();
        }
        let mut replay = OperationalWorld::restore(&world.checkpoint()).unwrap();
        let requests = vec![
            dispatch_request("train:follower", "interlocking:train", world.now_ms),
            dispatch_request("train:cross", "interlocking:cross", world.now_ms),
            dispatch_request("train:yard", "interlocking:yard", world.now_ms),
        ];
        world.submit_dispatch_requests(&requests).unwrap();
        let mut permutation = requests;
        permutation.reverse();
        replay.submit_dispatch_requests(&permutation).unwrap();
        assert_eq!(world.state_hash(), replay.state_hash());
        assert!(world.trains["train:cross"].authority.is_none());
        assert!(world.trains["train:yard"].authority.is_none());
        let deadline = world
            .fare_control_hold("train:stops")
            .unwrap()
            .deadline_ms
            .unwrap();
        let start = world.now_ms;
        for step in 1..=8 {
            let at = start + (deadline - start) * step / 8;
            world.advance_to(at).unwrap();
            replay.advance_to(at).unwrap();
            world.verify_invariants().unwrap();
            replay.verify_invariants().unwrap();
            assert_eq!(world.state_hash(), replay.state_hash());
        }
        assert!(world.trains["train:stops"].authority.is_some());
        assert!(world.trains["train:cross"].authority.is_none());
        assert!(world.trains["train:yard"].authority.is_none());
        let events = world
            .events
            .iter()
            .filter(|e| e.kind == "dispatcher-decision")
            .map(|e| e.subject_id.as_str())
            .collect::<Vec<_>>();
        assert!(events.contains(&"train:stops"));
        assert!(!events.contains(&"train:cross") && !events.contains(&"train:yard"));
    }
}

#[test]
fn verbindlicher_planabbruch_friert_istposition_ein_und_beendet_nur_unaktivierte_holds() {
    let (infra, input) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    world
        .set_fare_control_policy(control_policy(&world, 10_000))
        .unwrap();
    world.request_fare_control_hold(&request("case-1")).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    world.advance_to(1000).unwrap();
    let segment = world.trains["train:stops"].motion_segment.clone().unwrap();
    let now = segment.started_at_ms + (segment.valid_until_ms - segment.started_at_ms) / 2;
    world.advance_to(now).unwrap();
    let expected_head = segment.position_at(now).unwrap();
    let prefix = world.trains["train:stops"]
        .passenger_stops
        .as_ref()
        .unwrap()
        .receipts
        .clone();
    let mut cancellation = CancelPassengerStopPlanInputV1 {
        train_id: "train:stops".into(),
        expected_stop_plan_hash: "b".repeat(64),
        causality_id: "test-disposition-cancel".into(),
    };
    let unchanged = world.state_hash();
    assert!(world.cancel_passenger_stop_plan(&cancellation).is_err());
    assert_eq!(unchanged, world.state_hash());
    cancellation.expected_stop_plan_hash = world.trains["train:stops"]
        .passenger_stops
        .as_ref()
        .unwrap()
        .plan_hash
        .clone();
    let receipt = world.cancel_passenger_stop_plan(&cancellation).unwrap();
    assert_eq!(world.trains["train:stops"].head_route_mm, expected_head);
    assert_eq!(
        world.trains["train:stops"]
            .passenger_stops
            .as_ref()
            .unwrap()
            .receipts,
        prefix
    );
    assert!(!world.route_locks.is_empty());
    assert!(!world.trains["train:stops"].occupied_intervals.is_empty());
    assert_eq!(
        world.fare_control_hold("train:stops").unwrap().outcome,
        Some(FareControlHoldOutcomeV1::TargetUnavailable)
    );
    assert_eq!(
        world.cancel_passenger_stop_plan(&cancellation).unwrap(),
        receipt
    );
    assert!(world.request_fare_control_hold(&request("case-2")).is_err());
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    world.advance_to(now + 100_000).unwrap();
    restored.advance_to(now + 100_000).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    world.verify_invariants().unwrap();
    assert_eq!(world.trains["train:stops"].head_route_mm, expected_head);
    assert_eq!(
        world.trains["train:stops"]
            .passenger_stops
            .as_ref()
            .unwrap()
            .receipts,
        prefix
    );

    let mut active = active_world(10_000);
    let prior = active.fare_control_hold("train:stops").unwrap().clone();
    cancellation.expected_stop_plan_hash = active.trains["train:stops"]
        .passenger_stops
        .as_ref()
        .unwrap()
        .plan_hash
        .clone();
    active.cancel_passenger_stop_plan(&cancellation).unwrap();
    assert_eq!(active.fare_control_hold("train:stops").unwrap(), &prior);
    active.advance_to(prior.deadline_ms.unwrap()).unwrap();
    active.verify_invariants().unwrap();
    assert_eq!(
        active.fare_control_hold("train:stops").unwrap().outcome,
        Some(FareControlHoldOutcomeV1::Timeout)
    );
    assert!(active.trains["train:stops"].authority.is_none());
    assert!(matches!(
        active.trains["train:stops"].motion_state,
        MotionState::SafeStop { .. }
    ));
}

#[test]
fn kontrollhalt_aktiviert_nur_nach_istbereitschaft_und_fdl_erteilt_neue_zustimmung() {
    use zugfolge_sim::operational::*;
    let (infra, input) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    world
        .set_fare_control_policy(control_policy(&world, 10_000))
        .unwrap();
    let request = RequestFareControlHoldInputV1 {
        train_id: "train:stops".into(),
        case_id: "test-case-1".into(),
        reason: FareControlReasonV1::IdentityRefusal,
        causality_id: "test-request".into(),
    };
    let hold = world.request_fare_control_hold(&request).unwrap();
    assert_eq!(hold.target_stop_id, "train:stops:1");
    assert_eq!(world.trains["train:stops"].head_route_mm, 10_000);
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    world.advance_to(1000).unwrap();
    advance_stop_train_until_standing(&mut world);
    world.advance_to(world.now_ms + 17_000).unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    let arrival = world.now_ms;
    let old_authority = world.trains["train:stops"].authority.clone().unwrap();
    let old_locks = world.route_locks.clone();
    let occupied = world.trains["train:stops"].occupied_intervals.clone();
    world.advance_to(arrival + 4_999).unwrap();
    assert_eq!(
        world.fare_control_hold("train:stops").unwrap().status,
        FareControlHoldStatusV1::Requested
    );
    world.advance_to(arrival + 5_000).unwrap();
    world.verify_invariants().unwrap();
    assert_eq!(
        world.fare_control_hold("train:stops").unwrap().status,
        FareControlHoldStatusV1::Active
    );
    assert!(world.trains["train:stops"].authority.is_none());
    assert_eq!(world.route_locks, old_locks);
    assert_eq!(world.trains["train:stops"].occupied_intervals, occupied);
    assert!(world.plan_motion("train:stops").is_err());
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    world.advance_to(arrival + 15_000).unwrap();
    restored.advance_to(arrival + 15_000).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    world.verify_invariants().unwrap();
    let released = world.fare_control_hold("train:stops").unwrap();
    assert_eq!(released.status, FareControlHoldStatusV1::Released);
    assert_eq!(released.outcome, Some(FareControlHoldOutcomeV1::Timeout));
    assert_ne!(
        world.trains["train:stops"].authority.as_ref().unwrap().id,
        old_authority.id
    );
    assert_eq!(
        world.trains["train:stops"]
            .authority
            .as_ref()
            .unwrap()
            .issued_at_ms,
        arrival + 15_000
    );
    assert!(world.request_fare_control_hold(&request).is_err());
}

#[test]
fn endbahnhof_hold_verhindert_vorzeitige_fortsetzung_und_gibt_die_echte_formation_frei() {
    let (mut infra, input) = passenger_stop_fixture();
    let mut seed = infra.route_versions["route:v1"]
        .legs
        .last()
        .unwrap()
        .clone();
    seed.edge_entry_mm = 10_000;
    seed.edge_exit_mm = 0;
    seed.route_start_mm = 0;
    seed.block_ids = BTreeSet::from(["block:successor:seed".into()]);
    let mut exit = infra.route_versions["route:v1"].legs[0].clone();
    exit.edge_id = "edge:successor".into();
    exit.edge_entry_mm = 0;
    exit.edge_exit_mm = 60_000;
    exit.route_start_mm = 10_000;
    exit.block_ids = BTreeSet::from(["block:successor:exit".into()]);
    infra.directed_edges.insert(exit.edge_id.clone(), 60_000);
    let mut geometry = infra.edge_geometries["edge:a"].clone();
    for point in &mut geometry {
        point.longitude_e7 += 60_000;
    }
    infra.edge_geometries.insert(exit.edge_id.clone(), geometry);
    infra.route_versions.insert(
        "route:successor".into(),
        RouteVersion {
            id: "route:successor".into(),
            template_id: "template:successor".into(),
            predecessor_id: Some("route:v1".into()),
            transition_route_mm: Some(10_000),
            legs: vec![seed, exit],
        },
    );
    for (part, start, end) in [("seed", 0, 10_000), ("exit", 10_000, 70_000)] {
        let id = format!("interlocking:successor:{part}");
        let mut route = infra.interlocking_routes["interlocking:train:c"].clone();
        route.id = id.clone();
        route.route_template_id = "template:successor".into();
        route.signal_id = format!("signal:{id}");
        route.authority_start_route_mm = start;
        route.authority_end_route_mm = end;
        route.release_after_tail_route_mm = end;
        route.path_resources = BTreeSet::from([format!("block:successor:{part}")]);
        route.overlap_resources = BTreeSet::from([format!("overlap:successor:{part}")]);
        route.flank_resources = BTreeSet::from([format!("flank:successor:{part}")]);
        route.switch_positions.clear();
        infra.block_resources.extend(
            route
                .path_resources
                .iter()
                .chain(&route.overlap_resources)
                .chain(&route.flank_resources)
                .cloned(),
        );
        infra.signals.insert(route.signal_id.clone());
        infra.interlocking_routes.insert(id, route);
    }
    let mut world = world_with_release(infra);
    world.materialize(input).unwrap();
    world
        .set_fare_control_policy(control_policy(&world, 600_000))
        .unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    world.advance_to(1000).unwrap();
    advance_stop_train_until_standing(&mut world);
    world.advance_to(world.now_ms + 17_000).unwrap();
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    let hold = world
        .request_fare_control_hold(&request("terminal-case"))
        .unwrap();
    assert_eq!(hold.target_stop_id, "train:stops:2");
    world.advance_to(world.now_ms + 5_000).unwrap();
    advance_stop_train_until_standing(&mut world);
    assert_eq!(
        world.fare_control_hold("train:stops").unwrap().status,
        FareControlHoldStatusV1::Active
    );
    world.verify_invariants().unwrap();
    let deadline = world
        .fare_control_hold("train:stops")
        .unwrap()
        .deadline_ms
        .unwrap();
    world
        .queue_movement_continuation(MovementContinuation {
            id: "test-terminal-continuation".into(),
            predecessor_train_id: "train:stops".into(),
            predecessor_base_route_version_id: "route:v1".into(),
            successor: TrainMaterialization {
                stop_plan: None,
                service_outcome: None,
                id: "train:successor".into(),
                train_number: "RB 2".into(),
                operator_id: "operator:1".into(),
                movement_kind: MovementKind::Train,
                route_version_id: "route:successor".into(),
                formation_version_id: "formation:1".into(),
                head_route_mm: 10_000,
                scheduled_departure_ms: None,
                public_passenger_stop: false,
            },
            successor_dispatch: dispatch_request(
                "train:successor",
                "interlocking:successor:exit",
                world.now_ms,
            ),
            not_before_ms: world.now_ms,
            minimum_dwell_ms: 300_000,
            continuity: MovementContinuity::SameDirection,
        })
        .unwrap();
    assert!(!world.trains.contains_key("train:successor"));
    assert!(world.retire_train("train:stops").is_err());
    let mut restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    world.advance_to(deadline - 1).unwrap();
    assert!(!world.trains.contains_key("train:successor"));
    world.advance_to(deadline).unwrap();
    restored.advance_to(deadline).unwrap();
    assert_eq!(world.state_hash(), restored.state_hash());
    world.verify_invariants().unwrap();
    assert!(!world.trains.contains_key("train:stops"));
    assert_eq!(
        world.trains["train:successor"].formation_version_id,
        "formation:1"
    );
    assert_eq!(
        world.fare_control_hold("train:stops").unwrap().outcome,
        Some(FareControlHoldOutcomeV1::Timeout)
    );
}
