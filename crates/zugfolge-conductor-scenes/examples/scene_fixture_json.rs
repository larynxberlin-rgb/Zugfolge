//! Explicit fictional geography; all motion/signal snapshots come from OperationalWorld.
#[path = "../tests/support/scene.rs"]
mod scene;
#[path = "../tests/support/mod.rs"]
mod support;

fn main() {
    let (infra, train) = support::passenger_stop_fixture();
    let release = scene::release();
    zugfolge_conductor_scenes::validate_scene_release_infrastructure(&release, &infra).unwrap();
    let mut world = support::world_with_release(infra);
    world.materialize(train).unwrap();
    world
        .lock_route("train:stops", "interlocking:train")
        .unwrap();
    let initial = scene::input(&world, &release);
    world.advance_to(1_000).unwrap();
    let moving = scene::input(&world, &release);
    let restored =
        zugfolge_sim::operational::OperationalWorld::restore(&world.checkpoint()).unwrap();
    println!(
        "{}",
        serde_json::json!({"initial":initial,"moving":moving,"restored":scene::input(&restored,&release)})
    );
}
