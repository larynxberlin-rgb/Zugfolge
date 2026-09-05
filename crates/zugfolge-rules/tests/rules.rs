//! Vertragstests für Trigger, Maßnahmen, Grenzen, Vorlagen und Rücktests.

use zugfolge_rules::{
    Action, Comparison, Condition, DispatchCaseInput, DispatchImpactInput, DispatchLimitsInput,
    FactKey, FactValue, HistoricalDispatchCase, LimitKind, OPERATING_PROGRAM_SCHEMA,
    OperatingProgram, OperatingRule, RuleDispatcher, RuleTrigger, backtest, connection_oriented,
    conservative_punctual, evaluate_dispatch_case, rotation_protecting,
};
use zugfolge_sim::{
    DispatchDecision, DispatchFacts, DispatchImpact, DispatchLimits, DispatchTrigger, Dispatcher,
    OperatingStatus, TrainCategory, TrainRun, Waypoint,
};

fn train() -> TrainRun {
    TrainRun {
        world_id: 7,
        id: 31,
        region_id: 2,
        operator: "Testbahn".into(),
        train_number: "RB 31".into(),
        category: TrainCategory::Regional,
        route: vec![Waypoint {
            operating_point: "Leipzig Hbf".into(),
            position_mm: 0,
            arrival: 100,
            minimum_dwell_seconds: 30,
            departure: 130,
        }],
        next_waypoint: 0,
        delay_seconds: 0,
        position_mm: 0,
        speed_mm_per_second: 0,
        status: OperatingStatus::Planned,
    }
}

fn facts(decision_id: u64) -> DispatchFacts {
    DispatchFacts {
        decision_id,
        delay_seconds: 900,
        connection_threatened: true,
        vehicle_failed: true,
        duty_excess_seconds: 60,
        route_closed: true,
        platform_changed: true,
        turnaround_shortfall_seconds: 120,
        adhoc_conflict: true,
        hold_until: 1_500,
        limits: DispatchLimits::default(),
        impact: DispatchImpact {
            affected_train_runs: 2,
            affected_connections: 3,
            affected_rotations: 1,
            affected_personnel_pools: 1,
            affected_vehicles: 2,
            cost_cents: 12_500,
            contract_penalty_cents: 4_000,
            cancelled_stops: 1,
            cause: "Streckensperrung".into(),
            affected_resource: "Abzweig Gröbers".into(),
            contract_effect: "Pünktlichkeitsquote".into(),
        },
        manual_override: None,
        manual_reason: None,
    }
}

fn program(trigger: RuleTrigger, action: Action) -> OperatingProgram {
    OperatingProgram {
        schema: OPERATING_PROGRAM_SCHEMA.into(),
        world_id: "7".into(),
        operator_id: "9".into(),
        version: 1,
        enabled: true,
        rules: vec![OperatingRule {
            id: "test-rule".into(),
            priority: 100,
            enabled: true,
            trigger,
            condition: Condition::Predicate {
                fact: FactKey::AffectedTrainRuns,
                comparison: Comparison::GreaterOrEqual,
                value: FactValue::Integer(1),
            },
            action,
        }],
    }
}

#[test]
fn single_case_boundary_uses_real_rules_and_keeps_manual_decision_explainable() {
    let explanation = evaluate_dispatch_case(
        program(RuleTrigger::RouteClosure, Action::ShortTurn),
        DispatchCaseInput {
            decision_id: 91,
            train_run_id: 31,
            event_at: 420,
            trigger: RuleTrigger::RouteClosure,
            delay_seconds: 420,
            connection_threatened: true,
            vehicle_failed: false,
            duty_excess_seconds: 0,
            route_closed: true,
            platform_changed: false,
            turnaround_shortfall_seconds: 0,
            adhoc_conflict: false,
            hold_until: 600,
            limits: DispatchLimitsInput {
                capacity_available: true,
                train_characteristics_compatible: true,
                route_knowledge_available: true,
                train_protection_compatible: true,
                electrification_compatible: true,
                train_length_allowed: true,
                vehicle_available: true,
                maintenance_valid: true,
                personnel_qualified: true,
                rest_time_compliant: true,
                rotation_feasible: true,
                contract_allows: true,
                cost_within_limit: true,
            },
            impact: DispatchImpactInput {
                affected_train_runs: 1,
                affected_connections: 1,
                affected_rotations: 1,
                affected_personnel_pools: 1,
                affected_vehicles: 1,
                cost_cents: 95_000,
                contract_penalty_cents: 0,
                cancelled_stops: 0,
                cause: "Weichenstoerung".into(),
                affected_resource: "track:tut-segment-2".into(),
                contract_effect: "Qualitaetsziel gehalten".into(),
            },
            manual_action: Some(Action::RequestReroute),
            manual_reason: Some("Manueller Eingriff".into()),
        },
    )
    .unwrap();
    assert_eq!(explanation.decision_id, 91);
    assert_eq!(explanation.train_run_id, 31);
    assert_eq!(explanation.selected_action, Some(Action::RequestReroute));
    assert!(explanation.manual_override);
    assert_eq!(explanation.impact.cost_cents, 95_000);
}

#[test]
fn all_eight_triggers_are_executable() {
    let cases = [
        (
            RuleTrigger::DelayThreshold {
                at_least_seconds: 300,
            },
            DispatchTrigger::DelayThreshold,
        ),
        (RuleTrigger::ConnectionRisk, DispatchTrigger::ConnectionRisk),
        (RuleTrigger::VehicleFailure, DispatchTrigger::VehicleFailure),
        (
            RuleTrigger::PersonnelDutyExceeded,
            DispatchTrigger::PersonnelDutyExceeded,
        ),
        (RuleTrigger::RouteClosure, DispatchTrigger::RouteClosure),
        (RuleTrigger::PlatformChange, DispatchTrigger::PlatformChange),
        (
            RuleTrigger::TurnaroundShortfall,
            DispatchTrigger::TurnaroundShortfall,
        ),
        (
            RuleTrigger::AdHocPathConflict,
            DispatchTrigger::AdHocPathConflict,
        ),
    ];
    for (index, (rule_trigger, dispatch_trigger)) in cases.into_iter().enumerate() {
        let mut dispatcher = RuleDispatcher::new(program(rule_trigger, Action::CancelRun)).unwrap();
        let decision =
            dispatcher.decide(&train(), 1_000, dispatch_trigger, &facts(index as u64 + 1));
        assert_eq!(decision, DispatchDecision::Cancel);
        assert_eq!(dispatcher.decisions().len(), 1);
        let expected_observation = match rule_trigger {
            RuleTrigger::DelayThreshold { .. } => RuleTrigger::DelayThreshold {
                at_least_seconds: 900,
            },
            value => value,
        };
        assert_eq!(dispatcher.decisions()[0].trigger, expected_observation);
    }
}

#[test]
fn all_twelve_actions_reach_the_m44_contract() {
    let cases = [
        (Action::HoldConnection, DispatchDecision::HoldUntil(1_500)),
        (Action::BreakConnection, DispatchDecision::BreakConnection),
        (Action::SkipStop, DispatchDecision::SkipStop),
        (Action::ShortTurn, DispatchDecision::ShortTurn),
        (Action::ShortenTrain, DispatchDecision::ShortenTrain),
        (Action::StrengthenTrain, DispatchDecision::StrengthenTrain),
        (Action::CancelRun, DispatchDecision::Cancel),
        (
            Action::ActivateReserveRotation,
            DispatchDecision::ActivateReserveRotation,
        ),
        (
            Action::ProvideReplacementVehicle,
            DispatchDecision::ProvideReplacementVehicle,
        ),
        (Action::RequestReroute, DispatchDecision::RequestReroute),
        (Action::ReturnPath, DispatchDecision::ReturnPath),
        (
            Action::TriggerRailReplacement,
            DispatchDecision::TriggerRailReplacement,
        ),
    ];
    for (index, (action, expected)) in cases.into_iter().enumerate() {
        let mut dispatcher =
            RuleDispatcher::new(program(RuleTrigger::RouteClosure, action)).unwrap();
        assert_eq!(
            dispatcher.decide(
                &train(),
                1_000,
                DispatchTrigger::RouteClosure,
                &facts(index as u64 + 1)
            ),
            expected
        );
    }
}

#[test]
fn priority_is_stable_and_disabled_rules_are_ignored() {
    let mut value = program(RuleTrigger::RouteClosure, Action::CancelRun);
    value.rules = vec![
        OperatingRule {
            id: "z-later".into(),
            priority: 200,
            enabled: true,
            action: Action::ShortTurn,
            ..value.rules[0].clone()
        },
        OperatingRule {
            id: "a-first".into(),
            priority: 200,
            enabled: true,
            action: Action::RequestReroute,
            ..value.rules[0].clone()
        },
        OperatingRule {
            id: "disabled".into(),
            priority: 300,
            enabled: false,
            action: Action::CancelRun,
            ..value.rules[0].clone()
        },
    ];
    let mut dispatcher = RuleDispatcher::new(value).unwrap();
    assert_eq!(
        dispatcher.decide(&train(), 1_000, DispatchTrigger::RouteClosure, &facts(1)),
        DispatchDecision::RequestReroute
    );
    assert_eq!(
        dispatcher.decisions()[0].selected_rule_id.as_deref(),
        Some("a-first")
    );
}

#[test]
fn nested_condition_trees_use_all_any_and_not_deterministically() {
    let mut value = program(RuleTrigger::RouteClosure, Action::ShortTurn);
    value.rules[0].condition = Condition::All {
        children: vec![
            Condition::Predicate {
                fact: FactKey::RouteClosed,
                comparison: Comparison::Equal,
                value: FactValue::Boolean(true),
            },
            Condition::Any {
                children: vec![
                    Condition::Predicate {
                        fact: FactKey::AffectedTrainRuns,
                        comparison: Comparison::GreaterOrEqual,
                        value: FactValue::Integer(10),
                    },
                    Condition::Not {
                        child: Box::new(Condition::Predicate {
                            fact: FactKey::CostCents,
                            comparison: Comparison::GreaterOrEqual,
                            value: FactValue::Integer(100_000),
                        }),
                    },
                ],
            },
        ],
    };
    let mut dispatcher = RuleDispatcher::new(value).unwrap();
    assert_eq!(
        dispatcher.decide(&train(), 1_000, DispatchTrigger::RouteClosure, &facts(1)),
        DispatchDecision::ShortTurn
    );
    assert_eq!(dispatcher.decisions()[0].conditions.len(), 3);
}

#[test]
fn reroute_checks_every_operational_boundary() {
    type Reject = fn(&mut DispatchLimits);
    let boundaries: [(LimitKind, Reject); 13] = [
        (LimitKind::Capacity, |v| v.capacity_available = false),
        (LimitKind::TrainCharacteristics, |v| {
            v.train_characteristics_compatible = false
        }),
        (LimitKind::RouteKnowledge, |v| {
            v.route_knowledge_available = false
        }),
        (LimitKind::TrainProtection, |v| {
            v.train_protection_compatible = false
        }),
        (LimitKind::Electrification, |v| {
            v.electrification_compatible = false
        }),
        (LimitKind::TrainLength, |v| v.train_length_allowed = false),
        (LimitKind::VehicleAvailability, |v| {
            v.vehicle_available = false
        }),
        (LimitKind::Maintenance, |v| v.maintenance_valid = false),
        (LimitKind::PersonnelQualification, |v| {
            v.personnel_qualified = false
        }),
        (LimitKind::RestTime, |v| v.rest_time_compliant = false),
        (LimitKind::Rotation, |v| v.rotation_feasible = false),
        (LimitKind::Contract, |v| v.contract_allows = false),
        (LimitKind::Cost, |v| v.cost_within_limit = false),
    ];
    for (index, (kind, reject)) in boundaries.into_iter().enumerate() {
        let mut event = facts(index as u64 + 1);
        reject(&mut event.limits);
        let mut dispatcher =
            RuleDispatcher::new(program(RuleTrigger::RouteClosure, Action::RequestReroute))
                .unwrap();
        assert_eq!(
            dispatcher.decide(&train(), 1_000, DispatchTrigger::RouteClosure, &event),
            DispatchDecision::Cancel
        );
        let alternative = &dispatcher.decisions()[0].rejected_alternatives[0];
        assert!(
            alternative
                .limits
                .iter()
                .any(|check| check.kind == kind && !check.accepted)
        );
    }
}

#[test]
fn manual_override_is_one_decision_only_and_never_bypasses_limits() {
    let mut dispatcher =
        RuleDispatcher::new(program(RuleTrigger::RouteClosure, Action::ShortTurn)).unwrap();
    let mut accepted = facts(1);
    accepted.manual_override = Some(DispatchDecision::RequestReroute);
    accepted.manual_reason = Some("Fahrdienstliche Einzelfallentscheidung".into());
    assert_eq!(
        dispatcher.decide(&train(), 1_000, DispatchTrigger::RouteClosure, &accepted),
        DispatchDecision::RequestReroute
    );
    assert!(dispatcher.decisions()[0].manual_override);

    let automatic = facts(2);
    assert_eq!(
        dispatcher.decide(&train(), 1_001, DispatchTrigger::RouteClosure, &automatic),
        DispatchDecision::ShortTurn
    );
    assert!(!dispatcher.decisions()[1].manual_override);

    let mut rejected = facts(3);
    rejected.manual_override = Some(DispatchDecision::RequestReroute);
    rejected.manual_reason = Some("Fahrdienstliche Einzelfallentscheidung".into());
    rejected.limits.capacity_available = false;
    assert_eq!(
        dispatcher.decide(&train(), 1_002, DispatchTrigger::RouteClosure, &rejected),
        DispatchDecision::Cancel
    );
    assert!(
        dispatcher.decisions()[2]
            .rejected_alternatives
            .iter()
            .any(|entry| entry.manual)
    );
}

#[test]
fn templates_canonical_json_and_backtest_are_deterministic_and_read_only() {
    for template in [
        conservative_punctual(7, 9, 1),
        zugfolge_rules::connection_oriented(7, 9, 1),
        zugfolge_rules::rotation_protecting(7, 9, 1),
    ] {
        template.validate().unwrap();
        assert_eq!(
            template.checksum().unwrap(),
            template
                .clone()
                .canonicalized()
                .unwrap()
                .checksum()
                .unwrap()
        );
    }

    let executable_templates = [
        (
            conservative_punctual(7, 9, 1),
            DispatchTrigger::RouteClosure,
            DispatchDecision::ShortTurn,
        ),
        (
            connection_oriented(7, 9, 1),
            DispatchTrigger::ConnectionRisk,
            DispatchDecision::HoldUntil(1_500),
        ),
        (
            rotation_protecting(7, 9, 1),
            DispatchTrigger::VehicleFailure,
            DispatchDecision::ActivateReserveRotation,
        ),
    ];
    for (index, (template, trigger, expected)) in executable_templates.into_iter().enumerate() {
        let mut dispatcher = RuleDispatcher::new(template).unwrap();
        assert_eq!(
            dispatcher.decide(&train(), 1_000, trigger, &facts(index as u64 + 1)),
            expected
        );
    }

    let source_facts = facts(77);
    let cases = vec![HistoricalDispatchCase {
        train: train(),
        event_at: 1_000,
        trigger: DispatchTrigger::RouteClosure,
        facts: source_facts.clone(),
        actual_action: Some(Action::CancelRun),
    }];
    let first = backtest(
        program(RuleTrigger::RouteClosure, Action::ShortTurn),
        &cases,
    )
    .unwrap();
    let second = backtest(
        program(RuleTrigger::RouteClosure, Action::ShortTurn),
        &cases,
    )
    .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.changed_decisions, 1);
    assert_eq!(cases[0].facts, source_facts);
}
