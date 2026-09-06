use serde::{Deserialize, Serialize};
use zugfolge_demand::FareFactV1;

macro_rules! value_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}
value_enum!(PresentationV1 {
    EmptyPhone,
    DefectivePhone,
    TechnicalIssue,
    Admission,
    Misunderstanding,
    Excuse,
    LackOfMoney,
    Silence,
    HostileReaction,
    Refusal,
    Intoxication,
    SafetyEscalation
});
value_enum!(ToneV1 {
    Friendly,
    Neutral,
    Impatient,
    Unfriendly
});
value_enum!(CooperationV1 {
    Cooperative,
    Evasive,
    IdentityRefusal,
    ConcreteDanger
});
value_enum!(DocumentStatusV1 {
    Unchecked,
    VerifiedValid,
    NotPresentable,
    VerifiedInvalid
});
value_enum!(AcquisitionExceptionV1 {
    Unknown,
    Proven,
    Excluded
});
value_enum!(IdentityStatusV1 {
    Unknown,
    Confirmed,
    Refused
});
value_enum!(DialogueIntentV1 {
    CloseWithoutAction,
    RequestDocumentCheck,
    RequestRegularClaim,
    RequestProvisionalClaim,
    RequestPolice
});
value_enum!(DialogueConditionV1 {
    Always,
    DocumentUnchecked,
    DocumentValid,
    RegularClaimAllowed,
    ProvisionalClaimAllowed,
    PoliceAllowed
});
value_enum!(EncounterStatusV1 { Active, Closed });

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueEvidenceV1 {
    pub document_status: DocumentStatusV1,
    pub acquisition_exception: AcquisitionExceptionV1,
    pub identity_status: IdentityStatusV1,
    pub concrete_danger: bool,
}
impl Default for DialogueEvidenceV1 {
    fn default() -> Self {
        Self {
            document_status: DocumentStatusV1::Unchecked,
            acquisition_exception: AcquisitionExceptionV1::Unknown,
            identity_status: IdentityStatusV1::Unknown,
            concrete_danger: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueReleaseV1 {
    pub schema_version: String,
    pub release_id: String,
    pub locale: String,
    pub families: Vec<DialogueFamilyV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueFamilyV1 {
    pub family_id: String,
    pub weight_basis_points: u32,
    pub trees: Vec<DialogueTreeV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueTreeV1 {
    pub tree_id: String,
    pub scenario: String,
    pub weight_basis_points: u32,
    pub presentation: PresentationV1,
    pub tone: ToneV1,
    pub cooperation: CooperationV1,
    pub entry_node_id: String,
    pub nodes: Vec<DialogueNodeV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueNodeV1 {
    pub node_id: String,
    pub passenger_text: String,
    pub options: Vec<DialogueOptionV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueOptionV1 {
    pub option_id: String,
    pub text: String,
    pub condition: DialogueConditionV1,
    pub time_cost_ms: i64,
    pub next_node_id: Option<String>,
    pub intent: Option<DialogueIntentV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartDialogueInputV1 {
    pub world_id: String,
    pub period_id: String,
    pub train_run_id: String,
    pub passenger_key: String,
    pub encounter_id: String,
    pub now_ms: i64,
    pub release_hash: String,
    pub seed: String,
    pub fare_fact: FareFactV1,
    pub evidence: DialogueEvidenceV1,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChooseDialogueInputV1 {
    pub command_id: String,
    pub expected_revision: u64,
    pub now_ms: i64,
    pub option_id: String,
    pub evidence: DialogueEvidenceV1,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseDialogueInputV1 {
    pub command_id: String,
    pub expected_revision: u64,
    pub now_ms: i64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObserveDialogueInputV1 {
    pub command_id: String,
    pub expected_revision: u64,
    pub now_ms: i64,
    pub evidence: DialogueEvidenceV1,
}
// Dieser vollständige Zustand ist ausschließlich serverseitig zu persistieren.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueStateV1 {
    pub schema_version: String,
    pub world_id: String,
    pub period_id: String,
    pub train_run_id: String,
    pub passenger_key: String,
    pub encounter_id: String,
    pub release_id: String,
    pub release_hash: String,
    pub selection_hash: String,
    pub fare_fact: FareFactV1,
    pub evidence: DialogueEvidenceV1,
    pub tree_id: String,
    pub node_id: String,
    pub revision: u64,
    pub updated_at_ms: i64,
    pub available_at_ms: i64,
    pub status: EncounterStatusV1,
    pub last_receipt: Option<DialogueReceiptV1>,
    pub state_hash: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueReceiptV1 {
    pub command_id: String,
    pub command_hash: String,
    pub intent: Option<DialogueIntentV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueTransitionV1 {
    pub state: DialogueStateV1,
    pub encounter: PassengerEncounterV1,
    pub intent: Option<DialogueIntentV1>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassengerEncounterV1 {
    pub schema_version: String,
    pub encounter_id: String,
    pub revision: u64,
    pub status: EncounterStatusV1,
    pub passenger_text: String,
    pub options: Vec<PassengerDialogueOptionV1>,
    pub hints: DialogueEvidenceV1,
    pub available_at_ms: i64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassengerDialogueOptionV1 {
    pub option_id: String,
    pub text: String,
    pub time_cost_ms: i64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogueReleaseReportV1 {
    pub release_id: String,
    pub release_hash: String,
    pub families: u32,
    pub trees: u32,
    pub utterances: u32,
}
value_enum!(DialogueErrorV1 {
    InvalidRelease,
    InvalidInput,
    ReleaseMismatch,
    InvalidState,
    StaleRevision,
    ConflictingCommand,
    OptionNotAllowed,
    EvidenceRegression,
    DialogueClosed,
    NotReady,
    TimeOverflow
});
impl std::fmt::Display for DialogueErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Dialogprüfung abgelehnt: {self:?}")
    }
}
impl std::error::Error for DialogueErrorV1 {}
