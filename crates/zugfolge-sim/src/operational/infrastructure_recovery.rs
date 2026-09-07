//! Ursachengebundener Wiederanlauf nach technischer Infrastrukturfreigabe.
use super::*;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InfrastructureDisruptionStop {
    pub causes: BTreeSet<String>,
    pub revoked_authority: Option<MovementAuthority>,
}

impl OperationalWorld {
    pub(super) fn stop_for_infrastructure_disruption(
        &mut self,
        train_id: &str,
        disruption_id: &str,
    ) -> Result<(), OperationalError> {
        let train = &self.trains[train_id];
        let prior = self.infrastructure_disruption_stops.get(train_id).cloned();
        // Eine zusätzliche Sperre darf einen anders begründeten Stopp nicht
        // als technisch freigabefähigen Infrastrukturstopp umetikettieren.
        if matches!(train.motion_state, MotionState::SafeStop { .. }) && prior.is_none() {
            return Ok(());
        }
        let mut evidence = prior.unwrap_or(InfrastructureDisruptionStop {
            causes: BTreeSet::new(),
            revoked_authority: train.authority.clone(),
        });
        evidence.causes.insert(disruption_id.into());
        self.safe_stop(train_id, "infrastructure-disruption")?;
        self.infrastructure_disruption_stops
            .insert(train_id.into(), evidence);
        Ok(())
    }

    pub(super) fn release_infrastructure_disruption_stops(
        &mut self,
        disruption_id: &str,
    ) -> Result<(), OperationalError> {
        let affected: Vec<_> = self
            .infrastructure_disruption_stops
            .iter()
            .filter(|(_, evidence)| evidence.causes.contains(disruption_id))
            .map(|(train, _)| train.clone())
            .collect();
        for id in affected {
            let evidence = self.infrastructure_disruption_stops.get_mut(&id).unwrap();
            evidence.causes.remove(disruption_id);
            self.refresh_released_infrastructure_stop(&id)?;
        }
        Ok(())
    }

    pub(super) fn refresh_released_infrastructure_stop(
        &mut self,
        id: &str,
    ) -> Result<(), OperationalError> {
        let Some(evidence) = self.infrastructure_disruption_stops.get(id) else {
            return Ok(());
        };
        let train = &self.trains[id];
        if !evidence.causes.is_empty()
            || self.fare_control_blocks_departure(id)
            || train
                .passenger_stops
                .as_ref()
                .is_some_and(|p| p.cancellation.is_some())
            || matches!(
                train.motion_state,
                MotionState::Standing | MotionState::Moving
            )
        {
            return Ok(());
        }
        if train.speed_mmps != 0
            || train.motion_segment.is_some()
            || train.authority.is_some()
            || !matches!(&train.motion_state, MotionState::SafeStop { reason } if reason == "infrastructure-disruption")
        {
            return Err(OperationalError::UnsafeState);
        }
        let train = self.trains.get_mut(id).unwrap();
        train.motion_state = MotionState::Standing;
        train.waiting_reason = Some("missing-route-authority".into());
        Ok(())
    }

    pub(super) fn infrastructure_remaining_template(
        &self,
        train_id: &str,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        if self
            .infrastructure_disruption_stops
            .get(train_id)
            .is_none_or(|e| !e.causes.is_empty())
            || self.fare_control_blocks_departure(train_id)
        {
            return Ok(None);
        }
        let train = &self.trains[train_id];
        if !matches!(train.motion_state, MotionState::Standing) {
            return Ok(None);
        }
        let mut found = None;
        for lock in self
            .route_locks
            .values()
            .filter(|lock| lock.train_id == train_id)
        {
            let template = self
                .infrastructure()?
                .interlocking_route(&lock.template_id)?
                .ok_or(OperationalError::UnsafeState)?;
            if template.authority_start_route_mm <= train.head_route_mm
                && train.head_route_mm < template.authority_end_route_mm
            {
                if found.as_ref().is_some_and(|old| old != &template) {
                    return Err(OperationalError::UnsafeState);
                }
                found = Some(template);
            }
        }
        Ok(found)
    }

    pub(super) fn infrastructure_signal_withheld(&self, train_id: &str, end: i64) -> bool {
        self.infrastructure_disruption_stops.contains_key(train_id)
            && self.trains[train_id]
                .authority
                .as_ref()
                .is_none_or(|a| a.end_route_mm < end)
    }

    pub(super) fn finish_infrastructure_authority_reissue(&mut self, train_id: &str) {
        let Some(evidence) = self.infrastructure_disruption_stops.get(train_id) else {
            return;
        };
        if evidence.causes.is_empty()
            && self.trains[train_id]
                .authority
                .as_ref()
                .is_some_and(|current| {
                    evidence
                        .revoked_authority
                        .as_ref()
                        .is_none_or(|old| current.end_route_mm >= old.end_route_mm)
                })
        {
            self.infrastructure_disruption_stops.remove(train_id);
        }
    }

    pub(super) fn verify_infrastructure_disruption_stops(&self) -> Result<(), OperationalError> {
        for (id, evidence) in &self.infrastructure_disruption_stops {
            let train = self.trains.get(id).ok_or(OperationalError::UnsafeState)?;
            if evidence
                .causes
                .iter()
                .any(|cause| !self.active_disruptions.contains_key(cause))
                || (!evidence.causes.is_empty()
                    && (!matches!(&train.motion_state, MotionState::SafeStop { reason } if reason == "infrastructure-disruption")
                        || train.speed_mmps != 0
                        || train.authority.is_some()
                        || train.motion_segment.is_some()))
            {
                return Err(OperationalError::UnsafeState);
            }
            if let Some(old) = &evidence.revoked_authority {
                let lock = self
                    .route_locks
                    .get(&old.source_route_lock_id)
                    .ok_or(OperationalError::UnsafeState)?;
                if old.train_id != *id
                    || old.route_version_id != train.route_version_id
                    || lock.train_id != *id
                    || old.issued_at_ms > self.now_ms
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
        }
        Ok(())
    }
}
