//! End-to-end acceptance evidence for milestone M8.

use zugfolge_conflict::{ConflictResource, ResourceExclusions};
use zugfolge_determinism::{SimTime, WorldSeed};
use zugfolge_disruption::{
    ActorRole, Alternative, CauseResponsibility, CauseType, ConstructionNotice, ContractTreatment,
    DAILY_RESTRICTION_CALIBRATION_VERSION, DELAY_CAUSE_CATALOG, DecisionRecord, DepartureAuthority,
    DepartureCause, DepartureWindow, DisruptionEffect, DisruptionMode, DisruptionPolicy,
    DisruptionRuntime, EconomyRates, FINE_CAUSE_CATALOG_2023, FineCauseGeneration,
    GeneratedSourceKind, InfrastructureIncidentExposure, ManualDisruptionCommand, Movement,
    MovementKind, PASSENGER_INFORMATION_CATALOG, PRIMARY_CAUSE_WEIGHTS,
    PassengerStopIncidentExposure, PolicyChange, ProviderFailure, ProviderRecord, ProviderRegistry,
    RealisticFineCauseCoverage, ReplacementRequest, RestrictionDirection, RestrictionTraffic,
    RightsStatus, RouteSafetyProof, RuntimeCommand, SEQUENCE_DELAY_SHARE_BASIS_POINTS,
    SPONTANEOUS_INCIDENT_CALIBRATION_VERSION, SimulationProfile, SpontaneousIncidentClass,
    SpontaneousIncidentExposure, TrainRunIncidentExposure, VEHICLE_INCIDENT_WEIGHTS,
    VirtualDispatcher, WorldScope, fine_cause_code, fine_cause_simulation_disposition,
    generate_daily_restrictions, generate_disruptions,
};
use zugfolge_infra::{FacilityId, TrackId};

fn at(seconds: i64) -> SimTime {
    SimTime::from_seconds(seconds)
}

fn policy(world_id: u64) -> DisruptionPolicy {
    DisruptionPolicy::new(
        world_id,
        1,
        DisruptionMode::Simulated,
        DisruptionMode::Manual,
        None,
        SimulationProfile::pilot("pilot/v1"),
        "disruption-rules/v1",
        at(0),
        None,
    )
    .unwrap()
}

fn no_spontaneous_exposure() -> SpontaneousIncidentExposure {
    SpontaneousIncidentExposure {
        infrastructure: Vec::new(),
        train_runs: Vec::new(),
        passenger_stops: Vec::new(),
    }
}

#[test]
fn policywechsel_wird_erst_am_veroeffentlichten_stichtag_wirksam() {
    let mut runtime = DisruptionRuntime::new(policy(7), at(21 * 86_400)).unwrap();
    let audit = runtime
        .schedule_policy_change(PolicyChange {
            world_id: 7,
            requested_at: at(100),
            effective_at: at(21 * 86_400),
            requested_by: "admin-1".into(),
            reason: "Neue veröffentlichte Periodenregel".into(),
            planned_works_mode: DisruptionMode::Manual,
            operational_incident_mode: DisruptionMode::Simulated,
            provider_set_id: None,
            simulation_profile: SimulationProfile::pilot("pilot/v2"),
            ruleset_version: "disruption-rules/v2".into(),
        })
        .unwrap();
    assert_eq!(audit.world_id, 7);
    assert_eq!(runtime.policy().version(), 1);
    runtime.advance_policy(at(21 * 86_400 - 1)).unwrap();
    assert_eq!(runtime.policy().version(), 1);
    runtime.advance_policy(at(21 * 86_400)).unwrap();
    assert_eq!(runtime.policy().version(), 2);
}

#[test]
fn ursachen_und_reisendeninformation_bleiben_getrennte_kataloge() {
    let track = DELAY_CAUSE_CATALOG
        .iter()
        .find(|entry| entry.code == 23)
        .unwrap();
    assert_eq!(track.label, "Fahrbahn");
    assert_eq!(
        track.responsibility,
        CauseResponsibility::InfrastructureManager
    );
    let vehicle = DELAY_CAUSE_CATALOG
        .iter()
        .find(|entry| entry.code == 64)
        .unwrap();
    assert_eq!(
        vehicle.responsibility,
        CauseResponsibility::RailwayUndertaking
    );
    let sequence = DELAY_CAUSE_CATALOG
        .iter()
        .find(|entry| entry.code == 91)
        .unwrap();
    assert_eq!(sequence.cause_type, CauseType::Secondary);
    assert!(DELAY_CAUSE_CATALOG.iter().all(|entry| entry.code != 78));
    assert_eq!(PASSENGER_INFORMATION_CATALOG[0].code, 78);
}

#[test]
fn haupt_und_feincodes_2023_sind_vollstaendig_verknuepft_eindeutig_und_markenfrei() {
    let mut ids = std::collections::BTreeSet::new();
    for fine in FINE_CAUSE_CATALOG_2023 {
        assert!(ids.insert(fine.id), "doppelte Feinkennung {}", fine.id);
        assert!(
            DELAY_CAUSE_CATALOG
                .iter()
                .any(|main| main.code == fine.main_code),
            "Feinkennung {} verweist auf unbekannten Hauptcode",
            fine.id
        );
        assert_eq!(fine_cause_code(fine.id, fine.main_code), Some(fine));
        let searchable = format!("{} {}", fine.id, fine.label).to_lowercase();
        for forbidden in ["infrago", "station&service", "deutsche bahn"] {
            assert!(
                !searchable.contains(forbidden),
                "Markenname in Feinkennung {}",
                fine.id
            );
        }
    }
    let without_fine_examples = [19_u8, 29, 40, 49, 59, 69, 70, 71, 80, 91, 92, 93, 94, 95];
    for code in &without_fine_examples {
        assert!(
            FINE_CAUSE_CATALOG_2023
                .iter()
                .all(|fine| fine.main_code != *code),
            "Hauptcode {code} darf keine erfundene Feinkodierung erhalten"
        );
    }
    for main in DELAY_CAUSE_CATALOG.iter().filter(|entry| {
        matches!(
            entry.cause_type,
            CauseType::Primary | CauseType::DangerousEvent
        ) && !without_fine_examples.contains(&entry.code)
    }) {
        assert!(
            FINE_CAUSE_CATALOG_2023
                .iter()
                .any(|fine| fine.main_code == main.code),
            "Hauptcode {} hat keine Feinkodierung",
            main.code
        );
    }
}

#[test]
fn jeder_feincode_hat_einen_expliziten_simulations_und_realistikkanal() {
    for fine in FINE_CAUSE_CATALOG_2023 {
        let disposition = fine_cause_simulation_disposition(fine);
        if matches!(
            disposition.generation,
            FineCauseGeneration::ExcludedEffectless | FineCauseGeneration::TemporaryStatus
        ) {
            assert_eq!(
                disposition.realistic_coverage,
                RealisticFineCauseCoverage::NotMaterialized,
                "wirkungsloser Code {} darf auch in REALISTIC nicht erscheinen",
                fine.id
            );
            assert!(disposition.effect.is_none());
        } else {
            assert!(
                disposition.effect.is_some(),
                "simulierbarer Code {} braucht eine konkrete Wirkungsfamilie",
                fine.id
            );
        }
        if disposition.realistic_coverage == RealisticFineCauseCoverage::InternalGapSimulation {
            assert_eq!(
                disposition.generation,
                FineCauseGeneration::SpontaneousInternal,
                "interne Feed-Luecke {} braucht einen Simulationskanal",
                fine.id
            );
        }
    }
    for effectless in [
        "telecom.radio",
        "structure.noise-barrier",
        "station.passenger-information",
        "traction-unit.train-radio",
        "investigation.infrastructure",
    ] {
        let fine = FINE_CAUSE_CATALOG_2023
            .iter()
            .find(|entry| entry.id == effectless)
            .unwrap();
        assert_eq!(
            fine_cause_simulation_disposition(fine).realistic_coverage,
            RealisticFineCauseCoverage::NotMaterialized
        );
    }
    for internal in [
        "dwell.passenger-volume",
        "coach.door",
        "freight-wagon.hotbox",
        "traction-unit.brake",
        "traction-unit.door-control",
    ] {
        let fine = FINE_CAUSE_CATALOG_2023
            .iter()
            .find(|entry| entry.id == internal)
            .unwrap();
        assert_eq!(
            fine_cause_simulation_disposition(fine).realistic_coverage,
            RealisticFineCauseCoverage::InternalGapSimulation
        );
    }
}

#[test]
fn statistik_kalibriert_nur_primaerursachen_und_laesst_zugfolge_entstehen() {
    assert_eq!(
        PRIMARY_CAUSE_WEIGHTS
            .iter()
            .map(|weight| weight.weight_basis_points)
            .sum::<u32>(),
        10_000
    );
    assert_eq!(SEQUENCE_DELAY_SHARE_BASIS_POINTS, 3_449);
}

#[test]
fn generator_ist_seed_release_und_profil_deterministisch() {
    let resources = vec![
        (
            "L-H-block-1".into(),
            ConflictResource::Block {
                track: TrackId::new(1),
                ordinal: 0,
            },
            9_200,
        ),
        (
            "Erfurt-platform-4".into(),
            ConflictResource::Track(TrackId::new(4)),
            7_100,
        ),
    ];
    let first = generate_disruptions(
        &policy(7),
        WorldSeed::new(77, 8),
        "infra-2026",
        at(0),
        at(28 * 86_400),
        &resources,
        &no_spontaneous_exposure(),
    )
    .unwrap();
    let second = generate_disruptions(
        &policy(7),
        WorldSeed::new(77, 8),
        "infra-2026",
        at(0),
        at(28 * 86_400),
        &resources,
        &no_spontaneous_exposure(),
    )
    .unwrap();
    assert_eq!(first, second);
    assert!(!first.is_empty());
    assert!(
        first
            .iter()
            .all(|event| event.world_id == 7 && event.source.substream == "disruption")
    );
    assert_ne!(
        first,
        generate_disruptions(
            &policy(7),
            WorldSeed::new(78, 8),
            "infra-2026",
            at(0),
            at(28 * 86_400),
            &resources,
            &no_spontaneous_exposure(),
        )
        .unwrap()
    );
}

#[test]
fn spontane_stoerungen_nutzen_getrennte_reale_bezugsgroessen() {
    let resource = ConflictResource::Track(TrackId::new(4));
    let resources = vec![("pilot-track".into(), resource, 8_000)];
    let exposure = SpontaneousIncidentExposure {
        infrastructure: vec![InfrastructureIncidentExposure {
            resource_id: "pilot-track".into(),
            resource,
            load_basis_points: 8_000,
        }],
        train_runs: (0..10_000)
            .map(|ordinal| TrainRunIncidentExposure {
                train_run_id: format!("run-{ordinal}"),
                resource,
            })
            .collect(),
        passenger_stops: (0..10_000)
            .map(|ordinal| PassengerStopIncidentExposure {
                train_run_id: format!("run-{}", ordinal / 10),
                resource,
            })
            .collect(),
    };
    let both_simulated = DisruptionPolicy::new(
        7,
        1,
        DisruptionMode::Simulated,
        DisruptionMode::Simulated,
        None,
        SimulationProfile::pilot("spontaneous-pilot/v1"),
        "disruption-rules/v2",
        at(0),
        None,
    )
    .unwrap();
    let events = generate_disruptions(
        &both_simulated,
        WorldSeed::new(77, 8),
        "infra-2026",
        at(0),
        at(100 * 86_400),
        &resources,
        &exposure,
    )
    .unwrap();
    let spontaneous = events
        .iter()
        .filter(|event| event.kind == zugfolge_disruption::DisruptionKind::OperationalIncident)
        .collect::<Vec<_>>();
    assert_eq!(spontaneous.len(), 303 + 22 + 40);
    assert_eq!(
        spontaneous
            .iter()
            .filter(|event| matches!(event.cause_code, 62..=64))
            .count(),
        22
    );
    assert_eq!(
        spontaneous
            .iter()
            .filter(|event| event.cause_code == 50)
            .count(),
        40
    );
    assert_eq!(
        spontaneous
            .iter()
            .filter(|event| matches!(event.cause_code, 25 | 26))
            .count(),
        303
    );
    assert!(spontaneous.iter().all(|event| {
        event.published_at == event.starts_at
            && event.source.calibration_version == SPONTANEOUS_INCIDENT_CALIBRATION_VERSION
            && event.effect.operational_impact()
                == zugfolge_disruption::OperationalImpact::RunningTime
            && fine_cause_code(&event.fine_cause_id, event.cause_code).is_some()
    }));
    assert!(
        spontaneous
            .iter()
            .filter(|event| matches!(event.cause_code, 50 | 62..=64))
            .all(|event| event.scope.train_run_ids.len() == 1)
    );
}

#[test]
fn realistic_ergaenzt_nur_nicht_oeffentliche_fahrzeug_und_halteereignisse() {
    let resource = ConflictResource::Track(TrackId::new(4));
    let exposure = SpontaneousIncidentExposure {
        infrastructure: vec![InfrastructureIncidentExposure {
            resource_id: "pilot-track".into(),
            resource,
            load_basis_points: 8_000,
        }],
        train_runs: (0..10_000)
            .map(|ordinal| TrainRunIncidentExposure {
                train_run_id: format!("run-{ordinal}"),
                resource,
            })
            .collect(),
        passenger_stops: (0..10_000)
            .map(|ordinal| PassengerStopIncidentExposure {
                train_run_id: format!("run-{}", ordinal / 10),
                resource,
            })
            .collect(),
    };
    let realistic = DisruptionPolicy::new(
        7,
        1,
        DisruptionMode::Manual,
        DisruptionMode::Realistic,
        Some("public-infrastructure-restrictions/de-v1".into()),
        SimulationProfile::pilot("realistic-gap/v1"),
        "disruption-rules/v2",
        at(0),
        None,
    )
    .unwrap();
    let events = generate_disruptions(
        &realistic,
        WorldSeed::new(77, 8),
        "infra-2026",
        at(0),
        at(100 * 86_400),
        &[],
        &exposure,
    )
    .unwrap();
    assert_eq!(events.len(), 22 + 40);
    assert!(events.iter().all(|event| {
        matches!(event.cause_code, 50 | 62..=64)
            && event.source.kind == GeneratedSourceKind::SimulatedRealisticGap
            && event.scope.train_run_ids.len() == 1
    }));
    assert!(
        events
            .iter()
            .all(|event| !matches!(event.cause_code, 25 | 26))
    );
}

#[test]
fn tuerstörung_bleibt_im_fahrzeugbudget_und_ist_keine_erfundene_zusatzquote() {
    assert_eq!(
        VEHICLE_INCIDENT_WEIGHTS
            .iter()
            .map(|weight| weight.weight)
            .sum::<u32>(),
        22
    );
    assert!(VEHICLE_INCIDENT_WEIGHTS.iter().any(|weight| {
        weight.class == SpontaneousIncidentClass::VehicleDoor && weight.weight == 2
    }));
    assert!(fine_cause_code("traction-unit.door-control", 64).is_some());
}

#[test]
fn manueller_modus_erzwingt_autorisierung_weltisolation_pflichtfelder_und_audit() {
    let command = ManualDisruptionCommand {
        world_id: 7,
        command_id: "manual-1".into(),
        starts_at: at(1_000),
        ends_at: at(2_000),
        cause: "Signaltechnische Untersuchung".into(),
        cause_code: 25,
        fine_cause_id: "signalling.interlocking".into(),
        affected_resources: vec![ConflictResource::Track(TrackId::new(4))],
        effect: DisruptionEffect::Closure,
    };
    let denied = DisruptionRuntime::create_manual(
        &WorldScope {
            world_id: 7,
            actor_id: "player-1".into(),
            role: ActorRole::Player,
        },
        &command,
    );
    assert!(denied.is_err());
    let wrong_world = DisruptionRuntime::create_manual(
        &WorldScope {
            world_id: 8,
            actor_id: "admin-1".into(),
            role: ActorRole::WorldAdmin,
        },
        &command,
    );
    assert!(wrong_world.is_err());
    let created = DisruptionRuntime::create_manual(
        &WorldScope {
            world_id: 7,
            actor_id: "admin-1".into(),
            role: ActorRole::WorldAdmin,
        },
        &command,
    )
    .unwrap();
    assert_eq!(created.audit.actor_id, "admin-1");
    assert_eq!(created.audit.cause_code, 25);
    assert_eq!(created.disruption.world_id, 7);
}

#[test]
fn alle_auswirkungen_sind_ressourcenwirksam_und_validiert() {
    let track = ConflictResource::Track(TrackId::new(4));
    let effects = [
        DisruptionEffect::Closure,
        DisruptionEffect::SingleTrack {
            shared_resource: track,
            remaining_capacity: 1,
        },
        DisruptionEffect::SpeedRestriction {
            maximum_speed_mm_per_second: 11_111,
        },
        DisruptionEffect::PlatformChange {
            replacement: ConflictResource::Track(TrackId::new(5)),
        },
        DisruptionEffect::TrafficHold {
            maximum_hold_seconds: 900,
        },
        DisruptionEffect::RouteDeviation {
            alternative_resources: vec![ConflictResource::Track(TrackId::new(6))],
        },
        DisruptionEffect::VehicleRestriction {
            maximum_axle_load_kg: 20_000,
            maximum_train_length_mm: 180_000,
        },
        DisruptionEffect::PlatformUsableLength {
            maximum_usable_length_mm: 161_000,
        },
    ];
    for effect in effects {
        assert!(effect.validate(&[track]).is_ok());
        assert!(!effect.affected_resources(&[track]).is_empty());
    }
}

#[test]
fn tagesmodell_simuliert_la_auch_im_realistischen_modus_offen_und_deterministisch() {
    let mut profile = SimulationProfile::pilot("la-pilot/v1");
    profile.daily_restrictions_per_day = 400;
    let realistic = DisruptionPolicy::new(
        7,
        1,
        DisruptionMode::Realistic,
        DisruptionMode::Realistic,
        Some("real-events-plus-explicit-daily-model".into()),
        profile,
        "disruption-rules/v1",
        at(0),
        None,
    )
    .unwrap();
    let resources = vec![
        (
            "line-1".into(),
            ConflictResource::Block {
                track: TrackId::new(1),
                ordinal: 0,
            },
            8_000,
        ),
        (
            "platform-4".into(),
            ConflictResource::Track(TrackId::new(4)),
            6_000,
        ),
    ];
    let first = generate_daily_restrictions(
        &realistic,
        WorldSeed::new(77, 8),
        "infra-2026",
        at(8 * 86_400),
        &resources,
    )
    .unwrap();
    let replay = generate_daily_restrictions(
        &realistic,
        WorldSeed::new(77, 8),
        "infra-2026",
        at(8 * 86_400),
        &resources,
    )
    .unwrap();
    assert_eq!(first, replay);
    assert!(first.iter().all(|event| {
        event.source.kind == GeneratedSourceKind::SimulatedDailyRestriction
            && event.source.calibration_version == DAILY_RESTRICTION_CALIBRATION_VERSION
            && fine_cause_code(&event.fine_cause_id, event.cause_code).is_some()
    }));
    assert!(
        first
            .iter()
            .any(|event| matches!(event.effect, DisruptionEffect::PlatformUsableLength { .. }))
    );
    assert!(
        first
            .iter()
            .any(|event| matches!(event.effect, DisruptionEffect::SpeedRestriction { .. }))
    );
    assert!(first.iter().any(|event| {
        event.scope.direction != RestrictionDirection::Both
            || event.scope.traffic != RestrictionTraffic::All
    }));
    assert_ne!(
        first,
        generate_daily_restrictions(
            &realistic,
            WorldSeed::new(77, 8),
            "infra-2026",
            at(9 * 86_400),
            &resources,
        )
        .unwrap()
    );
}

#[test]
fn baustelle_hat_mehrwoechigen_vorlauf_und_restkapazitaet() {
    let notice = ConstructionNotice::new(
        7,
        "works-1",
        at(0),
        at(14 * 86_400),
        at(42 * 86_400),
        vec![ConflictResource::Block {
            track: TrackId::new(1),
            ordinal: 0,
        }],
        1,
    )
    .unwrap();
    assert_eq!(notice.lead_time_seconds(), 14 * 86_400);
    assert_eq!(notice.remaining_capacity, 1);
}

fn movement(id: u64, kind: MovementKind, earliest: i64, scheduled: i64, latest: i64) -> Movement {
    Movement {
        world_id: 7,
        id,
        operator_id: id,
        kind,
        departure: DepartureWindow {
            earliest: at(earliest),
            scheduled: at(scheduled),
            latest: at(latest),
        },
        requested_at: at(earliest),
        reservations: vec![(
            ConflictResource::Facility(FacilityId::new(1)),
            at(earliest),
            at(earliest + 60),
        )],
        minimum_dwell_met: true,
        route_safety: RouteSafetyProof::secured(),
        departure_authority: DepartureAuthority::MainSignal,
        personnel_and_vehicle_ready: true,
        affected_connections: 0,
        contract_effect_cents: 0,
        network_stability_rank: 0,
        rotation_effect_rank: 0,
        recoverability_rank: 0,
        essential_for_recovery: false,
        waiting_since: at(earliest),
    }
}

#[test]
fn fruehfahrt_ist_nur_im_expliziten_fenster_und_nicht_fuer_personenzuege_zulaessig() {
    for kind in [
        MovementKind::EmptyStock,
        MovementKind::Freight,
        MovementKind::Supplementary,
        MovementKind::Shunting,
    ] {
        let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 3_600);
        let decision = dispatcher
            .coordinate(
                at(100),
                vec![movement(kind as u64 + 1, kind, 100, 200, 300)],
            )
            .unwrap()
            .remove(0);
        assert_eq!(decision.departure_at, Some(at(100)));
        assert_eq!(decision.cause, DepartureCause::PermittedEarlyDeparture);
    }
    let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 3_600);
    let passenger = dispatcher
        .coordinate(
            at(100),
            vec![movement(99, MovementKind::Passenger, 100, 200, 300)],
        )
        .unwrap()
        .remove(0);
    assert_eq!(passenger.departure_at, Some(at(200)));
}

#[test]
fn virtuelle_fahrdienstleiter_koordinieren_zug_und_rangierfahrt_erklaerbar() {
    let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 300);
    let mut passenger = movement(1, MovementKind::Passenger, 100, 100, 500);
    passenger.affected_connections = 40;
    let mut shunting = movement(2, MovementKind::Shunting, 100, 100, 500);
    shunting.essential_for_recovery = true;
    shunting.waiting_since = at(0);
    let decisions = dispatcher
        .coordinate(at(400), vec![shunting, passenger])
        .unwrap();
    assert_eq!(
        decisions
            .iter()
            .filter(|d| d.departure_at == Some(at(400)))
            .count(),
        1
    );
    assert!(
        decisions
            .iter()
            .all(|d| !d.explanation.checked_alternatives.is_empty())
    );
    assert!(
        decisions
            .iter()
            .all(|d| d.explanation.rule.starts_with("virtual-dispatcher/"))
    );
}

#[test]
fn virtueller_fahrdienstleiter_verweigert_ohne_fahrwegpruefung_oder_zustimmung() {
    let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 300);
    let mut missing_route = movement(1, MovementKind::Passenger, 100, 100, 500);
    missing_route.route_safety.flank_protection_proved = false;
    let mut missing_consent = movement(2, MovementKind::Passenger, 100, 100, 500);
    missing_consent.departure_authority = DepartureAuthority::None;
    missing_consent.reservations[0].0 = ConflictResource::Facility(FacilityId::new(2));
    let decisions = dispatcher
        .coordinate(at(100), vec![missing_consent, missing_route])
        .unwrap();
    assert_eq!(decisions[0].cause, DepartureCause::MissingRouteProof);
    assert_eq!(decisions[1].cause, DepartureCause::MissingDepartureConsent);
    assert!(
        decisions
            .iter()
            .all(|decision| decision.departure_at.is_none())
    );
}

#[test]
fn sicherheit_geht_vor_puenktlichkeit_und_befehl_ist_eine_individuelle_zustimmung() {
    let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 300);
    let mut unsafe_priority = movement(1, MovementKind::Passenger, 100, 100, 500);
    unsafe_priority.affected_connections = 500;
    unsafe_priority.route_safety.route_proved_clear = false;
    let mut ordered = movement(2, MovementKind::Passenger, 100, 100, 500);
    ordered.departure_authority = DepartureAuthority::WrittenOrder;
    let decisions = dispatcher
        .coordinate(at(100), vec![unsafe_priority, ordered])
        .unwrap();
    assert_eq!(decisions[0].cause, DepartureCause::MissingRouteProof);
    assert_eq!(decisions[1].departure_at, Some(at(100)));
    assert!(decisions[1].explanation.rule.contains("rule-408-2025"));
}

#[test]
fn zwei_evu_konkurrieren_um_genau_eine_umleitungstrasse() {
    let resource = ConflictResource::Block {
        track: TrackId::new(9),
        ordinal: 0,
    };
    let rates = EconomyRates::test("economy-2026");
    let requests = vec![
        ReplacementRequest::reroute(
            7,
            11,
            "rp-a",
            at(10),
            at(100),
            resource,
            at(1_000),
            at(2_000),
        ),
        ReplacementRequest::reroute(
            7,
            12,
            "rp-b",
            at(10),
            at(100),
            resource,
            at(1_000),
            at(2_000),
        ),
    ];
    let outcomes = zugfolge_disruption::run_replacement_planning(
        WorldSeed::new(7, 3),
        ResourceExclusions::new(),
        &rates,
        requests,
    )
    .unwrap();
    assert_eq!(
        outcomes
            .iter()
            .filter(|o| matches!(o.selected, Alternative::Reroute { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|o| matches!(o.selected, Alternative::RailReplacement { .. }))
            .count(),
        1
    );
    assert!(outcomes.iter().all(|o| !o.explanation.is_empty()));
}

#[test]
fn ersatzkonzept_prueft_alle_fachlichen_grenzen_und_begruendet_ablehnung() {
    let resource = ConflictResource::Track(TrackId::new(3));
    let mut request = ReplacementRequest::reroute(
        7,
        11,
        "rp-a",
        at(10),
        at(100),
        resource,
        at(1_000),
        at(2_000),
    );
    request.alternatives.insert(
        0,
        Alternative::Reroute {
            resource,
            starts_at: at(1_000),
            ends_at: at(2_000),
            route_knowledge: false,
            train_protection: true,
            electrification: true,
            train_length: true,
            vehicle_suitable: true,
        },
    );
    let outcome = zugfolge_disruption::run_replacement_planning(
        WorldSeed::new(7, 3),
        ResourceExclusions::new(),
        &EconomyRates::test("economy-2026"),
        vec![request],
    )
    .unwrap()
    .remove(0);
    assert!(
        outcome
            .rejections
            .iter()
            .any(|reason| reason.contains("Streckenkenntnis"))
    );
}

#[test]
fn vertrag_standardkonzept_sev_und_ledger_bleiben_ganzzahlig_und_ausgeglichen() {
    let rates = EconomyRates::test("economy-2026");
    let timely = zugfolge_disruption::settle_replacement_contract(&rates, true, true, false, 5);
    assert_eq!(timely.treatment, ContractTreatment::Reduction);
    let late = zugfolge_disruption::settle_replacement_contract(&rates, false, false, false, 5);
    assert_eq!(late.treatment, ContractTreatment::Penalty);
    let standard = zugfolge_disruption::automatic_standard_plan(7, 11, "auto", &rates, 5);
    assert!(matches!(
        standard.selected,
        Alternative::RailReplacement { .. }
    ));
    assert!(standard.cost_cents > timely.amount_cents);
    assert_eq!(
        standard
            .ledger_entries
            .iter()
            .map(|entry| entry.amount_cents)
            .sum::<i64>(),
        0
    );
}

#[test]
fn eventlog_replay_und_resume_ergeben_identischen_zustandshash() {
    let commands = vec![
        zugfolge_disruption::RuntimeCommand::PublishConstruction(
            ConstructionNotice::new(
                7,
                "works-1",
                at(0),
                at(14 * 86_400),
                at(42 * 86_400),
                vec![ConflictResource::Track(TrackId::new(4))],
                0,
            )
            .unwrap(),
        ),
        zugfolge_disruption::RuntimeCommand::RecordProviderFailure(ProviderFailure {
            world_id: 7,
            provider_set_id: "provider-set".into(),
            failed_at: at(20),
            reason: "timeout".into(),
        }),
    ];
    let first = DisruptionRuntime::replay(policy(7), at(21 * 86_400), &commands).unwrap();
    let second = DisruptionRuntime::replay(policy(7), at(21 * 86_400), &commands).unwrap();
    assert_eq!(first.state_hash(), second.state_hash());
    assert_eq!(first.events_after(0), second.events_after(0));
}

#[test]
fn realistic_bleibt_ohne_rechtefreigabe_deaktiviert_und_providerausfall_behält_sicheren_stand() {
    let mut registry = ProviderRegistry::new();
    registry
        .register(ProviderRecord {
            id: "candidate-a".into(),
            rights_status: RightsStatus::Blocked,
            commercial_use: false,
            replay_storage: false,
        })
        .unwrap();
    assert!(registry.enable("candidate-a").is_err());
    registry
        .seed_last_safe("candidate-a", at(100), vec!["works-1".into()])
        .unwrap();
    let fallback = registry
        .provider_failed("candidate-a", at(200), "timeout")
        .unwrap();
    assert_eq!(fallback.visible_disruption_ids, vec!["works-1"]);
    assert!(!fallback.switched_to_simulation);
}

#[test]
fn mehrwoechige_baustelle_vergibt_eine_umleitung_und_erklaert_den_ersatz_end_to_end() {
    let shared = ConflictResource::Block {
        track: TrackId::new(9),
        ordinal: 0,
    };
    let notice = ConstructionNotice::new(
        7,
        "lhe-works-42d",
        at(0),
        at(14 * 86_400),
        at(42 * 86_400),
        vec![shared],
        1,
    )
    .unwrap();
    let rates = EconomyRates::test("economy-2026");
    let outcomes = zugfolge_disruption::run_replacement_planning(
        WorldSeed::new(7, 8),
        ResourceExclusions::new(),
        &rates,
        vec![
            ReplacementRequest::reroute(
                7,
                11,
                "evu-a",
                at(100),
                at(500),
                shared,
                at(14 * 86_400),
                at(14 * 86_400 + 600),
            ),
            ReplacementRequest::reroute(
                7,
                12,
                "evu-b",
                at(100),
                at(500),
                shared,
                at(14 * 86_400),
                at(14 * 86_400 + 600),
            ),
        ],
    )
    .unwrap();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome.selected, Alternative::Reroute { .. }))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome.selected, Alternative::RailReplacement { .. }))
            .count(),
        1
    );
    assert!(outcomes.iter().all(|outcome| {
        outcome
            .ledger_entries
            .iter()
            .map(|entry| entry.amount_cents)
            .sum::<i64>()
            == 0
    }));
    assert!(
        outcomes
            .iter()
            .all(|outcome| !outcome.explanation.is_empty())
    );

    let mut dispatcher = VirtualDispatcher::new(7, ResourceExclusions::new(), 300);
    let decisions = dispatcher
        .coordinate(
            at(14 * 86_400),
            vec![
                movement(
                    1,
                    MovementKind::Passenger,
                    14 * 86_400,
                    14 * 86_400,
                    14 * 86_400 + 900,
                ),
                movement(
                    2,
                    MovementKind::Shunting,
                    14 * 86_400,
                    14 * 86_400,
                    14 * 86_400 + 900,
                ),
            ],
        )
        .unwrap();
    assert_eq!(
        decisions
            .iter()
            .filter(|decision| decision.departure_at == Some(at(14 * 86_400)))
            .count(),
        1
    );

    let mut commands = vec![RuntimeCommand::PublishConstruction(notice)];
    for outcome in &outcomes {
        let (action, explanation) = if matches!(outcome.selected, Alternative::Reroute { .. }) {
            ("request_reroute", outcome.explanation.clone())
        } else {
            (
                "trigger_rail_replacement",
                format!(
                    "{}; Ablehnungen: {}",
                    outcome.explanation,
                    outcome.rejections.join("; ")
                ),
            )
        };
        commands.push(RuntimeCommand::RecordDecision(DecisionRecord {
            world_id: 7,
            decision_id: format!("replacement-{}", outcome.operator_id),
            operator_id: outcome.operator_id,
            movement_id: outcome.request_id.clone(),
            at: at(14 * 86_400),
            action: action.into(),
            cause_code: 31,
            affected_resource: "block:track-9:0".into(),
            explanation,
        }));
    }
    let first = DisruptionRuntime::replay(policy(7), at(21 * 86_400), &commands).unwrap();
    let second = DisruptionRuntime::replay(policy(7), at(21 * 86_400), &commands).unwrap();
    assert_eq!(first.events_after(0).len(), 3);
    assert_eq!(first.events_after(1), first.events_after(0)[1..]);
    assert!(first.events_after(3).is_empty());
    assert!(first.events_after(u64::MAX).is_empty());
    assert_eq!(first.state_hash(), second.state_hash());
    assert!(
        first
            .events_after(0)
            .iter()
            .all(|event| event.world_id == 7)
    );
    assert!(first.events_after(0).iter().skip(1).all(|event| {
        event.cause_code == Some(31)
            && event.operator_id.is_some()
            && event.affected_resource.as_deref() == Some("block:track-9:0")
    }));
}
