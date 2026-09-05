//! Der Kalibrierungskern akzeptiert keine synthetischen Nachweise als Beobachtung.
use zugfolge_demand::*;

fn contract_fixture() -> DemandCalibrationV1 {
    // Diese Werte testen ausschließlich den Vergleichsvertrag. Sie sind kein realer Holdout.
    let mut tolerances = Vec::new();
    let mut holdout = Vec::new();
    for mode in [RailModeV1::Spnv, RailModeV1::Spfv] {
        for metric in [
            CalibrationMetricV1::DailyProfile,
            CalibrationMetricV1::CrossSection,
            CalibrationMetricV1::TransferFlow,
        ] {
            tolerances.push(CalibrationToleranceV1 {
                mode,
                metric,
                absolute_passengers: 2,
                relative_basis_points: 500,
            });
            holdout.push(CalibrationObservationV1 {
                id: format!("contract-{mode:?}-{metric:?}"),
                mode,
                metric,
                source_id: "contract-fixture".into(),
                provenance: Provenance::Observed,
                observed_passengers: 100,
                simulated_passengers: 105,
            });
        }
    }
    DemandCalibrationV1 {
        schema_version: "zugfolge-demand-calibration/v1".into(),
        world_id: "contract-world".into(),
        demand_release_id: "contract-release".into(),
        plan_id: "contract-plan".into(),
        sources: vec![SourceEvidenceV1 {
            id: "contract-fixture".into(),
            url: "https://example.invalid/contract-fixture".into(),
            license: "Synthetic test-only contract data".into(),
            artifact_sha256: "0".repeat(64),
            rights_approved: true,
        }],
        training_observation_ids: vec!["contract-training".into()],
        tolerances,
        holdout,
    }
}

#[test]
fn separate_modes_metrics_frozen_tolerances_and_permutation_are_reported() {
    let mut input = contract_fixture();
    let report = calibrate_demand(&input).unwrap();
    assert!(report.accepted);
    assert_eq!(report.deviations.len(), 6);
    assert!(
        report
            .deviations
            .iter()
            .all(|row| row.allowed_deviation == 5 && row.absolute_deviation == 5)
    );
    input.holdout.reverse();
    input.tolerances.reverse();
    assert_eq!(calibrate_demand(&input).unwrap(), report);
    input.holdout[0].simulated_passengers = 106;
    assert!(!calibrate_demand(&input).unwrap().accepted);
    input.holdout[0].observed_passengers = 0;
    input.holdout[0].simulated_passengers = 2;
    assert!(calibrate_demand(&input).unwrap().accepted);
    input.holdout[0].simulated_passengers = 3;
    assert!(!calibrate_demand(&input).unwrap().accepted);
}

#[test]
fn held_out_rights_sources_and_real_observation_gates_fail_closed() {
    let mut input = contract_fixture();
    input
        .training_observation_ids
        .push(input.holdout[0].id.clone());
    assert_eq!(
        calibrate_demand(&input).unwrap_err().0,
        "calibration_train_holdout_overlap"
    );
    input = contract_fixture();
    input.sources[0].rights_approved = false;
    assert_eq!(
        calibrate_demand(&input).unwrap_err().0,
        "source_rights_not_approved"
    );
    input = contract_fixture();
    input.holdout[0].provenance = Provenance::Balanced;
    assert_eq!(
        calibrate_demand(&input).unwrap_err().0,
        "synthetic_holdout_not_accepted"
    );
    input = contract_fixture();
    input.holdout.pop();
    assert_eq!(
        calibrate_demand(&input).unwrap_err().0,
        "incomplete_spnv_spfv_holdout"
    );
    input = contract_fixture();
    input.holdout[0].source_id = "missing".into();
    assert_eq!(
        calibrate_demand(&input).unwrap_err().0,
        "unknown_calibration_source"
    );
}
