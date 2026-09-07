use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zugfolge_conductor_dialogue::DialogueEvidenceV1;
use zugfolge_demand::ManifestPassengerV1;
use zugfolge_fleet::release_catalog::EconomyReleaseDocument;

macro_rules! value_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}
value_enum!(FarePurchaseAvailabilityV1 {
    Available,
    Unavailable,
    Unknown
});
value_enum!(FareInspectionCaseStatusV1 {
    Open,
    ClosedWithoutClaim,
    ClaimOpen,
    Settled
});
value_enum!(FareClaimKindV1 {
    Regular,
    Provisional
});
value_enum!(FareLedgerRoleV1 {
    Receivable,
    ClaimAccrual,
    Cash,
    ClaimReduction,
    HandlingCost,
    WriteOff,
    Premium,
    CapAdjustment
});
value_enum!(FareLedgerEventKindV1 {
    ClaimOpened,
    Payment,
    Reduction,
    HandlingCost,
    WriteOff,
    Premium,
    CapAdjustment
});
value_enum!(PoliceResolutionV1 {
    Pending,
    IdentityConfirmed,
    IdentityNotConfirmed,
    Unavailable,
    TimedOut,
    TargetUnavailable
});

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareInspectionPolicyV1 {
    pub schema_version: String,
    pub policy_id: String,
    pub world_id: String,
    pub period_id: String,
    pub content_hash: String,
    pub invalid_document_presented_basis_points: u32,
    pub identity_refusal_basis_points: u32,
    pub concrete_danger_basis_points: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareJourneyEvidenceV1 {
    pub schema_version: String,
    pub evidence_id: String,
    pub world_id: String,
    pub period_id: String,
    pub train_run_id: String,
    pub boarding_stop_id: String,
    pub alighting_stop_id: String,
    pub ordinary_fare_cents: Option<String>,
    pub ticket_office: FarePurchaseAvailabilityV1,
    pub ticket_machine: FarePurchaseAvailabilityV1,
    pub source_id: String,
    pub content_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareInspectionPinV1 {
    pub world_id: String,
    pub operator_id: String,
    pub period_id: String,
    pub train_run_id: String,
    pub encounter_id: String,
    pub manifest_revision: u64,
    pub demand_state_hash: String,
    pub segment_id: String,
    pub passenger: ManifestPassengerV1,
    pub dialogue_release_hash: String,
    pub inspected_at_ms: i64,
    pub seed_hash: String,
    pub inspection_policy: FareInspectionPolicyV1,
    pub journey_evidence: Option<FareJourneyEvidenceV1>,
    pub economy_release: EconomyReleaseDocument,
    pub expected_economy_release_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareInspectionCaseV1 {
    pub schema_version: String,
    pub case_id: String,
    pub pin: FareInspectionPinV1,
    pub pin_hash: String,
    pub status: FareInspectionCaseStatusV1,
    pub evidence: DialogueEvidenceV1,
    pub claim_kind: Option<FareClaimKindV1>,
    pub claim_opened_at_ms: Option<i64>,
    pub original_claim_cents: String,
    pub claim_cents: String,
    pub paid_cents: String,
    pub costs_cents: String,
    pub written_off_cents: String,
    pub reduced_cents: String,
    pub proof_deadline_ms: i64,
    pub proof_received_at_ms: Option<i64>,
    pub payment_processed: bool,
    pub proof_processed: bool,
    pub police_hold_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoliceResponseModelV1 {
    pub schema_version: String,
    pub model_id: String,
    pub world_id: String,
    pub content_hash: String,
    pub available_basis_points: u32,
    pub delayed_basis_points: u32,
    pub response_ms: i64,
    pub delayed_response_ms: i64,
    pub identity_success_basis_points: u32,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoliceCaseOutcomeV1 {
    pub case_id: String,
    pub identity_confirmed: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoliceResponsePlanV1 {
    pub world_id: String,
    pub operator_id: String,
    pub hold_id: String,
    pub train_run_id: String,
    pub target_stop_id: String,
    pub requested_at_ms: i64,
    pub model: PoliceResponseModelV1,
    pub available: bool,
    pub response_after_activation_ms: i64,
    pub cases: Vec<PoliceCaseOutcomeV1>,
    pub resolution: PoliceResolutionV1,
    pub plan_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoliceOperationalEvidenceV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub hold_id: String,
    pub target_stop_id: String,
    pub model_hash: String,
    pub operational_state_hash: String,
    pub activated_at_ms: Option<i64>,
    pub deadline_ms: Option<i64>,
    pub released_at_ms: Option<i64>,
    pub target_unavailable: bool,
    pub outcome: PoliceResolutionV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareLedgerPostingV1 {
    pub role: FareLedgerRoleV1,
    pub amount_cents: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareLedgerEventV1 {
    pub world_id: String,
    pub operator_id: String,
    pub event_id: String,
    pub case_id: Option<String>,
    pub at_ms: i64,
    pub day_start_ms: i64,
    pub kind: FareLedgerEventKindV1,
    pub economy_release_hash: String,
    pub postings: Vec<FareLedgerPostingV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareDaySettlementV1 {
    pub day_start_ms: i64,
    pub contract_revenue_cents: String,
    pub contract_receipt_ids: Vec<String>,
    pub net_cents: String,
    pub premium_cents: String,
    pub cap_adjustment_cents: String,
    pub settlement_revision: u64,
    pub economy_release_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareContractRevenueEvidenceV1 {
    pub schema_version: String,
    pub world_id: String,
    pub operator_id: String,
    pub contract_id: String,
    pub journal_effect_id: String,
    pub economy_release_hash: String,
    pub service_start_ms: i64,
    pub service_end_ms: i64,
    pub settled_at_ms: i64,
    pub ordering_fee_cents: String,
    pub bonus_cents: String,
    pub penalty_cents: String,
    pub content_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmedFareContractRevenueV1 {
    pub evidence: FareContractRevenueEvidenceV1,
    pub ledger_transaction_id: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlReceiptV1 {
    pub command_id: String,
    pub command_hash: String,
    pub domain_state_hash: String,
    pub revision: u64,
    pub case_id: Option<String>,
    pub binding: Option<FareControlEffectBindingV1>,
    pub ledger_event_ids: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FareControlEffectBindingV1 {
    Claim {
        case_id: String,
    },
    Hold {
        hold_id: String,
        case_ids: Vec<String>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlWorldStateV1 {
    pub schema_version: String,
    pub world_id: String,
    pub operator_id: String,
    pub revision: u64,
    pub now_ms: i64,
    pub cases: BTreeMap<String, FareInspectionCaseV1>,
    pub police_plans: BTreeMap<String, PoliceResponsePlanV1>,
    pub days: BTreeMap<String, FareDaySettlementV1>,
    pub ledger_events: BTreeMap<String, FareLedgerEventV1>,
    pub receipts: BTreeMap<String, FareControlReceiptV1>,
    pub state_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FareControlActionV1 {
    OpenCase {
        case_id: String,
        pin: Box<FareInspectionPinV1>,
    },
    InspectDocument {
        case_id: String,
    },
    CreateClaim {
        case_id: String,
        kind: FareClaimKindV1,
    },
    CloseCase {
        case_id: String,
    },
    ReceiveProof {
        case_id: String,
        received_at_ms: i64,
    },
    AdvanceTime,
    PlanPolice {
        hold_id: String,
        train_run_id: String,
        target_stop_id: String,
        case_ids: Vec<String>,
        model: PoliceResponseModelV1,
    },
    ResolvePolice {
        evidence: PoliceOperationalEvidenceV1,
    },
    SettleDay {
        day_start_ms: i64,
        contract_revenue_evidence: Vec<ConfirmedFareContractRevenueV1>,
        economy_release: Box<EconomyReleaseDocument>,
    },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlCommandV1 {
    pub world_id: String,
    pub operator_id: String,
    pub command_id: String,
    pub expected_revision: u64,
    pub now_ms: i64,
    pub action: FareControlActionV1,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlTransitionV1 {
    pub state: FareControlWorldStateV1,
    pub receipt: FareControlReceiptV1,
    pub ledger_events: Vec<FareLedgerEventV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareInspectionCaseViewV1 {
    pub case_id: String,
    pub encounter_id: String,
    pub train_run_id: String,
    pub status: FareInspectionCaseStatusV1,
    pub evidence: DialogueEvidenceV1,
    pub claim_kind: Option<FareClaimKindV1>,
    pub claim_cents: String,
    pub paid_cents: String,
    pub costs_cents: String,
    pub written_off_cents: String,
    pub proof_deadline_ms: i64,
}

/// Öffentliche EVU-Tageswerte ohne private Beleg-, Personen- oder Modellpins.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareDayReportV1 {
    pub day_start_ms: i64,
    pub contract_revenue_cents: String,
    pub net_cents: String,
    pub premium_cents: String,
    pub cap_adjustment_cents: String,
    pub contribution_cents: String,
    pub settlement_revision: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareControlReportV1 {
    pub cases: Vec<FareInspectionCaseViewV1>,
    pub days: Vec<FareDayReportV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FareControlError(pub &'static str);
impl std::fmt::Display for FareControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for FareControlError {}
