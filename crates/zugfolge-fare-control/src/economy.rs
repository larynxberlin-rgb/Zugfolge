use crate::common::*;
use crate::*;
use zugfolge_fleet::release_catalog::EconomyReleaseDocument;

#[allow(
    clippy::too_many_arguments,
    reason = "Explizite Buchungsbelege werden vollständig am einzigen Journalwriter übergeben"
)]
pub(crate) fn post(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case_id: Option<&str>,
    at: i64,
    kind: FareLedgerEventKindV1,
    release: &EconomyReleaseDocument,
    postings: &[(FareLedgerRoleV1, i64)],
    tag: &str,
) -> Result<(), FareControlError> {
    let sum = postings
        .iter()
        .try_fold(0_i64, |sum, (_, value)| add(sum, *value))?;
    need(
        sum == 0 && postings.iter().filter(|(_, n)| *n != 0).count() >= 2,
        "fare_ledger_unbalanced",
    )?;
    let event_id = hash(&(
        &state.world_id,
        &state.operator_id,
        &command.command_id,
        case_id,
        tag,
    ))?;
    let event = FareLedgerEventV1 {
        world_id: state.world_id.clone(),
        operator_id: state.operator_id.clone(),
        event_id: event_id.clone(),
        case_id: case_id.map(str::to_owned),
        at_ms: at,
        day_start_ms: day(at, rules(release)?),
        kind,
        economy_release_hash: release.checksum.clone(),
        postings: postings
            .iter()
            .filter(|(_, n)| *n != 0)
            .map(|(role, n)| FareLedgerPostingV1 {
                role: *role,
                amount_cents: n.to_string(),
            })
            .collect(),
    };
    need(
        !state.ledger_events.contains_key(&event_id),
        "fare_ledger_duplicate",
    )?;
    state.ledger_events.insert(event_id, event);
    Ok(())
}
pub(crate) fn cost(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case: &mut FareInspectionCaseV1,
    value: i64,
    tag: &str,
) -> Result<(), FareControlError> {
    if value == 0 {
        return Ok(());
    }
    need(value > 0, "fare_amount_invalid")?;
    case.costs_cents = add(nonnegative(&case.costs_cents)?, value)?.to_string();
    post(
        state,
        command,
        Some(&case.case_id),
        command.now_ms,
        FareLedgerEventKindV1::HandlingCost,
        &case.pin.economy_release,
        &[
            (FareLedgerRoleV1::HandlingCost, value),
            (FareLedgerRoleV1::Cash, -value),
        ],
        tag,
    )
}
pub(crate) fn reduce(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case: &mut FareInspectionCaseV1,
    at: i64,
) -> Result<(), FareControlError> {
    let reduced = nonnegative(&rules(&case.pin.economy_release)?.reduced_claim_cents)?;
    let old = nonnegative(&case.claim_cents)?;
    if old <= reduced {
        return Ok(());
    }
    let reduction = old - reduced;
    let paid = nonnegative(&case.paid_cents)?;
    let written_off = nonnegative(&case.written_off_cents)?;
    let refund = (paid - reduced).max(0);
    let reverse_writeoff = written_off.min(reduction - refund);
    let receivable = reduction - refund - reverse_writeoff;
    post(
        state,
        command,
        Some(&case.case_id),
        at,
        FareLedgerEventKindV1::Reduction,
        &case.pin.economy_release,
        &[
            (FareLedgerRoleV1::ClaimReduction, reduction),
            (FareLedgerRoleV1::Receivable, -receivable),
            (FareLedgerRoleV1::Cash, -refund),
            (FareLedgerRoleV1::WriteOff, -reverse_writeoff),
        ],
        "proof-reduction",
    )?;
    case.claim_cents = reduced.to_string();
    case.paid_cents = (paid - refund).to_string();
    case.written_off_cents = (written_off - reverse_writeoff).to_string();
    case.reduced_cents = add(nonnegative(&case.reduced_cents)?, reduction)?.to_string();
    let handling = nonnegative(&rules(&case.pin.economy_release)?.proof_handling_cost_cents)?;
    if handling > 0 {
        case.costs_cents = add(nonnegative(&case.costs_cents)?, handling)?.to_string();
        post(
            state,
            command,
            Some(&case.case_id),
            at,
            FareLedgerEventKindV1::HandlingCost,
            &case.pin.economy_release,
            &[
                (FareLedgerRoleV1::HandlingCost, handling),
                (FareLedgerRoleV1::Cash, -handling),
            ],
            "proof-handling",
        )?;
    }
    Ok(())
}
fn process_payment(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case: &mut FareInspectionCaseV1,
    payment_at: i64,
) -> Result<(), FareControlError> {
    let rules = rules(&case.pin.economy_release)?.clone();
    if !case.payment_processed && command.now_ms >= payment_at {
        let sample = case_sample(case, "fare_payment")?;
        let claim = nonnegative(&case.claim_cents)?;
        let value = if sample < rules.full_payment_basis_points {
            claim
        } else if sample < rules.full_payment_basis_points + rules.partial_payment_basis_points {
            fraction(claim, rules.partial_payment_share_basis_points)?
        } else {
            0
        };
        if value > 0 {
            post(
                state,
                command,
                Some(&case.case_id),
                payment_at,
                FareLedgerEventKindV1::Payment,
                &case.pin.economy_release,
                &[
                    (FareLedgerRoleV1::Cash, value),
                    (FareLedgerRoleV1::Receivable, -value),
                ],
                "payment",
            )?;
            case.paid_cents = value.to_string();
        }
        case.payment_processed = true;
    }
    Ok(())
}
pub(crate) fn advance_case(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    case: &mut FareInspectionCaseV1,
) -> Result<(), FareControlError> {
    let Some(opened) = case.claim_opened_at_ms else {
        return Ok(());
    };
    let rules = rules(&case.pin.economy_release)?.clone();
    let proof_at = add(case.pin.inspected_at_ms, rules.valid_proof_delay_ms)?;
    if !case.proof_processed && command.now_ms >= proof_at {
        case.proof_processed = true;
        if case.pin.passenger.fare_fact != zugfolge_demand::FareFactV1::Invalid
            && case_sample(case, "fare_proof")? < rules.valid_proof_submission_basis_points
        {
            case.proof_received_at_ms = Some(
                case.proof_received_at_ms
                    .map_or(proof_at, |old| old.min(proof_at)),
            );
        }
    }
    if case
        .proof_received_at_ms
        .is_some_and(|at| at <= command.now_ms)
        && case.pin.passenger.fare_fact != zugfolge_demand::FareFactV1::Invalid
    {
        case.evidence.document_status =
            zugfolge_conductor_dialogue::DocumentStatusV1::VerifiedValid;
    }
    let valid_proof_at = case
        .proof_received_at_ms
        .filter(|at| *at < case.proof_deadline_ms)
        .filter(|_| case.pin.passenger.fare_fact != zugfolge_demand::FareFactV1::Invalid);
    let payment_at = add(opened, rules.payment_delay_ms)?;
    let writeoff_at = add(opened, rules.write_off_delay_ms)?;
    // Fällige Ereignisse bleiben in sachlicher Zeitreihenfolge. Ein später
    // gestarteter Worker darf Zahlung, Abschreibung und spätere Korrektur
    // nicht zu einer anderen Tageswirkung zusammenziehen.
    let mut due = vec![(payment_at, 1_u8), (writeoff_at, 2_u8)];
    if let Some(proof) = valid_proof_at {
        due.push((proof.max(opened), 0));
    }
    due.sort();
    for (at, kind) in due.into_iter().filter(|(at, _)| *at <= command.now_ms) {
        match kind {
            0 => reduce(state, command, case, at)?,
            1 => process_payment(state, command, case, at)?,
            _ => {
                let remaining = nonnegative(&case.claim_cents)?
                    - nonnegative(&case.paid_cents)?
                    - nonnegative(&case.written_off_cents)?;
                need(remaining >= 0, "fare_case_balance_invalid")?;
                if remaining > 0 {
                    post(
                        state,
                        command,
                        Some(&case.case_id),
                        at,
                        FareLedgerEventKindV1::WriteOff,
                        &case.pin.economy_release,
                        &[
                            (FareLedgerRoleV1::WriteOff, remaining),
                            (FareLedgerRoleV1::Receivable, -remaining),
                        ],
                        "writeoff",
                    )?;
                    case.written_off_cents =
                        add(nonnegative(&case.written_off_cents)?, remaining)?.to_string();
                }
            }
        }
    }
    if command.now_ms >= writeoff_at
        || (case.payment_processed && case.claim_cents == case.paid_cents)
    {
        case.status = FareInspectionCaseStatusV1::Settled;
    }
    Ok(())
}
pub(crate) fn settle_day(
    state: &mut FareControlWorldStateV1,
    command: &FareControlCommandV1,
    start: i64,
    evidence: &[ConfirmedFareContractRevenueV1],
    release: &EconomyReleaseDocument,
) -> Result<(), FareControlError> {
    let rules = rules(release)?;
    let end = add(start, rules.day_length_ms)?;
    need(
        start >= 0 && start == day(start, rules) && command.now_ms >= end,
        "fare_day_evidence_invalid",
    )?;
    let mut ids = Vec::new();
    let mut journal_ids = std::collections::BTreeSet::new();
    let mut ledger_ids = std::collections::BTreeSet::new();
    let mut revenue = 0_i64;
    for confirmed in evidence {
        let proof = &confirmed.evidence;
        need(
            proof.schema_version == "fare-contract-revenue-evidence/v1"
                && proof.world_id == state.world_id
                && proof.operator_id == state.operator_id
                && id(&proof.contract_id)
                && id(&proof.journal_effect_id)
                && id(&confirmed.ledger_transaction_id)
                && sha(&proof.economy_release_hash)
                && proof.content_hash == fare_contract_revenue_evidence_hash(proof)?
                && proof.service_start_ms >= 0
                && proof.service_end_ms > proof.service_start_ms
                && proof.settled_at_ms >= proof.service_end_ms
                && proof.settled_at_ms <= command.now_ms
                && journal_ids.insert(&proof.journal_effect_id)
                && ledger_ids.insert(&confirmed.ledger_transaction_id),
            "fare_day_evidence_invalid",
        )?;
        let gross = add(
            nonnegative(&proof.ordering_fee_cents)?,
            nonnegative(&proof.bonus_cents)?,
        )?;
        nonnegative(&proof.penalty_cents)?;
        let overlap_start = start.max(proof.service_start_ms);
        let overlap_end = end.min(proof.service_end_ms);
        if overlap_start < overlap_end {
            let duration = i128::from(proof.service_end_ms - proof.service_start_ms);
            let before =
                i128::from(gross) * i128::from(overlap_start - proof.service_start_ms) / duration;
            let after =
                i128::from(gross) * i128::from(overlap_end - proof.service_start_ms) / duration;
            revenue = add(
                revenue,
                i64::try_from(after - before)
                    .map_err(|_| FareControlError("fare_arithmetic_overflow"))?,
            )?;
            ids.push(confirmed.ledger_transaction_id.clone());
        }
    }
    ids.sort();
    let mut net = 0_i64;
    let mut reversed_writeoffs = std::collections::BTreeMap::<String, i64>::new();
    for event in state.ledger_events.values() {
        for posting in &event.postings {
            let value = amount(&posting.amount_cents)?;
            if posting.role == FareLedgerRoleV1::WriteOff && value < 0 {
                let case_id = event
                    .case_id
                    .as_ref()
                    .ok_or(FareControlError("fare_ledger_state_invalid"))?;
                let old = reversed_writeoffs.get(case_id).copied().unwrap_or(0);
                reversed_writeoffs.insert(
                    case_id.clone(),
                    add(
                        old,
                        value
                            .checked_neg()
                            .ok_or(FareControlError("fare_arithmetic_overflow"))?,
                    )?,
                );
            }
        }
    }
    // Eine Korrektur einer Abschreibung mindert ausschließlich den damaligen
    // Verlust. Sie ist kein neuer Zahlungseingang am späteren Nachweistag.
    let mut writeoffs = state
        .ledger_events
        .values()
        .filter(|event| event.kind == FareLedgerEventKindV1::WriteOff)
        .collect::<Vec<_>>();
    writeoffs.sort_by_key(|event| (event.at_ms, &event.event_id));
    for event in writeoffs {
        for posting in &event.postings {
            if posting.role != FareLedgerRoleV1::WriteOff {
                continue;
            }
            let value = nonnegative(&posting.amount_cents)?;
            let case_id = event
                .case_id
                .as_ref()
                .ok_or(FareControlError("fare_ledger_state_invalid"))?;
            let reversed = reversed_writeoffs.entry(case_id.clone()).or_default();
            let correction = value.min(*reversed);
            *reversed -= correction;
            if event.day_start_ms == start {
                net = add(net, -(value - correction))?;
            }
        }
    }
    for event in state
        .ledger_events
        .values()
        .filter(|event| event.day_start_ms == start)
    {
        if matches!(
            event.kind,
            FareLedgerEventKindV1::Premium
                | FareLedgerEventKindV1::CapAdjustment
                | FareLedgerEventKindV1::ClaimOpened
        ) {
            continue;
        }
        for posting in &event.postings {
            let value = amount(&posting.amount_cents)?;
            // Cash trägt Zahlung, Rückzahlung und reale Bearbeitungskosten.
            // Abschreibungen bleiben zusätzlich negativ; die Forderungsanlage
            // selbst begründet keinerlei sicheren Kontrollbeitrag.
            if posting.role == FareLedgerRoleV1::Cash {
                net = add(net, value)?;
            }
        }
    }
    let cap = fraction(revenue, rules.positive_daily_cap_basis_points)?;
    let requested_premium =
        i128::from(net.max(0)) * i128::from(rules.premium_multiplier_basis_points) / 10_000;
    let premium = i64::try_from(requested_premium.min(i128::from((cap - net.max(0)).max(0))))
        .map_err(|_| FareControlError("fare_arithmetic_overflow"))?;
    let adjustment =
        i64::try_from((i128::from(net) + i128::from(premium) - i128::from(cap)).max(0))
            .map_err(|_| FareControlError("fare_arithmetic_overflow"))?;
    let old = state.days.get(&start.to_string()).cloned();
    if let Some(old) = &old {
        need(
            old.economy_release_hash == release.checksum,
            "fare_day_release_mismatch",
        )?;
    }
    let old_premium = old
        .as_ref()
        .map_or(Ok(0), |d| nonnegative(&d.premium_cents))?;
    let old_adjustment = old
        .as_ref()
        .map_or(Ok(0), |d| nonnegative(&d.cap_adjustment_cents))?;
    let premium_delta = premium - old_premium;
    let adjustment_delta = adjustment - old_adjustment;
    if premium_delta != 0 {
        post(
            state,
            command,
            None,
            command.now_ms,
            FareLedgerEventKindV1::Premium,
            release,
            &[
                (FareLedgerRoleV1::Cash, premium_delta),
                (FareLedgerRoleV1::Premium, -premium_delta),
            ],
            "day-premium",
        )?;
    }
    if adjustment_delta != 0 {
        post(
            state,
            command,
            None,
            command.now_ms,
            FareLedgerEventKindV1::CapAdjustment,
            release,
            &[
                (FareLedgerRoleV1::CapAdjustment, adjustment_delta),
                (FareLedgerRoleV1::Cash, -adjustment_delta),
            ],
            "day-cap",
        )?;
    }
    let revision = old.as_ref().map_or(Ok(1), |d| {
        d.settlement_revision
            .checked_add(1)
            .ok_or(FareControlError("fare_arithmetic_overflow"))
    })?;
    state.days.insert(
        start.to_string(),
        FareDaySettlementV1 {
            day_start_ms: start,
            contract_revenue_cents: revenue.to_string(),
            contract_receipt_ids: ids,
            net_cents: net.to_string(),
            premium_cents: premium.to_string(),
            cap_adjustment_cents: adjustment.to_string(),
            settlement_revision: revision,
            economy_release_hash: release.checksum.clone(),
        },
    );
    Ok(())
}
