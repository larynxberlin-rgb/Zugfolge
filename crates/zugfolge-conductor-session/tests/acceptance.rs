//! Zusammenhängender Gegenlauf aus echten Betriebs- und Nachfragekernen.
#[allow(
    dead_code,
    reason = "Gemeinsame Testproduzenten liefern mehrere Nachweispfade"
)]
mod support;
#[test]
fn kontrollhalt_verzoegert_folgezug_und_m10_plant_nur_den_nichtgefahrenen_anschluss_neu() {
    let report = support::acceptance::report();
    assert_eq!(report["leaderDelayMs"], 600_000);
    assert!(report["followerDelayMs"].as_i64().unwrap() > 0);
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../evidence/network-consequence-v1.json")).unwrap();
    assert_eq!(report, golden);
}

#[test]
fn groesste_vollstaendig_belegte_konfiguration_bleibt_mit_allen_220_personen_restorierbar() {
    use zugfolge_conductor::*;
    use zugfolge_conductor_session::*;
    let fixture = support::Fixture::for_configuration(2);
    let layout = build_interior_layout(fixture.source.interior.as_ref().unwrap()).unwrap();
    let passengers =
        project_conductor_passengers_v2(fixture.source.projection.as_ref().unwrap()).unwrap();
    assert_eq!(layout.passenger_places.len(), 220);
    assert_eq!(passengers.passengers.len(), 220);
    assert_eq!(
        layout.capacity.premium_seats + layout.capacity.standard_seats,
        200
    );
    let started = apply_conductor_session_command(&fixture.input(
        fixture.initial(),
        "full-capacity",
        ConductorCommandActionV1::StartSession,
    ))
    .unwrap();
    let restored = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
        schema_version: "conductor-session-restore-input/v1".into(),
        state: started.state.clone(),
        expected_state_hash: started.state.state_hash.clone(),
        dialogue_releases: fixture.source.dialogue_releases.clone(),
    })
    .unwrap();
    assert_eq!(restored, started.state);
    let projected = serde_json::to_string(&started.snapshot).unwrap();
    assert!(!projected.contains("fareFact"));
    assert!(!projected.contains("journeyChainId"));
    assert!(!projected.contains("ownerRef"));
}

#[test]
fn fahrgastbremsung_liefert_an_jeder_ereignisgrenze_eine_gebundene_geometrie() {
    use std::collections::BTreeSet;
    use zugfolge_sim::operational::*;
    let mut world = support::Fixture::for_configuration(2)
        .source
        .operational_world;
    let mut extended = false;
    let mut constant_segments = 0;
    for _ in 0..100 {
        let projection = world
            .project(ProjectionKind::LiveMap, &BTreeSet::new())
            .unwrap();
        let train = &projection.trains[0];
        if let Some(segment) = &train.motion_segment {
            if segment.start_route_mm == segment.segment_end_route_mm {
                assert_eq!(train.motion_geometry, vec![train.head_geometry.clone()]);
                assert!(segment.valid_until_ms > segment.started_at_ms);
                constant_segments += 1;
            } else {
                assert!(train.motion_geometry.len() >= 2, "{segment:?}");
            }
            world.advance_to(segment.valid_until_ms).unwrap();
        } else if !extended {
            world
                .submit_dispatch_requests(&[DispatchRequest {
                    train_id: "regional-1".into(),
                    interlocking_route_id: "interlocking:train:b".into(),
                    committed_rank: 0,
                    timetable_deviation_ms: 0,
                    passenger_impact: 0,
                    contractual_impact: 0,
                    network_impact: 0,
                    resource_consequence: 0,
                    recovery_rank: 0,
                    waiting_since_ms: world.now_ms,
                }])
                .unwrap();
            extended = true;
        } else {
            assert!(constant_segments > 0);
            assert!(
                world.trains["regional-1"]
                    .passenger_stops
                    .as_ref()
                    .unwrap()
                    .receipts[1]
                    .actual_arrival_ms
                    .is_some()
            );
            return;
        }
    }
    panic!("Ereignisgrenze überschritten");
}
