//! Exakte Fahrgasthalte aus gepinnten Gleis-/Bahnsteigbindungen.
use super::*;
use sha2::{Digest, Sha256};

pub const MAX_PASSENGER_STOPS_PER_TRAIN: usize = 100;
pub(super) const MAX_STOP_CONTRACT_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStop {
    pub stop_id: String,
    pub station_id: String,
    pub stop_sequence: usize,
    pub route_mm: RouteMillimetres,
    pub platform_id: String,
    pub scheduled_arrival_ms: SimMillis,
    pub scheduled_departure_ms: SimMillis,
    pub minimum_dwell_ms: SimMillis,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStopPlan {
    pub schema_version: String,
    pub world_id: String,
    pub infrastructure_release_id: String,
    pub timetable_release_id: String,
    pub service_id: String,
    pub service_run_id: String,
    pub train_run_id: String,
    pub route_version_id: String,
    pub source_binding_hash: String,
    pub stops: Vec<OperationalPassengerStop>,
}

fn sha256_json(value: &impl Serialize) -> String {
    // Value objects use serde_json's sorted map; field order in transport is irrelevant.
    let canonical = serde_json::to_value(value).expect("integer stop contract");
    let bytes = serde_json::to_vec(&canonical).expect("canonical stop contract");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 500 && !value.chars().any(char::is_control)
}

impl OperationalPassengerStopPlan {
    pub fn hash(&self) -> String {
        sha256_json(self)
    }

    fn validate(&self) -> Result<(), OperationalError> {
        let ids = [
            &self.world_id,
            &self.infrastructure_release_id,
            &self.timetable_release_id,
            &self.service_id,
            &self.service_run_id,
            &self.train_run_id,
            &self.route_version_id,
        ];
        if self.schema_version != "zugfolge-operational-passenger-stop-plan/v1"
            || ids.iter().any(|id| !valid_id(id))
            || self.source_binding_hash.len() != 64
            || !self
                .source_binding_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !(2..=MAX_PASSENGER_STOPS_PER_TRAIN).contains(&self.stops.len())
        {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        let mut stop_ids = BTreeSet::new();
        for (index, stop) in self.stops.iter().enumerate() {
            if stop.stop_sequence != index
                || !valid_id(&stop.stop_id)
                || !valid_id(&stop.station_id)
                || !valid_id(&stop.platform_id)
                || !stop_ids.insert(&stop.stop_id)
                || stop.route_mm < 0
                || stop.scheduled_arrival_ms < 0
                || stop.minimum_dwell_ms < 0
                || [
                    stop.route_mm,
                    stop.scheduled_arrival_ms,
                    stop.scheduled_departure_ms,
                    stop.minimum_dwell_ms,
                ]
                .into_iter()
                .any(|value| value > MAX_STOP_CONTRACT_INTEGER)
                || stop
                    .scheduled_arrival_ms
                    .checked_add(stop.minimum_dwell_ms)
                    .is_none_or(|ready| ready > stop.scheduled_departure_ms)
                || index > 0
                    && (self.stops[index - 1].route_mm >= stop.route_mm
                        || self.stops[index - 1].scheduled_departure_ms > stop.scheduled_arrival_ms)
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStopFact {
    pub actual_arrival_ms: Option<SimMillis>,
    pub actual_departure_ms: Option<SimMillis>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStopProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancellation: Option<OperationalPassengerStopCancellation>,
    pub plan: OperationalPassengerStopPlan,
    pub plan_hash: String,
    pub next_stop_index: usize,
    pub receipts: Vec<OperationalPassengerStopFact>,
}

impl OperationalPassengerStopProgress {
    pub(super) fn new(plan: OperationalPassengerStopPlan) -> Self {
        Self {
            cancellation: None,
            plan_hash: plan.hash(),
            next_stop_index: 0,
            receipts: vec![OperationalPassengerStopFact::default(); plan.stops.len()],
            plan,
        }
    }

    pub(super) fn departure_due(&self) -> Option<SimMillis> {
        if self.cancellation.is_some() {
            return None;
        }
        let index = self.next_stop_index;
        if index + 1 >= self.plan.stops.len() {
            return None;
        }
        let arrival = self.receipts[index].actual_arrival_ms?;
        Some(
            arrival
                .saturating_add(self.plan.stops[index].minimum_dwell_ms)
                .max(self.plan.stops[index].scheduled_departure_ms),
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStopReceipt {
    pub schema_version: String,
    pub world_id: String,
    pub service_run_id: String,
    pub train_run_id: String,
    pub stop_id: String,
    pub stop_sequence: usize,
    pub stop_plan_hash: String,
    pub route_version_id: String,
    pub formation_version_id: String,
    pub kind: String,
    pub actual_time_ms: SimMillis,
    pub receipt_id: String,
}

/// Unveränderlicher Nachweis eines serverseitig disponierten Fahrgasthaltplan-Abbruchs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalPassengerStopCancellation {
    pub world_id: String,
    pub train_run_id: String,
    pub stop_plan_hash: String,
    pub cancelled_at_ms: i64,
    pub causality_id: String,
}
/// Nur aus einer verbindlichen Betriebsdisposition gebildeter Abbruchbefehl.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelPassengerStopPlanInputV1 {
    pub train_id: String,
    pub expected_stop_plan_hash: String,
    pub causality_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScheduledPassengerDeparture {
    pub at_ms: SimMillis,
    pub train_id: String,
    pub stop_sequence: usize,
}

impl OperationalWorld {
    /// Bricht ausschließlich den gebundenen tatsächlichen Haltplan atomar ab.
    pub fn cancel_passenger_stop_plan(
        &mut self,
        input: &CancelPassengerStopPlanInputV1,
    ) -> Result<OperationalPassengerStopCancellation, OperationalError> {
        if !self.prepared_handovers.is_empty() || !valid_id(&input.causality_id) {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        let train = self
            .trains
            .get(&input.train_id)
            .ok_or(OperationalError::InvalidPassengerStopPlan)?;
        let progress = train
            .passenger_stops
            .as_ref()
            .ok_or(OperationalError::InvalidPassengerStopPlan)?;
        if progress.plan_hash != input.expected_stop_plan_hash {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        if let Some(receipt) = &progress.cancellation {
            return if receipt.causality_id == input.causality_id {
                Ok(receipt.clone())
            } else {
                Err(OperationalError::InvalidPassengerStopPlan)
            };
        }
        let receipt = OperationalPassengerStopCancellation {
            world_id: self.world_id.clone(),
            train_run_id: input.train_id.clone(),
            stop_plan_hash: progress.plan_hash.clone(),
            cancelled_at_ms: self.now_ms,
            causality_id: input.causality_id.clone(),
        };
        let mut next = self.clone();
        // Zwischen Segmentgrenzen gilt die tatsächlich erreichte Position.
        if let Some(segment) = train.motion_segment.clone() {
            let head = segment.position_at(self.now_ms)?;
            let route = self
                .infrastructure()?
                .route_version(&train.route_version_id)?
                .ok_or(OperationalError::InvalidPassengerStopPlan)?;
            let length = self
                .formations
                .get(&train.formation_version_id)
                .ok_or(OperationalError::InvalidPassengerStopPlan)?
                .performance
                .length_mm;
            let tail = head.saturating_sub(i64::from(length));
            let intervals = intervals_for(&route, tail, head)?;
            next.ensure_intervals_free(&input.train_id, &intervals)?;
            let mut blocks = blocks_for(&route, tail, head);
            if let Some(protection) = self.handover_protection_by_train.get(&input.train_id) {
                blocks.extend(protection.iter().cloned());
            }
            let changed = train.occupied_blocks.union(&blocks).cloned().collect();
            let value = next.trains.get_mut(&input.train_id).expect("geprüfter Zug");
            value.head_route_mm = head;
            value.tail_route_mm = tail;
            value.occupied_intervals = intervals;
            value.occupied_blocks = blocks;
            value.direction = route
                .leg_at(head)
                .ok_or(OperationalError::InvalidPassengerStopPlan)?
                .direction;
            // Ausschließlich die tatsächliche Zugschlusslage kann Fahrstraßen freigeben.
            next.release_routes_after_tail(&input.train_id)?;
            next.refresh_resource_lifecycle(&changed);
        }
        next.trains
            .get_mut(&input.train_id)
            .expect("geprüfter Zug")
            .passenger_stops
            .as_mut()
            .expect("Haltplan")
            .cancellation = Some(receipt.clone());
        next.safe_stop(&input.train_id, "passenger-stop-plan-cancelled")?;
        next.cancel_requested_fare_control_hold(&input.train_id, &input.causality_id)?;
        next.record(
            "passenger-stop-plan-cancelled",
            &input.train_id,
            serde_json::to_string(&receipt)
                .map_err(|_| OperationalError::InvalidPassengerStopPlan)?,
        )?;
        next.verify_invariants()?;
        *self = next;
        Ok(receipt)
    }

    pub fn validate_passenger_stop_plan(
        &self,
        input: &TrainMaterialization,
    ) -> Result<(), OperationalError> {
        let Some(plan) = &input.stop_plan else {
            return Ok(());
        };
        plan.validate()?;
        if plan.world_id != self.world_id
            || plan.infrastructure_release_id != self.infra_release_id
            || !(0..=MAX_STOP_CONTRACT_INTEGER).contains(&self.now_ms)
            || plan.train_run_id != input.id
            || plan.route_version_id != input.route_version_id
            || input.movement_kind != MovementKind::Train
            || !input.public_passenger_stop
            || plan.stops[0].route_mm != input.head_route_mm
            || Some(plan.stops[0].scheduled_departure_ms) != input.scheduled_departure_ms
            || input.service_outcome.as_ref().is_some_and(|binding| {
                binding.service_id != plan.service_id
                    || binding.service_run_id != plan.service_run_id
                    || plan.stops.last().is_none_or(|stop| {
                        stop.scheduled_arrival_ms != binding.scheduled_arrival_ms
                    })
            })
        {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        self.validate_stop_geometry(plan, &input.formation_version_id, 0)
    }

    pub(super) fn validate_stop_geometry(
        &self,
        plan: &OperationalPassengerStopPlan,
        formation_id: &str,
        from_index: usize,
    ) -> Result<(), OperationalError> {
        let formation = self
            .formations
            .get(formation_id)
            .ok_or(OperationalError::InvalidPassengerStopPlan)?;
        self.validate_stop_geometry_for_formation(plan, formation, from_index)
    }

    pub(super) fn validate_stop_geometry_for_formation(
        &self,
        plan: &OperationalPassengerStopPlan,
        formation: &FormationVersion,
        from_index: usize,
    ) -> Result<(), OperationalError> {
        let infrastructure = self.infrastructure()?;
        let route = infrastructure
            .route_version(&plan.route_version_id)?
            .ok_or(OperationalError::InvalidPassengerStopPlan)?;
        for stop in plan.stops.iter().skip(from_index) {
            let tail = stop
                .route_mm
                .checked_sub(i64::from(formation.performance.length_mm))
                .filter(|tail| *tail >= 0)
                .ok_or(OperationalError::InvalidPassengerStopPlan)?;
            let platform = infrastructure
                .platform_interval(&stop.platform_id)?
                .ok_or(OperationalError::InvalidPassengerStopPlan)?;
            let intervals = intervals_for(&route, tail, stop.route_mm)?;
            if intervals.is_empty()
                || occupied_interval_length_mm(&intervals)?
                    != i64::from(formation.performance.length_mm)
                || intervals.iter().any(|interval| {
                    interval.edge_id != platform.edge_id
                        || interval.direction != platform.direction
                        || interval.from_mm < platform.from_mm
                        || interval.to_mm > platform.to_mm
                })
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
        }
        if plan
            .stops
            .last()
            .is_none_or(|stop| stop.route_mm != route.length_mm())
        {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        Ok(())
    }

    pub(super) fn passenger_stop_waiting(&self, train_id: &str) -> bool {
        if self
            .trains
            .get(train_id)
            .and_then(|t| t.passenger_stops.as_ref())
            .is_some_and(|p| p.cancellation.is_some())
        {
            return true;
        }
        if self.fare_control_blocks_departure(train_id) {
            return true;
        }
        self.trains
            .get(train_id)
            .and_then(|train| train.passenger_stops.as_ref())
            .is_some_and(|progress| {
                progress.receipts[progress.next_stop_index]
                    .actual_arrival_ms
                    .is_some()
                    && progress.departure_due().is_none_or(|due| due > self.now_ms)
            })
    }

    pub(super) fn passenger_braking_target(&self, train: &OperationalTrain) -> Option<i64> {
        let progress = train.passenger_stops.as_ref()?;
        let index = if progress.receipts[progress.next_stop_index]
            .actual_arrival_ms
            .is_some()
        {
            progress.next_stop_index + 1
        } else {
            progress.next_stop_index
        };
        progress.plan.stops.get(index).map(|stop| stop.route_mm)
    }

    fn passenger_receipt(&mut self, train_id: &str, kind: &str) -> Result<(), OperationalError> {
        if !(0..=MAX_STOP_CONTRACT_INTEGER).contains(&self.now_ms) {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        let train = &self.trains[train_id];
        let progress = train
            .passenger_stops
            .as_ref()
            .ok_or(OperationalError::InvalidPassengerStopPlan)?;
        let stop = &progress.plan.stops[progress.next_stop_index];
        let receipt = OperationalPassengerStopReceipt {
            schema_version: "zugfolge-operational-passenger-stop-receipt/v1".to_owned(),
            world_id: self.world_id.clone(),
            service_run_id: progress.plan.service_run_id.clone(),
            train_run_id: train.id.clone(),
            stop_id: stop.stop_id.clone(),
            stop_sequence: stop.stop_sequence,
            stop_plan_hash: progress.plan_hash.clone(),
            route_version_id: train.route_version_id.clone(),
            formation_version_id: train.formation_version_id.clone(),
            kind: kind.to_owned(),
            actual_time_ms: self.now_ms,
            receipt_id: sha256_json(&(
                &self.world_id,
                &progress.plan.service_run_id,
                &train.id,
                &stop.stop_id,
                kind,
            )),
        };
        self.record(
            &format!("passenger-stop-{kind}"),
            train_id,
            serde_json::to_string(&receipt).expect("serializable stop receipt"),
        )
    }

    pub(super) fn record_passenger_arrival(
        &mut self,
        train_id: &str,
    ) -> Result<bool, OperationalError> {
        let train = &self.trains[train_id];
        let Some(progress) = &train.passenger_stops else {
            return Ok(false);
        };
        if train.speed_mmps != 0
            || train.motion_segment.is_some()
            || train.head_route_mm != progress.plan.stops[progress.next_stop_index].route_mm
            || progress.receipts[progress.next_stop_index]
                .actual_arrival_ms
                .is_some()
        {
            return Ok(false);
        }
        if self
            .now_ms
            .checked_add(progress.plan.stops[progress.next_stop_index].minimum_dwell_ms)
            .is_none_or(|due| due > MAX_STOP_CONTRACT_INTEGER)
        {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        self.passenger_receipt(train_id, "arrival")?;
        let train = self.trains.get_mut(train_id).expect("known train");
        let progress = train.passenger_stops.as_mut().expect("bound stops");
        progress.receipts[progress.next_stop_index].actual_arrival_ms = Some(self.now_ms);
        train.waiting_reason = Some("passenger-stop".to_owned());
        self.schedule_passenger_departure(train_id);
        self.schedule_fare_control_hold(train_id)?;
        self.progress_fare_control_holds()?;
        Ok(true)
    }

    pub(super) fn record_passenger_departure(
        &mut self,
        train_id: &str,
    ) -> Result<(), OperationalError> {
        let train = &self.trains[train_id];
        let Some(progress) = &train.passenger_stops else {
            return Ok(());
        };
        if progress.receipts[progress.next_stop_index]
            .actual_arrival_ms
            .is_none()
        {
            return Ok(());
        }
        if progress.departure_due().is_none_or(|due| due > self.now_ms)
            || train.head_route_mm != progress.plan.stops[progress.next_stop_index].route_mm
            || train
                .motion_segment
                .as_ref()
                .is_none_or(|segment| segment.segment_end_route_mm <= train.head_route_mm)
        {
            return Err(OperationalError::PassengerDepartureTooEarly);
        }
        self.passenger_receipt(train_id, "departure")?;
        let progress = self
            .trains
            .get_mut(train_id)
            .expect("known train")
            .passenger_stops
            .as_mut()
            .expect("bound stops");
        progress.receipts[progress.next_stop_index].actual_departure_ms = Some(self.now_ms);
        progress.next_stop_index += 1;
        self.scheduled_passenger_departures
            .retain(|entry| entry.train_id != train_id);
        Ok(())
    }

    pub(super) fn schedule_passenger_departure(&mut self, train_id: &str) {
        let train = &self.trains[train_id];
        if matches!(train.motion_state, MotionState::SafeStop { .. }) {
            return;
        }
        if let Some(progress) = &train.passenger_stops
            && let Some(at_ms) = progress.departure_due()
            && at_ms > self.now_ms
        {
            self.scheduled_passenger_departures
                .insert(ScheduledPassengerDeparture {
                    at_ms,
                    train_id: train_id.to_owned(),
                    stop_sequence: progress.next_stop_index,
                });
        }
    }

    pub(super) fn progress_passenger_departures(&mut self) -> Result<(), OperationalError> {
        while let Some(next) = self.scheduled_passenger_departures.first().cloned() {
            if next.at_ms > self.now_ms {
                break;
            }
            self.scheduled_passenger_departures.remove(&next);
            let Some(train) = self.trains.get(&next.train_id) else {
                continue;
            };
            if train
                .passenger_stops
                .as_ref()
                .is_none_or(|progress| progress.next_stop_index != next.stop_sequence)
                || !matches!(train.motion_state, MotionState::Standing)
                || train.motion_segment.is_some()
            {
                continue;
            }
            if self.fare_control_blocks_departure(&next.train_id) {
                continue;
            }
            if train
                .authority
                .as_ref()
                .is_some_and(|authority| authority.end_route_mm > train.head_route_mm)
            {
                self.plan_motion(&next.train_id)?;
            } else {
                self.dispatch_pending()?;
            }
        }
        Ok(())
    }

    pub(super) fn verify_passenger_stops(&self) -> Result<(), OperationalError> {
        for train in self.trains.values() {
            let Some(progress) = &train.passenger_stops else {
                continue;
            };
            if let Some(cancel) = &progress.cancellation {
                if cancel.world_id != self.world_id
                    || cancel.train_run_id != train.id
                    || cancel.stop_plan_hash != progress.plan_hash
                    || cancel.cancelled_at_ms < 0
                    || cancel.cancelled_at_ms > self.now_ms
                    || !valid_id(&cancel.causality_id)
                    || train.speed_mmps != 0
                    || train.motion_segment.is_some()
                    || train.authority.is_some()
                    || !matches!(train.motion_state, MotionState::SafeStop { .. })
                {
                    return Err(OperationalError::InvalidPassengerStopPlan);
                }
            }
            progress.plan.validate()?;
            if progress.plan_hash != progress.plan.hash()
                || progress.plan.world_id != self.world_id
                || progress.plan.infrastructure_release_id != self.infra_release_id
                || progress.plan.train_run_id != train.id
                || progress.plan.route_version_id != train.route_version_id
                || progress.receipts.len() != progress.plan.stops.len()
                || progress.next_stop_index >= progress.receipts.len()
                || progress
                    .receipts
                    .first()
                    .is_none_or(|fact| fact.actual_arrival_ms.is_none())
                || train.movement_kind != MovementKind::Train
                || !train.public_passenger_stop
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
            let mut previous_time = 0;
            for (index, fact) in progress.receipts.iter().enumerate() {
                if index < progress.next_stop_index
                    && (fact.actual_arrival_ms.is_none() || fact.actual_departure_ms.is_none())
                    || index == progress.next_stop_index && fact.actual_departure_ms.is_some()
                    || index > progress.next_stop_index
                        && (fact.actual_arrival_ms.is_some() || fact.actual_departure_ms.is_some())
                    || fact.actual_departure_ms.is_some() && fact.actual_arrival_ms.is_none()
                {
                    return Err(OperationalError::InvalidPassengerStopPlan);
                }
                for at in [fact.actual_arrival_ms, fact.actual_departure_ms]
                    .into_iter()
                    .flatten()
                {
                    if at < previous_time || at > self.now_ms || at > MAX_STOP_CONTRACT_INTEGER {
                        return Err(OperationalError::InvalidPassengerStopPlan);
                    }
                    previous_time = at;
                }
                if let (Some(arrival), Some(departure)) =
                    (fact.actual_arrival_ms, fact.actual_departure_ms)
                    && (arrival
                        .checked_add(progress.plan.stops[index].minimum_dwell_ms)
                        .is_none_or(|due| due > departure)
                        || departure < progress.plan.stops[index].scheduled_departure_ms)
                {
                    return Err(OperationalError::InvalidPassengerStopPlan);
                }
            }
            let current = &progress.plan.stops[progress.next_stop_index];
            if train.head_route_mm > current.route_mm
                || progress.receipts[progress.next_stop_index]
                    .actual_arrival_ms
                    .is_some()
                    && (train.head_route_mm != current.route_mm
                        || train.speed_mmps != 0
                        || train.motion_segment.is_some())
                || progress.next_stop_index > 0
                    && train.head_route_mm
                        < progress.plan.stops[progress.next_stop_index - 1].route_mm
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
            if self.infra.is_some() {
                self.validate_stop_geometry(
                    &progress.plan,
                    &train.formation_version_id,
                    progress.next_stop_index,
                )?;
            }
            if let Some(due) = progress.departure_due()
                && due > self.now_ms
                && !matches!(train.motion_state, MotionState::SafeStop { .. })
                && !self
                    .scheduled_passenger_departures
                    .contains(&ScheduledPassengerDeparture {
                        at_ms: due,
                        train_id: train.id.clone(),
                        stop_sequence: progress.next_stop_index,
                    })
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
        }
        for scheduled in &self.scheduled_passenger_departures {
            if scheduled.at_ms < self.now_ms
                || self
                    .trains
                    .get(&scheduled.train_id)
                    .and_then(|train| train.passenger_stops.as_ref())
                    .is_none_or(|progress| {
                        progress.next_stop_index != scheduled.stop_sequence
                            || progress.departure_due() != Some(scheduled.at_ms)
                    })
            {
                return Err(OperationalError::InvalidPassengerStopPlan);
            }
        }
        Ok(())
    }
}
