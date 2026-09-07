use crate::{common::*, *};
use std::collections::BTreeSet;
use zugfolge_conductor::*;
use zugfolge_sim::operational::{MovementKind, OperationalTrain};

pub(crate) fn access(
    state: &ConductorTrainStateV1,
    access: &ConductorSessionAccessV1,
) -> Result<(), ConductorSessionError> {
    require(
        access.world_id == state.world_id
            && id(&access.operator_id)
            && id(&access.owner_ref)
            && access.world_access_active
            && access.operator_active
            && access.train_use_authorized,
        "conductor_access_denied",
    )
}
pub(crate) fn operational<'a>(
    state: &ConductorTrainStateV1,
    source: &'a ConductorSessionSourceV1,
) -> Result<Option<&'a OperationalTrain>, ConductorSessionError> {
    let world = &source.operational_world;
    require(
        world.world_id == state.world_id
            && (state.now_ms..=MAX_SAFE).contains(&world.now_ms)
            && hash(&source.expected_operational_world_hash)
            && operational_world_hash(world) == source.expected_operational_world_hash,
        "conductor_operational_binding_mismatch",
    )?;
    world
        .verify_invariants()
        .map_err(|_| ConductorSessionError("conductor_operational_state_invalid"))?;
    Ok(world.trains.get(&state.train_run_id))
}
pub(crate) fn terminal(train: &OperationalTrain) -> bool {
    train.passenger_stops.as_ref().is_some_and(|p| {
        p.receipts
            .last()
            .is_some_and(|r| r.actual_arrival_ms.is_some())
    })
}

pub(crate) fn dialogue_release<'a>(
    releases: &'a [zugfolge_conductor_dialogue::DialogueReleaseV1],
    expected: &str,
) -> Result<&'a zugfolge_conductor_dialogue::DialogueReleaseV1, ConductorSessionError> {
    let mut found = None;
    for release in releases {
        let actual = zugfolge_conductor_dialogue::dialogue_release_hash(release)
            .map_err(|_| ConductorSessionError("invalid_session_dialogue_release"))?;
        if actual == expected {
            require(found.is_none(), "duplicate_session_dialogue_release")?;
            found = Some(release);
        }
    }
    found.ok_or(ConductorSessionError("session_dialogue_release_missing"))
}

pub(crate) struct LiveSource {
    pub layout: InteriorLayoutV1,
    pub passengers: PassengerProjectionV2,
    pub pins: ConductorSessionPinsV1,
}
pub(crate) fn live(
    state: &ConductorTrainStateV1,
    source: &ConductorSessionSourceV1,
    access: &ConductorSessionAccessV1,
) -> Result<LiveSource, ConductorSessionError> {
    let train =
        operational(state, source)?.ok_or(ConductorSessionError("conductor_train_unavailable"))?;
    require(
        train.operator_id == access.operator_id
            && train.movement_kind == MovementKind::Train
            && train.public_passenger_stop
            && !terminal(train)
            && train
                .passenger_stops
                .as_ref()
                .is_none_or(|p| p.cancellation.is_none()),
        "conductor_train_not_eligible",
    )?;
    let build = source
        .interior
        .as_ref()
        .ok_or(ConductorSessionError("conductor_interior_source_missing"))?;
    let input = source
        .projection
        .as_ref()
        .ok_or(ConductorSessionError("conductor_demand_source_missing"))?;
    validate_policy(&source.session_policy)?;
    require(
        build.binding.world_id == state.world_id
            && build.binding.operator_id == access.operator_id
            && source.session_policy.world_id == state.world_id
            && source.session_policy.period_id == build.binding.period_id
            && input.binding.period_id == build.binding.period_id
            && input.service.train_run_id == state.train_run_id
            && input.service.operator_id == access.operator_id
            && input.evaluation.now_ms <= source.operational_world.now_ms,
        "conductor_source_scope_mismatch",
    )?;
    let formation = source
        .operational_world
        .formations
        .get(&train.formation_version_id)
        .ok_or(ConductorSessionError(
            "conductor_operational_formation_missing",
        ))?;
    let m5 = build
        .mobilization
        .formations
        .iter()
        .find(|f| f.id == build.binding.formation_id)
        .ok_or(ConductorSessionError("conductor_fleet_formation_missing"))?;
    require(
        formation.vehicle_ids == m5.vehicle_ids && !formation.vehicle_ids.is_empty(),
        "conductor_formation_vehicle_mismatch",
    )?;
    let progress = train
        .passenger_stops
        .as_ref()
        .ok_or(ConductorSessionError("conductor_operational_stops_missing"))?;
    let demand_progress = input
        .evaluation
        .operational_progress
        .as_ref()
        .ok_or(ConductorSessionError("conductor_demand_progress_missing"))?;
    let demand_train = demand_progress
        .trains
        .iter()
        .find(|p| p.train_run_id == state.train_run_id)
        .ok_or(ConductorSessionError(
            "conductor_demand_train_progress_missing",
        ))?;
    require(
        progress.plan.stops.len() == input.service.stops.len()
            && progress
                .plan
                .stops
                .iter()
                .zip(&input.service.stops)
                .all(|(a, b)| a.stop_id == b.stop_id && a.station_id == b.station_id),
        "conductor_stop_plan_mismatch",
    )?;
    let expected_count = progress
        .receipts
        .iter()
        .filter(|r| r.actual_arrival_ms.is_some() || r.actual_departure_ms.is_some())
        .count();
    require(
        demand_train.stops.len() == expected_count
            && demand_train.stops.iter().all(|receipt| {
                progress
                    .plan
                    .stops
                    .iter()
                    .zip(&progress.receipts)
                    .any(|(stop, fact)| {
                        stop.stop_id == receipt.stop_id
                            && fact.actual_arrival_ms == receipt.actual_arrival_ms
                            && fact.actual_departure_ms == receipt.actual_departure_ms
                    })
            }),
        "conductor_stop_receipt_mismatch",
    )?;
    let layout = build_interior_layout(build)
        .map_err(|_| ConductorSessionError("conductor_interior_invalid"))?;
    let places = bind_interior_passenger_places(&BindInteriorPassengerPlacesInputV1 {
        schema_version: "conductor-interior-bind-input/v1".into(),
        layout: layout.clone(),
        train_run_id: state.train_run_id.clone(),
        service: input.service.clone(),
    })
    .map_err(|_| ConductorSessionError("conductor_train_capacity_mismatch"))?;
    require(
        places == input.interior,
        "conductor_interior_projection_mismatch",
    )?;
    let mut projection = input.clone();
    projection.previous_projection = state
        .passengers
        .as_ref()
        .filter(|p| {
            p.layout_hash == places.layout_hash
                && p.binding.period_id == input.binding.period_id
                && p.binding.seed_hash == input.binding.seed_hash
        })
        .cloned();
    let passengers = project_conductor_passengers_v2(&projection)
        .map_err(|_| ConductorSessionError("conductor_passenger_projection_invalid"))?;
    let dialogue_hash = state
        .session
        .as_ref()
        .filter(|s| s.status != ConductorSessionStatusV1::Ended)
        .map_or(&source.current_dialogue_release_hash, |s| {
            &s.pins.dialogue_release_hash
        });
    require(
        source.dialogue_releases.len() <= 64 && hash(dialogue_hash),
        "invalid_session_dialogue_catalog",
    )?;
    dialogue_release(&source.dialogue_releases, dialogue_hash)?;
    require(
        source.encounter_evidence.len() <= 20_000
            && source
                .encounter_evidence
                .iter()
                .map(|e| &e.encounter_id)
                .collect::<BTreeSet<_>>()
                .len()
                == source.encounter_evidence.len(),
        "invalid_session_evidence",
    )?;
    let pins = ConductorSessionPinsV1 {
        period_id: build.binding.period_id.clone(),
        operational_world_hash: source.expected_operational_world_hash.clone(),
        operational_formation_id: train.formation_version_id.clone(),
        formation_id: m5.id.clone(),
        vehicle_ids: formation.vehicle_ids.clone(),
        interior_layout_hash: layout.layout_hash.clone(),
        demand_state_hash: input.evaluation.state_hash.clone(),
        manifest_revision: input.evaluation.revision,
        projection_hash: passengers.state_hash.clone(),
        dialogue_release_hash: dialogue_hash.clone(),
        policy_hash: state
            .session
            .as_ref()
            .filter(|s| s.status != ConductorSessionStatusV1::Ended)
            .map_or_else(
                || source.session_policy.content_hash.clone(),
                |s| s.policy.content_hash.clone(),
            ),
    };
    Ok(LiveSource {
        layout,
        passengers,
        pins,
    })
}
