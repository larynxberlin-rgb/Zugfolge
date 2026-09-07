//! Vollständige Tagesmengen aus gepinnten Vorlagen, keine Vollständigkeitsbehauptung
//! aus der Teilmenge bereits materialisierter Fahrten.
use super::*;
use sha2::{Digest, Sha256};

const DAY_MS: i64 = 86_400_000;
const MAX_OPEN_DAYS: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceDayTemplateV1 {
    pub train_run_id: String,
    pub operator_id: String,
    pub first_day_index: u32,
    pub scheduled_departure_ms: i64,
    pub binding: ServiceOutcomeBinding,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceVehicleCostRateV1 {
    pub vehicle_id: String,
    pub cents_per_train_km: u32,
    pub source_reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceVehicleCostPolicyV1 {
    pub economy_release_hash: String,
    pub fleet_authority_release_hash: String,
    pub vehicle_costs: Vec<ServiceVehicleCostRateV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceDayPolicyV1 {
    pub schema_version: String,
    pub epoch_service_day: String,
    pub day_length_ms: i64,
    pub services: Vec<ServiceDayTemplateV1>,
    pub vehicle_cost_policy: Option<ServiceVehicleCostPolicyV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServiceDayProgress {
    outcomes: BTreeMap<String, serde_json::Value>,
    costs: BTreeMap<String, serde_json::Value>,
    receipt_hashes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VehicleCostProgress {
    last_head_mm: i64,
    distance_by_vehicle: BTreeMap<String, i64>,
    measurement_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServiceDayState {
    policy: ServiceDayPolicyV1,
    next_day_index: u32,
    open: BTreeMap<u32, ServiceDayProgress>,
    vehicle_progress: BTreeMap<String, VehicleCostProgress>,
}

fn invalid() -> OperationalError {
    OperationalError::InvalidServiceDay
}

fn evidence_hash(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("Typisierter Tagesbeleg");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// Gregorianische Kalenderarithmetik mit einem begrenzten, im Vertrag sichtbaren
// Jahresbereich. Es gibt weder Systemzeit noch lokale Zeitzonen im Kern.
fn shifted_day(day: &str, days: u32) -> Result<String, OperationalError> {
    let binding = ServiceOutcomeBinding {
        schema_version: "zugfolge-operational-service-outcome-binding/v1".into(),
        service_id: "calendar".into(),
        service_run_id: format!("calendar:service-day:{day}"),
        lot_id: "calendar".into(),
        service_day: day.into(),
        scheduled_arrival_ms: 0,
        required_seats: None,
        connection_assessment: ServiceConnectionAssessment::Unavailable,
    };
    binding.validate()?;
    let mut y: u32 = day[0..4].parse().map_err(|_| invalid())?;
    let mut m: u32 = day[5..7].parse().map_err(|_| invalid())?;
    let mut d: u32 = day[8..10].parse().map_err(|_| invalid())?;
    let mut remaining = days;
    while remaining > 0 {
        let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
        let count = match m {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        let to_next = count - d + 1;
        if remaining < to_next {
            d += remaining;
            break;
        }
        remaining -= to_next;
        d = 1;
        m += 1;
        if m == 13 {
            m = 1;
            y += 1;
        }
        if y > 9999 {
            return Err(invalid());
        }
    }
    Ok(format!("{y:04}-{m:02}-{d:02}"))
}

impl ServiceDayTemplateV1 {
    fn instance(&self, day_index: u32, epoch: &str) -> Result<Self, OperationalError> {
        let shift = i64::from(day_index)
            .checked_mul(DAY_MS)
            .ok_or_else(invalid)?;
        let mut result = self.clone();
        if day_index > 0 {
            result.train_run_id = format!("{}:day-{day_index}", self.train_run_id);
        }
        result.scheduled_departure_ms = result
            .scheduled_departure_ms
            .checked_add(shift)
            .ok_or_else(invalid)?;
        result.binding.scheduled_arrival_ms = result
            .binding
            .scheduled_arrival_ms
            .checked_add(shift)
            .ok_or_else(invalid)?;
        result.binding.service_day = shifted_day(epoch, day_index)?;
        result.binding.service_run_id = format!(
            "{}:service-day:{}",
            result.binding.service_id, result.binding.service_day
        );
        Ok(result)
    }
}

impl OperationalWorld {
    /// Bindet ausschließlich den optionalen signierten vollständigen Startkatalog.
    pub fn configure_service_days(
        &mut self,
        mut policy: ServiceDayPolicyV1,
    ) -> Result<(), OperationalError> {
        if self.service_day_state.is_some() || !self.trains.is_empty() {
            return Err(invalid());
        }
        policy
            .services
            .sort_by(|a, b| a.binding.service_id.cmp(&b.binding.service_id));
        if let Some(costs) = &mut policy.vehicle_cost_policy {
            costs
                .vehicle_costs
                .sort_by(|a, b| a.vehicle_id.cmp(&b.vehicle_id));
        }
        self.validate_service_day_policy(&policy)?;
        self.service_day_state = Some(ServiceDayState {
            policy,
            next_day_index: 0,
            open: BTreeMap::new(),
            vehicle_progress: BTreeMap::new(),
        });
        Ok(())
    }

    fn validate_service_day_policy(
        &self,
        policy: &ServiceDayPolicyV1,
    ) -> Result<(), OperationalError> {
        let outcomes = self.service_outcome_state.as_ref().ok_or_else(invalid)?;
        if policy.schema_version != "zugfolge-operational-service-day-policy/v1"
            || policy.day_length_ms != DAY_MS
            || policy.services.is_empty()
            || policy.services.len() > 1_000_000
        {
            return Err(invalid());
        }
        if policy
            .services
            .windows(2)
            .any(|pair| pair[0].binding.service_id >= pair[1].binding.service_id)
        {
            return Err(invalid());
        }
        shifted_day(&policy.epoch_service_day, 0)?;
        let mut services = BTreeSet::new();
        let mut trains = BTreeSet::new();
        for service in &policy.services {
            service.binding.validate()?;
            if service.train_run_id.is_empty()
                || service.operator_id.is_empty()
                || service.first_day_index > 1
                || !services.insert(service.binding.service_id.clone())
                || !trains.insert(&service.train_run_id)
                || service.scheduled_departure_ms < 0
                || service.scheduled_departure_ms >= 2 * DAY_MS
                || service.binding.scheduled_arrival_ms < service.scheduled_departure_ms
                || service.binding.scheduled_arrival_ms >= 3 * DAY_MS
                || service.binding.service_day != policy.epoch_service_day
            {
                return Err(invalid());
            }
        }
        if services != outcomes.policy.service_ids.iter().cloned().collect() {
            return Err(invalid());
        }
        if let Some(costs) = &policy.vehicle_cost_policy {
            if costs
                .vehicle_costs
                .windows(2)
                .any(|pair| pair[0].vehicle_id >= pair[1].vehicle_id)
            {
                return Err(invalid());
            }
            let hash = |value: &str| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            };
            if !hash(&costs.economy_release_hash) || !hash(&costs.fleet_authority_release_hash) {
                return Err(invalid());
            }
            let mut ids = BTreeSet::new();
            for cost in &costs.vehicle_costs {
                if !self.vehicles.contains_key(&cost.vehicle_id)
                    || cost.source_reference.is_empty()
                    || !ids.insert(&cost.vehicle_id)
                {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }

    fn day_templates(&self, day: u32) -> Result<Vec<ServiceDayTemplateV1>, OperationalError> {
        let policy = &self.service_day_state.as_ref().ok_or_else(invalid)?.policy;
        policy
            .services
            .iter()
            .filter(|service| service.first_day_index <= day)
            .map(|service| service.instance(day, &policy.epoch_service_day))
            .collect()
    }

    /// Publiziert alle erwarteten Fahrten, einschließlich noch nie gestarteter.
    pub fn open_service_day(&mut self, day_index: u32) -> Result<(), OperationalError> {
        let state = self.service_day_state.as_ref().ok_or_else(invalid)?;
        let current = u32::try_from(self.now_ms / DAY_MS).map_err(|_| invalid())?;
        if day_index > current.saturating_add(2) {
            return Err(invalid());
        }
        if day_index < state.next_day_index {
            return Ok(());
        }
        let count = usize::try_from(day_index - state.next_day_index + 1).map_err(|_| invalid())?;
        if count + state.open.len() > MAX_OPEN_DAYS {
            return Err(invalid());
        }
        let start = state.next_day_index;
        for day in start..=day_index {
            let templates = self.day_templates(day)?;
            self.service_day_state
                .as_mut()
                .expect("Tagespolicy")
                .open
                .insert(
                    day,
                    ServiceDayProgress {
                        outcomes: BTreeMap::new(),
                        costs: BTreeMap::new(),
                        receipt_hashes: BTreeMap::new(),
                    },
                );
            self.service_day_state
                .as_mut()
                .expect("Tagespolicy")
                .next_day_index = day.checked_add(1).ok_or_else(invalid)?;
            for ((operator, lot), services) in grouped(&templates) {
                let day_string = shifted_day(
                    &self
                        .service_day_state
                        .as_ref()
                        .expect("Tagespolicy")
                        .policy
                        .epoch_service_day,
                    day,
                )?;
                let id = day_id(&day_string, &operator, &lot);
                let value = serde_json::json!({"schemaVersion":"zugfolge-operational-service-day-planned/v1",
                    "worldId":self.world_id,"regionId":self.region_id,"operatorId":operator,"lotId":lot,
                    "serviceDayId":id,"serviceDay":day_string,"dayIndex":day,"dayEndMs":(i64::from(day)+1)*DAY_MS,
                    "serviceRunIds":services.iter().map(|service| &service.binding.service_run_id).collect::<Vec<_>>()});
                self.record("service-day-planned", &id, value.to_string())?;
            }
        }
        self.close_ready_service_days()
    }

    pub(super) fn bind_service_day(
        &mut self,
        input: &TrainMaterialization,
    ) -> Result<(), OperationalError> {
        let Some(state) = &self.service_day_state else {
            return Ok(());
        };
        let Some(binding) = &input.service_outcome else {
            return if input.public_passenger_stop {
                Err(invalid())
            } else {
                Ok(())
            };
        };
        let source = &state.policy.services[state
            .policy
            .services
            .binary_search_by(|s| s.binding.service_id.cmp(&binding.service_id))
            .map_err(|_| invalid())?];
        let shift = binding
            .scheduled_arrival_ms
            .checked_sub(source.binding.scheduled_arrival_ms)
            .ok_or_else(invalid)?;
        if shift < 0 || shift % DAY_MS != 0 {
            return Err(invalid());
        }
        let day = u32::try_from(shift / DAY_MS).map_err(|_| invalid())?;
        let expected = source.instance(day, &state.policy.epoch_service_day)?;
        if day < source.first_day_index
            || input.id != expected.train_run_id
            || input.operator_id != expected.operator_id
            || input.scheduled_departure_ms != Some(expected.scheduled_departure_ms)
            || binding != &expected.binding
        {
            return Err(invalid());
        }
        self.open_service_day(day)?;
        let progress = self
            .service_day_state
            .as_ref()
            .expect("Tagespolicy")
            .open
            .get(&day)
            .ok_or_else(invalid)?;
        if progress.outcomes.contains_key(&binding.service_run_id) {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn start_service_vehicle_cost(&mut self, input: &TrainMaterialization) {
        if let (Some(state), Some(binding)) = (&mut self.service_day_state, &input.service_outcome)
        {
            state.vehicle_progress.insert(
                binding.service_run_id.clone(),
                VehicleCostProgress {
                    last_head_mm: input.head_route_mm,
                    distance_by_vehicle: BTreeMap::new(),
                    measurement_hash: evidence_hash(&(
                        input.head_route_mm,
                        BTreeMap::<String, i64>::new(),
                    )),
                },
            );
        }
    }

    pub(super) fn measure_service_vehicle_cost(
        &mut self,
        train_id: &str,
        head_mm: i64,
    ) -> Result<(), OperationalError> {
        let Some(state) = &mut self.service_day_state else {
            return Ok(());
        };
        let train = self.trains.get(train_id).ok_or_else(invalid)?;
        let Some(service) = &train.service_outcome else {
            return Ok(());
        };
        if service.completed {
            return Ok(());
        }
        let progress = state
            .vehicle_progress
            .get_mut(&service.binding.service_run_id)
            .ok_or_else(invalid)?;
        let distance = head_mm
            .checked_sub(progress.last_head_mm)
            .filter(|distance| *distance >= 0)
            .ok_or_else(invalid)?;
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(invalid)?;
        for id in &formation.vehicle_ids {
            let total = progress.distance_by_vehicle.entry(id.clone()).or_default();
            *total = total.checked_add(distance).ok_or_else(invalid)?;
        }
        progress.last_head_mm = head_mm;
        progress.measurement_hash =
            evidence_hash(&(progress.last_head_mm, &progress.distance_by_vehicle));
        Ok(())
    }

    pub(super) fn record_service_day_outcome(
        &mut self,
        train_id: &str,
        outcome: &serde_json::Value,
    ) -> Result<(), OperationalError> {
        if self.service_day_state.is_none() {
            return Ok(());
        }
        let head = self.trains.get(train_id).ok_or_else(invalid)?.head_route_mm;
        self.measure_service_vehicle_cost(train_id, head)?;
        let state = self.service_day_state.as_mut().expect("Tagespolicy");
        let id = outcome["serviceRunId"].as_str().ok_or_else(invalid)?;
        let day = state
            .open
            .keys()
            .copied()
            .find(|day| {
                shifted_day(&state.policy.epoch_service_day, *day)
                    .ok()
                    .as_deref()
                    == outcome["serviceDay"].as_str()
            })
            .ok_or_else(invalid)?;
        let measured = state.vehicle_progress.remove(id).ok_or_else(invalid)?;
        let cost = vehicle_cost_receipt(
            &self.world_id,
            &self.region_id,
            state.policy.vehicle_cost_policy.as_ref(),
            outcome,
            &measured.distance_by_vehicle,
        )?;
        let progress = state.open.get_mut(&day).ok_or_else(invalid)?;
        if progress
            .outcomes
            .insert(id.into(), outcome.clone())
            .is_some()
        {
            return Err(invalid());
        }
        progress.costs.insert(id.into(), cost.clone());
        progress
            .receipt_hashes
            .insert(id.into(), evidence_hash(&(outcome, &cost)));
        self.record("service-vehicle-cost", train_id, cost.to_string())?;
        self.close_ready_service_days()
    }

    pub(super) fn service_day_next_at(&self) -> Option<i64> {
        let state = self.service_day_state.as_ref()?;
        state
            .open
            .keys()
            .map(|day| (i64::from(*day) + 1) * DAY_MS)
            .find(|at| *at > self.now_ms)
    }

    pub(super) fn close_ready_service_days(&mut self) -> Result<(), OperationalError> {
        let Some(state) = &self.service_day_state else {
            return Ok(());
        };
        let ready: Vec<_> = state
            .open
            .iter()
            .filter(|(day, progress)| {
                self.now_ms >= (i64::from(**day) + 1) * DAY_MS
                    && progress.outcomes.len()
                        == state
                            .policy
                            .services
                            .iter()
                            .filter(|s| s.first_day_index <= **day)
                            .count()
            })
            .map(|(day, _)| *day)
            .collect();
        for day in ready {
            let templates = self.day_templates(day)?;
            let state = self.service_day_state.as_mut().expect("Tagespolicy");
            let progress = state.open.remove(&day).ok_or_else(invalid)?;
            let day_string = shifted_day(&state.policy.epoch_service_day, day)?;
            for ((operator, lot), services) in grouped(&templates) {
                let ids: Vec<_> = services
                    .iter()
                    .map(|s| s.binding.service_run_id.clone())
                    .collect();
                let mut numerator = 0_i128;
                let mut cost_complete = true;
                for id in &ids {
                    let cost = progress.costs.get(id).ok_or_else(invalid)?;
                    if let Some(value) = cost["millimetreCents"].as_str() {
                        numerator = numerator
                            .checked_add(value.parse::<i128>().map_err(|_| invalid())?)
                            .ok_or_else(invalid)?;
                    } else {
                        cost_complete = false;
                    }
                }
                let cost_cents = i64::try_from(numerator / 1_000_000).map_err(|_| invalid())?;
                let id = day_id(&day_string, &operator, &lot);
                let value = serde_json::json!({"schemaVersion":"zugfolge-operational-service-day-closed/v1",
                    "worldId":self.world_id,"regionId":self.region_id,"operatorId":operator,"lotId":lot,
                    "serviceDayId":id,"serviceDay":day_string,"dayIndex":day,"dayEndMs":(i64::from(day)+1)*DAY_MS,
                    "closedAtMs":self.now_ms,"serviceRunIds":ids,"dayPlanComplete":true,
                    "vehicleCostEvidenceComplete":cost_complete,"formationOperatingCostCents":cost_complete.then(|| cost_cents.to_string())});
                self.record("service-day-closed", &id, value.to_string())?;
            }
        }
        Ok(())
    }

    pub(super) fn verify_service_days(&self) -> Result<(), OperationalError> {
        let Some(state) = &self.service_day_state else {
            return Ok(());
        };
        self.validate_service_day_policy(&state.policy)?;
        if state.open.len() > MAX_OPEN_DAYS {
            return Err(invalid());
        }
        for (day, progress) in &state.open {
            if *day >= state.next_day_index {
                return Err(invalid());
            }
            let expected: BTreeMap<_, _> = self
                .day_templates(*day)?
                .into_iter()
                .map(|s| (s.binding.service_run_id.clone(), s))
                .collect();
            if progress.costs.keys().ne(progress.outcomes.keys())
                || progress.receipt_hashes.keys().ne(progress.outcomes.keys())
            {
                return Err(invalid());
            }
            for (id, outcome) in &progress.outcomes {
                let service = expected.get(id).ok_or_else(invalid)?;
                if outcome["worldId"] != self.world_id
                    || outcome["operatorId"] != service.operator_id
                    || outcome["lotId"] != service.binding.lot_id
                    || outcome["trainRunId"] != service.train_run_id
                    || outcome["serviceRunId"] != *id
                    || outcome["serviceDay"] != service.binding.service_day
                    || outcome["serviceId"] != service.binding.service_id
                    || outcome["scheduledArrivalMs"] != service.binding.scheduled_arrival_ms
                    || outcome["schemaVersion"] != "zugfolge-operational-train-outcome/v1"
                    || outcome["status"] != "completed"
                    || outcome["actualArrivalMs"]
                        .as_i64()
                        .is_none_or(|at| at > self.now_ms || at < 0)
                    || progress.receipt_hashes[id] != evidence_hash(&(outcome, &progress.costs[id]))
                {
                    return Err(invalid());
                }
                let distance = decimal_i64(&outcome["distanceMm"])?;
                if decimal_i64(&outcome["trainKm"])? != distance / 1_000_000 {
                    return Err(invalid());
                }
                let arrival = outcome["actualArrivalMs"].as_i64().ok_or_else(invalid)?;
                let delay = arrival
                    .saturating_sub(service.binding.scheduled_arrival_ms)
                    .max(0);
                if outcome["delaySeconds"] != delay / 1000 + i64::from(delay % 1000 > 0) {
                    return Err(invalid());
                }
                let minimum = outcome["minimumSeatsProvided"]
                    .as_u64()
                    .and_then(|value| u32::try_from(value).ok());
                let missing = service
                    .binding
                    .required_seats
                    .zip(minimum)
                    .map(|(required, provided)| required.saturating_sub(provided));
                let connections = match service.binding.connection_assessment {
                    ServiceConnectionAssessment::NoneContracted => Some(0_u32),
                    ServiceConnectionAssessment::Unavailable => None,
                };
                if outcome["missingSeats"] != serde_json::json!(missing)
                    || outcome["missedConnections"] != serde_json::json!(connections)
                    || outcome["evidenceComplete"] != (missing.is_some() && connections.is_some())
                {
                    return Err(invalid());
                }
                let cost = &progress.costs[id];
                let mut uses = BTreeMap::new();
                let mut total = 0_i128;
                for line in cost["vehicleUses"].as_array().ok_or_else(invalid)? {
                    let vehicle = line["vehicleId"].as_str().ok_or_else(invalid)?;
                    let used = decimal_i64(&line["distanceMm"])?;
                    if !self.vehicles.contains_key(vehicle)
                        || used > distance
                        || uses.insert(vehicle.to_owned(), used).is_some()
                    {
                        return Err(invalid());
                    }
                    total += i128::from(used);
                }
                if total < i128::from(distance)
                    || cost
                        != &vehicle_cost_receipt(
                            &self.world_id,
                            &self.region_id,
                            state.policy.vehicle_cost_policy.as_ref(),
                            outcome,
                            &uses,
                        )?
                {
                    return Err(invalid());
                }
            }
        }
        let active: BTreeMap<_, _> = self
            .trains
            .values()
            .filter_map(|train| {
                train
                    .service_outcome
                    .as_ref()
                    .filter(|progress| !progress.completed)
                    .map(|p| (&p.binding.service_run_id, train))
            })
            .collect();
        if active.keys().copied().ne(state.vehicle_progress.keys()) {
            return Err(invalid());
        }
        for (id, progress) in &state.vehicle_progress {
            let train = active.get(id).ok_or_else(invalid)?;
            if progress.last_head_mm
                < train
                    .service_outcome
                    .as_ref()
                    .expect("Fahrt")
                    .start_head_route_mm
                || progress.last_head_mm > train.head_route_mm
                || progress.measurement_hash
                    != evidence_hash(&(progress.last_head_mm, &progress.distance_by_vehicle))
                || progress.distance_by_vehicle.iter().any(|(id, distance)| {
                    *distance < 0
                        || !self.vehicles.contains_key(id)
                        || *distance
                            > progress.last_head_mm
                                - train
                                    .service_outcome
                                    .as_ref()
                                    .expect("Fahrt")
                                    .start_head_route_mm
                })
            {
                return Err(invalid());
            }
            let total: i128 = progress
                .distance_by_vehicle
                .values()
                .map(|distance| i128::from(*distance))
                .sum();
            if total
                < i128::from(
                    progress.last_head_mm
                        - train
                            .service_outcome
                            .as_ref()
                            .expect("Fahrt")
                            .start_head_route_mm,
                )
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

fn grouped(
    services: &[ServiceDayTemplateV1],
) -> BTreeMap<(String, String), Vec<&ServiceDayTemplateV1>> {
    let mut result: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for service in services {
        result
            .entry((service.operator_id.clone(), service.binding.lot_id.clone()))
            .or_default()
            .push(service);
    }
    for values in result.values_mut() {
        values.sort_by(|a, b| a.binding.service_run_id.cmp(&b.binding.service_run_id));
    }
    result
}

fn day_id(day: &str, operator: &str, lot: &str) -> String {
    serde_json::to_string(&(day, operator, lot)).expect("Texttupel")
}

fn decimal_i64(value: &serde_json::Value) -> Result<i64, OperationalError> {
    let text = value.as_str().ok_or_else(invalid)?;
    let result = text.parse::<i64>().map_err(|_| invalid())?;
    if result < 0 || result.to_string() != text {
        return Err(invalid());
    }
    Ok(result)
}

fn vehicle_cost_receipt(
    world: &str,
    region: &str,
    policy: Option<&ServiceVehicleCostPolicyV1>,
    outcome: &serde_json::Value,
    uses: &BTreeMap<String, i64>,
) -> Result<serde_json::Value, OperationalError> {
    let mut numerator = 0_i128;
    let mut complete = policy.is_some();
    let mut lines = Vec::new();
    for (vehicle, distance) in uses {
        let rate = policy.and_then(|p| {
            p.vehicle_costs
                .binary_search_by(|r| r.vehicle_id.cmp(vehicle))
                .ok()
                .map(|index| &p.vehicle_costs[index])
        });
        if let Some(rate) = rate {
            numerator = numerator
                .checked_add(i128::from(*distance) * i128::from(rate.cents_per_train_km))
                .ok_or_else(invalid)?;
        } else {
            complete = false;
        }
        lines.push(serde_json::json!({"vehicleId":vehicle,"distanceMm":distance.to_string(),
            "centsPerTrainKm":rate.map(|r| r.cents_per_train_km),"sourceReference":rate.map(|r| &r.source_reference)}));
    }
    Ok(
        serde_json::json!({"schemaVersion":"zugfolge-operational-service-vehicle-cost/v1",
        "worldId":world,"regionId":region,"operatorId":outcome["operatorId"],"lotId":outcome["lotId"],
        "trainRunId":outcome["trainRunId"],"serviceRunId":outcome["serviceRunId"],"serviceDay":outcome["serviceDay"],"basis":"formation-operating-cost",
        "evidenceComplete":complete,"millimetreCents":complete.then(|| numerator.to_string()),"vehicleUses":lines,
        "economyReleaseHash":policy.map(|p| &p.economy_release_hash),"fleetAuthorityReleaseHash":policy.map(|p| &p.fleet_authority_release_hash)}),
    )
}
