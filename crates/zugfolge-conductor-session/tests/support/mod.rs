#[allow(dead_code, reason = "Gemeinsamer lokaler Abnahmeadapter")]
pub mod acceptance;
pub mod interior;
mod operational;
use zugfolge_conductor::*;
use zugfolge_conductor_session::*;
use zugfolge_demand::*;
use zugfolge_sim::operational::*;

pub struct Fixture {
    pub infrastructure: OperationalInfraRelease,
    pub materialization: TrainMaterialization,
    pub source: ConductorSessionSourceV1,
    pub demand: DemandEvaluationInputV1,
}
impl Fixture {
    pub fn new() -> Self {
        Self::for_configuration(1)
    }
    pub fn for_configuration(index: usize) -> Self {
        let build = interior::fixture(index);
        let layout = build_interior_layout(&build).unwrap();
        let mut demand = interior::demand(&layout);
        // Fiktive, explizit maßstäblich vergrößerte Teststrecke für das echte 70-m-Fahrzeug.
        let (mut infra, mut material) = operational::passenger_stop_fixture();
        for length in infra.directed_edges.values_mut() {
            *length *= 10;
        }
        for geometry in infra.edge_geometries.values_mut() {
            for point in geometry {
                point.edge_offset_mm *= 10;
            }
        }
        for route in infra.route_versions.values_mut() {
            route.transition_route_mm = route.transition_route_mm.map(|m| m * 10);
            for leg in &mut route.legs {
                leg.edge_entry_mm *= 10;
                leg.edge_exit_mm *= 10;
                leg.route_start_mm *= 10;
            }
        }
        for route in infra.interlocking_routes.values_mut() {
            route.authority_start_route_mm *= 10;
            route.authority_end_route_mm *= 10;
            route.release_after_tail_route_mm *= 10;
        }
        for platform in infra.platform_intervals.values_mut() {
            platform.from_mm *= 10;
            platform.to_mm *= 10;
        }
        let service = &demand.services[0];
        material.id = service.train_run_id.clone();
        material.operator_id = service.operator_id.clone();
        material.head_route_mm *= 10;
        material.scheduled_departure_ms = Some(service.stops[0].departure_ms);
        let plan = material.stop_plan.as_mut().unwrap();
        plan.world_id = demand.world_id.clone();
        plan.train_run_id = service.train_run_id.clone();
        plan.service_id = service.train_run_id.clone();
        for (stop, service_stop) in plan.stops.iter_mut().zip(&service.stops) {
            stop.route_mm *= 10;
            stop.stop_id = service_stop.stop_id.clone();
            stop.station_id = service_stop.station_id.clone();
            stop.scheduled_arrival_ms = service_stop.arrival_ms;
            stop.scheduled_departure_ms = service_stop.departure_ms;
            stop.minimum_dwell_ms = service_stop.departure_ms - service_stop.arrival_ms;
        }
        let infrastructure = infra.clone();
        let materialization = material.clone();
        let mut world = OperationalWorld::new(&demand.world_id, "region:a", 0, infra).unwrap();
        world
            .register_vehicle_type(operational::vehicle_type("type:session-test", 70_000), true)
            .unwrap();
        world
            .register_vehicle(operational::vehicle(
                &format!("fixture-interior-vehicle-{index}"),
                "type:session-test",
            ))
            .unwrap();
        world
            .create_formation(
                "formation:1",
                None,
                vec![format!("fixture-interior-vehicle-{index}")],
            )
            .unwrap();
        world.materialize(material).unwrap();
        world
            .lock_route("regional-1", "interlocking:train")
            .unwrap();
        let previous = evaluate_demand(&demand).unwrap();
        world.advance_to(service.stops[0].departure_ms + 1).unwrap();
        world.verify_invariants().unwrap();
        demand.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
            result: previous,
            services: demand.services.clone(),
        }));
        demand.revision += 1;
        demand.now_ms = world.now_ms;
        demand.operational_progress = Some(progress(&world));
        let evaluation = evaluate_demand(&demand).unwrap();
        let dialogue: zugfolge_conductor_dialogue::DialogueReleaseV1 = serde_json::from_str(
            include_str!("../../../../assets/conductor-dialogue/v1/release.json"),
        )
        .unwrap();
        let dialogue_hash = zugfolge_conductor_dialogue::dialogue_release_hash(&dialogue).unwrap();
        let mut policy = ConductorSessionPolicyV1 {
            schema_version: POLICY_SCHEMA.into(),
            policy_id: "test-only-session-policy".into(),
            revision: 1,
            world_id: world.world_id.clone(),
            period_id: demand.period_id.clone(),
            content_hash: String::new(),
            lease_duration_ms: 600_000,
            command_window_ms: 1000,
            max_commands_per_window: 100,
            min_command_interval_ms: 0,
            walk_speed_mm_per_second: 1400,
            max_movement_burst_mm: 10_000,
            inspection_range_mm: 2500,
            max_receipts: 4096,
        };
        policy.content_hash = conductor_session_policy_hash(&policy).unwrap();
        Self {
            infrastructure,
            materialization,
            source: ConductorSessionSourceV1 {
                expected_operational_world_hash: operational_world_hash(&world),
                operational_world: world,
                interior: Some(build),
                projection: Some(interior::projection_input(&layout, &demand, evaluation)),
                session_policy: policy,
                current_dialogue_release_hash: dialogue_hash,
                dialogue_releases: vec![dialogue],
                encounter_evidence: vec![],
                control_receipts: vec![],
            },
            demand,
        }
    }
    pub fn advance(&mut self, to: i64) {
        let previous = self.source.projection.as_ref().unwrap().evaluation.clone();
        self.source.operational_world.advance_to(to).unwrap();
        self.source.operational_world.verify_invariants().unwrap();
        self.demand.previous_evaluation = Some(Box::new(PreviousDemandEvaluationV1 {
            result: previous,
            services: self.demand.services.clone(),
        }));
        self.demand.now_ms = to;
        self.demand.revision += 1;
        self.demand.operational_progress = Some(progress(&self.source.operational_world));
        let evaluation = evaluate_demand(&self.demand).unwrap();
        let layout = build_interior_layout(self.source.interior.as_ref().unwrap()).unwrap();
        self.source.projection = Some(interior::projection_input(
            &layout,
            &self.demand,
            evaluation,
        ));
        self.source.expected_operational_world_hash =
            operational_world_hash(&self.source.operational_world);
    }
    pub fn access(&self) -> ConductorSessionAccessV1 {
        ConductorSessionAccessV1 {
            world_id: self.demand.world_id.clone(),
            operator_id: self.demand.services[0].operator_id.clone(),
            owner_ref: "private-owner-test-1".into(),
            world_access_active: true,
            operator_active: true,
            train_use_authorized: true,
            other_active_session_id: None,
        }
    }
    pub fn initial(&self) -> ConductorTrainStateV1 {
        initialize_conductor_session_state(&InitializeConductorSessionStateInputV1 {
            schema_version: "conductor-session-initialize-input/v1".into(),
            world_id: self.demand.world_id.clone(),
            train_run_id: "regional-1".into(),
            now_ms: 0,
        })
        .unwrap()
    }
    pub fn input(
        &self,
        state: ConductorTrainStateV1,
        id: &str,
        action: ConductorCommandActionV1,
    ) -> ApplyConductorSessionCommandInputV1 {
        let command = ConductorCommandV1 {
            schema_version: COMMAND_SCHEMA.into(),
            world_id: state.world_id.clone(),
            train_run_id: state.train_run_id.clone(),
            session_id: "session:test-1".into(),
            expected_revision: state.session.as_ref().map_or(0, |s| s.revision),
            expected_manifest_revision: if matches!(
                action,
                ConductorCommandActionV1::StartInspection { .. }
                    | ConductorCommandActionV1::ChooseDialogueOption { .. }
                    | ConductorCommandActionV1::RequestPolice { .. }
            ) {
                Some(self.demand.revision)
            } else {
                None
            },
            idempotency_key: id.into(),
            action,
        };
        ApplyConductorSessionCommandInputV1 {
            schema_version: "conductor-session-apply-input/v1".into(),
            expected_state_hash: state.state_hash.clone(),
            state,
            command,
            access: self.access(),
            source: self.source.clone(),
        }
    }
    pub fn sync(
        &self,
        state: ConductorTrainStateV1,
        id: &str,
    ) -> SynchronizeConductorSessionInputV1 {
        SynchronizeConductorSessionInputV1 {
            schema_version: "conductor-session-synchronize-input/v1".into(),
            expected_state_hash: state.state_hash.clone(),
            state,
            access: self.access(),
            source: self.source.clone(),
            causality_id: id.into(),
        }
    }
}
fn progress(world: &OperationalWorld) -> DemandOperationalProgressV1 {
    let progress = world.trains["regional-1"].passenger_stops.as_ref().unwrap();
    DemandOperationalProgressV1 {
        schema_version: "demand-operational-progress/v1".into(),
        world_id: world.world_id.clone(),
        as_of_ms: world.now_ms,
        receipt_id: format!("test-committed-{}", world.event_sequence),
        trains: vec![TrainOperationalProgressV1 {
            train_run_id: "regional-1".into(),
            stops: progress
                .plan
                .stops
                .iter()
                .zip(&progress.receipts)
                .filter(|(_, r)| r.actual_arrival_ms.is_some() || r.actual_departure_ms.is_some())
                .map(|(s, r)| StopOperationalProgressV1 {
                    stop_id: s.stop_id.clone(),
                    actual_arrival_ms: r.actual_arrival_ms,
                    actual_departure_ms: r.actual_departure_ms,
                })
                .collect(),
        }],
    }
}
