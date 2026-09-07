//! Sitzung durch echte M5-Kompilation, Betriebsbelege, M10 und den freigegebenen Dialogkorpus.
mod support;
use support::Fixture;
use zugfolge_conductor_dialogue::*;
use zugfolge_conductor_session::*;

#[test]
fn effektive_m10_ist_und_prognosezeiten_muessen_keine_planzeiten_vortaeuschen() {
    let mut fixture = Fixture::new();
    let previous = fixture
        .source
        .projection
        .as_ref()
        .unwrap()
        .evaluation
        .clone();
    let services = fixture.demand.services.clone();
    fixture.demand.previous_evaluation =
        Some(Box::new(zugfolge_demand::PreviousDemandEvaluationV1 {
            result: previous,
            services,
        }));
    fixture.demand.revision += 1;
    fixture.demand.services[0].stops[0].arrival_ms = 0;
    fixture.demand.services[0].stops[1].arrival_ms += 5000;
    fixture.demand.services[0].stops[1].departure_ms += 5000;
    let evaluated = zugfolge_demand::evaluate_demand(&fixture.demand).unwrap();
    let layout =
        zugfolge_conductor::build_interior_layout(fixture.source.interior.as_ref().unwrap())
            .unwrap();
    fixture.source.projection = Some(support::interior::projection_input(
        &layout,
        &fixture.demand,
        evaluated,
    ));
    let input = fixture.input(
        fixture.initial(),
        "effective-times",
        ConductorCommandActionV1::StartSession,
    );
    assert!(apply_conductor_session_command(&input).is_ok());
    let mut wrong = input;
    wrong
        .source
        .projection
        .as_mut()
        .unwrap()
        .service
        .stops
        .swap(1, 2);
    assert_eq!(
        apply_conductor_session_command(&wrong).unwrap_err().0,
        "conductor_stop_plan_mismatch"
    );
}

#[test]
fn echter_m10_watermark_darf_eine_millisekunde_hinter_dem_betrieb_liegen() {
    let mut fixture = Fixture::new();
    fixture
        .source
        .operational_world
        .advance_to(fixture.source.operational_world.now_ms + 1)
        .unwrap();
    fixture.source.expected_operational_world_hash =
        operational_world_hash(&fixture.source.operational_world);
    let input = fixture.input(
        fixture.initial(),
        "watermark",
        ConductorCommandActionV1::StartSession,
    );
    let started = apply_conductor_session_command(&input).unwrap();
    assert_eq!(
        started.state.now_ms,
        fixture.source.operational_world.now_ms
    );
    assert_eq!(
        started.state.passengers.as_ref().unwrap().as_of_ms,
        fixture
            .source
            .projection
            .as_ref()
            .unwrap()
            .evaluation
            .now_ms
    );
}

fn start(fixture: &Fixture) -> ConductorTrainStateV1 {
    apply_conductor_session_command(&fixture.input(
        fixture.initial(),
        "start",
        ConductorCommandActionV1::StartSession,
    ))
    .unwrap()
    .state
}

#[test]
fn nativ_quittierter_fahrtabbruch_beendet_die_sitzung_ohne_neue_manifestquelle() {
    let mut fixture = Fixture::new();
    let state = start(&fixture);
    let world = &mut fixture.source.operational_world;
    let plan_hash = world.trains["regional-1"]
        .passenger_stops
        .as_ref()
        .unwrap()
        .plan_hash
        .clone();
    world
        .cancel_passenger_stop_plan(&zugfolge_sim::operational::CancelPassengerStopPlanInputV1 {
            train_id: "regional-1".into(),
            expected_stop_plan_hash: plan_hash,
            causality_id: "test-real-cancellation".into(),
        })
        .unwrap();
    fixture.source.expected_operational_world_hash = operational_world_hash(world);
    fixture.source.interior = None;
    fixture.source.projection = None;
    let result = synchronize_conductor_session(&fixture.sync(state, "cancelled")).unwrap();
    assert_eq!(
        result.snapshot.unwrap().status,
        ConductorSessionStatusV1::Ended
    );
    assert_eq!(
        result.state.session.unwrap().end_reason,
        Some(ConductorSessionEndReasonV1::TrainUnavailable)
    );
}
fn inspect(fixture: &Fixture, state: ConductorTrainStateV1) -> ConductorSessionTransitionV1 {
    let position = &state.session.as_ref().unwrap().position;
    let layout = state.layout.as_ref().unwrap();
    let passenger = state
        .passengers
        .as_ref()
        .unwrap()
        .passengers
        .iter()
        .find(|passenger| {
            let target = if passenger.space_needs == zugfolge_demand::SpaceNeedsV1::Wheelchair {
                passenger.space_id.as_ref().unwrap()
            } else {
                &passenger.place_id
            };
            let interaction = layout
                .interactions
                .iter()
                .find(|i| i.target_id == *target)
                .unwrap();
            let p = &layout
                .nodes
                .iter()
                .find(|n| n.node_id == interaction.node_id)
                .unwrap()
                .point;
            p.vehicle_id == position.vehicle_id
                && p.body_id == position.body_id
                && p.deck_id == position.deck_id
                && p.x_mm.abs_diff(position.x_mm) + p.y_mm.abs_diff(position.y_mm) <= 2500
        })
        .expect("echter Fahrgast nahe dem Einstieg")
        .passenger_key
        .clone();
    apply_conductor_session_command(&fixture.input(
        state,
        "inspect",
        ConductorCommandActionV1::StartInspection {
            passenger_key: passenger,
        },
    ))
    .unwrap()
}

#[test]
fn echte_quellen_starten_eine_wiederherstellbare_sitzung() {
    let fixture = Fixture::new();
    let input = fixture.input(
        fixture.initial(),
        "start",
        ConductorCommandActionV1::StartSession,
    );
    assert_eq!(
        fixture
            .materialization
            .stop_plan
            .as_ref()
            .unwrap()
            .infrastructure_release_id,
        fixture.infrastructure.id
    );
    let result = apply_conductor_session_command(&input).unwrap();
    assert_eq!(result.events.len(), 1);
    assert!(
        result
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .is_none()
    );
    assert_eq!(result.state.session.as_ref().unwrap().revision, 1);
    let restored = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version: "conductor-session-restore-input/v1".into(),
        state: result.state.clone(),
        expected_state_hash: result.state_hash.clone(),
        dialogue_releases: fixture.source.dialogue_releases.clone(),
    })
    .unwrap();
    assert_eq!(restored, result.state);
    let visible = serde_json::to_string(&result.snapshot).unwrap();
    for forbidden in ["ownerRef", "fareFact", "treeId", "selectionHash"] {
        assert!(!visible.contains(forbidden), "{forbidden}");
    }
}

#[test]
fn echte_ankunft_ausstieg_und_fahrtende_beenden_ohne_neue_forderung() {
    let mut fixture = Fixture::new();
    let mut state = start(&fixture);
    fixture.advance(650_000);
    fixture
        .source
        .operational_world
        .lock_route("regional-1", "interlocking:train:b")
        .unwrap();
    fixture
        .source
        .operational_world
        .plan_motion("regional-1")
        .unwrap();
    fixture.advance(700_000);
    assert!(
        fixture.source.operational_world.trains["regional-1"]
            .passenger_stops
            .as_ref()
            .unwrap()
            .receipts[1]
            .actual_arrival_ms
            .is_some(),
        "{:?}",
        fixture.source.operational_world.trains["regional-1"]
    );
    let at_stop = synchronize_conductor_session(&fixture.sync(state, "arrival")).unwrap();
    state = at_stop.state;
    let alighting = state
        .passengers
        .as_ref()
        .unwrap()
        .passengers
        .iter()
        .find(|p| p.activity == zugfolge_conductor::PassengerActivityV1::Alighting)
        .expect("echter Aussteiger")
        .passenger_key
        .clone();
    assert_eq!(
        apply_conductor_session_command(&fixture.input(
            state.clone(),
            "alighting",
            ConductorCommandActionV1::StartInspection {
                passenger_key: alighting
            }
        ))
        .unwrap_err()
        .0,
        "conductor_passenger_alighting"
    );
    for at in [1_100_000, 1_500_000, 1_900_000] {
        fixture.advance(at);
        state = apply_conductor_session_command(&fixture.input(
            state,
            &format!("keep-{at}"),
            ConductorCommandActionV1::ResumeSession,
        ))
        .unwrap()
        .state;
    }
    fixture.advance(1_950_000);
    state = synchronize_conductor_session(&fixture.sync(state, "depart"))
        .unwrap()
        .state;
    fixture
        .source
        .operational_world
        .lock_route("regional-1", "interlocking:train:c")
        .unwrap();
    fixture
        .source
        .operational_world
        .plan_motion("regional-1")
        .unwrap();
    fixture.advance(2_100_000);
    let completed = synchronize_conductor_session(&fixture.sync(state, "terminal")).unwrap();
    assert_eq!(
        completed.state.session.unwrap().end_reason,
        Some(ConductorSessionEndReasonV1::TrainCompleted)
    );
    assert!(completed.effects.is_empty());
}

#[test]
fn laufende_begegnung_behaelt_den_gepinnten_release() {
    let mut fixture = Fixture::new();
    let inspection = inspect(&fixture, start(&fixture));
    let before = inspection
        .snapshot
        .as_ref()
        .unwrap()
        .active_encounter
        .clone();
    let old = inspection
        .state
        .session
        .as_ref()
        .unwrap()
        .pins
        .dialogue_release_hash
        .clone();
    let mut next = fixture.source.dialogue_releases[0].clone();
    next.release_id = "test-only-next-period-dialogue".into();
    fixture.source.current_dialogue_release_hash = dialogue_release_hash(&next).unwrap();
    fixture.source.dialogue_releases.push(next);
    let resumed = apply_conductor_session_command(&fixture.input(
        inspection.state,
        "new-current-release",
        ConductorCommandActionV1::ResumeSession,
    ))
    .unwrap();
    assert_eq!(resumed.snapshot.as_ref().unwrap().active_encounter, before);
    assert_eq!(
        resumed
            .state
            .session
            .as_ref()
            .unwrap()
            .pins
            .dialogue_release_hash,
        old
    );
}

#[test]
fn exklusivitaet_rechte_revision_und_quellenbindung_sind_verbindlich() {
    let fixture = Fixture::new();
    let state = start(&fixture);
    let mut input = fixture.input(
        state.clone(),
        "second",
        ConductorCommandActionV1::StartSession,
    );
    input.command.expected_revision = 0;
    input.command.session_id = "other".into();
    input.access.owner_ref = "other-owner".into();
    assert_eq!(
        apply_conductor_session_command(&input).unwrap_err().0,
        "conductor_train_reserved"
    );
    let mut input = fixture.input(
        fixture.initial(),
        "other-train",
        ConductorCommandActionV1::StartSession,
    );
    input.access.other_active_session_id = Some("reserved".into());
    assert_eq!(
        apply_conductor_session_command(&input).unwrap_err().0,
        "conductor_account_reserved"
    );
    for index in 0..5 {
        let mut input = fixture.input(
            state.clone(),
            "bad",
            ConductorCommandActionV1::ResumeSession,
        );
        match index {
            0 => input.access.world_id = "foreign".into(),
            1 => input.access.owner_ref = "foreign".into(),
            2 => input.access.operator_id = "foreign".into(),
            3 => input.access.world_access_active = false,
            _ => input.command.expected_revision = 0,
        };
        assert!(apply_conductor_session_command(&input).is_err(), "{index}");
    }
    let mut input = fixture.input(
        fixture.initial(),
        "bad-world",
        ConductorCommandActionV1::StartSession,
    );
    input.source.expected_operational_world_hash = "a".repeat(64);
    assert_eq!(
        apply_conductor_session_command(&input).unwrap_err().0,
        "conductor_operational_binding_mismatch"
    );
    let mut input = fixture.input(
        fixture.initial(),
        "bad-formation",
        ConductorCommandActionV1::StartSession,
    );
    input.source.interior.as_mut().unwrap().binding.formation_id = "unknown".into();
    assert_eq!(
        apply_conductor_session_command(&input).unwrap_err().0,
        "conductor_fleet_formation_missing"
    );
    let mut input = fixture.input(
        fixture.initial(),
        "bad-stop",
        ConductorCommandActionV1::StartSession,
    );
    input.source.projection.as_mut().unwrap().service.stops[0].station_id = "foreign".into();
    assert_eq!(
        apply_conductor_session_command(&input).unwrap_err().0,
        "conductor_stop_plan_mismatch"
    );
}

#[test]
fn idempotente_quittung_und_replay_bleiben_bitgleich() {
    let fixture = Fixture::new();
    let initial = fixture.initial();
    let first = fixture.input(
        initial.clone(),
        "start",
        ConductorCommandActionV1::StartSession,
    );
    let started = apply_conductor_session_command(&first).unwrap();
    let detach = fixture.input(
        started.state.clone(),
        "detach",
        ConductorCommandActionV1::DetachSession,
    );
    let detached = apply_conductor_session_command(&detach).unwrap();
    let mut duplicate = first.clone();
    duplicate.state = detached.state.clone();
    duplicate.expected_state_hash = duplicate.state.state_hash.clone();
    let repeated = apply_conductor_session_command(&duplicate).unwrap();
    assert_eq!(repeated.receipt, started.receipt);
    assert_eq!(repeated.state, detached.state);
    assert!(repeated.events.is_empty() && repeated.effects.is_empty());
    duplicate.command.action = ConductorCommandActionV1::EndSession;
    assert_eq!(
        apply_conductor_session_command(&duplicate).unwrap_err().0,
        "conductor_idempotency_conflict"
    );
    let replay = ReplayConductorSessionInputV1 {
        schema_version: "conductor-session-replay-input/v1".into(),
        expected_initial_state_hash: initial.state_hash.clone(),
        initial_state: initial,
        dialogue_releases: fixture.source.dialogue_releases.clone(),
        steps: vec![
            ConductorSessionReplayStepV1::Command {
                command: Box::new(first.command),
                access: first.access,
                source: Box::new(first.source),
                expected_result_hash: started.state_hash,
            },
            ConductorSessionReplayStepV1::Command {
                command: Box::new(detach.command),
                access: detach.access,
                source: Box::new(detach.source),
                expected_result_hash: detached.state_hash,
            },
        ],
    };
    assert_eq!(replay_conductor_session(&replay).unwrap(), detached.state);
    let mut bad = replay;
    bad.steps.reverse();
    assert!(replay_conductor_session(&bad).is_err());
}

#[test]
fn reload_disconnect_und_end_session_bewahren_dialog_und_kontrollhalt() {
    let fixture = Fixture::new();
    let inspection = inspect(&fixture, start(&fixture));
    let encounter = inspection
        .snapshot
        .as_ref()
        .unwrap()
        .active_encounter
        .clone();
    let passenger_key = inspection.state.encounters[&encounter.as_ref().unwrap().encounter_id]
        .passenger_key
        .clone();
    assert_eq!(
        inspection
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .as_ref(),
        Some(&passenger_key)
    );
    let other_passenger = inspection
        .state
        .passengers
        .as_ref()
        .unwrap()
        .passengers
        .iter()
        .find(|passenger| passenger.passenger_key != passenger_key)
        .unwrap()
        .passenger_key
        .clone();
    assert_eq!(
        apply_conductor_session_command(&fixture.input(
            inspection.state.clone(),
            "other-selection",
            ConductorCommandActionV1::StartInspection {
                passenger_key: other_passenger,
            },
        ))
        .unwrap_err()
        .0,
        "conductor_encounter_active"
    );
    let detached = apply_conductor_session_command(&fixture.input(
        inspection.state.clone(),
        "detach",
        ConductorCommandActionV1::DetachSession,
    ))
    .unwrap();
    assert_eq!(
        detached.snapshot.as_ref().unwrap().active_encounter,
        encounter
    );
    assert_eq!(
        detached
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .as_ref(),
        Some(&passenger_key)
    );
    let restored = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version: "conductor-session-restore-input/v1".into(),
        state: detached.state.clone(),
        expected_state_hash: detached.state_hash,
        dialogue_releases: fixture.source.dialogue_releases.clone(),
    })
    .unwrap();
    let reloaded = project_conductor_session_snapshot(&ProjectConductorSessionSnapshotInputV1 {
        schema_version: "conductor-session-project-input/v1".into(),
        expected_state_hash: restored.state_hash.clone(),
        state: restored.clone(),
        access: fixture.access(),
        source: fixture.source.clone(),
    })
    .unwrap();
    assert_eq!(reloaded.active_passenger_key.as_ref(), Some(&passenger_key));
    assert_eq!(reloaded.active_encounter, encounter);
    let resumed = apply_conductor_session_command(&fixture.input(
        restored,
        "resume",
        ConductorCommandActionV1::ResumeSession,
    ))
    .unwrap();
    assert_eq!(
        resumed.snapshot.as_ref().unwrap().active_encounter,
        encounter
    );
    assert_eq!(
        resumed
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .as_ref(),
        Some(&passenger_key)
    );
    let encounter_id = encounter.unwrap().encounter_id;
    let mut sync = fixture.sync(resumed.state, "control-receipt");
    sync.source
        .control_receipts
        .push(ConductorSessionControlReceiptV1 {
            world_id: sync.state.world_id.clone(),
            train_run_id: sync.state.train_run_id.clone(),
            effect_id: "test-only-accepted-hold-effect".into(),
            encounter_id,
            kind: ConductorControlReceiptKindV1::Hold,
            domain_receipt_id: "test-only-operational-hold-receipt".into(),
            domain_state_hash: "d".repeat(64),
        });
    let held = synchronize_conductor_session(&sync).unwrap();
    let ended = apply_conductor_session_command(&fixture.input(
        held.state,
        "end",
        ConductorCommandActionV1::EndSession,
    ))
    .unwrap();
    assert_eq!(ended.state.control_receipts.len(), 1);
    assert_eq!(
        ended.state.session.as_ref().unwrap().end_reason,
        Some(ConductorSessionEndReasonV1::Requested)
    );
    let ended_snapshot = ended.snapshot.unwrap();
    assert!(ended_snapshot.active_encounter.is_none());
    assert!(ended_snapshot.active_passenger_key.is_none());
    assert!(
        !serde_json::to_string(&ended_snapshot)
            .unwrap()
            .contains("activePassengerKey")
    );
    assert_eq!(ended.effects.len(), 1);
}

#[test]
fn aktive_begegnung_verlangt_den_tatsaechlichen_sichtbaren_fahrgast() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    let inspection = inspect(&fixture, start(&fixture));
    let key = inspection
        .snapshot
        .as_ref()
        .unwrap()
        .active_passenger_key
        .as_ref()
        .unwrap();
    let mut state = inspection.state.clone();
    let passengers = state.passengers.as_mut().unwrap();
    passengers
        .passengers
        .retain(|passenger| &passenger.passenger_key != key);
    passengers.state_hash.clear();
    passengers.state_hash = Sha256::digest(serde_json::to_vec(&*passengers).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    state.session.as_mut().unwrap().pins.projection_hash = passengers.state_hash.clone();
    state.state_hash = conductor_session_state_hash(&state).unwrap();
    assert_eq!(
        restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
            schema_version: "conductor-session-restore-input/v1".into(),
            expected_state_hash: state.state_hash.clone(),
            state,
            dialogue_releases: fixture.source.dialogue_releases.clone(),
        })
        .unwrap_err()
        .0,
        "conductor_session_encounter_missing"
    );
}

#[test]
fn tatsaechlicher_ausstieg_loescht_die_oeffentliche_dialogzuordnung() {
    let fixture = Fixture::new();
    let state = start(&fixture);
    let mut arrival = Fixture::new();
    arrival.advance(650_000);
    arrival
        .source
        .operational_world
        .lock_route("regional-1", "interlocking:train:b")
        .unwrap();
    arrival
        .source
        .operational_world
        .plan_motion("regional-1")
        .unwrap();
    arrival.advance(700_000);
    let arrived =
        synchronize_conductor_session(&arrival.sync(state.clone(), "arrival-preview")).unwrap();
    let layout = state.layout.as_ref().unwrap();
    let position = &state.session.as_ref().unwrap().position;
    let passenger_key = arrived
        .snapshot
        .as_ref()
        .unwrap()
        .passengers
        .passengers
        .iter()
        .filter(|passenger| {
            passenger.activity == zugfolge_conductor::PassengerActivityV1::Alighting
        })
        .find(|passenger| {
            let interaction = layout
                .interactions
                .iter()
                .find(|interaction| interaction.target_id == passenger.place_id)
                .unwrap();
            let point = &layout
                .nodes
                .iter()
                .find(|node| node.node_id == interaction.node_id)
                .unwrap()
                .point;
            point.vehicle_id == position.vehicle_id
                && point.body_id == position.body_id
                && point.deck_id == position.deck_id
                && point.x_mm.abs_diff(position.x_mm) + point.y_mm.abs_diff(position.y_mm) <= 2500
        })
        .expect("echter M10-Aussteiger in Reichweite des originalen Einstiegs")
        .passenger_key
        .clone();
    let inspection = apply_conductor_session_command(&fixture.input(
        state,
        "inspect-alighter",
        ConductorCommandActionV1::StartInspection {
            passenger_key: passenger_key.clone(),
        },
    ))
    .unwrap();
    assert_eq!(
        inspection
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .as_ref(),
        Some(&passenger_key)
    );
    let closed =
        synchronize_conductor_session(&arrival.sync(inspection.state.clone(), "actual-alighting"))
            .unwrap();
    let snapshot = closed.snapshot.unwrap();
    assert!(snapshot.active_encounter.is_none() && snapshot.active_passenger_key.is_none());
    assert_eq!(closed.effects.len(), 1);
    assert_eq!(
        closed.effects[0].kind,
        ConductorSessionEffectKindV1::CloseWithoutAction
    );
    // Frühere private V1-Stände konnten die Begegnung bis zur Abfahrt behalten.
    let mut legacy = closed.state;
    legacy.encounters = inspection.state.encounters;
    legacy.session.as_mut().unwrap().active_encounter_id =
        inspection.state.session.unwrap().active_encounter_id;
    legacy.state_hash = conductor_session_state_hash(&legacy).unwrap();
    let restored = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version: "conductor-session-restore-input/v1".into(),
        expected_state_hash: legacy.state_hash.clone(),
        state: legacy.clone(),
        dialogue_releases: fixture.source.dialogue_releases.clone(),
    })
    .unwrap();
    assert_eq!(restored, legacy);
    let migrated =
        synchronize_conductor_session(&arrival.sync(restored, "legacy-alighting")).unwrap();
    assert!(
        migrated
            .snapshot
            .as_ref()
            .unwrap()
            .active_passenger_key
            .is_none()
    );
    assert!(
        migrated
            .snapshot
            .as_ref()
            .unwrap()
            .active_encounter
            .is_none()
    );
}

#[test]
fn alte_snapshotbytes_ohne_oeffentliche_zuordnung_bleiben_unveraendert() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    let mut legacy = inspect(&fixture, start(&fixture)).snapshot.unwrap();
    // Historischer V1-Transportbeleg ohne Zuordnungsfeld, keine neue Fachquelle.
    legacy.active_passenger_key = None;
    legacy.snapshot_hash.clear();
    legacy.snapshot_hash = Sha256::digest(serde_json::to_vec(&legacy).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let original = serde_json::to_string(&legacy).unwrap();
    assert!(!original.contains("activePassengerKey"));
    let restored: ConductorSessionSnapshotV1 = serde_json::from_str(&original).unwrap();
    assert_eq!(serde_json::to_string(&restored).unwrap(), original);
    assert_eq!(restored.snapshot_hash, legacy.snapshot_hash);
    assert!(restored.active_passenger_key.is_none());
    assert!(restored.active_encounter.is_some());
}

#[test]
fn lease_und_rechteentzug_schliessen_kontrolliert_ohne_unsichtbare_deltas() {
    let mut fixture = Fixture::new();
    let state = start(&fixture);
    let expires = state.session.as_ref().unwrap().lease_until_ms;
    fixture.advance(expires);
    let result = synchronize_conductor_session(&fixture.sync(state, "lease")).unwrap();
    assert_eq!(
        result.state.session.unwrap().end_reason,
        Some(ConductorSessionEndReasonV1::LeaseExpired)
    );
    let fixture = Fixture::new();
    let state = inspect(&fixture, start(&fixture)).state;
    let mut input = fixture.sync(state, "revoked");
    input.access.train_use_authorized = false;
    let result = synchronize_conductor_session(&input).unwrap();
    assert_eq!(
        result.state.session.unwrap().end_reason,
        Some(ConductorSessionEndReasonV1::AccessRevoked)
    );
    assert!(result.snapshot.is_none());
}

#[test]
fn neue_quellen_entwerten_keine_commandrevision_und_manifest_bleibt_gebunden() {
    let mut fixture = Fixture::new();
    let state = start(&fixture);
    let revision = state.session.as_ref().unwrap().revision;
    fixture.advance(fixture.source.operational_world.now_ms + 1000);
    let result = apply_conductor_session_command(&fixture.input(
        state.clone(),
        "resume",
        ConductorCommandActionV1::ResumeSession,
    ))
    .unwrap();
    assert_eq!(
        result.state.session.as_ref().unwrap().revision,
        revision + 1
    );
    assert_eq!(result.events.len(), 1);
    let passenger = state.passengers.as_ref().unwrap().passengers[0]
        .passenger_key
        .clone();
    let mut stale = fixture.input(
        state,
        "inspection-stale",
        ConductorCommandActionV1::StartInspection {
            passenger_key: passenger,
        },
    );
    stale.command.expected_manifest_revision = Some(1);
    assert_eq!(
        apply_conductor_session_command(&stale).unwrap_err().0,
        "conductor_stale_manifest"
    );
}

#[test]
fn bewegungen_pruefen_reichweite_kollision_und_rate() {
    let fixture = Fixture::new();
    let state = start(&fixture);
    let position = state.session.as_ref().unwrap().position.clone();
    let mut outside = position.clone();
    outside.y_mm = 100_000;
    assert_eq!(
        apply_conductor_session_command(&fixture.input(
            state.clone(),
            "wall",
            ConductorCommandActionV1::Move {
                to: outside,
                transition_edge_id: None
            }
        ))
        .unwrap_err()
        .0,
        "conductor_movement_blocked"
    );
    let mut source = fixture.source.clone();
    source.session_policy.max_commands_per_window = 1;
    source.session_policy.content_hash =
        conductor_session_policy_hash(&source.session_policy).unwrap();
    let mut first = fixture.input(
        fixture.initial(),
        "limited",
        ConductorCommandActionV1::StartSession,
    );
    first.source = source.clone();
    let started = apply_conductor_session_command(&first).unwrap();
    let mut move_input = fixture.input(
        started.state,
        "step1",
        ConductorCommandActionV1::Move {
            to: position.clone(),
            transition_edge_id: None,
        },
    );
    move_input.source = source.clone();
    let moved = apply_conductor_session_command(&move_input).unwrap();
    let mut next = fixture.input(
        moved.state,
        "step2",
        ConductorCommandActionV1::Move {
            to: position,
            transition_edge_id: None,
        },
    );
    next.source = source;
    assert_eq!(
        apply_conductor_session_command(&next).unwrap_err().0,
        "conductor_command_rate_limited"
    );
    let inspection = inspect(&fixture, state);
    let point = inspection.state.session.as_ref().unwrap().position.clone();
    assert_eq!(
        apply_conductor_session_command(&fixture.input(
            inspection.state,
            "during-dialogue",
            ConductorCommandActionV1::Move {
                to: point,
                transition_edge_id: None
            }
        ))
        .unwrap_err()
        .0,
        "conductor_encounter_active"
    );
}

#[test]
fn optionen_muessen_sichtbar_sein_und_dokumentpruefung_hat_exakt_einen_effekt() {
    let mut fixture = Fixture::new();
    let inspection = inspect(&fixture, start(&fixture));
    let snapshot = inspection
        .snapshot
        .as_ref()
        .unwrap()
        .active_encounter
        .as_ref()
        .unwrap();
    let record = &inspection.state.encounters[&snapshot.encounter_id];
    let release = &fixture.source.dialogue_releases[0];
    let node = release
        .families
        .iter()
        .flat_map(|f| &f.trees)
        .find(|t| t.tree_id == record.dialogue.tree_id)
        .unwrap()
        .nodes
        .iter()
        .find(|n| n.node_id == record.dialogue.node_id)
        .unwrap();
    let option = node
        .options
        .iter()
        .find(|o| {
            o.intent == Some(DialogueIntentV1::RequestDocumentCheck)
                && snapshot
                    .options
                    .iter()
                    .any(|visible| visible.option_id == o.option_id)
        })
        .unwrap()
        .option_id
        .clone();
    let input = fixture.input(
        inspection.state,
        "check",
        ConductorCommandActionV1::ChooseDialogueOption { option_id: option },
    );
    let checked = apply_conductor_session_command(&input).unwrap();
    assert_eq!(checked.effects.len(), 1);
    assert_eq!(
        checked.effects[0].kind,
        ConductorSessionEffectKindV1::RequestDocumentCheck
    );
    let mut duplicate = input.clone();
    duplicate.state = checked.state.clone();
    duplicate.expected_state_hash = checked.state_hash.clone();
    assert!(
        apply_conductor_session_command(&duplicate)
            .unwrap()
            .effects
            .is_empty()
    );
    let encounter_id = checked
        .state
        .session
        .as_ref()
        .unwrap()
        .active_encounter_id
        .clone()
        .unwrap();
    let record = &checked.state.encounters[&encounter_id];
    let release = &fixture.source.dialogue_releases[0];
    let node = release
        .families
        .iter()
        .flat_map(|f| &f.trees)
        .find(|t| t.tree_id == record.dialogue.tree_id)
        .unwrap()
        .nodes
        .iter()
        .find(|n| n.node_id == record.dialogue.node_id)
        .unwrap();
    let hidden = node
        .options
        .iter()
        .find(|o| o.intent == Some(DialogueIntentV1::RequestRegularClaim))
        .unwrap()
        .option_id
        .clone();
    fixture.advance(record.dialogue.available_at_ms);
    fixture
        .source
        .encounter_evidence
        .push(ConductorEncounterEvidenceV1 {
            encounter_id,
            evidence: DialogueEvidenceV1 {
                document_status: DocumentStatusV1::VerifiedInvalid,
                acquisition_exception: AcquisitionExceptionV1::Excluded,
                identity_status: IdentityStatusV1::Confirmed,
                concrete_danger: false,
            },
        });
    let hidden_input = fixture.input(
        checked.state.clone(),
        "guessed",
        ConductorCommandActionV1::ChooseDialogueOption { option_id: hidden },
    );
    assert_eq!(
        apply_conductor_session_command(&hidden_input)
            .unwrap_err()
            .0,
        "conductor_dialogue_option_not_offered"
    );
    let observed = synchronize_conductor_session(&fixture.sync(checked.state, "observed")).unwrap();
    assert!(
        !observed
            .effects
            .iter()
            .any(|e| e.kind == ConductorSessionEffectKindV1::RequestRegularClaim)
    );
}

#[test]
fn json_und_restore_leaken_keine_eingabefakten() {
    let fixture = Fixture::new();
    let state = start(&fixture);
    let mut corrupted = state.clone();
    corrupted.session.as_mut().unwrap().owner_ref = "secret-test-marker".into();
    let error = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version: "conductor-session-restore-input/v1".into(),
        state: corrupted,
        expected_state_hash: state.state_hash,
        dialogue_releases: fixture.source.dialogue_releases,
    })
    .unwrap_err();
    assert_eq!(error.0, "conductor_session_state_hash_mismatch");
    for json in [
        "{secret-test-marker}",
        "{\"schemaVersion\":\"secret-test-marker\"}",
    ] {
        let error = apply_conductor_session_command_json(json).unwrap_err();
        assert_eq!(error.0, "invalid_conductor_session_json");
    }
}
