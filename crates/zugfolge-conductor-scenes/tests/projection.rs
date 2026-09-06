//! Tatsächlicher Betriebs-/Szenenpfad mit ausdrücklich fiktiver Infrastruktur.
mod support;

use support::*;
use zugfolge_conductor_scenes::*;
use zugfolge_sim::operational::{OperationalWorld, SignalAspect};
#[path = "support/scene.rs"]
mod scene;
use scene::{input, release};

#[test]
fn real_engine_stops_signals_motion_three_station_sizes_and_restore() {
    let (infra, train) = passenger_stop_fixture();
    let scene = release();
    validate_scene_release_infrastructure(&scene, &infra).unwrap();
    let mut world = world_with_release(infra);
    world.materialize(train).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let initial = project_conductor_scene(&input(&world, &scene)).unwrap();
    assert_eq!(
        initial.station.as_ref().unwrap().size,
        StationSceneSize::Small
    );
    assert_eq!(initial.speed_mmps, 0);
    let mut paused = input(&world, &scene);
    paused.sample_at_ms += 500;
    let paused = project_conductor_scene(&paused).unwrap();
    assert_eq!(initial.environment, paused.environment);
    assert_ne!(
        initial.lighting.local_time_of_day_ms,
        paused.lighting.local_time_of_day_ms
    );
    world.advance_to(1_000).unwrap();
    let during = input(&world, &scene);
    let segment = during.operational.trains[0]
        .motion_segment
        .as_ref()
        .unwrap();
    let mut sampled = during.clone();
    sampled.sample_at_ms = (world.now_ms + 100).min(segment.valid_until_ms);
    let sampled = project_conductor_scene(&sampled).unwrap();
    assert_eq!(
        sampled.route_mm,
        segment.position_at(sampled.at_ms).unwrap()
    );
    assert_eq!(sampled.speed_mmps, segment.speed_at(sampled.at_ms).unwrap());
    // The real engine advances its clock inside a segment without materializing
    // the stored segment-start position and speed until the next event boundary.
    let inside_ms = (world.now_ms + 1).min(segment.valid_until_ms - 1);
    let expected_speed = segment.speed_at(inside_ms).unwrap();
    world.advance_to(inside_ms).unwrap();
    let inside = input(&world, &scene);
    let projected = project_conductor_scene(&inside).unwrap();
    assert_eq!(projected.speed_mmps, expected_speed);
    assert_ne!(
        projected.speed_mmps,
        inside.operational.trains[0].speed_mmps
    );
    let mut inconsistent_start = inside.clone();
    inconsistent_start.operational.trains[0].speed_mmps += 1;
    assert_eq!(
        project_conductor_scene(&inconsistent_start)
            .unwrap_err()
            .code,
        "scene_motion_evidence_invalid"
    );
    let restored = OperationalWorld::restore(&world.checkpoint()).unwrap();
    assert_eq!(
        project_conductor_scene(&inside).unwrap(),
        project_conductor_scene(&input(&restored, &scene)).unwrap()
    );
    advance_stop_train_until_standing(&mut world);
    let signal_stop = project_conductor_scene(&input(&world, &scene)).unwrap();
    assert_eq!(signal_stop.route_mm, 30_000);
    assert_eq!(signal_stop.speed_mmps, 0);
    assert_eq!(signal_stop.signals[0].aspect, SignalAspect::Stop);
    let original_hash = world.state_hash();
    for _ in 0..25 {
        assert_eq!(
            project_conductor_scene(&input(&world, &scene)).unwrap(),
            signal_stop
        );
    }
    assert_eq!(world.state_hash(), original_hash);
    world
        .submit_dispatch_requests(&[dispatch_request(
            "train:stops",
            "interlocking:train:b",
            world.now_ms,
        )])
        .unwrap();
    advance_stop_train_until_standing(&mut world);
    let middle = project_conductor_scene(&input(&world, &scene))
        .unwrap()
        .station
        .unwrap();
    assert_eq!(middle.size, StationSceneSize::Medium);
    assert_eq!(middle.category, None);
    assert_eq!(middle.classification_provenance, SceneProvenance::Derived);
    world.advance_to(world.now_ms + 5_000).unwrap();
    advance_stop_train_until_standing(&mut world);
    let final_scene = project_conductor_scene(&input(&world, &scene)).unwrap();
    assert_eq!(final_scene.route_mm, 120_000);
    assert_eq!(final_scene.environment.urban_basis_points, 10_000);
    let large = final_scene.station.unwrap();
    assert_eq!(large.size, StationSceneSize::Large);
    assert_eq!(large.name, "Großer Prüfstadt-Hauptbahnhof Süd");
    world.verify_invariants().unwrap();
}

#[test]
fn every_urbanity_weight_is_conservative_and_stable_under_source_order() {
    let (infra, train) = passenger_stop_fixture();
    let mut world = world_with_release(infra);
    world.materialize(train).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let mut scene = release();
    for urbanity in 0..=10_000 {
        scene.routes[0]
            .urbanity
            .iter_mut()
            .for_each(|p| p.urbanity_basis_points = urbanity);
        let env = project_conductor_scene(&input(&world, &scene))
            .unwrap()
            .environment;
        assert_eq!(
            u32::from(env.rural_basis_points)
                + u32::from(env.suburban_basis_points)
                + u32::from(env.urban_basis_points),
            10_000
        );
        assert_eq!(env.urbanity_basis_points, urbanity);
    }
    let before = project_conductor_scene(&input(&world, &scene)).unwrap();
    scene.stations.reverse();
    scene.routes[0].stations.reverse();
    assert_eq!(
        project_conductor_scene(&input(&world, &scene)).unwrap(),
        before
    );
}

#[test]
fn rejects_wrong_bindings_missing_sources_stale_motion_and_unknown_fields() {
    let (infra, train) = passenger_stop_fixture();
    let mut world = world_with_release(infra.clone());
    world.materialize(train).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let scene = release();
    let original = input(&world, &scene);
    for mutation in 0..12 {
        let mut broken = original.clone();
        match mutation {
            0 => broken.binding.world_id = "foreign".into(),
            1 => broken.binding.operator_id = "foreign".into(),
            2 => broken.binding.train_run_id = "foreign".into(),
            3 => broken.binding.infra_release_hash = "1".repeat(64),
            4 => broken.binding.scene_release_hash = "2".repeat(64),
            5 => broken.binding.commit_sequence += 1,
            6 => broken.sample_at_ms = broken.operational.stale_after_ms + 1,
            7 => broken.binding.valid_until_ms = 0,
            8 => broken.operational.infra_release_id = "foreign".into(),
            9 => broken.operational.trains[0].speed_mmps = 1,
            10 => broken.operational.trains[0].route_version_id = "unknown-reroute".into(),
            _ => broken.scene_release.stations[0].category_source_id = None,
        }
        assert!(
            project_conductor_scene(&broken).is_err(),
            "mutation {mutation}"
        );
    }
    let mut wrong = scene.clone();
    wrong.routes[0].stations[0].to_route_mm += 1;
    assert_eq!(
        validate_scene_release_infrastructure(&wrong, &infra)
            .unwrap_err()
            .code,
        "scene_platform_geometry_mismatch"
    );
    let mut json = serde_json::to_value(&original).unwrap();
    json["fakeSpeed"] = 1.into();
    assert_eq!(
        project_conductor_scene_json(&json.to_string())
            .unwrap_err()
            .code,
        "scene_input_json_invalid"
    );
    world.advance_to(1_000).unwrap();
    let mut broken = input(&world, &scene);
    let segment = broken.operational.trains[0]
        .motion_segment
        .as_ref()
        .unwrap();
    broken.sample_at_ms = segment.valid_until_ms + 1;
    assert!(project_conductor_scene(&broken).is_err());
}
