//! Durchgängige Flottenbetriebsplanung — **M5.2 bis M5.14**.
//!
//! Alle Zeitwerte werden vom Aufrufer als Weltzeit übergeben. Reservierungen
//! sind halboffene Intervalle; Geld, Verbräuche und Bewertungen sind Integer.

#![allow(
    missing_docs,
    reason = "die öffentlichen Domänenfelder sind durch Typnamen und Modulübersicht beschrieben"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use zugfolge_conflict::ConflictResource;
use zugfolge_infra::{
    Acceleration, FacilityCatalog, FacilityId, FacilityKind, FleetClass, Length, Mass, Speed,
    SpeedCategory, TractionType, TrainCharacteristics, TrainCharacteristicsId, TrainProtection,
};

use crate::{InteriorConfiguration, ProcurementChannel, SimTime, VehicleId, WorldId};

/// Die fahrtechnischen, für eine Formation addierbaren Werte eines Assets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormationVehicle {
    pub world_id: WorldId,
    pub id: VehicleId,
    pub class: FleetClass,
    pub length: Length,
    pub mass: Mass,
    pub max_speed: Speed,
    pub acceleration: Acceleration,
    pub deceleration: Acceleration,
    pub traction: TractionType,
    pub protection: TrainProtection,
}

/// Ein aus individuellen Fahrzeugen gebildeter Zugverband (M5.2).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Formation {
    pub world_id: WorldId,
    pub id: u64,
    vehicles: Vec<FormationVehicle>,
}

impl Formation {
    pub fn new(
        world_id: WorldId,
        id: u64,
        vehicles: Vec<FormationVehicle>,
    ) -> Result<Self, OperationsError> {
        if vehicles.is_empty() {
            return Err(OperationsError::EmptyFormation);
        }
        if vehicles.iter().any(|v| v.world_id != world_id) {
            return Err(OperationsError::WrongWorld);
        }
        let ids: BTreeSet<_> = vehicles.iter().map(|v| v.id).collect();
        if ids.len() != vehicles.len() {
            return Err(OperationsError::DuplicateVehicle);
        }
        let first = &vehicles[0];
        if vehicles.iter().any(|v| v.traction != first.traction) {
            return Err(OperationsError::IncompatibleTraction);
        }
        Ok(Self {
            world_id,
            id,
            vehicles,
        })
    }

    pub fn vehicles(&self) -> &[FormationVehicle] {
        &self.vehicles
    }

    /// Verlustfrei-konservative Abbildung auf M1.9: Masse/Länge werden addiert,
    /// Vmax und Beschleunigungsvermögen durch das schwächste Fahrzeug begrenzt.
    pub fn characteristics(
        &self,
        id: TrainCharacteristicsId,
        name: impl Into<String>,
    ) -> Result<TrainCharacteristics, OperationsError> {
        let first = &self.vehicles[0];
        let mass = Mass::from_kilograms(
            self.vehicles
                .iter()
                .map(|v| v.mass.kilograms())
                .try_fold(0_i64, i64::checked_add)
                .ok_or(OperationsError::Overflow)?,
        );
        let length = Length::from_millimetres(
            self.vehicles
                .iter()
                .map(|v| v.length.millimetres())
                .try_fold(0_i64, i64::checked_add)
                .ok_or(OperationsError::Overflow)?,
        );
        let max_speed = self
            .vehicles
            .iter()
            .map(|v| v.max_speed)
            .min()
            .ok_or(OperationsError::EmptyFormation)?;
        let acceleration = self
            .vehicles
            .iter()
            .map(|v| v.acceleration)
            .min()
            .ok_or(OperationsError::EmptyFormation)?;
        let deceleration = self
            .vehicles
            .iter()
            .map(|v| v.deceleration)
            .min()
            .ok_or(OperationsError::EmptyFormation)?;
        let common = first
            .protection
            .systems()
            .filter(|s| self.vehicles.iter().all(|v| v.protection.contains(*s)));
        TrainCharacteristics::new(
            id,
            name,
            mass,
            length,
            max_speed,
            SpeedCategory::Standard,
            acceleration,
            deceleration,
            first.traction.clone(),
            TrainProtection::from_systems(common),
        )
        .map_err(|_| OperationsError::InvalidCharacteristics)
    }

    pub fn check_route(
        &self,
        platform_length: Length,
        required: &TrainProtection,
        approved_classes: &BTreeSet<FleetClass>,
    ) -> Result<(), OperationsError> {
        let length: i64 = self.vehicles.iter().map(|v| v.length.millimetres()).sum();
        if length > platform_length.millimetres() {
            return Err(OperationsError::PlatformTooShort);
        }
        if self
            .vehicles
            .iter()
            .any(|v| !approved_classes.contains(&v.class))
        {
            return Err(OperationsError::MissingApproval);
        }
        if required
            .systems()
            .any(|s| self.vehicles.iter().any(|v| !v.protection.contains(s)))
        {
            return Err(OperationsError::MissingProtection);
        }
        Ok(())
    }
}

/// Art eines Umlaufsegments (M5.3).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RotationActivity {
    Service,
    Turnaround,
    Stabling,
    Servicing,
    ExtraRun,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RotationLeg {
    pub formation_id: u64,
    pub location_from: u64,
    pub location_to: u64,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
    pub activity: RotationActivity,
}

/// Konfliktfreier Umlaufplan; Ortswechsel müssen durch eine Fahrt verbunden sein.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RotationPlan {
    legs: BTreeMap<u64, Vec<RotationLeg>>,
}

impl RotationPlan {
    pub fn add(&mut self, leg: RotationLeg) -> Result<(), OperationsError> {
        if leg.starts_at < 0 || leg.ends_at <= leg.starts_at {
            return Err(OperationsError::InvalidInterval);
        }
        let legs = self.legs.entry(leg.formation_id).or_default();
        if let Some(previous) = legs.last() {
            if previous.ends_at > leg.starts_at {
                return Err(OperationsError::RotationOverlap);
            }
            if previous.location_to != leg.location_from {
                return Err(OperationsError::LocationMismatch);
            }
        }
        legs.push(leg);
        Ok(())
    }
    pub fn legs(&self, formation_id: u64) -> &[RotationLeg] {
        self.legs
            .get(&formation_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }
}

/// Gestufte Wartungsart (M5.4).
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MaintenanceLevel {
    Inspection,
    Minor,
    Major,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaintenanceRule {
    pub level: MaintenanceLevel,
    pub interval_seconds: u64,
    pub interval_km: u64,
    pub workshop_seconds: u32,
    pub base_failure_per_million: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaintenanceState {
    pub elapsed_seconds: u64,
    pub distance_km: u64,
    pub last_level: Option<MaintenanceLevel>,
}

impl MaintenanceState {
    pub fn due<'a>(&self, rules: &'a [MaintenanceRule]) -> Vec<&'a MaintenanceRule> {
        rules
            .iter()
            .filter(|r| {
                self.elapsed_seconds >= r.interval_seconds || self.distance_km >= r.interval_km
            })
            .collect()
    }
    /// Deterministische Wahrscheinlichkeit; die Zufallsziehung erfolgt ausschließlich über den Weltseed des Aufrufers.
    pub fn failure_probability_per_million(&self, rules: &[MaintenanceRule]) -> u32 {
        rules
            .iter()
            .filter(|r| {
                self.elapsed_seconds >= r.interval_seconds || self.distance_km >= r.interval_km
            })
            .map(|r| r.base_failure_per_million)
            .fold(0, u32::saturating_add)
            .min(1_000_000)
    }
    pub fn maintain(&mut self, level: MaintenanceLevel) {
        self.elapsed_seconds = 0;
        self.distance_km = 0;
        self.last_level = Some(level);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersonnelPool {
    pub world_id: WorldId,
    pub id: u64,
    pub capacity_seconds: u32,
    pub minimum_rest_seconds: u32,
    pub classes: BTreeSet<FleetClass>,
    pub routes: BTreeSet<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Duty {
    pub pool_id: u64,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
    pub class: FleetClass,
    pub route_id: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DutyRoster {
    duties: BTreeMap<u64, Vec<Duty>>,
}
impl DutyRoster {
    pub fn assign(&mut self, pool: &PersonnelPool, duty: Duty) -> Result<(), OperationsError> {
        if duty.pool_id != pool.id
            || !pool.classes.contains(&duty.class)
            || !pool.routes.contains(&duty.route_id)
        {
            return Err(OperationsError::PersonnelUnqualified);
        }
        if duty.starts_at < 0
            || duty.ends_at <= duty.starts_at
            || duty.ends_at - duty.starts_at > i64::from(pool.capacity_seconds)
        {
            return Err(OperationsError::DutyCapacity);
        }
        let duties = self.duties.entry(pool.id).or_default();
        if let Some(last) = duties.last() {
            if last.ends_at + i64::from(pool.minimum_rest_seconds) > duty.starts_at {
                return Err(OperationsError::RestViolation);
            }
        }
        duties.push(duty);
        Ok(())
    }
    pub fn duties(&self, pool_id: u64) -> &[Duty] {
        self.duties.get(&pool_id).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// Ganzzahlige Fahrzeugbedarfe in Milli-Einheiten beziehungsweise Reinigungspunkten (M5.6).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct VehicleNeeds {
    pub energy_milli: u64,
    pub sand_milli: u64,
    pub fresh_water_milli: u64,
    pub waste_milli: u64,
    pub interior_soil: u64,
    pub exterior_soil: u64,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NeedRates {
    pub energy_per_km: u32,
    pub sand_per_braking: u32,
    pub water_per_passenger_hour: u32,
    pub waste_per_passenger_hour: u32,
    pub interior_per_passenger_hour: u32,
    pub exterior_per_hour: u32,
}
impl VehicleNeeds {
    pub fn accrue(
        &mut self,
        rates: NeedRates,
        distance_km: u32,
        brake_events: u32,
        passenger_hours: u32,
        operating_hours: u32,
    ) {
        self.energy_milli = self
            .energy_milli
            .saturating_add(u64::from(rates.energy_per_km) * u64::from(distance_km));
        self.sand_milli = self
            .sand_milli
            .saturating_add(u64::from(rates.sand_per_braking) * u64::from(brake_events));
        self.fresh_water_milli = self
            .fresh_water_milli
            .saturating_add(u64::from(rates.water_per_passenger_hour) * u64::from(passenger_hours));
        self.waste_milli = self
            .waste_milli
            .saturating_add(u64::from(rates.waste_per_passenger_hour) * u64::from(passenger_hours));
        self.interior_soil = self.interior_soil.saturating_add(
            u64::from(rates.interior_per_passenger_hour) * u64::from(passenger_hours),
        );
        self.exterior_soil = self
            .exterior_soil
            .saturating_add(u64::from(rates.exterior_per_hour) * u64::from(operating_hours));
    }
    pub fn apply(&mut self, kind: FacilityKind) {
        match kind {
            FacilityKind::FuelStation => self.energy_milli = 0,
            FacilityKind::DisposalFacility => self.waste_milli = 0,
            FacilityKind::TreatmentPlant => {
                self.energy_milli = 0;
                self.sand_milli = 0;
                self.fresh_water_milli = 0;
                self.waste_milli = 0;
                self.interior_soil = 0;
            }
            FacilityKind::WashPlant => self.exterior_soil = 0,
            _ => {}
        }
    }
}

/// Einheitliche Anlagenbelegung über dieselbe Ressourcendarstellung wie Fahrwege (M5.7).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FacilityReservation {
    pub world_id: WorldId,
    pub id: u64,
    pub vehicle_id: VehicleId,
    pub resource: ConflictResource,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
}
#[derive(Clone, Debug, Default)]
pub struct FacilityLedger {
    reservations: BTreeMap<(WorldId, u64), FacilityReservation>,
}
impl FacilityLedger {
    pub fn reserve(
        &mut self,
        reservation: FacilityReservation,
        class: &FleetClass,
        length: Length,
        facilities: &FacilityCatalog,
    ) -> Result<(), OperationsError> {
        if reservation.starts_at < 0 || reservation.ends_at <= reservation.starts_at {
            return Err(OperationsError::InvalidInterval);
        }
        let ConflictResource::Facility(facility_id) = reservation.resource else {
            return Err(OperationsError::NotFacilityResource);
        };
        let facility = facilities
            .facility(facility_id)
            .ok_or(OperationsError::UnknownFacility)?;
        if !facility.accommodates(class, length) {
            return Err(OperationsError::FacilityIncompatible);
        }
        let overlaps = self
            .reservations
            .values()
            .filter(|r| {
                r.world_id == reservation.world_id
                    && r.resource == reservation.resource
                    && r.starts_at < reservation.ends_at
                    && reservation.starts_at < r.ends_at
            })
            .count();
        if overlaps
            >= usize::try_from(facility.capacity())
                .map_err(|_| OperationsError::CapacityExhausted)?
        {
            return Err(OperationsError::CapacityExhausted);
        }
        if self
            .reservations
            .contains_key(&(reservation.world_id, reservation.id))
        {
            return Err(OperationsError::DuplicateReservation);
        }
        self.reservations
            .insert((reservation.world_id, reservation.id), reservation);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtraRunPurpose {
    Positioning,
    Workshop,
    Supply,
    Stabling,
}
/// Zusatzfahrt mit den vier zwingenden Nachweisen (M5.8).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtraRun {
    pub world_id: WorldId,
    pub id: u64,
    pub purpose: ExtraRunPurpose,
    pub formation_id: u64,
    pub route_reservation_id: u64,
    pub duty_id: u64,
    pub cost_cents: i64,
    pub visible: bool,
}
impl ExtraRun {
    pub fn validate(&self) -> Result<(), OperationsError> {
        if self.route_reservation_id == 0
            || self.duty_id == 0
            || self.cost_cents < 0
            || !self.visible
        {
            Err(OperationsError::IncompleteExtraRun)
        } else {
            Ok(())
        }
    }
}

/// Automatisch berechneter Rangierbedarf (M5.9); keine steuerbaren Bewegungen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShuntingRequirement {
    pub seconds: u32,
    pub resource: ConflictResource,
}
pub fn calculate_shunting(
    vehicle_count: usize,
    coupling_changes: u16,
    resource: ConflictResource,
) -> Result<ShuntingRequirement, OperationsError> {
    if vehicle_count == 0 {
        return Err(OperationsError::EmptyFormation);
    }
    let vehicles = u32::try_from(vehicle_count).map_err(|_| OperationsError::Overflow)?;
    Ok(ShuntingRequirement {
        seconds: 120_u32
            .saturating_add(vehicles.saturating_sub(1).saturating_mul(90))
            .saturating_add(u32::from(coupling_changes).saturating_mul(180)),
        resource,
    })
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SupplyPreferences {
    pub preferred_facilities: Vec<FacilityId>,
    pub preferred_locations: Vec<u64>,
    pub earliest: Option<SimTime>,
    pub latest: Option<SimTime>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupplyCandidate {
    pub facility_id: FacilityId,
    pub location_id: u64,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
    pub need_reduction: u64,
    pub deadhead_seconds: u32,
    pub cost_cents: i64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupplyPlan {
    pub selected: Vec<SupplyCandidate>,
    pub score: i64,
    pub optimum_bound: i64,
    pub gap: OptimizationGap,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OptimizationGap {
    pub absolute: i64,
    pub permille: u16,
    pub largest_lever: Option<String>,
}

/// Deterministischer Automatikplaner (M5.10–M5.12). Er maximiert gedeckten
/// Bedarf und Präferenzen, abzüglich Leerfahrt und Kosten, und zeigt seine
/// Lücke zur vom Aufrufer gelieferten oberen Schranke.
pub fn plan_supply(
    mut candidates: Vec<SupplyCandidate>,
    preferences: &SupplyPreferences,
    optimum_bound: i64,
) -> SupplyPlan {
    candidates.retain(|c| {
        preferences.earliest.is_none_or(|v| c.starts_at >= v)
            && preferences.latest.is_none_or(|v| c.ends_at <= v)
    });
    candidates.sort_by_key(|c| {
        (
            std::cmp::Reverse(candidate_score(c, preferences)),
            c.starts_at,
            c.facility_id,
        )
    });
    let mut selected = Vec::new();
    for candidate in candidates {
        if selected.iter().all(|s: &SupplyCandidate| {
            s.ends_at <= candidate.starts_at || candidate.ends_at <= s.starts_at
        }) {
            selected.push(candidate);
        }
    }
    let score = selected
        .iter()
        .map(|c| candidate_score(c, preferences))
        .sum();
    let absolute = optimum_bound.saturating_sub(score).max(0);
    let permille = if optimum_bound <= 0 {
        0
    } else {
        u16::try_from((absolute.saturating_mul(1000) / optimum_bound).min(1000)).unwrap_or(1000)
    };
    let largest_lever = selected
        .iter()
        .max_by_key(|c| c.deadhead_seconds)
        .filter(|c| c.deadhead_seconds > 0)
        .map(|_| "Leerfahrt durch bevorzugte nähere Anlage reduzieren".to_owned());
    SupplyPlan {
        selected,
        score,
        optimum_bound,
        gap: OptimizationGap {
            absolute,
            permille,
            largest_lever,
        },
    }
}
fn candidate_score(c: &SupplyCandidate, p: &SupplyPreferences) -> i64 {
    let facility_bonus = if p.preferred_facilities.contains(&c.facility_id) {
        20_000
    } else {
        0
    };
    let location_bonus = if p.preferred_locations.contains(&c.location_id) {
        10_000
    } else {
        0
    };
    i64::try_from(c.need_reduction)
        .unwrap_or(i64::MAX)
        .saturating_add(facility_bonus)
        .saturating_add(location_bonus)
        .saturating_sub(i64::from(c.deadhead_seconds))
        .saturating_sub(c.cost_cents / 100)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FeasibilityInput {
    pub rotation_errors: Vec<String>,
    pub personnel_errors: Vec<String>,
    pub maintenance_errors: Vec<String>,
    pub supply_errors: Vec<String>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeasibilityReport {
    pub releasable: bool,
    pub violations: Vec<String>,
}
pub fn check_feasibility(input: FeasibilityInput) -> FeasibilityReport {
    let violations = input
        .rotation_errors
        .into_iter()
        .chain(input.personnel_errors)
        .chain(input.maintenance_errors)
        .chain(input.supply_errors)
        .collect::<Vec<_>>();
    FeasibilityReport {
        releasable: violations.is_empty(),
        violations,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcurementLeadTimes {
    pub used_seconds: u64,
    pub new_build_periods: u16,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcurementOffer {
    pub id: u64,
    pub channel: ProcurementChannel,
    pub available_at: SimTime,
    pub configurable: bool,
    pub interior: Option<InteriorConfiguration>,
}
pub fn procurement_offer(
    id: u64,
    channel: ProcurementChannel,
    ordered_at: SimTime,
    period_seconds: u64,
    lead: ProcurementLeadTimes,
    existing: Option<InteriorConfiguration>,
) -> Result<ProcurementOffer, OperationsError> {
    if ordered_at < 0 || period_seconds == 0 {
        return Err(OperationsError::InvalidInterval);
    }
    let delay = match channel {
        ProcurementChannel::Leasing => 0,
        ProcurementChannel::Used => lead.used_seconds,
        ProcurementChannel::NewBuild => period_seconds
            .checked_mul(u64::from(lead.new_build_periods))
            .ok_or(OperationsError::Overflow)?,
    };
    let available_at = ordered_at
        .checked_add(i64::try_from(delay).map_err(|_| OperationsError::Overflow)?)
        .ok_or(OperationsError::Overflow)?;
    let configurable = channel == ProcurementChannel::NewBuild;
    if !configurable && existing.is_none() {
        return Err(OperationsError::ExistingConfigurationRequired);
    }
    Ok(ProcurementOffer {
        id,
        channel,
        available_at,
        configurable,
        interior: existing,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(missing_docs)]
pub enum OperationsError {
    EmptyFormation,
    WrongWorld,
    DuplicateVehicle,
    IncompatibleTraction,
    Overflow,
    InvalidCharacteristics,
    PlatformTooShort,
    MissingApproval,
    MissingProtection,
    InvalidInterval,
    RotationOverlap,
    LocationMismatch,
    PersonnelUnqualified,
    DutyCapacity,
    RestViolation,
    NotFacilityResource,
    UnknownFacility,
    FacilityIncompatible,
    CapacityExhausted,
    DuplicateReservation,
    IncompleteExtraRun,
    ExistingConfigurationRequired,
}
impl fmt::Display for OperationsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl Error for OperationsError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn umlauf_erzwingt_zeit_und_ort() {
        let mut plan = RotationPlan::default();
        plan.add(RotationLeg {
            formation_id: 1,
            location_from: 10,
            location_to: 20,
            starts_at: 100,
            ends_at: 200,
            activity: RotationActivity::Service,
        })
        .unwrap();
        assert_eq!(
            plan.add(RotationLeg {
                formation_id: 1,
                location_from: 20,
                location_to: 30,
                starts_at: 199,
                ends_at: 250,
                activity: RotationActivity::Turnaround
            }),
            Err(OperationsError::RotationOverlap)
        );
        assert_eq!(
            plan.add(RotationLeg {
                formation_id: 1,
                location_from: 99,
                location_to: 30,
                starts_at: 200,
                ends_at: 250,
                activity: RotationActivity::Service
            }),
            Err(OperationsError::LocationMismatch)
        );
    }

    #[test]
    fn bedarfe_laufen_ganzzahlig_und_anlage_deckt_sie() {
        let mut needs = VehicleNeeds::default();
        needs.accrue(
            NeedRates {
                energy_per_km: 20,
                sand_per_braking: 3,
                water_per_passenger_hour: 2,
                waste_per_passenger_hour: 1,
                interior_per_passenger_hour: 4,
                exterior_per_hour: 5,
            },
            10,
            4,
            30,
            2,
        );
        assert_eq!(needs.energy_milli, 200);
        assert_eq!(needs.interior_soil, 120);
        needs.apply(FacilityKind::TreatmentPlant);
        assert_eq!(needs.energy_milli, 0);
        assert_eq!(needs.interior_soil, 0);
    }

    #[test]
    fn automatik_beachtet_vorgaben_und_zeigt_luecke() {
        let preferred = FacilityId::new(2);
        let candidates = vec![
            SupplyCandidate {
                facility_id: FacilityId::new(1),
                location_id: 1,
                starts_at: 10,
                ends_at: 20,
                need_reduction: 100,
                deadhead_seconds: 50,
                cost_cents: 0,
            },
            SupplyCandidate {
                facility_id: preferred,
                location_id: 2,
                starts_at: 10,
                ends_at: 20,
                need_reduction: 90,
                deadhead_seconds: 0,
                cost_cents: 0,
            },
        ];
        let plan = plan_supply(
            candidates,
            &SupplyPreferences {
                preferred_facilities: vec![preferred],
                preferred_locations: vec![],
                earliest: Some(0),
                latest: Some(30),
            },
            25_000,
        );
        assert_eq!(plan.selected[0].facility_id, preferred);
        assert!(plan.gap.absolute > 0);
        assert!(plan.gap.permille <= 1_000);
    }

    #[test]
    fn beschaffungswege_haben_verschiedenes_tempo() {
        let lead = ProcurementLeadTimes {
            used_seconds: 100,
            new_build_periods: 3,
        };
        let leasing = procurement_offer(
            1,
            ProcurementChannel::Leasing,
            1_000,
            1_000,
            lead,
            Some(interior()),
        )
        .unwrap();
        let used = procurement_offer(
            2,
            ProcurementChannel::Used,
            1_000,
            1_000,
            lead,
            Some(interior()),
        )
        .unwrap();
        let new =
            procurement_offer(3, ProcurementChannel::NewBuild, 1_000, 1_000, lead, None).unwrap();
        assert_eq!(
            (leasing.available_at, used.available_at, new.available_at),
            (1_000, 1_100, 4_000)
        );
        assert!(!leasing.configurable && !used.configurable && new.configurable);
    }

    #[test]
    fn freigabe_sammelt_alle_verletzungen() {
        let report = check_feasibility(FeasibilityInput {
            rotation_errors: vec!["Umlauf".into()],
            personnel_errors: vec!["Personal".into()],
            maintenance_errors: vec![],
            supply_errors: vec!["Wasser".into()],
        });
        assert!(!report.releasable);
        assert_eq!(report.violations.len(), 3);
    }

    fn interior() -> InteriorConfiguration {
        InteriorConfiguration {
            first_class_seats: 0,
            second_class_seats: 10,
            density: crate::SeatingDensity::Standard,
            seat_type: crate::SeatType::Row,
            multipurpose: crate::MultipurposeArea::default(),
            toilets: 1,
            accessible_toilets: 1,
            amenities: BTreeSet::new(),
        }
    }
}
