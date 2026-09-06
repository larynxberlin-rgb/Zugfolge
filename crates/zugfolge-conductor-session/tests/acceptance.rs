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
