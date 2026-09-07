//! Begrenzter, rein lokaler Messadapter; Host misst Laufzeiten außerhalb des Fachkerns.
#![allow(
    dead_code,
    reason = "Gemeinsame Testproduzenten liefern mehrere Nachweispfade"
)]
#[path = "../tests/support/mod.rs"]
mod support;
use serde_json::json;
use std::io::{self, BufRead, Write};
use zugfolge_conductor::*;
use zugfolge_conductor_session::*;
fn main() {
    let index = std::env::args()
        .nth(1)
        .map_or(2, |s| s.parse::<usize>().expect("Konfiguration 1..3"));
    assert!((1..=3).contains(&index));
    let fixture = support::Fixture::for_configuration(index);
    let mut initial = fixture.initial();
    let mut output = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let line = line.expect("lokaler Prüfauftrag");
        assert!(line.len() <= 100);
        let value = match line.as_str() {
            "network" => support::acceptance::report(),
            "source" => {
                let layout =
                    build_interior_layout(fixture.source.interior.as_ref().unwrap()).unwrap();
                let projected =
                    project_conductor_passengers_v2(fixture.source.projection.as_ref().unwrap())
                        .unwrap();
                json!({"testOnly":true,"configuration":index,"lengthMm":layout.vehicles.iter().flat_map(|v| &v.bodies).map(|b|u64::from(b.length_mm+b.gap_after_mm)).sum::<u64>(),"capacity":layout.capacity,"passengers":projected.passengers.len(),"places":layout.passenger_places.len(),"bodies":layout.vehicles.iter().map(|v|v.bodies.len()).sum::<usize>(),"layoutHash":layout.layout_hash,"demandReleaseHash":fixture.source.projection.as_ref().unwrap().evaluation.release_hash,"demandStateHash":fixture.source.projection.as_ref().unwrap().evaluation.state_hash,"projectionHash":projected.state_hash,"operationalHash":fixture.source.expected_operational_world_hash,"fleetAuthorityHash":layout.binding.fleet_authority_release_hash})
            }
            "layout" => {
                let value =
                    build_interior_layout(fixture.source.interior.as_ref().unwrap()).unwrap();
                json!({"hash":value.layout_hash})
            }
            "demand" => {
                let value = zugfolge_demand::evaluate_demand(&fixture.demand).unwrap();
                json!({"hash":value.state_hash,"generated":value.totals.generated})
            }
            "projection" => {
                let value =
                    project_conductor_passengers_v2(fixture.source.projection.as_ref().unwrap())
                        .unwrap();
                json!({"hash":value.state_hash,"passengers":value.passengers.len()})
            }
            "start" => {
                let started = apply_conductor_session_command(&fixture.input(
                    fixture.initial(),
                    "acceptance-start",
                    ConductorCommandActionV1::StartSession,
                ))
                .unwrap();
                initial = started.state;
                json!({"hash":initial.state_hash,"snapshotBytes":serde_json::to_vec(&started.snapshot).unwrap().len()})
            }
            "restore" => {
                let value = restore_conductor_session_state(&RestoreConductorSessionStateInputV1 {
                    schema_version: "conductor-session-restore-input/v1".into(),
                    state: initial.clone(),
                    expected_state_hash: initial.state_hash.clone(),
                    dialogue_releases: fixture.source.dialogue_releases.clone(),
                })
                .unwrap();
                assert_eq!(value, initial);
                json!({"hash":value.state_hash})
            }
            "quit" => break,
            _ => panic!("unbekannter lokaler Prüfauftrag"),
        };
        writeln!(output, "{value}").unwrap();
        output.flush().unwrap();
    }
}
