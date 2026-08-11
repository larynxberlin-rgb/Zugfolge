//! Versioniertes Betriebsprogramm und deterministische Dispositionsregel-Engine (M7.1/M7.2).
//!
//! Der Kernvertrag bleibt rein: explizite Ereignisfakten hinein,
//! [`DecisionExplanation`] und eine M4.4-[`DispatchDecision`] hinaus. Dieses
//! Crate kennt weder Datenbank, Netzwerk noch Systemuhr.
#![allow(
    missing_docs,
    reason = "öffentliche Felder sind durch die versionierte Spezifikation und ihre Typen beschrieben"
)]

use std::collections::BTreeSet;
use std::error::Error;
use std::fmt;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_determinism::{StateHash, StateHasher};
use zugfolge_fleet::OperationsError;
use zugfolge_planner::PathDecision;
use zugfolge_sim::{
    DispatchDecision, DispatchFacts, DispatchImpact, DispatchLimits, DispatchTrigger, Dispatcher,
    SimTime, TrainRun,
};

pub const OPERATING_PROGRAM_SCHEMA: &str = "operating-program/v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OperatingProgram {
    pub schema: String,
    pub world_id: String,
    pub operator_id: String,
    pub version: u32,
    pub enabled: bool,
    pub rules: Vec<OperatingRule>,
}

impl OperatingProgram {
    pub fn validate(&self) -> Result<(), RuleError> {
        if self.schema != OPERATING_PROGRAM_SCHEMA {
            return Err(RuleError::WrongSchema);
        }
        if self.world_id.is_empty() || self.operator_id.is_empty() || self.version == 0 {
            return Err(RuleError::InvalidIdentity);
        }
        if self.rules.is_empty() {
            return Err(RuleError::EmptyProgram);
        }
        let mut ids = BTreeSet::new();
        for rule in &self.rules {
            rule.validate()?;
            if !ids.insert(rule.id.clone()) {
                return Err(RuleError::DuplicateRule(rule.id.clone()));
            }
        }
        Ok(())
    }

    pub fn canonicalized(&self) -> Result<Self, RuleError> {
        self.validate()?;
        let mut program = self.clone();
        program.rules.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(program)
    }

    pub fn canonical_json(&self) -> Result<String, RuleError> {
        serde_json::to_string(&self.canonicalized()?).map_err(|_| RuleError::Serialization)
    }

    pub fn checksum(&self) -> Result<String, RuleError> {
        let canonical = self.canonical_json()?;
        let digest = Sha256::digest(canonical.as_bytes());
        let mut checksum = String::with_capacity(64);
        for byte in digest {
            write!(&mut checksum, "{byte:02x}").map_err(|_| RuleError::Serialization)?;
        }
        Ok(checksum)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct OperatingRule {
    pub id: String,
    pub priority: i32,
    pub enabled: bool,
    pub trigger: RuleTrigger,
    pub condition: Condition,
    pub action: Action,
}

impl OperatingRule {
    fn validate(&self) -> Result<(), RuleError> {
        if self.id.is_empty()
            || self.id.len() > 96
            || !self.id.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
            })
        {
            return Err(RuleError::InvalidRuleId(self.id.clone()));
        }
        if !(-1_000_000..=1_000_000).contains(&self.priority) {
            return Err(RuleError::InvalidPriority(self.id.clone()));
        }
        self.trigger.validate()?;
        let mut nodes = 0_u32;
        self.condition.validate(0, &mut nodes)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuleTrigger {
    DelayThreshold { at_least_seconds: i64 },
    ConnectionRisk,
    VehicleFailure,
    PersonnelDutyExceeded,
    RouteClosure,
    PlatformChange,
    TurnaroundShortfall,
    AdHocPathConflict,
}

impl RuleTrigger {
    fn validate(self) -> Result<(), RuleError> {
        if matches!(self, Self::DelayThreshold { at_least_seconds } if at_least_seconds <= 0) {
            Err(RuleError::InvalidTrigger)
        } else {
            Ok(())
        }
    }

    fn matches(self, trigger: DispatchTrigger, facts: &DispatchFacts) -> bool {
        match self {
            Self::DelayThreshold { at_least_seconds } => {
                trigger == DispatchTrigger::DelayThreshold
                    && facts.delay_seconds >= at_least_seconds
            }
            Self::ConnectionRisk => {
                trigger == DispatchTrigger::ConnectionRisk && facts.connection_threatened
            }
            Self::VehicleFailure => {
                trigger == DispatchTrigger::VehicleFailure && facts.vehicle_failed
            }
            Self::PersonnelDutyExceeded => {
                trigger == DispatchTrigger::PersonnelDutyExceeded && facts.duty_excess_seconds > 0
            }
            Self::RouteClosure => trigger == DispatchTrigger::RouteClosure && facts.route_closed,
            Self::PlatformChange => {
                trigger == DispatchTrigger::PlatformChange && facts.platform_changed
            }
            Self::TurnaroundShortfall => {
                trigger == DispatchTrigger::TurnaroundShortfall
                    && facts.turnaround_shortfall_seconds > 0
            }
            Self::AdHocPathConflict => {
                trigger == DispatchTrigger::AdHocPathConflict && facts.adhoc_conflict
            }
        }
    }

    const fn observed(trigger: DispatchTrigger, facts: &DispatchFacts) -> Self {
        match trigger {
            DispatchTrigger::DelayThreshold => Self::DelayThreshold {
                at_least_seconds: facts.delay_seconds,
            },
            DispatchTrigger::ConnectionRisk => Self::ConnectionRisk,
            DispatchTrigger::VehicleFailure => Self::VehicleFailure,
            DispatchTrigger::PersonnelDutyExceeded => Self::PersonnelDutyExceeded,
            DispatchTrigger::RouteClosure => Self::RouteClosure,
            DispatchTrigger::PlatformChange => Self::PlatformChange,
            DispatchTrigger::TurnaroundShortfall => Self::TurnaroundShortfall,
            DispatchTrigger::AdHocPathConflict => Self::AdHocPathConflict,
            DispatchTrigger::Arrival | DispatchTrigger::Departure => Self::DelayThreshold {
                at_least_seconds: 0,
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Condition {
    All {
        children: Vec<Condition>,
    },
    Any {
        children: Vec<Condition>,
    },
    Not {
        child: Box<Condition>,
    },
    Predicate {
        fact: FactKey,
        comparison: Comparison,
        value: FactValue,
    },
}

impl Condition {
    fn validate(&self, depth: u8, nodes: &mut u32) -> Result<(), RuleError> {
        *nodes = nodes.saturating_add(1);
        if depth > 8 || *nodes > 64 {
            return Err(RuleError::ConditionTooComplex);
        }
        match self {
            Self::All { children } | Self::Any { children } => {
                if children.is_empty() {
                    return Err(RuleError::EmptyConditionGroup);
                }
                for child in children {
                    child.validate(depth.saturating_add(1), nodes)?;
                }
            }
            Self::Not { child } => child.validate(depth.saturating_add(1), nodes)?,
            Self::Predicate { fact, value, .. } if fact.value_kind() != value.kind() => {
                return Err(RuleError::ConditionTypeMismatch);
            }
            Self::Predicate { .. } => {}
        }
        Ok(())
    }

    fn evaluate(
        &self,
        facts: &DispatchFacts,
        path: &str,
        checks: &mut Vec<ConditionCheck>,
    ) -> bool {
        match self {
            Self::All { children } => {
                let mut matched = true;
                for (index, child) in children.iter().enumerate() {
                    matched &= child.evaluate(facts, &format!("{path}.{index}"), checks);
                }
                matched
            }
            Self::Any { children } => {
                let mut matched = false;
                for (index, child) in children.iter().enumerate() {
                    matched |= child.evaluate(facts, &format!("{path}.{index}"), checks);
                }
                matched
            }
            Self::Not { child } => !child.evaluate(facts, &format!("{path}.not"), checks),
            Self::Predicate {
                fact,
                comparison,
                value,
            } => {
                let actual = fact.read(facts);
                let matched = comparison.evaluate(&actual, value);
                checks.push(ConditionCheck {
                    path: path.to_owned(),
                    fact: *fact,
                    comparison: *comparison,
                    expected: value.clone(),
                    actual,
                    matched,
                });
                matched
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKey {
    DelaySeconds,
    ConnectionThreatened,
    VehicleFailed,
    DutyExcessSeconds,
    RouteClosed,
    PlatformChanged,
    TurnaroundShortfallSeconds,
    AdHocConflict,
    AffectedTrainRuns,
    CostCents,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ValueKind {
    Integer,
    Boolean,
}

impl FactKey {
    const fn value_kind(self) -> ValueKind {
        match self {
            Self::ConnectionThreatened
            | Self::VehicleFailed
            | Self::RouteClosed
            | Self::PlatformChanged
            | Self::AdHocConflict => ValueKind::Boolean,
            Self::DelaySeconds
            | Self::DutyExcessSeconds
            | Self::TurnaroundShortfallSeconds
            | Self::AffectedTrainRuns
            | Self::CostCents => ValueKind::Integer,
        }
    }

    fn read(self, facts: &DispatchFacts) -> FactValue {
        match self {
            Self::DelaySeconds => FactValue::Integer(facts.delay_seconds),
            Self::ConnectionThreatened => FactValue::Boolean(facts.connection_threatened),
            Self::VehicleFailed => FactValue::Boolean(facts.vehicle_failed),
            Self::DutyExcessSeconds => FactValue::Integer(i64::from(facts.duty_excess_seconds)),
            Self::RouteClosed => FactValue::Boolean(facts.route_closed),
            Self::PlatformChanged => FactValue::Boolean(facts.platform_changed),
            Self::TurnaroundShortfallSeconds => {
                FactValue::Integer(i64::from(facts.turnaround_shortfall_seconds))
            }
            Self::AdHocConflict => FactValue::Boolean(facts.adhoc_conflict),
            Self::AffectedTrainRuns => {
                FactValue::Integer(i64::from(facts.impact.affected_train_runs))
            }
            Self::CostCents => FactValue::Integer(facts.impact.cost_cents),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Equal,
    NotEqual,
    GreaterOrEqual,
    LessOrEqual,
}

impl Comparison {
    fn evaluate(self, actual: &FactValue, expected: &FactValue) -> bool {
        match (self, actual, expected) {
            (Self::Equal, left, right) => left == right,
            (Self::NotEqual, left, right) => left != right,
            (Self::GreaterOrEqual, FactValue::Integer(left), FactValue::Integer(right)) => {
                left >= right
            }
            (Self::LessOrEqual, FactValue::Integer(left), FactValue::Integer(right)) => {
                left <= right
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum FactValue {
    Integer(i64),
    Boolean(bool),
}

impl FactValue {
    const fn kind(&self) -> ValueKind {
        match self {
            Self::Integer(_) => ValueKind::Integer,
            Self::Boolean(_) => ValueKind::Boolean,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    HoldConnection,
    BreakConnection,
    SkipStop,
    ShortTurn,
    ShortenTrain,
    StrengthenTrain,
    CancelRun,
    ActivateReserveRotation,
    ProvideReplacementVehicle,
    RequestReroute,
    ReturnPath,
    TriggerRailReplacement,
}

impl Action {
    fn dispatch(self, facts: &DispatchFacts) -> DispatchDecision {
        match self {
            Self::HoldConnection => DispatchDecision::HoldUntil(facts.hold_until),
            Self::BreakConnection => DispatchDecision::BreakConnection,
            Self::SkipStop => DispatchDecision::SkipStop,
            Self::ShortTurn => DispatchDecision::ShortTurn,
            Self::ShortenTrain => DispatchDecision::ShortenTrain,
            Self::StrengthenTrain => DispatchDecision::StrengthenTrain,
            Self::CancelRun => DispatchDecision::Cancel,
            Self::ActivateReserveRotation => DispatchDecision::ActivateReserveRotation,
            Self::ProvideReplacementVehicle => DispatchDecision::ProvideReplacementVehicle,
            Self::RequestReroute => DispatchDecision::RequestReroute,
            Self::ReturnPath => DispatchDecision::ReturnPath,
            Self::TriggerRailReplacement => DispatchDecision::TriggerRailReplacement,
        }
    }

    pub const fn from_dispatch(decision: DispatchDecision) -> Option<Self> {
        match decision {
            DispatchDecision::Proceed => None,
            DispatchDecision::HoldUntil(_) => Some(Self::HoldConnection),
            DispatchDecision::BreakConnection => Some(Self::BreakConnection),
            DispatchDecision::SkipStop => Some(Self::SkipStop),
            DispatchDecision::ShortTurn => Some(Self::ShortTurn),
            DispatchDecision::ShortenTrain => Some(Self::ShortenTrain),
            DispatchDecision::StrengthenTrain => Some(Self::StrengthenTrain),
            DispatchDecision::Cancel => Some(Self::CancelRun),
            DispatchDecision::ActivateReserveRotation => Some(Self::ActivateReserveRotation),
            DispatchDecision::ProvideReplacementVehicle => Some(Self::ProvideReplacementVehicle),
            DispatchDecision::RequestReroute => Some(Self::RequestReroute),
            DispatchDecision::ReturnPath => Some(Self::ReturnPath),
            DispatchDecision::TriggerRailReplacement => Some(Self::TriggerRailReplacement),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitKind {
    Capacity,
    TrainCharacteristics,
    RouteKnowledge,
    TrainProtection,
    Electrification,
    TrainLength,
    VehicleAvailability,
    Maintenance,
    PersonnelQualification,
    RestTime,
    Rotation,
    Contract,
    Cost,
}

fn required_limits(action: Action) -> &'static [LimitKind] {
    use LimitKind as L;
    match action {
        Action::HoldConnection | Action::BreakConnection => {
            &[L::Capacity, L::Rotation, L::Contract, L::Cost]
        }
        Action::SkipStop
        | Action::ShortTurn
        | Action::CancelRun
        | Action::ReturnPath
        | Action::TriggerRailReplacement => &[
            L::Capacity,
            L::Rotation,
            L::PersonnelQualification,
            L::RestTime,
            L::Contract,
            L::Cost,
        ],
        Action::ShortenTrain | Action::StrengthenTrain => &[
            L::Capacity,
            L::TrainCharacteristics,
            L::TrainLength,
            L::VehicleAvailability,
            L::Maintenance,
            L::PersonnelQualification,
            L::RestTime,
            L::Rotation,
            L::Contract,
            L::Cost,
        ],
        Action::ActivateReserveRotation | Action::ProvideReplacementVehicle => &[
            L::Capacity,
            L::TrainCharacteristics,
            L::TrainProtection,
            L::Electrification,
            L::TrainLength,
            L::VehicleAvailability,
            L::Maintenance,
            L::PersonnelQualification,
            L::RestTime,
            L::Rotation,
            L::Contract,
            L::Cost,
        ],
        Action::RequestReroute => &[
            L::Capacity,
            L::TrainCharacteristics,
            L::RouteKnowledge,
            L::TrainProtection,
            L::Electrification,
            L::TrainLength,
            L::VehicleAvailability,
            L::Maintenance,
            L::PersonnelQualification,
            L::RestTime,
            L::Rotation,
            L::Contract,
            L::Cost,
        ],
    }
}

fn check_limit(kind: LimitKind, limits: &DispatchLimits) -> bool {
    match kind {
        LimitKind::Capacity => limits.capacity_available,
        LimitKind::TrainCharacteristics => limits.train_characteristics_compatible,
        LimitKind::RouteKnowledge => limits.route_knowledge_available,
        LimitKind::TrainProtection => limits.train_protection_compatible,
        LimitKind::Electrification => limits.electrification_compatible,
        LimitKind::TrainLength => limits.train_length_allowed,
        LimitKind::VehicleAvailability => limits.vehicle_available,
        LimitKind::Maintenance => limits.maintenance_valid,
        LimitKind::PersonnelQualification => limits.personnel_qualified,
        LimitKind::RestTime => limits.rest_time_compliant,
        LimitKind::Rotation => limits.rotation_feasible,
        LimitKind::Contract => limits.contract_allows,
        LimitKind::Cost => limits.cost_within_limit,
    }
}

fn limit_reason(kind: LimitKind, accepted: bool) -> String {
    let name = match kind {
        LimitKind::Capacity => "Konfliktfreiheit und Kapazität",
        LimitKind::TrainCharacteristics => "Zugcharakteristik",
        LimitKind::RouteKnowledge => "Streckenkenntnis",
        LimitKind::TrainProtection => "Zugsicherung",
        LimitKind::Electrification => "Elektrifizierung",
        LimitKind::TrainLength => "zulässige Zuglänge",
        LimitKind::VehicleAvailability => "Fahrzeugverfügbarkeit",
        LimitKind::Maintenance => "Fahrzeugfrist",
        LimitKind::PersonnelQualification => "Personalqualifikation",
        LimitKind::RestTime => "Personalruhezeit",
        LimitKind::Rotation => "Umlauf",
        LimitKind::Contract => "Verkehrsvertrag",
        LimitKind::Cost => "Kostenrahmen des gepinnten EconomyRelease",
    };
    format!(
        "{name}: {}",
        if accepted {
            "zulässig"
        } else {
            "nicht zulässig"
        }
    )
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConditionCheck {
    pub path: String,
    pub fact: FactKey,
    pub comparison: Comparison,
    pub expected: FactValue,
    pub actual: FactValue,
    pub matched: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LimitCheck {
    pub kind: LimitKind,
    pub accepted: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RejectedAlternative {
    pub rule_id: Option<String>,
    pub action: Action,
    pub reason: String,
    pub limits: Vec<LimitCheck>,
    pub manual: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ImpactExplanation {
    pub affected_train_runs: u32,
    pub affected_connections: u32,
    pub affected_rotations: u32,
    pub affected_personnel_pools: u32,
    pub affected_vehicles: u32,
    pub cost_cents: i64,
    pub contract_penalty_cents: i64,
    pub cancelled_stops: u32,
    pub cause: String,
    pub affected_resource: String,
    pub contract_effect: String,
}

impl From<&DispatchImpact> for ImpactExplanation {
    fn from(value: &DispatchImpact) -> Self {
        Self {
            affected_train_runs: value.affected_train_runs,
            affected_connections: value.affected_connections,
            affected_rotations: value.affected_rotations,
            affected_personnel_pools: value.affected_personnel_pools,
            affected_vehicles: value.affected_vehicles,
            cost_cents: value.cost_cents,
            contract_penalty_cents: value.contract_penalty_cents,
            cancelled_stops: value.cancelled_stops,
            cause: value.cause.clone(),
            affected_resource: value.affected_resource.clone(),
            contract_effect: value.contract_effect.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DecisionExplanation {
    pub decision_id: u64,
    pub world_id: String,
    pub operator_id: String,
    pub train_run_id: u64,
    pub event_at: SimTime,
    pub program_version: u32,
    pub program_checksum: String,
    pub trigger: RuleTrigger,
    pub selected_rule_id: Option<String>,
    pub selected_action: Option<Action>,
    pub conditions: Vec<ConditionCheck>,
    pub limits: Vec<LimitCheck>,
    pub rejected_alternatives: Vec<RejectedAlternative>,
    pub manual_override: bool,
    pub manual_reason: Option<String>,
    pub outcome_reason: String,
    pub impact: ImpactExplanation,
}

#[derive(Clone, Debug)]
pub struct RuleDispatcher {
    program: OperatingProgram,
    checksum: String,
    decisions: Vec<DecisionExplanation>,
}

impl RuleDispatcher {
    pub fn new(program: OperatingProgram) -> Result<Self, RuleError> {
        let program = program.canonicalized()?;
        let checksum = program.checksum()?;
        Ok(Self {
            program,
            checksum,
            decisions: Vec::new(),
        })
    }

    pub const fn program(&self) -> &OperatingProgram {
        &self.program
    }

    pub fn decisions(&self) -> &[DecisionExplanation] {
        &self.decisions
    }

    pub fn decision_hash(&self) -> StateHash {
        let mut hasher = StateHasher::new("dispatch-decisions/v1");
        hasher.seq("decisions", self.decisions.len());
        for decision in &self.decisions {
            let bytes = serde_json::to_vec(decision).expect("Entscheidung ist serialisierbar");
            hasher.bytes("decision", &bytes);
        }
        hasher.finish()
    }

    fn evaluate(
        &self,
        train: &TrainRun,
        event_at: SimTime,
        trigger: DispatchTrigger,
        facts: &DispatchFacts,
    ) -> (DispatchDecision, DecisionExplanation) {
        let mut conditions = Vec::new();
        let mut rejected_alternatives = Vec::new();
        let mut selected_rule_id = None;
        let mut selected_action = None;
        let mut selected_limits = Vec::new();
        let manual_reason_valid = facts
            .manual_reason
            .as_ref()
            .is_some_and(|reason| (8..=500).contains(&reason.trim().len()));

        if let Some(action) = facts.manual_override.and_then(Action::from_dispatch) {
            let limits = evaluate_limits(action, &facts.limits);
            if manual_reason_valid && limits.iter().all(|check| check.accepted) {
                selected_action = Some(action);
                selected_limits = limits;
            } else {
                rejected_alternatives.push(RejectedAlternative {
                    rule_id: None,
                    action,
                    reason: if manual_reason_valid {
                        "Manueller Einzelfall-Override verletzt mindestens eine betriebliche Grenze.".into()
                    } else {
                        "Manueller Einzelfall-Override braucht eine Begründung mit 8 bis 500 Zeichen.".into()
                    },
                    limits,
                    manual: true,
                });
            }
        }

        if selected_action.is_none() && self.program.enabled {
            for rule in self.program.rules.iter().filter(|rule| rule.enabled) {
                if !rule.trigger.matches(trigger, facts) {
                    continue;
                }
                let mut rule_checks = Vec::new();
                if !rule.condition.evaluate(facts, "root", &mut rule_checks) {
                    conditions.extend(rule_checks);
                    continue;
                }
                conditions.extend(rule_checks);
                let limits = evaluate_limits(rule.action, &facts.limits);
                if limits.iter().all(|check| check.accepted) {
                    selected_rule_id = Some(rule.id.clone());
                    selected_action = Some(rule.action);
                    selected_limits = limits;
                    break;
                }
                rejected_alternatives.push(RejectedAlternative {
                    rule_id: Some(rule.id.clone()),
                    action: rule.action,
                    reason: "Maßnahme wurde wegen einer konkreten betrieblichen Grenze verworfen."
                        .into(),
                    limits,
                    manual: false,
                });
            }
        }

        let decision = selected_action.map_or_else(
            || {
                if matches!(
                    trigger,
                    DispatchTrigger::Arrival | DispatchTrigger::Departure
                ) {
                    DispatchDecision::Proceed
                } else {
                    DispatchDecision::Cancel
                }
            },
            |action| action.dispatch(facts),
        );
        let manual_override = facts.manual_override.is_some()
            && selected_rule_id.is_none()
            && selected_action.is_some();
        let outcome_reason = match (selected_action, manual_override) {
            (Some(_), true) => {
                "Autorisierter Einzelfall-Override bestand dieselben Grenzen wie die Regelentscheidung.".into()
            }
            (Some(_), false) => "Höchste passende, zulässige Regel nach stabiler Priorität gewählt.".into(),
            (None, _) => "Keine zulässige Regel; sicherer konservativer Ausgang wurde gewählt.".into(),
        };
        let matching_trigger = RuleTrigger::observed(trigger, facts);
        (
            decision,
            DecisionExplanation {
                decision_id: facts.decision_id,
                world_id: self.program.world_id.clone(),
                operator_id: self.program.operator_id.clone(),
                train_run_id: train.id,
                event_at,
                program_version: self.program.version,
                program_checksum: self.checksum.clone(),
                trigger: matching_trigger,
                selected_rule_id,
                selected_action,
                conditions,
                limits: selected_limits,
                rejected_alternatives,
                manual_override,
                manual_reason: facts.manual_reason.clone(),
                outcome_reason,
                impact: ImpactExplanation::from(&facts.impact),
            },
        )
    }
}

impl Dispatcher for RuleDispatcher {
    fn decide(
        &mut self,
        train: &TrainRun,
        event_at: SimTime,
        trigger: DispatchTrigger,
        facts: &DispatchFacts,
    ) -> DispatchDecision {
        let (decision, explanation) = self.evaluate(train, event_at, trigger, facts);
        if facts.decision_id != 0 {
            self.decisions.push(explanation);
        }
        decision
    }
}

fn evaluate_limits(action: Action, limits: &DispatchLimits) -> Vec<LimitCheck> {
    required_limits(action)
        .iter()
        .map(|kind| {
            let accepted = check_limit(*kind, limits);
            LimitCheck {
                kind: *kind,
                accepted,
                reason: limit_reason(*kind, accepted),
            }
        })
        .collect()
}

/// Bindet die konkreten Fehler des M5-Flottenmodells an die M7-Grenzen.
pub fn apply_fleet_result(limits: &mut DispatchLimits, result: Result<(), OperationsError>) {
    if let Err(error) = result {
        match error {
            OperationsError::PlatformTooShort => limits.train_length_allowed = false,
            OperationsError::MissingApproval | OperationsError::InvalidCharacteristics => {
                limits.train_characteristics_compatible = false
            }
            OperationsError::MissingProtection => limits.train_protection_compatible = false,
            OperationsError::IncompatibleElectrification => {
                limits.electrification_compatible = false
            }
            OperationsError::PersonnelUnqualified | OperationsError::MissingPersonnelDuty => {
                limits.personnel_qualified = false
            }
            OperationsError::RestViolation => limits.rest_time_compliant = false,
            OperationsError::RotationOverlap
            | OperationsError::LocationMismatch
            | OperationsError::MissingRotation => limits.rotation_feasible = false,
            OperationsError::MaintenanceOverdue => limits.maintenance_valid = false,
            OperationsError::CapacityExhausted | OperationsError::ExtraRunRouteConflict => {
                limits.capacity_available = false
            }
            _ => limits.vehicle_available = false,
        }
    }
}

/// Bindet die echte M3-Planerentscheidung an die Kapazitätsgrenze einer Umleitung.
pub fn apply_path_decision(limits: &mut DispatchLimits, decision: PathDecision) {
    limits.capacity_available = !matches!(decision, PathDecision::Rejected);
}

#[derive(Clone, Debug)]
pub struct HistoricalDispatchCase {
    pub train: TrainRun,
    pub event_at: SimTime,
    pub trigger: DispatchTrigger,
    pub facts: DispatchFacts,
    pub actual_action: Option<Action>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BacktestEntry {
    pub decision_id: u64,
    pub actual_action: Option<Action>,
    pub hypothetical_action: Option<Action>,
    pub changed: bool,
    pub explanation: DecisionExplanation,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BacktestResult {
    pub program_version: u32,
    pub source_case_count: usize,
    pub changed_decisions: usize,
    pub entries: Vec<BacktestEntry>,
    pub result_hash: String,
}

pub fn backtest(
    program: OperatingProgram,
    cases: &[HistoricalDispatchCase],
) -> Result<BacktestResult, RuleError> {
    let mut dispatcher = RuleDispatcher::new(program)?;
    let mut entries = Vec::with_capacity(cases.len());
    for case in cases {
        let before = dispatcher.decisions.len();
        let decision = dispatcher.decide(&case.train, case.event_at, case.trigger, &case.facts);
        let explanation = dispatcher.decisions[before].clone();
        let hypothetical_action = Action::from_dispatch(decision);
        entries.push(BacktestEntry {
            decision_id: case.facts.decision_id,
            actual_action: case.actual_action,
            hypothetical_action,
            changed: case.actual_action != hypothetical_action,
            explanation,
        });
    }
    let changed_decisions = entries.iter().filter(|entry| entry.changed).count();
    let mut hasher = StateHasher::new("dispatch-backtest/v1");
    let bytes = serde_json::to_vec(&entries).map_err(|_| RuleError::Serialization)?;
    hasher.bytes("entries", &bytes);
    Ok(BacktestResult {
        program_version: dispatcher.program.version,
        source_case_count: entries.len(),
        changed_decisions,
        entries,
        result_hash: hasher.finish().to_hex(),
    })
}

pub fn conservative_punctual(
    world_id: impl ToString,
    operator_id: impl ToString,
    version: u32,
) -> OperatingProgram {
    program_from_template(
        world_id,
        operator_id,
        version,
        vec![
            rule(
                "closure-short-turn",
                300,
                RuleTrigger::RouteClosure,
                Action::ShortTurn,
                FactKey::RouteClosed,
                FactValue::Boolean(true),
            ),
            rule(
                "delay-break-connection",
                200,
                RuleTrigger::DelayThreshold {
                    at_least_seconds: 300,
                },
                Action::BreakConnection,
                FactKey::DelaySeconds,
                FactValue::Integer(300),
            ),
            rule(
                "turnaround-cancel",
                100,
                RuleTrigger::TurnaroundShortfall,
                Action::CancelRun,
                FactKey::TurnaroundShortfallSeconds,
                FactValue::Integer(1),
            ),
        ],
    )
}

pub fn connection_oriented(
    world_id: impl ToString,
    operator_id: impl ToString,
    version: u32,
) -> OperatingProgram {
    program_from_template(
        world_id,
        operator_id,
        version,
        vec![
            rule(
                "connection-hold",
                300,
                RuleTrigger::ConnectionRisk,
                Action::HoldConnection,
                FactKey::ConnectionThreatened,
                FactValue::Boolean(true),
            ),
            rule(
                "closure-reroute",
                200,
                RuleTrigger::RouteClosure,
                Action::RequestReroute,
                FactKey::RouteClosed,
                FactValue::Boolean(true),
            ),
        ],
    )
}

pub fn rotation_protecting(
    world_id: impl ToString,
    operator_id: impl ToString,
    version: u32,
) -> OperatingProgram {
    program_from_template(
        world_id,
        operator_id,
        version,
        vec![
            rule(
                "turnaround-short-turn",
                300,
                RuleTrigger::TurnaroundShortfall,
                Action::ShortTurn,
                FactKey::TurnaroundShortfallSeconds,
                FactValue::Integer(1),
            ),
            rule(
                "delay-skip-stop",
                200,
                RuleTrigger::DelayThreshold {
                    at_least_seconds: 600,
                },
                Action::SkipStop,
                FactKey::DelaySeconds,
                FactValue::Integer(600),
            ),
            rule(
                "vehicle-reserve",
                100,
                RuleTrigger::VehicleFailure,
                Action::ActivateReserveRotation,
                FactKey::VehicleFailed,
                FactValue::Boolean(true),
            ),
        ],
    )
}

fn program_from_template(
    world_id: impl ToString,
    operator_id: impl ToString,
    version: u32,
    rules: Vec<OperatingRule>,
) -> OperatingProgram {
    OperatingProgram {
        schema: OPERATING_PROGRAM_SCHEMA.into(),
        world_id: world_id.to_string(),
        operator_id: operator_id.to_string(),
        version,
        enabled: true,
        rules,
    }
}

fn rule(
    id: &str,
    priority: i32,
    trigger: RuleTrigger,
    action: Action,
    fact: FactKey,
    value: FactValue,
) -> OperatingRule {
    let comparison = match value {
        FactValue::Integer(_) => Comparison::GreaterOrEqual,
        FactValue::Boolean(_) => Comparison::Equal,
    };
    OperatingRule {
        id: id.into(),
        priority,
        enabled: true,
        trigger,
        condition: Condition::Predicate {
            fact,
            comparison,
            value,
        },
        action,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuleError {
    WrongSchema,
    InvalidIdentity,
    EmptyProgram,
    DuplicateRule(String),
    InvalidRuleId(String),
    InvalidPriority(String),
    InvalidTrigger,
    ConditionTooComplex,
    EmptyConditionGroup,
    ConditionTypeMismatch,
    Serialization,
}

impl fmt::Display for RuleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for RuleError {}
