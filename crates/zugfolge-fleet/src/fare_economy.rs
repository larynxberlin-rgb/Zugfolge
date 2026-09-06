//! Optionaler vollständiger M15-Abrechnungsvertrag im bestehenden M6-Release.
#![allow(missing_docs)]
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareInspectionEconomyV1 {
    pub schema_version: String,
    pub minimum_claim_cents: String,
    pub ordinary_fare_multiplier: u32,
    pub reduced_claim_cents: String,
    pub proof_window_days: u32,
    pub day_length_ms: i64,
    pub handling_cost_cents: String,
    pub unfounded_claim_cost_cents: String,
    pub police_handling_cost_cents: String,
    pub full_payment_basis_points: u32,
    pub partial_payment_basis_points: u32,
    pub partial_payment_share_basis_points: u32,
    pub payment_delay_ms: i64,
    pub write_off_delay_ms: i64,
    pub valid_proof_submission_basis_points: u32,
    pub valid_proof_delay_ms: i64,
    pub premium_multiplier_basis_points: u32,
    pub positive_daily_cap_basis_points: u32,
    pub revenue_allocation: String,
}
fn cents(value: &str) -> bool {
    value.parse::<i64>().is_ok_and(|n| n >= 0 && n.to_string() == value)
}
impl FareInspectionEconomyV1 {
    pub fn validate(&self) -> bool {
        self.schema_version == "fare-inspection-economy/v1"
            && self.minimum_claim_cents == "6000" && self.ordinary_fare_multiplier == 2
            && self.reduced_claim_cents == "700" && self.proof_window_days == 7
            && self.day_length_ms == 86_400_000
            && [&self.handling_cost_cents, &self.unfounded_claim_cost_cents, &self.police_handling_cost_cents].iter().all(|s| cents(s))
            && self.full_payment_basis_points <= 10_000 && self.partial_payment_basis_points <= 10_000
            && self.full_payment_basis_points + self.partial_payment_basis_points <= 10_000
            && (1..10_000).contains(&self.partial_payment_share_basis_points)
            && self.payment_delay_ms > 0 && self.write_off_delay_ms > self.payment_delay_ms
            && self.valid_proof_submission_basis_points <= 10_000 && self.valid_proof_delay_ms > 0
            && self.premium_multiplier_basis_points <= 40_000 && self.positive_daily_cap_basis_points <= 50
            && self.revenue_allocation == "uniform_settled_service_interval/v1"
    }
}

pub fn deserialize_optional_fare_inspection<'de, D>(deserializer: D) -> Result<Option<FareInspectionEconomyV1>, D::Error>
where D: serde::Deserializer<'de> {
    FareInspectionEconomyV1::deserialize(deserializer).map(Some)
}
