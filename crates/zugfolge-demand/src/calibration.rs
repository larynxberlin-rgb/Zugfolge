use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    DemandError, Provenance, RailModeV1, SourceEvidenceV1,
    engine::{digest, validate_sources},
    ensure,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalibrationMetricV1 {
    DailyProfile,
    CrossSection,
    TransferFlow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationToleranceV1 {
    pub mode: RailModeV1,
    pub metric: CalibrationMetricV1,
    pub absolute_passengers: u32,
    pub relative_basis_points: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationObservationV1 {
    pub id: String,
    pub mode: RailModeV1,
    pub metric: CalibrationMetricV1,
    pub source_id: String,
    pub provenance: Provenance,
    pub observed_passengers: u32,
    pub simulated_passengers: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandCalibrationV1 {
    pub schema_version: String,
    pub world_id: String,
    pub demand_release_id: String,
    pub plan_id: String,
    pub sources: Vec<SourceEvidenceV1>,
    pub training_observation_ids: Vec<String>,
    pub tolerances: Vec<CalibrationToleranceV1>,
    pub holdout: Vec<CalibrationObservationV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalibrationDeviationV1 {
    pub observation_id: String,
    pub mode: RailModeV1,
    pub metric: CalibrationMetricV1,
    pub source_id: String,
    pub observed_passengers: u32,
    pub simulated_passengers: u32,
    pub absolute_deviation: u32,
    pub allowed_deviation: u64,
    pub accepted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandCalibrationReportV1 {
    pub schema_version: String,
    pub world_id: String,
    pub demand_release_id: String,
    pub plan_id: String,
    pub evidence_hash: String,
    pub accepted: bool,
    pub deviations: Vec<CalibrationDeviationV1>,
}

/// Prüft freigegebene, disjunkte Holdouts gegen eingefrorene mode-/metrikspezifische Toleranzen.
pub fn calibrate_demand(
    input: &DemandCalibrationV1,
) -> Result<DemandCalibrationReportV1, DemandError> {
    ensure(
        input.schema_version == "zugfolge-demand-calibration/v1"
            && !input.world_id.is_empty()
            && !input.demand_release_id.is_empty()
            && !input.plan_id.is_empty(),
        "invalid_calibration_identity",
    )?;
    ensure(
        !input.training_observation_ids.is_empty()
            && !input.holdout.is_empty()
            && input.holdout.len() <= 100_000
            && input.training_observation_ids.len() <= 100_000,
        "invalid_calibration_size",
    )?;
    validate_sources(&input.sources)?;
    let mut seen: BTreeSet<_> = input.training_observation_ids.iter().collect();
    ensure(
        seen.len() == input.training_observation_ids.len() && seen.iter().all(|id| !id.is_empty()),
        "duplicate_training_observation",
    )?;
    let mut required = BTreeSet::new();
    for mode in [RailModeV1::Spnv, RailModeV1::Spfv] {
        for metric in [
            CalibrationMetricV1::DailyProfile,
            CalibrationMetricV1::CrossSection,
            CalibrationMetricV1::TransferFlow,
        ] {
            required.insert((mode, metric));
        }
    }
    ensure(
        input.tolerances.len() == 6
            && input
                .tolerances
                .iter()
                .map(|row| (row.mode, row.metric))
                .collect::<BTreeSet<_>>()
                == required
            && input
                .tolerances
                .iter()
                .all(|row| row.relative_basis_points <= 10_000),
        "incomplete_calibration_tolerances",
    )?;
    let mut covered = BTreeSet::new();
    let mut deviations = Vec::new();
    for observation in &input.holdout {
        ensure(
            !observation.id.is_empty() && seen.insert(&observation.id),
            "calibration_train_holdout_overlap",
        )?;
        ensure(
            observation.provenance == Provenance::Observed,
            "synthetic_holdout_not_accepted",
        )?;
        ensure(
            input
                .sources
                .iter()
                .any(|source| source.id == observation.source_id),
            "unknown_calibration_source",
        )?;
        covered.insert((observation.mode, observation.metric));
        let tolerance = input
            .tolerances
            .iter()
            .find(|row| row.mode == observation.mode && row.metric == observation.metric)
            .expect("complete tolerance set");
        let allowed_deviation = u64::from(tolerance.absolute_passengers).max(
            u64::from(observation.observed_passengers) * u64::from(tolerance.relative_basis_points)
                / 10_000,
        );
        let absolute_deviation = observation
            .simulated_passengers
            .abs_diff(observation.observed_passengers);
        deviations.push(CalibrationDeviationV1 {
            observation_id: observation.id.clone(),
            mode: observation.mode,
            metric: observation.metric,
            source_id: observation.source_id.clone(),
            observed_passengers: observation.observed_passengers,
            simulated_passengers: observation.simulated_passengers,
            absolute_deviation,
            allowed_deviation,
            accepted: u64::from(absolute_deviation) <= allowed_deviation,
        });
    }
    ensure(covered == required, "incomplete_spnv_spfv_holdout")?;
    deviations.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
    let mut canonical = input.clone();
    canonical.sources.sort_by(|a, b| a.id.cmp(&b.id));
    canonical.training_observation_ids.sort();
    canonical
        .tolerances
        .sort_by_key(|row| (row.mode, row.metric));
    canonical.holdout.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(DemandCalibrationReportV1 {
        schema_version: "zugfolge-demand-calibration-report/v1".into(),
        world_id: input.world_id.clone(),
        demand_release_id: input.demand_release_id.clone(),
        plan_id: input.plan_id.clone(),
        evidence_hash: digest(&["calibration_evidence", &serde_json::to_string(&canonical)?]),
        accepted: deviations.iter().all(|row| row.accepted),
        deviations,
    })
}
