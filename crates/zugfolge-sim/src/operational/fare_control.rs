//! Betrieblicher Kontrollhalt im vorhandenen Single-Writer.
use super::fare_control_types::*;
use super::*;
use sha2::{Digest, Sha256};

const MAX_INTEGER: i64 = 9_007_199_254_740_991;
fn error(code: &'static str) -> OperationalError {
    OperationalError::InvalidFareControl(code)
}
fn require(condition: bool, code: &'static str) -> Result<(), OperationalError> {
    if condition { Ok(()) } else { Err(error(code)) }
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 500 && !value.chars().any(char::is_control)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digest(value: &impl Serialize) -> String {
    Sha256::digest(serde_json::to_vec(value).expect("typisierte Ganzzahldaten"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Tatsächlicher typisierter Policyhash; ein vorhandenes Hashfeld wird geleert.
pub fn fare_control_policy_hash(policy: &FareControlPolicyV1) -> String {
    let mut value = policy.clone();
    value.content_hash.clear();
    digest(&value)
}
/// Prüft den vollständigen, bereits außerhalb des Kerns freigegebenen Vertrag.
pub fn validate_fare_control_policy(policy: &FareControlPolicyV1) -> Result<(), OperationalError> {
    require(
        policy.schema == FARE_CONTROL_POLICY_SCHEMA
            && [
                &policy.policy_id,
                &policy.world_id,
                &policy.schedule_period_id,
                &policy.police_response_model_id,
            ]
            .into_iter()
            .all(|v| identifier(v))
            && policy.revision > 0
            && policy.revision <= u64::try_from(MAX_INTEGER).expect("positiv")
            && hash(&policy.content_hash)
            && fare_control_policy_hash(policy) == policy.content_hash,
        "invalid_fare_control_policy",
    )?;
    require(
        policy.max_police_holds_per_train_run == 1
            && policy.eligible_reasons
                == BTreeSet::from([
                    FareControlReasonV1::IdentityRefusal,
                    FareControlReasonV1::ConcreteDanger,
                ])
            && policy.target_rule == "next_unreached_scheduled_passenger_stop"
            && policy.public_cause == FARE_CONTROL_CAUSE
            && (1..=3_600_000).contains(&policy.max_wait_ms)
            && hash(&policy.police_response_model_hash)
            && !policy.provider_by_stop_id.is_empty()
            && policy.provider_by_stop_id.len() <= 100_000
            && policy
                .provider_by_stop_id
                .iter()
                .all(|(stop, provider)| identifier(stop) && identifier(provider)),
        "invalid_fare_control_policy_contract",
    )
}

impl FareControlState {
    pub(super) fn empty() -> Self {
        Self {
            policy: None,
            holds: BTreeMap::new(),
            scheduled: BTreeSet::new(),
            resume_requests: BTreeMap::new(),
            revoked_authorities: BTreeMap::new(),
        }
    }
}

impl OperationalWorld {
    pub(super) fn verify_fare_control(&self) -> Result<(), OperationalError> {
        let Some(state) = &self.fare_control_state else {
            return Ok(());
        };
        if let Some(policy) = &state.policy {
            validate_fare_control_policy(policy)?;
            require(
                policy.world_id == self.world_id,
                "fare_control_world_mismatch",
            )?;
        }
        require(state.holds.len() <= 1_000_000, "fare_control_hold_limit")?;
        let mut scheduled = BTreeSet::new();
        for (train_id, hold) in &state.holds {
            validate_fare_control_policy(&hold.policy)?;
            require(
                hold.schema_version == FARE_CONTROL_HOLD_SCHEMA
                    && hold.world_id == self.world_id
                    && hold.train_run_id == *train_id
                    && hold.hold_id == digest(&("fare-control-hold/v1", &self.world_id, train_id))
                    && hold.policy.world_id == self.world_id
                    && hold.policy_hash == hold.policy.content_hash
                    && hold.model_hash == hold.policy.police_response_model_hash
                    && hold.policy.provider_by_stop_id.get(&hold.target_stop_id)
                        == Some(&hold.provider_id)
                    && !hold.case_ids.is_empty()
                    && hold.case_ids.len() <= 20_000
                    && hold.case_ids.iter().all(|s| identifier(s))
                    && identifier(&hold.causality_id)
                    && hold.revision > 0
                    && hold.revision <= u64::try_from(MAX_INTEGER).expect("positiv")
                    && (0..=self.now_ms).contains(&hold.requested_at_ms),
                "invalid_fare_control_hold",
            )?;
            let train = self.trains.get(train_id);
            let ready = self.fare_control_ready_at(hold)?;
            match hold.status {
                FareControlHoldStatusV1::Requested => {
                    require(
                        train
                            .and_then(|t| t.passenger_stops.as_ref())
                            .is_some_and(|p| {
                                p.cancellation.is_none()
                                    && p.plan
                                        .stops
                                        .iter()
                                        .any(|s| s.stop_id == hold.target_stop_id)
                            }),
                        "fare_control_target_unavailable",
                    )?;
                    require(
                        train.is_some()
                            && hold.activated_at_ms.is_none()
                            && hold.deadline_ms.is_none()
                            && hold.released_at_ms.is_none()
                            && hold.outcome.is_none(),
                        "invalid_fare_control_requested",
                    )?;
                    if let Some(at_ms) = ready {
                        require(at_ms > self.now_ms, "fare_control_activation_overdue")?;
                        scheduled.insert(ScheduledFareControlHold {
                            at_ms,
                            train_id: train_id.clone(),
                        });
                    }
                }
                FareControlHoldStatusV1::Active => {
                    let train = train.ok_or_else(|| error("fare_control_active_train_missing"))?;
                    let activated = hold
                        .activated_at_ms
                        .ok_or_else(|| error("fare_control_activation_missing"))?;
                    let deadline = hold
                        .deadline_ms
                        .ok_or_else(|| error("fare_control_deadline_missing"))?;
                    require(
                        ready == Some(activated)
                            && activated >= hold.requested_at_ms
                            && activated <= self.now_ms
                            && activated.checked_add(hold.policy.max_wait_ms) == Some(deadline)
                            && deadline <= MAX_INTEGER
                            && deadline > self.now_ms
                            && hold.released_at_ms.is_none()
                            && hold.outcome.is_none()
                            && train.speed_mmps == 0
                            && train.motion_segment.is_none()
                            && train.authority.is_none(),
                        "invalid_fare_control_active",
                    )?;
                    scheduled.insert(ScheduledFareControlHold {
                        at_ms: deadline,
                        train_id: train_id.clone(),
                    });
                }
                FareControlHoldStatusV1::Released => {
                    let at = hold
                        .released_at_ms
                        .ok_or_else(|| error("fare_control_release_missing"))?;
                    require(
                        (hold.requested_at_ms..=self.now_ms).contains(&at)
                            && hold.outcome.is_some(),
                        "invalid_fare_control_released",
                    )?;
                    if hold.outcome == Some(FareControlHoldOutcomeV1::TargetUnavailable) {
                        require(
                            hold.activated_at_ms.is_none() && hold.deadline_ms.is_none(),
                            "invalid_fare_control_target_unavailable",
                        )?;
                    } else {
                        let activated = hold
                            .activated_at_ms
                            .ok_or_else(|| error("fare_control_activation_missing"))?;
                        let deadline = hold
                            .deadline_ms
                            .ok_or_else(|| error("fare_control_deadline_missing"))?;
                        require(
                            activated >= hold.requested_at_ms
                                && activated <= at
                                && activated.checked_add(hold.policy.max_wait_ms) == Some(deadline)
                                && deadline <= MAX_INTEGER
                                && if hold.outcome == Some(FareControlHoldOutcomeV1::Timeout) {
                                    at == deadline
                                } else {
                                    at < deadline
                                },
                            "invalid_fare_control_released_time",
                        )?;
                    }
                }
            }
        }
        require(
            scheduled == state.scheduled,
            "fare_control_schedule_mismatch",
        )?;
        for (train_id, request) in &state.resume_requests {
            require(
                request.train_id == *train_id
                    && self.fare_control_blocks_departure(train_id)
                    && request.waiting_since_ms <= self.now_ms,
                "invalid_fare_control_resume_request",
            )?;
        }
        for (train_id, authority) in &state.revoked_authorities {
            let hold = state
                .holds
                .get(train_id)
                .ok_or_else(|| error("fare_control_hold_missing"))?;
            let train = self
                .trains
                .get(train_id)
                .ok_or_else(|| error("fare_control_train_missing"))?;
            require(
                hold.status != FareControlHoldStatusV1::Requested
                    && train.authority.is_none()
                    && authority.train_id == *train_id
                    && authority.route_version_id == train.route_version_id
                    && hold
                        .activated_at_ms
                        .is_some_and(|at| authority.issued_at_ms <= at)
                    && self
                        .route_locks
                        .get(&authority.source_route_lock_id)
                        .is_some_and(|l| l.train_id == *train_id),
                "invalid_fare_control_revoked_authority",
            )?;
        }
        Ok(())
    }
    pub(super) fn fare_control_handover(&self, train_id: &str) -> Option<FareControlHandoverV1> {
        let state = self.fare_control_state.as_ref()?;
        Some(FareControlHandoverV1 {
            hold: state.holds.get(train_id)?.clone(),
            resume_request: state.resume_requests.get(train_id).cloned(),
            revoked_authority: state.revoked_authorities.get(train_id).cloned(),
        })
    }
    pub(super) fn adopt_fare_control_handover(
        &mut self,
        train_id: &str,
        input: Option<&FareControlHandoverV1>,
    ) -> Result<(), OperationalError> {
        let Some(input) = input else {
            return Ok(());
        };
        require(
            input.hold.world_id == self.world_id
                && input.hold.train_run_id == train_id
                && self.fare_control_hold(train_id).is_none(),
            "fare_control_handover_conflict",
        )?;
        let state = self
            .fare_control_state
            .get_or_insert_with(FareControlState::empty);
        state.holds.insert(train_id.into(), input.hold.clone());
        if let Some(request) = &input.resume_request {
            state
                .resume_requests
                .insert(train_id.into(), request.clone());
        }
        if let Some(authority) = &input.revoked_authority {
            state
                .revoked_authorities
                .insert(train_id.into(), authority.clone());
        }
        self.schedule_fare_control_hold(train_id)
    }
    pub(super) fn remove_fare_control_handover(&mut self, train_id: &str) {
        if let Some(state) = &mut self.fare_control_state {
            state.holds.remove(train_id);
            state.resume_requests.remove(train_id);
            state.revoked_authorities.remove(train_id);
            state.scheduled.retain(|s| s.train_id != train_id);
        }
    }
    pub(super) fn fare_control_remaining_template(
        &self,
        train_id: &str,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        if !self.fare_control_authority_revoked(train_id)
            || self.fare_control_blocks_departure(train_id)
        {
            return Ok(None);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| error("fare_control_train_missing"))?;
        let mut found = None;
        for lock in self.route_locks.values().filter(|l| l.train_id == train_id) {
            let template = self
                .infrastructure()?
                .interlocking_route(&lock.template_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                })?;
            if template.authority_start_route_mm <= train.head_route_mm
                && train.head_route_mm < template.authority_end_route_mm
            {
                require(
                    found
                        .as_ref()
                        .is_none_or(|old: &InterlockingRouteTemplate| old == &template),
                    "fare_control_ambiguous_retained_route",
                )?;
                found = Some(template);
            }
        }
        Ok(found)
    }
    pub(super) fn departure_interlocking_route(
        &self,
        train_id: &str,
        route_template_id: &str,
        head: i64,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        if let Some(retained) = self.fare_control_remaining_template(train_id)? {
            return Ok(Some(retained));
        }
        if let Some(retained) = self.infrastructure_remaining_template(train_id)? {
            return Ok(Some(retained));
        }
        self.infrastructure()?
            .train_interlocking_route(route_template_id, head)
    }
    pub(super) fn fare_control_authority_reissued(&mut self, train_id: &str) {
        if let Some(state) = &mut self.fare_control_state {
            state.revoked_authorities.remove(train_id);
        }
    }
    pub(super) fn fare_control_blocks_departure(&self, train_id: &str) -> bool {
        self.fare_control_hold(train_id)
            .is_some_and(|h| h.status == FareControlHoldStatusV1::Active)
    }
    pub(super) fn fare_control_authority_revoked(&self, train_id: &str) -> bool {
        self.fare_control_state
            .as_ref()
            .is_some_and(|s| s.revoked_authorities.contains_key(train_id))
    }
    pub(super) fn fare_control_next_at(&self) -> Option<i64> {
        self.fare_control_state
            .as_ref()?
            .scheduled
            .first()
            .map(|s| s.at_ms)
    }
    fn fare_control_ready_at(
        &self,
        hold: &FareControlHoldV1,
    ) -> Result<Option<i64>, OperationalError> {
        let Some(progress) = self
            .trains
            .get(&hold.train_run_id)
            .and_then(|t| t.passenger_stops.as_ref())
        else {
            return Ok(None);
        };
        let Some(index) = progress
            .plan
            .stops
            .iter()
            .position(|s| s.stop_id == hold.target_stop_id)
        else {
            return Ok(None);
        };
        let Some(arrival) = progress.receipts[index].actual_arrival_ms else {
            return Ok(None);
        };
        let ready = arrival
            .checked_add(progress.plan.stops[index].minimum_dwell_ms)
            .ok_or(OperationalError::ArithmeticOverflow)?
            .max(progress.plan.stops[index].scheduled_departure_ms);
        require(ready <= MAX_INTEGER, "fare_control_time_overflow")?;
        Ok(Some(ready))
    }
    pub(super) fn schedule_fare_control_hold(
        &mut self,
        train_id: &str,
    ) -> Result<(), OperationalError> {
        let Some(hold) = self.fare_control_hold(train_id) else {
            return Ok(());
        };
        let due = match hold.status {
            FareControlHoldStatusV1::Requested => self.fare_control_ready_at(hold)?,
            FareControlHoldStatusV1::Active => hold.deadline_ms,
            FareControlHoldStatusV1::Released => None,
        };
        let state = self.fare_control_state.as_mut().expect("Holdzustand");
        state.scheduled.retain(|s| s.train_id != train_id);
        if let Some(at_ms) = due {
            state.scheduled.insert(ScheduledFareControlHold {
                at_ms,
                train_id: train_id.into(),
            });
        }
        Ok(())
    }
    pub(super) fn progress_fare_control_holds(&mut self) -> Result<(), OperationalError> {
        while let Some(next) = self
            .fare_control_state
            .as_ref()
            .and_then(|s| s.scheduled.first())
            .cloned()
        {
            if next.at_ms > self.now_ms {
                break;
            }
            self.fare_control_state
                .as_mut()
                .expect("Termin")
                .scheduled
                .remove(&next);
            let status = self
                .fare_control_hold(&next.train_id)
                .ok_or_else(|| error("fare_control_hold_missing"))?
                .status;
            match status {
                FareControlHoldStatusV1::Requested => {
                    let hold = self.fare_control_hold(&next.train_id).expect("Hold");
                    require(
                        self.fare_control_ready_at(hold)? == Some(next.at_ms)
                            && next.at_ms == self.now_ms,
                        "fare_control_activation_time_mismatch",
                    )?;
                    let deadline = self
                        .now_ms
                        .checked_add(hold.policy.max_wait_ms)
                        .ok_or(OperationalError::ArithmeticOverflow)?;
                    require(deadline <= MAX_INTEGER, "fare_control_time_overflow")?;
                    let train = self
                        .trains
                        .get_mut(&next.train_id)
                        .ok_or_else(|| error("fare_control_train_missing"))?;
                    require(
                        train.speed_mmps == 0 && train.motion_segment.is_none(),
                        "fare_control_train_not_stopped",
                    )?;
                    let old_authority = train.authority.take();
                    train.waiting_reason = Some(FARE_CONTROL_CAUSE.into());
                    let old_request = self.pending_dispatch_requests.remove(&next.train_id);
                    self.waiting_by_resource.retain(|_, waiting| {
                        waiting.remove(&next.train_id);
                        !waiting.is_empty()
                    });
                    let state = self.fare_control_state.as_mut().expect("Hold");
                    if let Some(authority) = old_authority {
                        state
                            .revoked_authorities
                            .insert(next.train_id.clone(), authority);
                    }
                    if let Some(request) = old_request {
                        state.resume_requests.insert(next.train_id.clone(), request);
                    }
                    let hold = state.holds.get_mut(&next.train_id).expect("Hold");
                    hold.status = FareControlHoldStatusV1::Active;
                    hold.activated_at_ms = Some(self.now_ms);
                    hold.deadline_ms = Some(deadline);
                    hold.revision += 1;
                    state.scheduled.insert(ScheduledFareControlHold {
                        at_ms: deadline,
                        train_id: next.train_id.clone(),
                    });
                    self.rebuild_signal_aspects()?;
                    self.record_fare_control_event(&next.train_id, "fare-control-hold-activated")?;
                    self.record(
                        "departure-authority-withheld",
                        &next.train_id,
                        FARE_CONTROL_CAUSE,
                    )?;
                }
                FareControlHoldStatusV1::Active => self.release_fare_control_hold(
                    &next.train_id,
                    FareControlHoldOutcomeV1::Timeout,
                    "fare-control-deadline",
                )?,
                FareControlHoldStatusV1::Released => {
                    return Err(error("fare_control_stale_schedule"));
                }
            }
        }
        Ok(())
    }
    pub(super) fn cancel_requested_fare_control_hold(
        &mut self,
        train_id: &str,
        causality: &str,
    ) -> Result<(), OperationalError> {
        if self
            .fare_control_hold(train_id)
            .is_some_and(|h| h.status == FareControlHoldStatusV1::Requested)
        {
            self.release_fare_control_hold(
                train_id,
                FareControlHoldOutcomeV1::TargetUnavailable,
                causality,
            )?;
        }
        Ok(())
    }
    fn release_fare_control_hold(
        &mut self,
        train_id: &str,
        outcome: FareControlHoldOutcomeV1,
        causality: &str,
    ) -> Result<(), OperationalError> {
        let state = self
            .fare_control_state
            .as_mut()
            .ok_or_else(|| error("fare_control_hold_missing"))?;
        let hold = state
            .holds
            .get_mut(train_id)
            .ok_or_else(|| error("fare_control_hold_missing"))?;
        hold.status = FareControlHoldStatusV1::Released;
        hold.outcome = Some(outcome);
        hold.released_at_ms = Some(self.now_ms);
        hold.causality_id = causality.into();
        hold.revision += 1;
        state.scheduled.retain(|s| s.train_id != train_id);
        self.refresh_released_infrastructure_stop(train_id)?;
        let may_depart = self.trains.get(train_id).is_some_and(|t| {
            !matches!(t.motion_state, MotionState::SafeStop { .. })
                && t.passenger_stops
                    .as_ref()
                    .is_none_or(|p| p.cancellation.is_none())
        });
        let state = self.fare_control_state.as_mut().expect("Holdzustand");
        if let Some(mut request) = state
            .resume_requests
            .remove(train_id)
            .filter(|_| may_depart)
        {
            request.waiting_since_ms = self.now_ms;
            self.pending_dispatch_requests
                .insert(train_id.into(), request);
        }
        if let Some(train) = self.trains.get_mut(train_id).filter(|_| may_depart) {
            train.waiting_reason = Some("missing-route-authority".into());
        }
        self.record_fare_control_event(train_id, "fare-control-hold-released")?;
        if !may_depart {
            return Ok(());
        }
        self.record(
            "departure-authority-requested",
            train_id,
            FARE_CONTROL_CAUSE,
        )?;
        self.dispatch_pending()?;
        self.progress_movement_continuations()?;
        Ok(())
    }
    /// Übernimmt nur ein fälliges, extern im lokalen Kontrollfallkern festgestelltes Ergebnis.
    pub fn resolve_fare_control_hold(
        &mut self,
        input: &ResolveFareControlHoldInputV1,
    ) -> Result<FareControlHoldV1, OperationalError> {
        require(
            self.prepared_handovers.is_empty(),
            "fare_control_handover_pending",
        )?;
        let hold = self
            .fare_control_hold(&input.train_id)
            .ok_or_else(|| error("fare_control_hold_missing"))?;
        require(
            hold.hold_id == input.hold_id
                && hold.model_hash == input.model_hash
                && hold.revision == input.expected_revision
                && identifier(&input.causality_id),
            "fare_control_resolution_binding_mismatch",
        )?;
        require(
            hold.status == FareControlHoldStatusV1::Active
                && hold.deadline_ms.is_some_and(|at| self.now_ms < at),
            "fare_control_hold_not_active",
        )?;
        let outcome = match input.outcome {
            ResolveFareControlHoldOutcomeV1::IdentityConfirmed => {
                FareControlHoldOutcomeV1::IdentityConfirmed
            }
            ResolveFareControlHoldOutcomeV1::IdentityNotConfirmed => {
                FareControlHoldOutcomeV1::IdentityNotConfirmed
            }
            ResolveFareControlHoldOutcomeV1::Unavailable => FareControlHoldOutcomeV1::Unavailable,
        };
        let mut next = self.clone();
        next.release_fare_control_hold(&input.train_id, outcome, &input.causality_id)?;
        let hold = next
            .fare_control_hold(&input.train_id)
            .expect("Hold")
            .clone();
        *self = next;
        Ok(hold)
    }
    /// Bindet eine freigegebene Weltpolicy; bereits angeforderte Halte behalten ihren Pin.
    pub fn set_fare_control_policy(
        &mut self,
        policy: FareControlPolicyV1,
    ) -> Result<(), OperationalError> {
        require(
            self.prepared_handovers.is_empty(),
            "fare_control_handover_pending",
        )?;
        validate_fare_control_policy(&policy)?;
        require(
            policy.world_id == self.world_id,
            "fare_control_world_mismatch",
        )?;
        if let Some(old) = self
            .fare_control_state
            .as_ref()
            .and_then(|s| s.policy.as_ref())
        {
            if old == &policy {
                return Ok(());
            }
            require(
                policy.schedule_period_id != old.schedule_period_id
                    || policy.revision > old.revision,
                "fare_control_policy_revision_regression",
            )?;
        }
        let mut next = self.clone();
        next.fare_control_state
            .get_or_insert_with(FareControlState::empty)
            .policy = Some(policy.clone());
        next.record(
            "fare-control-policy-bound",
            &self.world_id,
            &policy.content_hash,
        )?;
        *self = next;
        Ok(())
    }
    /// Liefert ausschließlich den tatsächlich gespeicherten zuggebundenen Hold.
    pub fn fare_control_hold(&self, train_id: &str) -> Option<&FareControlHoldV1> {
        self.fare_control_state.as_ref()?.holds.get(train_id)
    }
    /// Fordert den nächsten noch nicht angekommenen tatsächlichen Planhalt an.
    pub fn request_fare_control_hold(
        &mut self,
        input: &RequestFareControlHoldInputV1,
    ) -> Result<FareControlHoldV1, OperationalError> {
        require(
            self.prepared_handovers.is_empty(),
            "fare_control_handover_pending",
        )?;
        require(
            [&input.train_id, &input.case_id, &input.causality_id]
                .into_iter()
                .all(|v| identifier(v)),
            "invalid_fare_control_request",
        )?;
        let train = self
            .trains
            .get(&input.train_id)
            .ok_or_else(|| error("fare_control_train_missing"))?;
        require(
            train.movement_kind == MovementKind::Train && train.public_passenger_stop,
            "fare_control_train_not_eligible",
        )?;
        let progress = train
            .passenger_stops
            .as_ref()
            .ok_or_else(|| error("fare_control_stops_missing"))?;
        require(
            progress.cancellation.is_none(),
            "fare_control_target_unavailable",
        )?;
        let mut next = self.clone();
        if let Some(hold) = self.fare_control_hold(&input.train_id) {
            require(
                hold.status == FareControlHoldStatusV1::Requested,
                "fare_control_train_quota_used",
            )?;
            let index = progress
                .plan
                .stops
                .iter()
                .position(|s| s.stop_id == hold.target_stop_id)
                .ok_or_else(|| error("fare_control_target_unavailable"))?;
            require(
                progress.receipts[index].actual_arrival_ms.is_none(),
                "fare_control_bundling_closed",
            )?;
            require(
                hold.policy.eligible_reasons.contains(&input.reason),
                "fare_control_reason_not_allowed",
            )?;
            if hold.case_ids.contains(&input.case_id) {
                return Ok(hold.clone());
            }
            require(hold.case_ids.len() < 20_000, "fare_control_case_limit")?;
            let hold = next
                .fare_control_state
                .as_mut()
                .expect("bestehender Hold")
                .holds
                .get_mut(&input.train_id)
                .expect("bestehender Hold");
            hold.case_ids.insert(input.case_id.clone());
            hold.revision = hold
                .revision
                .checked_add(1)
                .ok_or(OperationalError::ArithmeticOverflow)?;
            hold.causality_id = input.causality_id.clone();
        } else {
            let policy = self
                .fare_control_state
                .as_ref()
                .and_then(|s| s.policy.as_ref())
                .ok_or_else(|| error("fare_control_policy_missing"))?;
            require(
                policy.eligible_reasons.contains(&input.reason),
                "fare_control_reason_not_allowed",
            )?;
            let index = progress
                .receipts
                .iter()
                .position(|r| r.actual_arrival_ms.is_none())
                .ok_or_else(|| error("fare_control_future_stop_missing"))?;
            let target = &progress.plan.stops[index];
            let provider = policy
                .provider_by_stop_id
                .get(&target.stop_id)
                .ok_or_else(|| error("fare_control_provider_missing"))?;
            let hold = FareControlHoldV1 {
                schema_version: FARE_CONTROL_HOLD_SCHEMA.into(),
                world_id: self.world_id.clone(),
                train_run_id: input.train_id.clone(),
                hold_id: digest(&("fare-control-hold/v1", &self.world_id, &input.train_id)),
                case_ids: BTreeSet::from([input.case_id.clone()]),
                target_stop_id: target.stop_id.clone(),
                requested_at_ms: self.now_ms,
                activated_at_ms: None,
                deadline_ms: None,
                released_at_ms: None,
                status: FareControlHoldStatusV1::Requested,
                outcome: None,
                revision: 1,
                causality_id: input.causality_id.clone(),
                provider_id: provider.clone(),
                policy_hash: policy.content_hash.clone(),
                model_hash: policy.police_response_model_hash.clone(),
                policy: policy.clone(),
            };
            next.fare_control_state
                .as_mut()
                .expect("Policy gebunden")
                .holds
                .insert(input.train_id.clone(), hold);
        }
        next.record_fare_control_event(&input.train_id, "fare-control-hold-requested")?;
        let hold = next
            .fare_control_hold(&input.train_id)
            .expect("angeforderter Hold")
            .clone();
        *self = next;
        Ok(hold)
    }
    pub(super) fn record_fare_control_event(
        &mut self,
        train_id: &str,
        kind: &str,
    ) -> Result<(), OperationalError> {
        let hold = self
            .fare_control_hold(train_id)
            .ok_or_else(|| error("fare_control_hold_missing"))?;
        let public = FareControlHoldEventV1 {
            schema_version: "zugfolge-fare-control-hold-event/v1".into(),
            world_id: hold.world_id.clone(),
            train_run_id: hold.train_run_id.clone(),
            hold_id: hold.hold_id.clone(),
            target_stop_id: hold.target_stop_id.clone(),
            at_ms: self.now_ms,
            status: hold.status,
            outcome: hold.outcome,
            revision: hold.revision,
            cause: FARE_CONTROL_CAUSE.into(),
            causality_id: hold.causality_id.clone(),
        };
        self.record(
            kind,
            train_id,
            serde_json::to_string(&public).expect("datensparsames Ereignis"),
        )
    }
}
