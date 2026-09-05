//! Versionierte, ausschliesslich aus signierten Bindungen und Bewegung
//! abgeleitete Abschlussbelege. Fehlende Vertragsfakten bleiben unbekannt.
use super::*;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceVehicleCapacity {
    pub vehicle_id: String,
    pub seats: u32,
    pub source_reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceOutcomePolicy {
    pub schema_version: String,
    pub vehicle_capacities: Vec<ServiceVehicleCapacity>,
    pub service_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceConnectionAssessment {
    NoneContracted,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceOutcomeBinding {
    pub schema_version: String,
    pub service_id: String,
    pub service_run_id: String,
    pub lot_id: String,
    pub service_day: String,
    pub scheduled_arrival_ms: SimMillis,
    pub required_seats: Option<u32>,
    pub connection_assessment: ServiceConnectionAssessment,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceOutcomeProgress {
    pub binding: ServiceOutcomeBinding,
    pub start_head_route_mm: RouteMillimetres,
    pub minimum_seats_provided: Option<u32>,
    pub capacity_sources: BTreeSet<String>,
    pub completed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ServiceOutcomeState {
    policy: ServiceOutcomePolicy,
    planned: BTreeMap<String, serde_json::Value>,
    latest_started_day: BTreeMap<String, String>,
}

impl ServiceOutcomeBinding {
    fn validate(&self) -> Result<(), OperationalError> {
        let day = self.service_day.as_bytes();
        if self.schema_version != "zugfolge-operational-service-outcome-binding/v1"
            || self.service_run_id.is_empty()
            || self.lot_id.is_empty()
            || self.scheduled_arrival_ms < 0
            || day.len() != 10
            || day[4] != b'-'
            || day[7] != b'-'
            || !day
                .iter()
                .enumerate()
                .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        let year: u32 = self.service_day[0..4]
            .parse()
            .map_err(|_| OperationalError::InvalidServiceOutcome)?;
        let month: u32 = self.service_day[5..7]
            .parse()
            .map_err(|_| OperationalError::InvalidServiceOutcome)?;
        let date: u32 = self.service_day[8..10]
            .parse()
            .map_err(|_| OperationalError::InvalidServiceOutcome)?;
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days = match month {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            2 if leap => 29,
            2 => 28,
            _ => 0,
        };
        if year == 0
            || date == 0
            || date > days
            || self.service_id.is_empty()
            || self.service_run_id
                != format!("{}:service-day:{}", self.service_id, self.service_day)
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        Ok(())
    }
}

impl OperationalWorld {
    pub fn validate_service_outcome_template(
        &self,
        train: &TrainMaterialization,
    ) -> Result<(), OperationalError> {
        let Some(binding) = &train.service_outcome else {
            return Ok(());
        };
        binding.validate()?;
        if self
            .service_outcome_state
            .as_ref()
            .is_none_or(|state| !state.policy.service_ids.contains(&binding.service_id))
            || train.movement_kind != MovementKind::Train
            || !train.public_passenger_stop
            || train
                .scheduled_departure_ms
                .is_none_or(|departure| departure > binding.scheduled_arrival_ms)
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        Ok(())
    }

    pub fn configure_service_outcomes(
        &mut self,
        policy: ServiceOutcomePolicy,
    ) -> Result<(), OperationalError> {
        if self.service_outcome_state.is_some()
            || !self.trains.is_empty()
            || policy.schema_version != "zugfolge-operational-service-outcome-policy/v1"
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        let mut ids = BTreeSet::new();
        for capacity in &policy.vehicle_capacities {
            if !self.vehicles.contains_key(&capacity.vehicle_id)
                || capacity.source_reference.is_empty()
                || !ids.insert(&capacity.vehicle_id)
            {
                return Err(OperationalError::InvalidServiceOutcome);
            }
        }
        let mut services = BTreeSet::new();
        if policy
            .service_ids
            .iter()
            .any(|id| id.is_empty() || !services.insert(id))
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        self.service_outcome_state = Some(ServiceOutcomeState {
            policy,
            planned: BTreeMap::new(),
            latest_started_day: BTreeMap::new(),
        });
        Ok(())
    }

    fn service_plan(
        &self,
        train: &TrainMaterialization,
        binding: &ServiceOutcomeBinding,
    ) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion":"zugfolge-operational-train-service-planned/v1",
            "worldId":self.world_id,"operatorId":train.operator_id,"lotId":binding.lot_id,
            "trainRunId":train.id,"serviceId":binding.service_id,"serviceRunId":binding.service_run_id,"serviceDay":binding.service_day,
            "scheduledArrivalMs":binding.scheduled_arrival_ms,
            "requiredSeats":binding.required_seats,"connectionAssessment":binding.connection_assessment
        })
    }

    pub(super) fn plan_service_outcome(
        &mut self,
        train: &TrainMaterialization,
    ) -> Result<(), OperationalError> {
        self.validate_service_outcome_template(train)?;
        let Some(binding) = &train.service_outcome else {
            return Ok(());
        };
        let plan = self.service_plan(train, binding);
        let state = self
            .service_outcome_state
            .as_mut()
            .ok_or(OperationalError::InvalidServiceOutcome)?;
        if let Some(existing) = state.planned.get(&binding.service_run_id) {
            return if existing == &plan {
                Ok(())
            } else {
                Err(OperationalError::InvalidServiceOutcome)
            };
        }
        state
            .planned
            .insert(binding.service_run_id.clone(), plan.clone());
        self.record("train-service-planned", &train.id, plan.to_string())?;
        Ok(())
    }

    fn formation_service_capacity(&self, formation_id: &str) -> (Option<u32>, BTreeSet<String>) {
        let Some(state) = &self.service_outcome_state else {
            return (None, BTreeSet::new());
        };
        let Some(formation) = self.formations.get(formation_id) else {
            return (None, BTreeSet::new());
        };
        let mut seats = Some(0u32);
        let mut sources = BTreeSet::new();
        for vehicle_id in &formation.vehicle_ids {
            let capacity = state
                .policy
                .vehicle_capacities
                .iter()
                .find(|capacity| capacity.vehicle_id == *vehicle_id);
            seats = seats
                .zip(capacity)
                .and_then(|(sum, capacity)| sum.checked_add(capacity.seats));
            if let Some(capacity) = capacity {
                sources.insert(capacity.source_reference.clone());
            }
        }
        (seats, sources)
    }

    fn claim_service_day(
        &mut self,
        binding: &ServiceOutcomeBinding,
    ) -> Result<(), OperationalError> {
        let state = self
            .service_outcome_state
            .as_mut()
            .ok_or(OperationalError::InvalidServiceOutcome)?;
        if state
            .latest_started_day
            .get(&binding.service_id)
            .is_some_and(|day| day >= &binding.service_day)
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        state
            .latest_started_day
            .insert(binding.service_id.clone(), binding.service_day.clone());
        Ok(())
    }

    pub(super) fn verify_service_outcomes(&self) -> Result<(), OperationalError> {
        let Some(state) = &self.service_outcome_state else {
            return if self
                .trains
                .values()
                .any(|train| train.service_outcome.is_some())
            {
                Err(OperationalError::InvalidServiceOutcome)
            } else {
                Ok(())
            };
        };
        let mut ids = BTreeSet::new();
        let mut services = BTreeSet::new();
        if state.policy.schema_version != "zugfolge-operational-service-outcome-policy/v1"
            || state.policy.vehicle_capacities.iter().any(|capacity| {
                capacity.vehicle_id.is_empty()
                    || capacity.source_reference.is_empty()
                    || !ids.insert(&capacity.vehicle_id)
            })
            || state
                .policy
                .service_ids
                .iter()
                .any(|id| id.is_empty() || !services.insert(id))
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        for (id, day) in &state.latest_started_day {
            if !state.policy.service_ids.contains(id) {
                return Err(OperationalError::InvalidServiceOutcome);
            }
            ServiceOutcomeBinding {
                schema_version: "zugfolge-operational-service-outcome-binding/v1".into(),
                service_id: id.clone(),
                service_run_id: format!("{id}:service-day:{day}"),
                lot_id: "receipt".into(),
                service_day: day.clone(),
                scheduled_arrival_ms: 0,
                required_seats: None,
                connection_assessment: ServiceConnectionAssessment::Unavailable,
            }
            .validate()?;
        }
        for train in self.trains.values() {
            if let Some(progress) = &train.service_outcome {
                progress.binding.validate()?;
                if progress.start_head_route_mm < 0
                    || progress.start_head_route_mm > train.head_route_mm
                    || state
                        .latest_started_day
                        .get(&progress.binding.service_id)
                        .is_none_or(|day| day < &progress.binding.service_day)
                    || progress.capacity_sources.iter().any(|source| {
                        !state
                            .policy
                            .vehicle_capacities
                            .iter()
                            .any(|capacity| &capacity.source_reference == source)
                    })
                    || progress.minimum_seats_provided.is_some()
                        && progress.capacity_sources.is_empty()
                {
                    return Err(OperationalError::InvalidServiceOutcome);
                }
                let (current, _) = self.formation_service_capacity(&train.formation_version_id);
                if !progress.completed
                    && progress
                        .minimum_seats_provided
                        .zip(current)
                        .is_some_and(|(minimum, current)| minimum > current)
                {
                    return Err(OperationalError::InvalidServiceOutcome);
                }
            }
        }
        Ok(())
    }

    pub(super) fn start_service_outcome(
        &mut self,
        input: &TrainMaterialization,
        formation_id: &str,
    ) -> Result<Option<ServiceOutcomeProgress>, OperationalError> {
        let Some(binding) = &input.service_outcome else {
            return Ok(None);
        };
        self.validate_service_outcome_template(input)?;
        if self
            .service_outcome_state
            .as_ref()
            .and_then(|state| state.latest_started_day.get(&binding.service_id))
            .is_some_and(|day| day >= &binding.service_day)
        {
            return Err(OperationalError::InvalidServiceOutcome);
        }
        self.plan_service_outcome(input)?;
        let (minimum_seats_provided, capacity_sources) =
            self.formation_service_capacity(formation_id);
        self.claim_service_day(binding)?;
        Ok(Some(ServiceOutcomeProgress {
            binding: binding.clone(),
            start_head_route_mm: input.head_route_mm,
            minimum_seats_provided,
            capacity_sources,
            completed: false,
        }))
    }

    pub(super) fn update_service_capacity(&mut self, train_id: &str) {
        let train = &self.trains[train_id];
        if train
            .service_outcome
            .as_ref()
            .is_none_or(|progress| progress.completed)
        {
            return;
        }
        let (capacity, sources) = self.formation_service_capacity(&train.formation_version_id);
        if let Some(progress) = &mut self
            .trains
            .get_mut(train_id)
            .expect("known train")
            .service_outcome
        {
            progress.minimum_seats_provided = progress
                .minimum_seats_provided
                .zip(capacity)
                .map(|(previous, current)| previous.min(current));
            progress.capacity_sources.extend(sources);
        }
    }

    pub(super) fn release_service_plan(&mut self, train: &OperationalTrain) {
        if let (Some(state), Some(progress)) =
            (&mut self.service_outcome_state, &train.service_outcome)
        {
            state.planned.remove(&progress.binding.service_run_id);
        }
    }

    pub(super) fn adopt_service_outcome(
        &mut self,
        train: &OperationalTrain,
    ) -> Result<(), OperationalError> {
        let Some(progress) = &train.service_outcome else {
            return Ok(());
        };
        let input = TrainMaterialization {
            service_outcome: Some(progress.binding.clone()),
            id: train.id.clone(),
            train_number: train.train_number.clone(),
            operator_id: train.operator_id.clone(),
            movement_kind: train.movement_kind,
            route_version_id: train.route_version_id.clone(),
            formation_version_id: train.formation_version_id.clone(),
            head_route_mm: train.head_route_mm,
            scheduled_departure_ms: train.scheduled_departure_ms,
            public_passenger_stop: train.public_passenger_stop,
        };
        self.validate_service_outcome_template(&input)?;
        if !progress.completed {
            self.plan_service_outcome(&input)?;
        }
        self.claim_service_day(&progress.binding)?;
        Ok(())
    }

    pub(super) fn complete_service_outcome(
        &mut self,
        train_id: &str,
    ) -> Result<(), OperationalError> {
        let train = &self.trains[train_id];
        let Some(progress) = &train.service_outcome else {
            return Ok(());
        };
        if progress.completed {
            return Ok(());
        }
        let distance_mm = train
            .head_route_mm
            .checked_sub(progress.start_head_route_mm)
            .filter(|distance| *distance >= 0)
            .ok_or(OperationalError::InvalidServiceOutcome)?;
        let delay_ms = self
            .now_ms
            .saturating_sub(progress.binding.scheduled_arrival_ms)
            .max(0);
        let missing_seats = progress
            .binding
            .required_seats
            .zip(progress.minimum_seats_provided)
            .map(|(required, provided)| required.saturating_sub(provided));
        let missed_connections = match progress.binding.connection_assessment {
            ServiceConnectionAssessment::NoneContracted => Some(0u32),
            ServiceConnectionAssessment::Unavailable => None,
        };
        let outcome = serde_json::json!({
            "schemaVersion":"zugfolge-operational-train-outcome/v1",
            "worldId":self.world_id,"operatorId":train.operator_id,"lotId":progress.binding.lot_id,
            "trainRunId":train.id,"serviceId":progress.binding.service_id,"serviceRunId":progress.binding.service_run_id,"serviceDay":progress.binding.service_day,
            "status":"completed","scheduledArrivalMs":progress.binding.scheduled_arrival_ms,"actualArrivalMs":self.now_ms,
            "delaySeconds":delay_ms / 1000 + i64::from(delay_ms % 1000 > 0),
            "distanceMm":distance_mm.to_string(),"trainKm":(distance_mm / 1_000_000).to_string(),
            "minimumSeatsProvided":progress.minimum_seats_provided,"capacitySources":progress.capacity_sources,
            "missingSeats":missing_seats,"missedConnections":missed_connections,
            "evidenceComplete":missing_seats.is_some() && missed_connections.is_some()
        });
        self.record("train-outcome", train_id, outcome.to_string())?;
        // The immutable domain journal and command ledger retain the receipt;
        // regional snapshots retain only pending/active service plans.
        let id = self.trains[train_id]
            .service_outcome
            .as_ref()
            .expect("bound service")
            .binding
            .service_run_id
            .clone();
        if let Some(state) = &mut self.service_outcome_state {
            state.planned.remove(&id);
        }
        self.trains
            .get_mut(train_id)
            .expect("known train")
            .service_outcome
            .as_mut()
            .expect("bound service")
            .completed = true;
        Ok(())
    }
}
