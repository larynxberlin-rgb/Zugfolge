//! Fachnachweis gegen den tatsächlichen nativen Kontroll- und M6-Releasevertrag.
use zugfolge_conductor_dialogue::{DocumentStatusV1, IdentityStatusV1};
use zugfolge_demand::{FareFactV1, ManifestPassengerV1};
use zugfolge_fare_control::*;
use zugfolge_fleet::{
    FareInspectionEconomyV1,
    release_catalog::{EconomyReleaseDocument, recompute_economy_release_checksum},
};
const DAY: i64 = 86_400_000;
fn economy() -> EconomyReleaseDocument {
    let seed: serde_json::Value = serde_json::from_str(include_str!(
        "../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3.json"
    ))
    .unwrap();
    let mut release: EconomyReleaseDocument =
        serde_json::from_value(seed["economy"]["release"].clone()).unwrap();
    release.fare_inspection = Some(FareInspectionEconomyV1 {
        schema_version: "fare-inspection-economy/v1".into(),
        minimum_claim_cents: "6000".into(),
        ordinary_fare_multiplier: 2,
        reduced_claim_cents: "700".into(),
        proof_window_days: 7,
        day_length_ms: DAY,
        handling_cost_cents: "100".into(),
        unfounded_claim_cost_cents: "250".into(),
        police_handling_cost_cents: "300".into(),
        full_payment_basis_points: 10_000,
        partial_payment_basis_points: 0,
        partial_payment_share_basis_points: 5000,
        payment_delay_ms: DAY,
        write_off_delay_ms: 3 * DAY,
        valid_proof_submission_basis_points: 10_000,
        valid_proof_delay_ms: 2 * DAY,
        premium_multiplier_basis_points: 40_000,
        positive_daily_cap_basis_points: 50,
        revenue_allocation: "uniform_settled_service_interval/v1".into(),
    });
    release.checksum = recompute_economy_release_checksum(&release).unwrap();
    release
}
fn pin(fare: FareFactV1) -> FareInspectionPinV1 {
    let mut policy = FareInspectionPolicyV1 {
        schema_version: "fare-inspection-policy/v1".into(),
        policy_id: "inspection-test".into(),
        world_id: "world".into(),
        period_id: "period".into(),
        content_hash: String::new(),
        invalid_document_presented_basis_points: 0,
        identity_refusal_basis_points: 0,
        concrete_danger_basis_points: 0,
    };
    policy.content_hash = fare_inspection_policy_hash(&policy).unwrap();
    let mut journey = FareJourneyEvidenceV1 {
        schema_version: "fare-journey-evidence/v1".into(),
        evidence_id: "journey-proof".into(),
        world_id: "world".into(),
        period_id: "period".into(),
        train_run_id: "train".into(),
        boarding_stop_id: "stop-a".into(),
        alighting_stop_id: "stop-b".into(),
        ordinary_fare_cents: Some("1250".into()),
        ticket_office: FarePurchaseAvailabilityV1::Available,
        ticket_machine: FarePurchaseAvailabilityV1::Unknown,
        source_id: "explicit-test-evidence".into(),
        content_hash: String::new(),
    };
    journey.content_hash = fare_journey_evidence_hash(&journey).unwrap();
    let passenger: ManifestPassengerV1 = serde_json::from_value(serde_json::json!({
        "passengerKey":"private-passenger", "journeyChainId":"journey", "boardingStopId":"stop-a", "alightingStopId":"stop-b",
        "demandSegment":"ordinary", "comfortClass":"standard", "spaceNeeds":"ordinary", "fareFact":fare,
        "farePolicyProvenance":"balanced", "reservationId":null, "seatNumber":null
    })).unwrap();
    let economy = economy();
    FareInspectionPinV1 {
        world_id: "world".into(),
        operator_id: "operator".into(),
        period_id: "period".into(),
        train_run_id: "train".into(),
        encounter_id: "encounter".into(),
        manifest_revision: 4,
        demand_state_hash: "d".repeat(64),
        segment_id: "segment".into(),
        passenger,
        dialogue_release_hash: "a".repeat(64),
        inspected_at_ms: 0,
        seed_hash: "e".repeat(64),
        inspection_policy: policy,
        journey_evidence: Some(journey),
        expected_economy_release_hash: economy.checksum.clone(),
        economy_release: economy,
    }
}
fn command(
    state: &FareControlWorldStateV1,
    at: i64,
    action: FareControlActionV1,
) -> FareControlCommandV1 {
    FareControlCommandV1 {
        world_id: state.world_id.clone(),
        operator_id: state.operator_id.clone(),
        command_id: format!("command-{}", state.revision),
        expected_revision: state.revision,
        now_ms: at,
        action,
    }
}
fn step(
    state: &mut FareControlWorldStateV1,
    at: i64,
    action: FareControlActionV1,
) -> FareControlTransitionV1 {
    let result = apply_fare_control(state, &state.state_hash, &command(state, at, action)).unwrap();
    *state = result.state.clone();
    result
}
fn opened(pin: FareInspectionPinV1) -> FareControlWorldStateV1 {
    let mut state = initialize_fare_control("world", "operator", 0).unwrap();
    step(
        &mut state,
        0,
        FareControlActionV1::OpenCase {
            case_id: "case".into(),
            pin: Box::new(pin),
        },
    );
    state
}
fn inspected(pin: FareInspectionPinV1) -> FareControlWorldStateV1 {
    let mut state = opened(pin);
    step(
        &mut state,
        0,
        FareControlActionV1::InspectDocument {
            case_id: "case".into(),
        },
    );
    state
}
fn claimed(pin: FareInspectionPinV1) -> FareControlWorldStateV1 {
    let mut state = inspected(pin);
    step(
        &mut state,
        0,
        FareControlActionV1::CreateClaim {
            case_id: "case".into(),
            kind: FareClaimKindV1::Provisional,
        },
    );
    state
}
fn revenue(
    day: i64,
    cents: &str,
    release: &EconomyReleaseDocument,
) -> Vec<ConfirmedFareContractRevenueV1> {
    if cents == "0" {
        return vec![];
    }
    let mut evidence = FareContractRevenueEvidenceV1 {
        schema_version: "fare-contract-revenue-evidence/v1".into(),
        world_id: "world".into(),
        operator_id: "operator".into(),
        contract_id: "actual-m6-contract".into(),
        journal_effect_id: "actual-m6-journal".into(),
        economy_release_hash: release.checksum.clone(),
        service_start_ms: day,
        service_end_ms: day + DAY,
        settled_at_ms: day + DAY,
        ordering_fee_cents: cents.into(),
        bonus_cents: "0".into(),
        penalty_cents: "1700".into(),
        content_hash: String::new(),
    };
    evidence.content_hash = fare_contract_revenue_evidence_hash(&evidence).unwrap();
    vec![ConfirmedFareContractRevenueV1 {
        evidence,
        ledger_transaction_id: "actual-m6-ledger-receipt".into(),
    }]
}

#[test]
fn genuine_and_false_phone_problem_stay_identical_until_actual_proof() {
    let mut genuine = claimed(pin(FareFactV1::ValidUnpresentable));
    let mut false_excuse = claimed(pin(FareFactV1::Invalid));
    assert_eq!(
        genuine.cases["case"].evidence,
        false_excuse.cases["case"].evidence
    );
    assert_eq!(genuine.cases["case"].claim_cents, "6000");
    step(&mut genuine, 2 * DAY, FareControlActionV1::AdvanceTime);
    step(&mut false_excuse, 2 * DAY, FareControlActionV1::AdvanceTime);
    assert_eq!(genuine.cases["case"].evidence.document_status, DocumentStatusV1::VerifiedValid);
    assert_eq!(false_excuse.cases["case"].evidence.document_status, DocumentStatusV1::NotPresentable);
    assert_eq!(
        (
            genuine.cases["case"].claim_cents.as_str(),
            genuine.cases["case"].paid_cents.as_str()
        ),
        ("700", "700")
    );
    assert_eq!(
        (
            false_excuse.cases["case"].claim_cents.as_str(),
            false_excuse.cases["case"].paid_cents.as_str()
        ),
        ("6000", "6000")
    );
    assert!(
        genuine
            .ledger_events
            .values()
            .any(|e| e.kind == FareLedgerEventKindV1::Reduction)
    );
    let public = serde_json::to_string(
        &project_fare_cases(&genuine, &genuine.state_hash, "world", "operator").unwrap(),
    )
    .unwrap();
    for hidden in [
        "private-passenger",
        "fareFact",
        "seedHash",
        "inspectionPolicy",
        "paymentBasisPoints",
    ] {
        assert!(!public.contains(hidden));
    }
}
#[test]
fn valid_ticket_missing_tariff_and_purchase_exception_create_no_claim() {
    let valid = inspected(pin(FareFactV1::Valid));
    assert_eq!(
        valid.cases["case"].evidence.document_status,
        DocumentStatusV1::VerifiedValid
    );
    for kind in [FareClaimKindV1::Regular, FareClaimKindV1::Provisional] {
        assert!(
            apply_fare_control(
                &valid,
                &valid.state_hash,
                &command(
                    &valid,
                    0,
                    FareControlActionV1::CreateClaim {
                        case_id: "case".into(),
                        kind
                    }
                )
            )
            .is_err()
        );
    }
    let mut missing = pin(FareFactV1::Invalid);
    missing.journey_evidence = None;
    let mut exception = pin(FareFactV1::Invalid);
    let journey = exception.journey_evidence.as_mut().unwrap();
    journey.ticket_office = FarePurchaseAvailabilityV1::Unavailable;
    journey.ticket_machine = FarePurchaseAvailabilityV1::Unavailable;
    journey.content_hash = fare_journey_evidence_hash(journey).unwrap();
    for source in [missing, exception] {
        let state = inspected(source);
        assert!(
            apply_fare_control(
                &state,
                &state.state_hash,
                &command(
                    &state,
                    0,
                    FareControlActionV1::CreateClaim {
                        case_id: "case".into(),
                        kind: FareClaimKindV1::Provisional
                    }
                )
            )
            .is_err()
        );
        assert!(state.ledger_events.is_empty());
    }
}
#[test]
fn proof_deadline_uses_received_day_and_allows_later_processing() {
    let mut source = pin(FareFactV1::ValidUnpresentable);
    source
        .economy_release
        .fare_inspection
        .as_mut()
        .unwrap()
        .valid_proof_submission_basis_points = 0;
    source.economy_release.checksum =
        recompute_economy_release_checksum(&source.economy_release).unwrap();
    source.expected_economy_release_hash = source.economy_release.checksum.clone();
    for (received, expected) in [(8 * DAY - 1, "700"), (8 * DAY, "6000")] {
        let mut state = claimed(source.clone());
        assert_eq!(state.cases["case"].proof_deadline_ms, 8 * DAY);
        step(
            &mut state,
            9 * DAY,
            FareControlActionV1::ReceiveProof {
                case_id: "case".into(),
                received_at_ms: received,
            },
        );
        assert_eq!(state.cases["case"].claim_cents, expected);
    }
}
#[test]
fn late_worker_preserves_payment_writeoff_and_refund_days() {
    let mut source = pin(FareFactV1::ValidUnpresentable);
    let rates = source.economy_release.fare_inspection.as_mut().unwrap();
    rates.full_payment_basis_points = 0;
    rates.valid_proof_delay_ms = 4 * DAY;
    source.economy_release.checksum =
        recompute_economy_release_checksum(&source.economy_release).unwrap();
    source.expected_economy_release_hash = source.economy_release.checksum.clone();
    let mut incremental = claimed(source.clone());
    for at in [DAY, 3 * DAY, 4 * DAY] {
        step(&mut incremental, at, FareControlActionV1::AdvanceTime);
    }
    let mut restored = claimed(source);
    step(&mut restored, 4 * DAY, FareControlActionV1::AdvanceTime);
    assert_eq!(incremental.cases, restored.cases);
    let entries = |state: &FareControlWorldStateV1| {
        let mut rows = state
            .ledger_events
            .values()
            .map(|e| {
                (
                    e.at_ms,
                    format!("{:?}", e.kind),
                    serde_json::to_string(&e.postings).unwrap(),
                )
            })
            .collect::<Vec<_>>();
        rows.sort();
        rows
    };
    assert_eq!(entries(&incremental), entries(&restored));
    let release = restored.cases["case"].pin.economy_release.clone();
    for day_start_ms in [3 * DAY, 4 * DAY] {
        step(
            &mut restored,
            5 * DAY,
            FareControlActionV1::SettleDay {
                day_start_ms,
                contract_revenue_evidence: revenue(day_start_ms, "100000000", &release),
                economy_release: Box::new(release.clone()),
            },
        );
    }
    assert_eq!(restored.days[&(3 * DAY).to_string()].net_cents, "-700");
    assert_eq!(restored.days[&(4 * DAY).to_string()].net_cents, "0");
    assert_eq!(restored.days[&(4 * DAY).to_string()].premium_cents, "0");
}
#[test]
fn partial_payment_writeoff_and_negative_costs_never_generate_a_premium() {
    let mut source = pin(FareFactV1::Invalid);
    let rates = source.economy_release.fare_inspection.as_mut().unwrap();
    rates.full_payment_basis_points = 0;
    rates.partial_payment_basis_points = 10_000;
    source.economy_release.checksum =
        recompute_economy_release_checksum(&source.economy_release).unwrap();
    source.expected_economy_release_hash = source.economy_release.checksum.clone();
    let release = source.economy_release.clone();
    let mut state = claimed(source);
    step(&mut state, 4 * DAY, FareControlActionV1::AdvanceTime);
    assert_eq!(
        (
            state.cases["case"].paid_cents.as_str(),
            state.cases["case"].written_off_cents.as_str()
        ),
        ("3000", "3000")
    );
    step(
        &mut state,
        4 * DAY,
        FareControlActionV1::SettleDay {
            day_start_ms: 3 * DAY,
            contract_revenue_evidence: revenue(3 * DAY, "10000000", &release),
            economy_release: Box::new(release),
        },
    );
    let day = &state.days[&(3 * DAY).to_string()];
    assert_eq!(
        (
            day.net_cents.as_str(),
            day.premium_cents.as_str(),
            day.cap_adjustment_cents.as_str()
        ),
        ("-3000", "0", "0")
    );
}
#[test]
fn daily_cap_missing_receipt_and_later_correction_are_idempotent() {
    let source = pin(FareFactV1::Invalid);
    let release = source.economy_release.clone();
    let mut state = claimed(source);
    step(&mut state, 2 * DAY, FareControlActionV1::AdvanceTime);
    let day_action = |cents: &str| FareControlActionV1::SettleDay {
        day_start_ms: DAY,
        contract_revenue_evidence: revenue(DAY, cents, &release),
        economy_release: Box::new(release.clone()),
    };
    step(&mut state, 2 * DAY, day_action("0"));
    assert_eq!(
        (
            state.days[&DAY.to_string()].premium_cents.as_str(),
            state.days[&DAY.to_string()].cap_adjustment_cents.as_str()
        ),
        ("0", "6000")
    );
    let command = command(&state, 2 * DAY, day_action("4000000"));
    let result = apply_fare_control(&state, &state.state_hash, &command).unwrap();
    let replay = apply_fare_control(&result.state, &result.state.state_hash, &command).unwrap();
    assert_eq!(result, replay);
    let day = &result.state.days[&DAY.to_string()];
    assert_eq!(
        (
            day.net_cents.as_str(),
            day.premium_cents.as_str(),
            day.cap_adjustment_cents.as_str()
        ),
        ("6000", "14000", "0")
    );
    let restored: FareControlWorldStateV1 =
        serde_json::from_str(&serde_json::to_string(&result.state).unwrap()).unwrap();
    assert_eq!(
        restore_fare_control(&restored, &result.state.state_hash).unwrap(),
        result.state
    );
    assert!(project_fare_cases(&restored, &restored.state_hash, "foreign", "operator").is_err());
}

fn police_model(available: u32, delay: i64, success: u32) -> PoliceResponseModelV1 {
    let mut model = PoliceResponseModelV1 {
        schema_version: "police-response-model/v1".into(),
        model_id: "police-test".into(),
        world_id: "world".into(),
        content_hash: String::new(),
        available_basis_points: available,
        delayed_basis_points: 0,
        response_ms: delay,
        delayed_response_ms: delay,
        identity_success_basis_points: success,
    };
    model.content_hash = police_response_model_hash(&model).unwrap();
    model
}
#[test]
fn police_requires_observed_ground_and_actual_timely_operational_completion() {
    let plain = inspected(pin(FareFactV1::Invalid));
    let model = police_model(10_000, 20_000, 10_000);
    let action = FareControlActionV1::PlanPolice {
        hold_id: "hold".into(),
        train_run_id: "train".into(),
        target_stop_id: "target".into(),
        case_ids: vec!["case".into()],
        model: model.clone(),
    };
    assert!(
        apply_fare_control(
            &plain,
            &plain.state_hash,
            &command(&plain, 0, action.clone())
        )
        .is_err()
    );
    let mut source = pin(FareFactV1::Invalid);
    source.inspection_policy.identity_refusal_basis_points = 10_000;
    source.inspection_policy.content_hash =
        fare_inspection_policy_hash(&source.inspection_policy).unwrap();
    let mut state = inspected(source);
    assert_eq!(
        state.cases["case"].evidence.identity_status,
        IdentityStatusV1::Refused
    );
    step(&mut state, 0, action);
    let mut evidence = PoliceOperationalEvidenceV1 {
        world_id: "world".into(),
        train_run_id: "train".into(),
        hold_id: "hold".into(),
        target_stop_id: "target".into(),
        model_hash: model.content_hash,
        operational_state_hash: "f".repeat(64),
        activated_at_ms: Some(10_000),
        deadline_ms: Some(60_000),
        released_at_ms: None,
        target_unavailable: false,
        outcome: PoliceResolutionV1::Pending,
    };
    assert_eq!(
        police_response_due(&state.police_plans["hold"], &evidence, 29_999).unwrap(),
        None
    );
    assert_eq!(
        police_response_due(&state.police_plans["hold"], &evidence, 30_000).unwrap(),
        Some(PoliceResolutionV1::IdentityConfirmed)
    );
    evidence.released_at_ms = Some(20_000);
    evidence.outcome = PoliceResolutionV1::IdentityConfirmed;
    assert!(
        apply_fare_control(
            &state,
            &state.state_hash,
            &command(
                &state,
                30_000,
                FareControlActionV1::ResolvePolice {
                    evidence: evidence.clone()
                }
            )
        )
        .is_err()
    );
    evidence.released_at_ms = Some(30_000);
    step(
        &mut state,
        30_000,
        FareControlActionV1::ResolvePolice { evidence },
    );
    assert_eq!(
        state.cases["case"].evidence.identity_status,
        IdentityStatusV1::Confirmed
    );
    assert_eq!(
        state.cases["case"].status,
        FareInspectionCaseStatusV1::ClaimOpen
    );
    assert_eq!(state.cases["case"].costs_cents, "400");
}

#[test]
fn bundled_police_unavailable_failure_timeout_and_cancel_do_not_invent_identity() {
    for (available, success, delayed, outcome, released) in [
        (0, 10_000, 0, PoliceResolutionV1::Unavailable, 10_000),
        (
            10_000,
            0,
            0,
            PoliceResolutionV1::IdentityNotConfirmed,
            30_000,
        ),
        (10_000, 10_000, 10_000, PoliceResolutionV1::TimedOut, 60_000),
        (
            10_000,
            10_000,
            0,
            PoliceResolutionV1::TargetUnavailable,
            5_000,
        ),
    ] {
        let mut source = pin(FareFactV1::Invalid);
        source.inspection_policy.identity_refusal_basis_points = 10_000;
        source.inspection_policy.content_hash =
            fare_inspection_policy_hash(&source.inspection_policy).unwrap();
        let mut state = inspected(source.clone());
        source.passenger.passenger_key = "another-passenger".into();
        source.encounter_id = "another-encounter".into();
        step(
            &mut state,
            0,
            FareControlActionV1::OpenCase {
                case_id: "second".into(),
                pin: Box::new(source),
            },
        );
        step(
            &mut state,
            0,
            FareControlActionV1::InspectDocument {
                case_id: "second".into(),
            },
        );
        let mut model = police_model(available, 20_000, success);
        model.delayed_basis_points = delayed;
        model.delayed_response_ms = 70_000;
        model.content_hash = police_response_model_hash(&model).unwrap();
        for case_id in ["case", "second"] {
            step(
                &mut state,
                0,
                FareControlActionV1::PlanPolice {
                    hold_id: "hold".into(),
                    train_run_id: "train".into(),
                    target_stop_id: "target".into(),
                    case_ids: vec![case_id.into()],
                    model: model.clone(),
                },
            );
        }
        assert_eq!(state.police_plans["hold"].cases.len(), 2);
        step(
            &mut state,
            1,
            FareControlActionV1::CloseCase {
                case_id: "case".into(),
            },
        );
        assert_eq!(state.cases["case"].status, FareInspectionCaseStatusV1::Open);
        let cancelled = outcome == PoliceResolutionV1::TargetUnavailable;
        let evidence = PoliceOperationalEvidenceV1 {
            world_id: "world".into(),
            train_run_id: "train".into(),
            hold_id: "hold".into(),
            target_stop_id: "target".into(),
            model_hash: model.content_hash.clone(),
            operational_state_hash: "f".repeat(64),
            activated_at_ms: (!cancelled).then_some(10_000),
            deadline_ms: (!cancelled).then_some(60_000),
            released_at_ms: Some(released),
            target_unavailable: cancelled,
            outcome,
        };
        step(
            &mut state,
            released,
            FareControlActionV1::ResolvePolice { evidence },
        );
        assert!(
            state
                .cases
                .values()
                .all(
                    |case| case.evidence.identity_status == IdentityStatusV1::Refused
                        && case.claim_kind.is_none()
                        && case.status == FareInspectionCaseStatusV1::ClosedWithoutClaim
                )
        );
        assert!(
            apply_fare_control(
                &state,
                &state.state_hash,
                &command(
                    &state,
                    released,
                    FareControlActionV1::PlanPolice {
                        hold_id: "second-hold".into(),
                        train_run_id: "train".into(),
                        target_stop_id: "next".into(),
                        case_ids: vec!["case".into()],
                        model
                    }
                )
            )
            .is_err()
        );
        assert_eq!(
            restore_fare_control(&state, &state.state_hash).unwrap(),
            state
        );
    }
}

#[test]
fn multiple_trains_share_one_daily_cap_and_revenue_partition_is_exact() {
    let source = pin(FareFactV1::Invalid);
    let release = source.economy_release.clone();
    let mut state = claimed(source.clone());
    let mut second = source;
    second.train_run_id = "second-train".into();
    second.encounter_id = "second-encounter".into();
    second.passenger.passenger_key = "second-passenger".into();
    let journey = second.journey_evidence.as_mut().unwrap();
    journey.train_run_id = second.train_run_id.clone();
    journey.content_hash = fare_journey_evidence_hash(journey).unwrap();
    step(
        &mut state,
        0,
        FareControlActionV1::OpenCase {
            case_id: "second".into(),
            pin: Box::new(second),
        },
    );
    step(
        &mut state,
        0,
        FareControlActionV1::InspectDocument {
            case_id: "second".into(),
        },
    );
    step(
        &mut state,
        0,
        FareControlActionV1::CreateClaim {
            case_id: "second".into(),
            kind: FareClaimKindV1::Provisional,
        },
    );
    step(&mut state, 2 * DAY, FareControlActionV1::AdvanceTime);
    step(
        &mut state,
        2 * DAY,
        FareControlActionV1::SettleDay {
            day_start_ms: DAY,
            contract_revenue_evidence: revenue(DAY, "4000000", &release),
            economy_release: Box::new(release.clone()),
        },
    );
    let day = &state.days[&DAY.to_string()];
    assert_eq!(
        (
            &day.net_cents,
            &day.premium_cents,
            &day.cap_adjustment_cents
        ),
        (&"12000".into(), &"8000".into(), &"0".into())
    );
    let mut proof = revenue(0, "101", &release);
    proof[0].evidence.service_end_ms = 3 * DAY;
    proof[0].evidence.settled_at_ms = 3 * DAY;
    proof[0].evidence.content_hash =
        fare_contract_revenue_evidence_hash(&proof[0].evidence).unwrap();
    let mut only_revenue = initialize_fare_control("world", "operator", 0).unwrap();
    for start in [0, DAY, 2 * DAY] {
        step(
            &mut only_revenue,
            3 * DAY,
            FareControlActionV1::SettleDay {
                day_start_ms: start,
                contract_revenue_evidence: proof.clone(),
                economy_release: Box::new(release.clone()),
            },
        );
    }
    assert_eq!(
        only_revenue
            .days
            .values()
            .map(|day| day.contract_revenue_cents.parse::<i64>().unwrap())
            .sum::<i64>(),
        101
    );
    proof.push(proof[0].clone());
    assert!(
        apply_fare_control(
            &only_revenue,
            &only_revenue.state_hash,
            &command(
                &only_revenue,
                3 * DAY,
                FareControlActionV1::SettleDay {
                    day_start_ms: 0,
                    contract_revenue_evidence: proof,
                    economy_release: Box::new(release)
                }
            )
        )
        .is_err()
    );
}

#[test]
fn invalid_release_null_money_overflow_and_changed_restore_are_rejected() {
    let mut source = pin(FareFactV1::Invalid);
    source.expected_economy_release_hash = "0".repeat(64);
    let initial = initialize_fare_control("world", "operator", 0).unwrap();
    assert!(
        apply_fare_control(
            &initial,
            &initial.state_hash,
            &command(
                &initial,
                0,
                FareControlActionV1::OpenCase {
                    case_id: "case".into(),
                    pin: Box::new(source)
                }
            )
        )
        .is_err()
    );
    let release = economy();
    let mut json = serde_json::to_value(&release).unwrap();
    json["fareInspection"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<EconomyReleaseDocument>(json).is_err());
    let mut source = pin(FareFactV1::Invalid);
    let journey = source.journey_evidence.as_mut().unwrap();
    journey.ordinary_fare_cents = Some(i64::MAX.to_string());
    journey.content_hash = fare_journey_evidence_hash(journey).unwrap();
    let state = inspected(source);
    assert!(
        apply_fare_control(
            &state,
            &state.state_hash,
            &command(
                &state,
                0,
                FareControlActionV1::CreateClaim {
                    case_id: "case".into(),
                    kind: FareClaimKindV1::Provisional
                }
            )
        )
        .is_err()
    );
    let mut changed = state.clone();
    changed
        .cases
        .get_mut("case")
        .unwrap()
        .pin
        .passenger
        .fare_fact = FareFactV1::Valid;
    assert!(restore_fare_control(&changed, &state.state_hash).is_err());
    assert!(
        apply_fare_control_json("private-parser-marker")
            .unwrap_err()
            .to_string()
            .find("private-parser-marker")
            .is_none()
    );
}
