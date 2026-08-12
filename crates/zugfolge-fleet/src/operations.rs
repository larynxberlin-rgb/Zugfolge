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

use zugfolge_conflict::{
    CapacityLedger, ConflictResource, OccupationLedger, ResourceReservation,
    TrainRun as RoutedTrainRun,
};
use zugfolge_determinism::{Rng, SimTime as DeterministicSimTime};
use zugfolge_infra::{
    Acceleration, Electrification, FacilityCatalog, FacilityId, FacilityKind, FleetClass, Force,
    Length, Mass, Power, ProtectionSystem, Speed, SpeedCategory, TractionType,
    TrainCharacteristics, TrainCharacteristicsId, TrainProtection,
};

use crate::{
    InteriorConfiguration, ProcurementChannel, SimTime, VehicleAsset, VehicleId, VehicleTypeId,
    WorldId,
};

/// Betriebliche Rolle eines einzelnen Fahrzeugs in einer Formation.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum VehicleRole {
    /// Angetriebenes Fahrzeug mit eigener Traktion.
    Locomotive,
    /// Angetriebener Triebzug oder Triebzugteil.
    PoweredUnit,
    /// Nicht angetriebener Reisezugwagen.
    Coach,
    /// Nicht angetriebener Wagen mit einem oder zwei Steuerständen.
    ControlCar,
}

/// Steuerstände an den beiden Enden eines Fahrzeugs.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ControlStandConfiguration {
    /// Steuerstand am ersten Ende der Formation, wenn das Fahrzeug dort liegt.
    pub front: bool,
    /// Steuerstand am letzten Ende der Formation, wenn das Fahrzeug dort liegt.
    pub rear: bool,
}

impl ControlStandConfiguration {
    /// Beidseitiger Führerstand, typisch für eine Lokomotive oder einen
    /// vollständigen Triebzug.
    pub const fn both_ends() -> Self {
        Self {
            front: true,
            rear: true,
        }
    }

    /// Kein Führerstand, typisch für einen Reisezugwagen.
    pub const fn none() -> Self {
        Self {
            front: false,
            rear: false,
        }
    }
}

/// Kalibrierte Fahrdynamik einer konkret gebildeten Formation.
///
/// Leistung, Anfahrzugkraft und Bremsgewicht sind feste Eigenschaften eines
/// einzelnen Fahrzeugtyps. Eine feste Beschleunigung einer Lokomotive wäre es
/// dagegen nicht: Sie hängt von der Masse des tatsächlich gekuppelten
/// Wagenparks ab. Deshalb wird dieses Profil beim Bilden einer dienstfähigen
/// Formation geführt und nicht als verpflichtender Stammdatenwert einer Lok.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormationDynamics {
    /// Effektives Anfahrvermögen der konkreten Formation.
    pub acceleration: Acceleration,
    /// Effektives Bremsvermögen der konkreten Formation.
    pub deceleration: Acceleration,
}

impl FormationDynamics {
    /// Baut ein vollständiges, ganzzahliges Fahrprofil.
    pub fn new(
        acceleration: Acceleration,
        deceleration: Acceleration,
    ) -> Result<Self, OperationsError> {
        if !acceleration.is_positive() || !deceleration.is_positive() {
            return Err(OperationsError::MissingFormationDynamics);
        }
        Ok(Self {
            acceleration,
            deceleration,
        })
    }
}

/// Physische Werte eines Katalogtyps; der Release kann sie versioniert neben
/// Markt- und Quellenangaben führen, ohne sie am Einzelfahrzeug zu duplizieren.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleTechnicalData {
    pub vehicle_type_id: VehicleTypeId,
    pub length: Length,
    pub mass: Mass,
    pub max_speed: Speed,
    pub acceleration: Acceleration,
    pub deceleration: Acceleration,
    pub traction: TractionType,
    pub role: VehicleRole,
    pub control_stands: ControlStandConfiguration,
    /// Kontinuierliche Leistung in kW.
    pub continuous_power: Power,
    /// Anfahrzugkraft in kN.
    pub starting_tractive_effort: Force,
    /// Bremsgewicht in kg.
    pub brake_weight: Mass,
}

/// Die fahrtechnischen, für eine Formation addierbaren Werte eines Assets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormationVehicle {
    pub world_id: WorldId,
    pub id: VehicleId,
    pub vehicle_type_id: VehicleTypeId,
    pub class: FleetClass,
    pub length: Length,
    pub mass: Mass,
    pub max_speed: Speed,
    pub acceleration: Acceleration,
    pub deceleration: Acceleration,
    pub traction: TractionType,
    pub role: VehicleRole,
    pub control_stands: ControlStandConfiguration,
    pub protection: TrainProtection,
    pub continuous_power: Power,
    pub starting_tractive_effort: Force,
    pub brake_weight: Mass,
}

impl FormationVehicle {
    /// Leitet die Formationseingabe aus dem echten Asset und typgebundenen
    /// technischen Daten ab; Zugsicherung kommt immer aus dem Ist-Asset.
    pub fn from_asset(
        asset: &VehicleAsset,
        technical: &VehicleTechnicalData,
    ) -> Result<Self, OperationsError> {
        if asset.vehicle_type_id() != technical.vehicle_type_id {
            return Err(OperationsError::TechnicalDataMismatch);
        }
        validate_vehicle_role(
            technical.role,
            &technical.traction,
            technical.control_stands,
        )?;
        Ok(Self {
            world_id: asset.world_id(),
            id: asset.id(),
            vehicle_type_id: asset.vehicle_type_id(),
            class: asset.class_designation().clone(),
            length: technical.length,
            mass: technical.mass,
            max_speed: technical.max_speed,
            acceleration: technical.acceleration,
            deceleration: technical.deceleration,
            traction: technical.traction.clone(),
            role: technical.role,
            control_stands: technical.control_stands,
            protection: asset.installed_protection().clone(),
            continuous_power: technical.continuous_power,
            starting_tractive_effort: technical.starting_tractive_effort,
            brake_weight: technical.brake_weight,
        })
    }
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
        for vehicle in &vehicles {
            validate_vehicle_role(vehicle.role, &vehicle.traction, vehicle.control_stands)?;
            if vehicle.role != VehicleRole::Coach && !has_baseline_protection(&vehicle.protection) {
                return Err(OperationsError::MissingProtection);
            }
        }
        let first_powered = vehicles
            .iter()
            .find(|vehicle| vehicle.traction != TractionType::Unpowered);
        if first_powered.is_some_and(|first| {
            vehicles.iter().any(|vehicle| {
                vehicle.traction != TractionType::Unpowered && vehicle.traction != first.traction
            })
        }) {
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

    /// Ob mindestens ein Fahrzeug den Wagenpark aus eigener Kraft bewegen kann.
    pub fn can_move_under_own_power(&self) -> bool {
        self.vehicles
            .iter()
            .any(|vehicle| vehicle.traction != TractionType::Unpowered)
    }

    /// Ein ausschließlich aus Wagen bestehender Park kann nur geschleppt,
    /// abgestellt oder in eine Werkstatt gebracht werden.
    pub fn requires_external_locomotive(&self) -> bool {
        !self.can_move_under_own_power()
    }

    /// Ob an beiden Enden der Formation ein Führerstand vorhanden ist.
    pub fn has_control_stands_at_both_ends(&self) -> bool {
        self.vehicles
            .first()
            .is_some_and(|vehicle| vehicle.control_stands.front)
            && self
                .vehicles
                .last()
                .is_some_and(|vehicle| vehicle.control_stands.rear)
    }

    /// Ob ein Richtungswechsel ohne Umsetzen einer Lok möglich ist.
    pub fn supports_direct_reversal(&self) -> bool {
        self.can_move_under_own_power() && self.has_control_stands_at_both_ends()
    }

    /// Ob für einen Richtungswechsel die Lok um den Wagenpark rangieren muss.
    pub fn requires_locomotive_runaround(&self) -> bool {
        self.can_move_under_own_power() && !self.has_control_stands_at_both_ends()
    }

    /// Fahrzeuge, die bei der aktuellen Reihung einen Führerstand am
    /// jeweiligen Zugende stellen. Reisezugwagen tragen keine eigene
    /// Zugsicherung; bei einem Wendezug müssen aber Lok und Steuerwagen ihre
    /// jeweils aktive Zugspitze ausrüsten.
    fn driving_vehicles(&self) -> Vec<&FormationVehicle> {
        let mut driving = Vec::new();
        if self
            .vehicles
            .first()
            .is_some_and(|vehicle| vehicle.control_stands.front)
        {
            driving.push(&self.vehicles[0]);
        }
        if self
            .vehicles
            .last()
            .is_some_and(|vehicle| vehicle.control_stands.rear)
            && self.vehicles.last().map(|vehicle| vehicle.id)
                != self.vehicles.first().map(|vehicle| vehicle.id)
        {
            driving.push(self.vehicles.last().expect("Formation ist nicht leer"));
        }
        if driving.is_empty() {
            if let Some(vehicle) = self
                .vehicles
                .iter()
                .find(|vehicle| vehicle.traction != TractionType::Unpowered)
            {
                driving.push(vehicle);
            }
        }
        driving
    }

    /// Abwärtskompatible Ableitung aus einem je Fahrzeug hinterlegten
    /// Referenzprofil.
    ///
    /// Neue Authority-Releases sollen stattdessen
    /// [`Self::characteristics_with_dynamics`] mit einem zur tatsächlichen
    /// Formation passenden, signierten Fahrprofil verwenden. Das verhindert,
    /// dass eine Lokomotive fälschlich eine vom Wagenpark unabhängige
    /// Beschleunigung erhält.
    pub fn characteristics(
        &self,
        id: TrainCharacteristicsId,
        name: impl Into<String>,
    ) -> Result<TrainCharacteristics, OperationsError> {
        let acceleration = self
            .vehicles
            .iter()
            .filter(|vehicle| vehicle.traction != TractionType::Unpowered)
            .map(|v| v.acceleration)
            .min()
            .ok_or(OperationsError::NoPropulsion)?;
        // Unpowered coaches contribute their mode-dependent brake weights;
        // they do not have an own M1.10 deceleration input. Their zero value
        // must therefore not invalidate an otherwise complete formation.
        let deceleration = self
            .vehicles
            .iter()
            .filter(|vehicle| vehicle.traction != TractionType::Unpowered)
            .map(|v| v.deceleration)
            .min()
            .ok_or(OperationsError::NoPropulsion)?;
        self.characteristics_with_dynamics(
            id,
            name,
            FormationDynamics::new(acceleration, deceleration)?,
        )
    }

    /// Bildet eine Fahrzeugreihung mit einem formationsbezogenen Fahrprofil
    /// auf die Planner-Charakteristik ab.
    ///
    /// Masse, Länge, Leistung, Zugkraft, Bremsgewicht und Vmax bleiben dabei
    /// verlustfrei am Fahrzeugverband. Vmax ist stets das Minimum *aller*
    /// gekuppelten Fahrzeuge, also ausdrücklich auch von Reise- und
    /// Steuerwagen.
    pub fn characteristics_with_dynamics(
        &self,
        id: TrainCharacteristicsId,
        name: impl Into<String>,
        dynamics: FormationDynamics,
    ) -> Result<TrainCharacteristics, OperationsError> {
        let first = self
            .vehicles
            .iter()
            .find(|vehicle| vehicle.traction != TractionType::Unpowered)
            .ok_or(OperationsError::NoPropulsion)?;
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
        let continuous_power = Power::from_kilowatts(
            self.vehicles
                .iter()
                .map(|vehicle| vehicle.continuous_power.kilowatts())
                .try_fold(0_i64, i64::checked_add)
                .ok_or(OperationsError::Overflow)?,
        );
        let starting_tractive_effort = Force::from_kilonewtons(
            self.vehicles
                .iter()
                .map(|vehicle| vehicle.starting_tractive_effort.kilonewtons())
                .try_fold(0_i64, i64::checked_add)
                .ok_or(OperationsError::Overflow)?,
        );
        let brake_weight = Mass::from_kilograms(
            self.vehicles
                .iter()
                .map(|vehicle| vehicle.brake_weight.kilograms())
                .try_fold(0_i64, i64::checked_add)
                .ok_or(OperationsError::Overflow)?,
        );
        let driving = self.driving_vehicles();
        let common = first.protection.systems().filter(|system| {
            driving
                .iter()
                .all(|vehicle| vehicle.protection.contains(*system))
        });
        TrainCharacteristics::new_with_performance(
            id,
            name,
            mass,
            length,
            max_speed,
            SpeedCategory::Standard,
            dynamics.acceleration,
            dynamics.deceleration,
            first.traction.clone(),
            TrainProtection::from_systems(common),
            continuous_power,
            starting_tractive_effort,
            brake_weight,
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
        let driving = self.driving_vehicles();
        if required.systems().any(|system| {
            driving
                .iter()
                .any(|vehicle| !vehicle.protection.contains(system))
        }) {
            return Err(OperationsError::MissingProtection);
        }
        Ok(())
    }

    /// Vollständige streckenbezogene Prüfung einschließlich Elektrifizierung.
    pub fn check_operating_route(
        &self,
        platform_lengths: &[Length],
        electrifications: &[Electrification],
        required: &TrainProtection,
        approved_classes: &BTreeSet<FleetClass>,
    ) -> Result<(), OperationsError> {
        let shortest_platform = platform_lengths
            .iter()
            .copied()
            .min()
            .ok_or(OperationsError::MissingPlatform)?;
        self.check_route(shortest_platform, required, approved_classes)?;
        if electrifications.iter().any(|electrification| {
            self.vehicles.iter().any(|vehicle| {
                vehicle.traction != TractionType::Unpowered
                    && !vehicle.traction.can_use(*electrification)
            })
        }) {
            return Err(OperationsError::IncompatibleElectrification);
        }
        Ok(())
    }
}

fn validate_vehicle_role(
    role: VehicleRole,
    traction: &TractionType,
    control_stands: ControlStandConfiguration,
) -> Result<(), OperationsError> {
    let unpowered = *traction == TractionType::Unpowered;
    match role {
        VehicleRole::Coach => {
            if !unpowered || control_stands != ControlStandConfiguration::none() {
                return Err(OperationsError::InvalidVehicleRole);
            }
        }
        VehicleRole::ControlCar => {
            if !unpowered || control_stands == ControlStandConfiguration::none() {
                return Err(OperationsError::InvalidVehicleRole);
            }
        }
        VehicleRole::Locomotive | VehicleRole::PoweredUnit => {
            if unpowered {
                return Err(OperationsError::InvalidVehicleRole);
            }
        }
    }
    Ok(())
}

fn has_baseline_protection(protection: &TrainProtection) -> bool {
    protection.contains(ProtectionSystem::Pzb)
        || protection.contains(ProtectionSystem::EtcsLevel1)
        || protection.contains(ProtectionSystem::EtcsLevel2)
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
    /// Seed-deterministische Ziehung gegen die berechnete Ausfallwahrscheinlichkeit.
    pub fn failure_occurs(&self, rules: &[MaintenanceRule], rng: &mut Rng) -> bool {
        rng.below(1_000_000) < u64::from(self.failure_probability_per_million(rules))
    }
    pub fn maintain(&mut self, level: MaintenanceLevel) {
        self.elapsed_seconds = 0;
        self.distance_km = 0;
        self.last_level = Some(level);
    }

    /// Schreibt Betrieb ganzzahlig fort.
    pub fn accrue(&mut self, elapsed_seconds: u64, distance_km: u64) {
        self.elapsed_seconds = self.elapsed_seconds.saturating_add(elapsed_seconds);
        self.distance_km = self.distance_km.saturating_add(distance_km);
    }
}

/// Gebuchter, kapazitätswirksamer Werkstattaufenthalt für eine Wartungsfrist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaintenanceOrder {
    pub world_id: WorldId,
    pub id: u64,
    pub vehicle_id: VehicleId,
    pub level: MaintenanceLevel,
    pub facility_id: FacilityId,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
    completed: bool,
}

impl MaintenanceOrder {
    /// Reserviert die Werkstatt nur für eine tatsächlich fällige Frist.
    #[allow(
        clippy::too_many_arguments,
        reason = "Wartungszustand, Fahrzeug und Anlage sind getrennte Domänenobjekte"
    )]
    pub fn schedule(
        world_id: WorldId,
        id: u64,
        vehicle_id: VehicleId,
        class: &FleetClass,
        length: Length,
        level: MaintenanceLevel,
        starts_at: SimTime,
        state: &MaintenanceState,
        rules: &[MaintenanceRule],
        facility_id: FacilityId,
        facilities: &FacilityCatalog,
        reservations: &mut FacilityLedger,
    ) -> Result<Self, OperationsError> {
        let rule = state
            .due(rules)
            .into_iter()
            .find(|rule| rule.level == level)
            .ok_or(OperationsError::MaintenanceNotDue)?;
        let ends_at = starts_at
            .checked_add(i64::from(rule.workshop_seconds))
            .ok_or(OperationsError::Overflow)?;
        let facility = facilities
            .facility(facility_id)
            .ok_or(OperationsError::UnknownFacility)?;
        if facility.kind() != FacilityKind::Workshop {
            return Err(OperationsError::NotAWorkshop);
        }
        reservations.reserve(
            FacilityReservation {
                world_id,
                id,
                vehicle_id,
                resource: ConflictResource::Facility(facility_id),
                starts_at,
                ends_at,
            },
            class,
            length,
            facilities,
        )?;
        Ok(Self {
            world_id,
            id,
            vehicle_id,
            level,
            facility_id,
            starts_at,
            ends_at,
            completed: false,
        })
    }

    /// Schließt eine fällige Wartung ab; vorher bleibt die Frist bestehen.
    pub fn complete(
        &mut self,
        at: SimTime,
        state: &mut MaintenanceState,
    ) -> Result<(), OperationsError> {
        if self.completed {
            return Err(OperationsError::MaintenanceAlreadyCompleted);
        }
        if at < self.ends_at {
            return Err(OperationsError::MaintenanceNotFinished);
        }
        state.maintain(self.level);
        self.completed = true;
        Ok(())
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
    engine: CapacityLedger,
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
        if self
            .reservations
            .contains_key(&(reservation.world_id, reservation.id))
        {
            return Err(OperationsError::DuplicateReservation);
        }
        self.engine
            .set_capacity(
                reservation.world_id,
                reservation.resource,
                facility.capacity(),
            )
            .map_err(|_| OperationsError::CapacityExhausted)?;
        let engine_reservation = ResourceReservation::new(
            reservation.world_id,
            reservation.id,
            reservation.resource,
            DeterministicSimTime::from_seconds(reservation.starts_at),
            DeterministicSimTime::from_seconds(reservation.ends_at),
        )
        .map_err(|_| OperationsError::InvalidInterval)?;
        self.engine
            .try_reserve(engine_reservation)
            .map_err(|_| OperationsError::CapacityExhausted)?;
        self.reservations
            .insert((reservation.world_id, reservation.id), reservation);
        Ok(())
    }

    /// Gemeinsame Konfliktengine, etwa für Rangierbelegungen derselben Ressource.
    pub const fn conflict_engine(&self) -> &CapacityLedger {
        &self.engine
    }

    /// Gibt eine Belegung in beiden Sichten frei.
    pub fn release(&mut self, world_id: WorldId, id: u64) -> Result<(), OperationsError> {
        self.engine
            .release(world_id, id)
            .map_err(|_| OperationsError::UnknownReservation)?;
        self.reservations
            .remove(&(world_id, id))
            .ok_or(OperationsError::UnknownReservation)?;
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
/// Zusatzfahrt als echte Fahrt in Konfliktprüfung und Simulationskern (M5.8).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtraRun {
    pub world_id: WorldId,
    pub id: u64,
    pub purpose: ExtraRunPurpose,
    pub formation_id: u64,
    pub personnel_pool_id: u64,
    pub cost_cents: i64,
    /// Materialisierte Fahrt für Simulation und Livemap.
    pub simulation_run: zugfolge_sim::TrainRun,
}
impl ExtraRun {
    pub fn validate(&self) -> Result<(), OperationsError> {
        if self.cost_cents < 0
            || self.simulation_run.world_id != self.world_id
            || self.simulation_run.id != self.id
            || self.simulation_run.category != zugfolge_sim::TrainCategory::EmptyStock
            || self.simulation_run.route.is_empty()
        {
            Err(OperationsError::IncompleteExtraRun)
        } else {
            Ok(())
        }
    }
}

/// Zweiphasiger Kostenport: Bei einem Trassenkonflikt wird die Vormerkung
/// verworfen; nach erfolgreicher Reservierung ist das Commit unfehlbar.
pub trait ExtraRunLedger {
    type Token;
    fn authorize(
        &mut self,
        world_id: WorldId,
        run_id: u64,
        amount_cents: i64,
    ) -> Result<Self::Token, OperationsError>;
    fn commit(&mut self, token: Self::Token);
    fn cancel(&mut self, token: Self::Token);
}

/// Registriert eine Zusatzfahrt atomar in Trasse, Personal und Kosten.
pub fn register_extra_run(
    extra: &ExtraRun,
    routed: &RoutedTrainRun,
    roster: &DutyRoster,
    occupations: &mut OccupationLedger,
    ledger: &mut impl ExtraRunLedger,
) -> Result<zugfolge_sim::Command, OperationsError> {
    extra.validate()?;
    let starts_at = extra
        .simulation_run
        .route
        .first()
        .map(|point| point.arrival)
        .ok_or(OperationsError::IncompleteExtraRun)?;
    let ends_at = extra
        .simulation_run
        .route
        .last()
        .map(|point| point.departure)
        .ok_or(OperationsError::IncompleteExtraRun)?;
    if !roster
        .duties(extra.personnel_pool_id)
        .iter()
        .any(|duty| duty.starts_at <= starts_at && duty.ends_at >= ends_at)
    {
        return Err(OperationsError::MissingExtraRunDuty);
    }
    let token = ledger.authorize(extra.world_id, extra.id, extra.cost_cents)?;
    if occupations.try_insert(routed).is_err() {
        ledger.cancel(token);
        return Err(OperationsError::ExtraRunRouteConflict);
    }
    ledger.commit(token);
    Ok(zugfolge_sim::Command::Materialize(
        extra.simulation_run.clone(),
    ))
}

/// Automatisch berechneter Rangierbedarf (M5.9); keine steuerbaren Bewegungen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShuntingRequirement {
    pub seconds: u32,
    pub resource: ConflictResource,
}

/// Quellenbasierte Simulationswerte für manuelles Kuppeln und Entkuppeln.
///
/// Die 180 Sekunden für das Kuppeln liegen im Bereich der gemessenen
/// 3:18 Minuten für einen Zugverband; 120 Sekunden für das Entkuppeln sind als
/// technischer Mindestwert aus einer veröffentlichten Betriebsstudie
/// übernommen. Fahrwegauflösung, Verständigung und Personalwege kommen
/// zusätzlich aus der jeweiligen Betriebsstelle.
pub const COUPLING_SECONDS: u32 = 180;
pub const UNCOUPLING_SECONDS: u32 = 120;
pub const RUNAROUND_SECONDS: u32 = 300;

/// Art der nach einer Änderung erforderlichen Bremsprobe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrakeTestKind {
    /// Keine Bremsprobe, etwa beim reinen Abhängen am Zugschluss.
    None,
    /// Vereinfachte Bremsprobe nach einer Zusammensetzungsänderung.
    Simplified,
    /// Volle Bremsprobe nach Inbetriebnahme oder maßgeblichem Führerstandswechsel.
    Full,
}

impl BrakeTestKind {
    /// Konservative, ganzzahlige Zeitannahme für die Simulation.
    pub fn seconds(self, vehicle_count: usize) -> Result<u32, OperationsError> {
        let vehicles = u32::try_from(vehicle_count).map_err(|_| OperationsError::Overflow)?;
        match self {
            Self::None => Ok(0),
            Self::Simplified => Ok(60_u32.saturating_add(vehicles.saturating_mul(30))),
            Self::Full => Ok(120_u32.saturating_add(vehicles.saturating_mul(45))),
        }
    }
}

/// Legt fest, ob eine Änderung eine Bremsprobe auslöst.
pub const fn required_brake_test(
    composition_changed: bool,
    leading_control_stand_changed: bool,
    only_rear_vehicle_detached: bool,
) -> BrakeTestKind {
    if only_rear_vehicle_detached && !leading_control_stand_changed {
        BrakeTestKind::None
    } else if leading_control_stand_changed {
        BrakeTestKind::Full
    } else if composition_changed {
        BrakeTestKind::Simplified
    } else {
        BrakeTestKind::None
    }
}

/// Zeitanteile eines Rangier- oder Formationsmanövers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormationManeuverTime {
    pub coupling_seconds: u32,
    pub uncoupling_seconds: u32,
    pub brake_test_seconds: u32,
    pub runaround_seconds: u32,
    pub total_seconds: u32,
}

/// Berechnet alle technischen Zeitanteile einer Formationsänderung.
pub fn calculate_formation_maneuver_time(
    vehicle_count: usize,
    couplings: u16,
    uncouplings: u16,
    brake_test: BrakeTestKind,
    runaround: bool,
) -> Result<FormationManeuverTime, OperationsError> {
    if vehicle_count == 0 {
        return Err(OperationsError::EmptyFormation);
    }
    let coupling_seconds = u32::from(couplings).saturating_mul(COUPLING_SECONDS);
    let uncoupling_seconds = u32::from(uncouplings).saturating_mul(UNCOUPLING_SECONDS);
    let brake_test_seconds = brake_test.seconds(vehicle_count)?;
    let runaround_seconds = if runaround { RUNAROUND_SECONDS } else { 0 };
    let total_seconds = coupling_seconds
        .saturating_add(uncoupling_seconds)
        .saturating_add(brake_test_seconds)
        .saturating_add(runaround_seconds);
    Ok(FormationManeuverTime {
        coupling_seconds,
        uncoupling_seconds,
        brake_test_seconds,
        runaround_seconds,
        total_seconds,
    })
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
    let handling = calculate_formation_maneuver_time(
        vehicle_count,
        coupling_changes,
        0,
        BrakeTestKind::None,
        false,
    )?;
    Ok(ShuntingRequirement {
        seconds: 120_u32
            .saturating_add(vehicles.saturating_sub(1).saturating_mul(90))
            .saturating_add(handling.total_seconds),
        resource,
    })
}

/// Reserviert den automatisch berechneten Rangieraufwand in derselben
/// Konfliktengine wie Anlagen und Bahnhofsköpfe.
pub fn reserve_shunting(
    ledger: &mut CapacityLedger,
    world_id: WorldId,
    reservation_id: u64,
    starts_at: SimTime,
    requirement: &ShuntingRequirement,
) -> Result<(), OperationsError> {
    let ends_at = starts_at
        .checked_add(i64::from(requirement.seconds))
        .ok_or(OperationsError::Overflow)?;
    let reservation = ResourceReservation::new(
        world_id,
        reservation_id,
        requirement.resource,
        DeterministicSimTime::from_seconds(starts_at),
        DeterministicSimTime::from_seconds(ends_at),
    )
    .map_err(|_| OperationsError::InvalidInterval)?;
    ledger
        .try_reserve(reservation)
        .map_err(|_| OperationsError::CapacityExhausted)
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

/// Nachweis der Automatikgüte gegenüber derselben manuellen Planung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AutomationQuality {
    /// Güte in Promille; 850 entspricht 85 Prozent.
    pub permille: u16,
    /// Ob das in M5.10 verlangte Mindestziel von 85 Prozent erreicht ist.
    pub target_reached: bool,
}

/// Vergleicht Kosten bei identischer Leistung; niedrigere Kosten sind besser.
pub fn assess_automation_quality(
    automatic_cost_cents: i64,
    manual_cost_cents: i64,
) -> Result<AutomationQuality, OperationsError> {
    if automatic_cost_cents <= 0 || manual_cost_cents <= 0 {
        return Err(OperationsError::InvalidQualityComparison);
    }
    let permille = u16::try_from(
        manual_cost_cents
            .saturating_mul(1_000)
            .checked_div(automatic_cost_cents)
            .unwrap_or(0)
            .min(1_000),
    )
    .unwrap_or(1_000);
    Ok(AutomationQuality {
        permille,
        target_reached: permille >= 850,
    })
}

/// Leitet den Qualitätsnachweis aus zwei tatsächlich geplanten Varianten ab.
/// Beide Varianten müssen denselben Bedarf decken; bloße Kostenzahlen ohne
/// fachlich identische Leistung sind kein belastbarer M5.10-Nachweis.
pub fn assess_supply_plan_quality(
    automatic: &SupplyPlan,
    manual: &[SupplyCandidate],
) -> Result<AutomationQuality, OperationsError> {
    let automatic_need = automatic
        .selected
        .iter()
        .try_fold(0_u64, |sum, candidate| {
            sum.checked_add(candidate.need_reduction)
        })
        .ok_or(OperationsError::Overflow)?;
    let manual_need = manual
        .iter()
        .try_fold(0_u64, |sum, candidate| {
            sum.checked_add(candidate.need_reduction)
        })
        .ok_or(OperationsError::Overflow)?;
    if automatic_need == 0 || automatic_need != manual_need {
        return Err(OperationsError::InvalidQualityComparison);
    }
    let automatic_cost = automatic
        .selected
        .iter()
        .try_fold(0_i64, |sum, candidate| {
            sum.checked_add(candidate.cost_cents)
        })
        .ok_or(OperationsError::Overflow)?;
    let manual_cost = manual
        .iter()
        .try_fold(0_i64, |sum, candidate| {
            sum.checked_add(candidate.cost_cents)
        })
        .ok_or(OperationsError::Overflow)?;
    assess_automation_quality(automatic_cost, manual_cost)
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

/// Obergrenzen für die vor einer Fahrplanfreigabe zulässigen Fahrzeugbedarfe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NeedLimits {
    pub energy_milli: u64,
    pub sand_milli: u64,
    pub fresh_water_milli: u64,
    pub waste_milli: u64,
    pub interior_soil: u64,
    pub exterior_soil: u64,
}

impl NeedLimits {
    fn accepts(self, needs: VehicleNeeds) -> bool {
        needs.energy_milli <= self.energy_milli
            && needs.sand_milli <= self.sand_milli
            && needs.fresh_water_milli <= self.fresh_water_milli
            && needs.waste_milli <= self.waste_milli
            && needs.interior_soil <= self.interior_soil
            && needs.exterior_soil <= self.exterior_soil
    }
}

/// Für die Freigabe benötigter Wartungs- und Versorgungszustand.
#[derive(Clone, Copy, Debug)]
pub struct VehicleReadiness<'a> {
    pub vehicle_id: VehicleId,
    pub maintenance: &'a MaintenanceState,
    pub maintenance_rules: &'a [MaintenanceRule],
    pub needs: VehicleNeeds,
    pub limits: NeedLimits,
}

/// Minimaler Leistungsbezug für die typisierte M5.13-Freigabe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlannedService {
    pub formation_id: u64,
    pub personnel_pool_id: u64,
    pub starts_at: SimTime,
    pub ends_at: SimTime,
}

/// Verhindert eine Fahrplanfreigabe ohne deckenden Umlauf, Personaldienst,
/// fristgerechtes Fahrzeug und ausreichende Versorgung.
pub fn validate_timetable_release(
    services: &[PlannedService],
    rotations: &RotationPlan,
    roster: &DutyRoster,
    readiness: &[VehicleReadiness<'_>],
) -> Result<(), OperationsError> {
    for service in services {
        if service.starts_at < 0 || service.ends_at <= service.starts_at {
            return Err(OperationsError::InvalidInterval);
        }
        let has_rotation = rotations.legs(service.formation_id).iter().any(|leg| {
            leg.activity == RotationActivity::Service
                && leg.starts_at <= service.starts_at
                && leg.ends_at >= service.ends_at
        });
        if !has_rotation {
            return Err(OperationsError::MissingRotation);
        }
        let has_duty = roster
            .duties(service.personnel_pool_id)
            .iter()
            .any(|duty| duty.starts_at <= service.starts_at && duty.ends_at >= service.ends_at);
        if !has_duty {
            return Err(OperationsError::MissingPersonnelDuty);
        }
        let vehicle = readiness
            .iter()
            .find(|vehicle| vehicle.vehicle_id == service.formation_id)
            .ok_or(OperationsError::MissingVehicleReadiness)?;
        if !vehicle
            .maintenance
            .due(vehicle.maintenance_rules)
            .is_empty()
        {
            return Err(OperationsError::MaintenanceOverdue);
        }
        if !vehicle.limits.accepts(vehicle.needs) {
            return Err(OperationsError::SupplyNeedsExceeded);
        }
    }
    Ok(())
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

/// Überführt das Ergebnis der Automatik in reale Anlagenbelegungen und wendet
/// die jeweilige Versorgungsleistung am Fahrzeugzustand an.
#[allow(
    clippy::too_many_arguments,
    reason = "Plan, Fahrzeug, Anlage und Welt sind unabhängige Domänenwerte"
)]
pub fn commit_supply_plan(
    plan: &SupplyPlan,
    world_id: WorldId,
    first_reservation_id: u64,
    vehicle_id: VehicleId,
    class: &FleetClass,
    length: Length,
    facilities: &FacilityCatalog,
    reservations: &mut FacilityLedger,
    needs: &mut VehicleNeeds,
) -> Result<(), OperationsError> {
    let original_needs = *needs;
    let mut inserted = Vec::new();
    for (offset, candidate) in plan.selected.iter().enumerate() {
        let offset = u64::try_from(offset).map_err(|_| OperationsError::Overflow)?;
        let id = first_reservation_id
            .checked_add(offset)
            .ok_or(OperationsError::Overflow)?;
        let facility = facilities
            .facility(candidate.facility_id)
            .ok_or(OperationsError::UnknownFacility)?;
        if let Err(error) = reservations.reserve(
            FacilityReservation {
                world_id,
                id,
                vehicle_id,
                resource: ConflictResource::Facility(candidate.facility_id),
                starts_at: candidate.starts_at,
                ends_at: candidate.ends_at,
            },
            class,
            length,
            facilities,
        ) {
            for id in inserted {
                let _ = reservations.release(world_id, id);
            }
            *needs = original_needs;
            return Err(error);
        }
        inserted.push(id);
        needs.apply(facility.kind());
    }
    Ok(())
}

/// Kostenport für die verbindliche Beschaffung in Integer-Cent.
pub trait ProcurementLedger {
    fn debit_procurement(
        &mut self,
        world_id: WorldId,
        order_id: u64,
        amount_cents: i64,
    ) -> Result<(), OperationsError>;
}

/// Verbindliche Bestellung mit Lieferereignis statt sofortigem Fahrzeug.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcurementOrder {
    pub world_id: WorldId,
    pub id: u64,
    pub offer: ProcurementOffer,
    pub price_cents: i64,
    pub ordered_configuration: InteriorConfiguration,
    delivered: bool,
}

impl ProcurementOrder {
    /// Belastet das Ledger, bevor die Bestellung entsteht.
    pub fn place(
        world_id: WorldId,
        id: u64,
        offer: ProcurementOffer,
        price_cents: i64,
        ordered_configuration: Option<InteriorConfiguration>,
        ledger: &mut impl ProcurementLedger,
    ) -> Result<Self, OperationsError> {
        if price_cents < 0 {
            return Err(OperationsError::InvalidProcurementPrice);
        }
        let configuration = if offer.configurable {
            ordered_configuration.ok_or(OperationsError::ExistingConfigurationRequired)?
        } else {
            let fixed = offer
                .interior
                .clone()
                .ok_or(OperationsError::ExistingConfigurationRequired)?;
            if ordered_configuration
                .as_ref()
                .is_some_and(|requested| requested != &fixed)
            {
                return Err(OperationsError::SecondaryConfigurationImmutable);
            }
            fixed
        };
        configuration
            .validate()
            .map_err(|_| OperationsError::InvalidProcurementConfiguration)?;
        ledger.debit_procurement(world_id, id, price_cents)?;
        Ok(Self {
            world_id,
            id,
            offer,
            price_cents,
            ordered_configuration: configuration,
            delivered: false,
        })
    }

    /// Liefert genau einmal zum zugesagten Zeitpunkt.
    pub fn deliver(&mut self, at: SimTime) -> Result<InteriorConfiguration, OperationsError> {
        if at < self.offer.available_at {
            return Err(OperationsError::ProcurementNotDue);
        }
        if self.delivered {
            return Err(OperationsError::ProcurementAlreadyDelivered);
        }
        self.delivered = true;
        Ok(self.ordered_configuration.clone())
    }
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
    TechnicalDataMismatch,
    InvalidVehicleRole,
    NoPropulsion,
    MissingFormationDynamics,
    MissingPlatform,
    IncompatibleElectrification,
    MaintenanceNotDue,
    MaintenanceAlreadyCompleted,
    MaintenanceNotFinished,
    NotAWorkshop,
    UnknownReservation,
    MissingExtraRunDuty,
    ExtraRunRouteConflict,
    LedgerRejected,
    InvalidQualityComparison,
    InvalidProcurementPrice,
    SecondaryConfigurationImmutable,
    InvalidProcurementConfiguration,
    ProcurementNotDue,
    ProcurementAlreadyDelivered,
    MissingRotation,
    MissingPersonnelDuty,
    MissingVehicleReadiness,
    MaintenanceOverdue,
    SupplyNeedsExceeded,
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
    use zugfolge_conflict::{
        OccupationLedger, TrainCategory as RoutedCategory, TrainNumber, TrainRun as RoutedRun,
        derive_occupation_profile,
        example::{nordstadt_bis_talheim, reference_infrastructure, regional_train},
    };
    use zugfolge_determinism::SimTime as RoutedTime;
    use zugfolge_infra::{ElectricSystems, PowerSystem, ProtectionSystem};

    fn formation_vehicle(
        id: VehicleId,
        traction: TractionType,
        role: VehicleRole,
        control_stands: ControlStandConfiguration,
    ) -> FormationVehicle {
        let powered = traction != TractionType::Unpowered;
        FormationVehicle {
            world_id: 1,
            id,
            vehicle_type_id: 1,
            class: FleetClass::new("ET1").expect("Testbaureihe"),
            length: Length::from_metres(25),
            mass: Mass::from_tonnes(45),
            max_speed: Speed::from_km_h(160),
            acceleration: Acceleration::from_millimetres_per_second_squared(500),
            deceleration: Acceleration::from_millimetres_per_second_squared(700),
            traction,
            role,
            control_stands,
            continuous_power: if powered {
                Power::from_kilowatts(2_000)
            } else {
                Power::ZERO
            },
            starting_tractive_effort: if powered {
                Force::from_kilonewtons(200)
            } else {
                Force::ZERO
            },
            brake_weight: Mass::from_tonnes(45),
            protection: TrainProtection::single(ProtectionSystem::Pzb),
        }
    }

    #[test]
    fn wagenpark_ohne_lok_ist_gueltig_aber_nicht_eigenfahrfaehig() {
        let coach = formation_vehicle(
            1,
            TractionType::Unpowered,
            VehicleRole::Coach,
            ControlStandConfiguration::none(),
        );
        let parking = Formation::new(1, 1, vec![coach]).expect("Wagenpark darf abgestellt werden");
        assert!(parking.requires_external_locomotive());
        assert!(!parking.can_move_under_own_power());
        assert_eq!(
            parking
                .characteristics(TrainCharacteristicsId::new(1), "Wagenpark")
                .expect_err("Wagenpark darf keine Zugcharakteristik bilden"),
            OperationsError::NoPropulsion
        );
    }

    #[test]
    fn steuerwagen_ermoeglicht_wenden_ohne_lok_umsetzen() {
        let locomotive = formation_vehicle(
            1,
            TractionType::Diesel,
            VehicleRole::Locomotive,
            ControlStandConfiguration {
                front: true,
                rear: false,
            },
        );
        let mut coach = formation_vehicle(
            2,
            TractionType::Unpowered,
            VehicleRole::Coach,
            ControlStandConfiguration::none(),
        );
        coach.max_speed = Speed::from_km_h(120);
        let control_car = formation_vehicle(
            3,
            TractionType::Unpowered,
            VehicleRole::ControlCar,
            ControlStandConfiguration {
                front: false,
                rear: true,
            },
        );
        let with_control_car = Formation::new(1, 2, vec![locomotive.clone(), coach, control_car])
            .expect("Lok-Wagen-Steuerwagen-Formation");
        assert!(with_control_car.supports_direct_reversal());
        assert!(!with_control_car.requires_locomotive_runaround());
        assert_eq!(
            with_control_car
                .characteristics(TrainCharacteristicsId::new(2), "Wendezug")
                .expect("Zugcharakteristik")
                .max_speed()
                .km_h(),
            120
        );
        let characteristics = with_control_car
            .characteristics(TrainCharacteristicsId::new(2), "Wendezug")
            .expect("Zugcharakteristik");
        assert_eq!(characteristics.continuous_power().kilowatts(), 2_000);
        assert_eq!(
            characteristics.starting_tractive_effort().kilonewtons(),
            200
        );
        assert_eq!(characteristics.brake_weight().kilograms(), 135_000);

        let without_control_car = Formation::new(
            1,
            3,
            vec![
                locomotive,
                formation_vehicle(
                    4,
                    TractionType::Unpowered,
                    VehicleRole::Coach,
                    ControlStandConfiguration::none(),
                ),
            ],
        )
        .expect("Lok-Wagen-Formation");
        assert!(!without_control_car.supports_direct_reversal());
        assert!(without_control_car.requires_locomotive_runaround());
    }

    #[test]
    fn reisezugwagen_benoetigen_keine_eigene_zugsicherung() {
        let locomotive = formation_vehicle(
            1,
            TractionType::Diesel,
            VehicleRole::Locomotive,
            ControlStandConfiguration::both_ends(),
        );
        let mut coach = formation_vehicle(
            2,
            TractionType::Unpowered,
            VehicleRole::Coach,
            ControlStandConfiguration::none(),
        );
        coach.protection = TrainProtection::unprotected();
        let formation = Formation::new(1, 4, vec![locomotive, coach]).expect("Lok-Wagen-Formation");
        let approved = BTreeSet::from([FleetClass::new("ET1").expect("Testbaureihe")]);
        formation
            .check_route(
                Length::from_metres(100),
                &TrainProtection::single(ProtectionSystem::Pzb),
                &approved,
            )
            .expect("Die Lok stellt die Zugsicherung fuer den Wagenpark");
    }

    #[test]
    fn fuehrendes_fahrzeug_benoetigt_pzb_oder_etcs() {
        let mut control_car = formation_vehicle(
            1,
            TractionType::Unpowered,
            VehicleRole::ControlCar,
            ControlStandConfiguration {
                front: true,
                rear: false,
            },
        );
        control_car.protection = TrainProtection::unprotected();
        assert_eq!(
            Formation::new(1, 6, vec![control_car]).expect_err("Steuerwagen ohne Sicherung"),
            OperationsError::MissingProtection
        );
    }

    #[test]
    fn etcs_darf_ohne_pzb_verbaut_sein() {
        let mut locomotive = formation_vehicle(
            1,
            TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
            VehicleRole::Locomotive,
            ControlStandConfiguration::both_ends(),
        );
        locomotive.protection = TrainProtection::single(ProtectionSystem::EtcsLevel2);
        Formation::new(1, 7, vec![locomotive]).expect("ETCS-only ist zulaessig");
    }

    #[test]
    fn unpowered_coach_darf_ohne_eigenen_fahrdynamikwert_gebildet_werden() {
        let locomotive = formation_vehicle(
            1,
            TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
            VehicleRole::Locomotive,
            ControlStandConfiguration::both_ends(),
        );
        let mut coach = formation_vehicle(
            2,
            TractionType::Unpowered,
            VehicleRole::Coach,
            ControlStandConfiguration::none(),
        );
        coach.acceleration = Acceleration::default();
        coach.deceleration = Acceleration::default();
        coach.protection = TrainProtection::unprotected();
        let formation = Formation::new(1, 5, vec![locomotive, coach])
            .expect("Steuerungs- und Rollenregeln bleiben erfüllt");
        formation
            .characteristics(TrainCharacteristicsId::new(5), "Lok-Wagen-Zug")
            .expect("Der Wagen wird über Bremsgewicht und die Lok-Dynamik geführt");
    }

    #[test]
    fn rohe_lokdaten_benoetigen_ein_formationsbezogenes_fahrprofil() {
        let mut locomotive = formation_vehicle(
            1,
            TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
            VehicleRole::Locomotive,
            ControlStandConfiguration::both_ends(),
        );
        locomotive.acceleration = Acceleration::default();
        locomotive.deceleration = Acceleration::default();
        let coach = formation_vehicle(
            2,
            TractionType::Unpowered,
            VehicleRole::Coach,
            ControlStandConfiguration::none(),
        );
        let formation = Formation::new(1, 8, vec![locomotive, coach])
            .expect("Lok-Wagen-Formation bleibt als Bestand zulässig");

        assert_eq!(
            formation
                .characteristics(TrainCharacteristicsId::new(8), "ohne Fahrprofil")
                .expect_err("eine Lok hat keine feste Beschleunigung"),
            OperationsError::MissingFormationDynamics
        );

        let characteristics = formation
            .characteristics_with_dynamics(
                TrainCharacteristicsId::new(8),
                "mit Fahrprofil",
                FormationDynamics::new(
                    Acceleration::from_millimetres_per_second_squared(600),
                    Acceleration::from_millimetres_per_second_squared(700),
                )
                .expect("vollständiges Fahrprofil"),
            )
            .expect("formationsbezogene Fahrdynamik ist ausreichend");
        assert_eq!(
            characteristics.acceleration(),
            Acceleration::from_millimetres_per_second_squared(600)
        );
        assert_eq!(
            characteristics.deceleration(),
            Acceleration::from_millimetres_per_second_squared(700)
        );
    }

    #[test]
    fn rangierzeit_enthaelt_kuppeln_entkuppeln_umsetzen_und_bremsprobe() {
        let timing = calculate_formation_maneuver_time(8, 1, 1, BrakeTestKind::Simplified, true)
            .expect("gueltige Rangierzeit");
        assert_eq!(timing.coupling_seconds, 180);
        assert_eq!(timing.uncoupling_seconds, 120);
        assert_eq!(timing.brake_test_seconds, 300);
        assert_eq!(timing.runaround_seconds, 300);
        assert_eq!(timing.total_seconds, 900);
        assert_eq!(
            required_brake_test(true, false, false),
            BrakeTestKind::Simplified
        );
        assert_eq!(required_brake_test(true, true, false), BrakeTestKind::Full);
        assert_eq!(required_brake_test(true, false, true), BrakeTestKind::None);
    }

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

    #[derive(Default)]
    struct TestExtraLedger {
        authorized: bool,
        committed: bool,
        cancelled: bool,
    }
    impl ExtraRunLedger for TestExtraLedger {
        type Token = u64;
        fn authorize(
            &mut self,
            _: WorldId,
            run_id: u64,
            amount: i64,
        ) -> Result<u64, OperationsError> {
            if amount < 0 {
                return Err(OperationsError::LedgerRejected);
            }
            self.authorized = true;
            Ok(run_id)
        }
        fn commit(&mut self, _: u64) {
            self.committed = true;
        }
        fn cancel(&mut self, _: u64) {
            self.cancelled = true;
        }
    }

    #[test]
    fn zusatzfahrt_wird_als_echter_zug_reserviert_und_materialisiert() {
        let infrastructure = reference_infrastructure();
        let itinerary = nordstadt_bis_talheim(&infrastructure);
        let profile =
            derive_occupation_profile(&infrastructure, &itinerary, &regional_train()).unwrap();
        let routed = RoutedRun::new(
            TrainNumber::new(RoutedCategory::Supplementary, 80_001).unwrap(),
            RoutedTime::from_seconds(1_000),
            &profile,
        );
        let mut occupations = OccupationLedger::new(infrastructure.exclusions().clone());
        let class = FleetClass::new("442").unwrap();
        let pool = PersonnelPool {
            world_id: 1,
            id: 7,
            capacity_seconds: 3_600,
            minimum_rest_seconds: 0,
            classes: BTreeSet::from([class.clone()]),
            routes: BTreeSet::from([9]),
        };
        let mut roster = DutyRoster::default();
        roster
            .assign(
                &pool,
                Duty {
                    pool_id: 7,
                    starts_at: 900,
                    ends_at: 2_000,
                    class,
                    route_id: 9,
                },
            )
            .unwrap();
        let run = zugfolge_sim::TrainRun {
            world_id: 1,
            id: 42,
            region_id: 1,
            operator: "EVU".into(),
            train_number: "Lr 80001".into(),
            category: zugfolge_sim::TrainCategory::EmptyStock,
            route: vec![
                zugfolge_sim::Waypoint {
                    operating_point: "A".into(),
                    position_mm: 0,
                    arrival: 1_000,
                    minimum_dwell_seconds: 0,
                    departure: 1_000,
                },
                zugfolge_sim::Waypoint {
                    operating_point: "B".into(),
                    position_mm: 1_000,
                    arrival: 1_100,
                    minimum_dwell_seconds: 0,
                    departure: 1_100,
                },
            ],
            next_waypoint: 0,
            delay_seconds: 0,
            position_mm: 0,
            speed_mm_per_second: 0,
            status: zugfolge_sim::OperatingStatus::Planned,
        };
        let extra = ExtraRun {
            world_id: 1,
            id: 42,
            purpose: ExtraRunPurpose::Supply,
            formation_id: 3,
            personnel_pool_id: 7,
            cost_cents: 500,
            simulation_run: run,
        };
        let mut ledger = TestExtraLedger::default();
        let command =
            register_extra_run(&extra, &routed, &roster, &mut occupations, &mut ledger).unwrap();
        assert!(matches!(command, zugfolge_sim::Command::Materialize(run) if run.id == 42));
        assert!(ledger.authorized && ledger.committed && !ledger.cancelled);
        assert_eq!(occupations.run_count(), 1);
    }

    #[test]
    fn automatik_beweist_eine_dreiwoechige_periode_ohne_sperre() {
        let class = FleetClass::new("442").unwrap();
        let pool = PersonnelPool {
            world_id: 1,
            id: 1,
            capacity_seconds: 3_600,
            minimum_rest_seconds: 0,
            classes: BTreeSet::from([class.clone()]),
            routes: BTreeSet::from([1]),
        };
        let mut roster = DutyRoster::default();
        let mut rotations = RotationPlan::default();
        let mut maintenance = MaintenanceState {
            elapsed_seconds: 0,
            distance_km: 0,
            last_level: None,
        };
        let rules = [MaintenanceRule {
            level: MaintenanceLevel::Inspection,
            interval_seconds: 7 * 86_400,
            interval_km: 10_000,
            workshop_seconds: 600,
            base_failure_per_million: 100,
        }];
        let mut needs = VehicleNeeds::default();
        let limits = NeedLimits {
            energy_milli: 500,
            sand_milli: 500,
            fresh_water_milli: 500,
            waste_milli: 500,
            interior_soil: 500,
            exterior_soil: 500,
        };
        let mut automatic_plans = Vec::new();
        let mut manual_selections = Vec::new();
        for day in 0_i64..21 {
            let start = day * 86_400 + 1_000;
            if !maintenance.due(&rules).is_empty() {
                maintenance.maintain(MaintenanceLevel::Inspection);
            }
            if needs.energy_milli > 400 || needs.waste_milli > 400 {
                let facility = FacilityId::new(1);
                let manual = SupplyCandidate {
                    facility_id: FacilityId::new(2),
                    location_id: 2,
                    starts_at: start - 600,
                    ends_at: start - 300,
                    need_reduction: 1_000,
                    deadhead_seconds: 0,
                    cost_cents: 88,
                };
                let plan = plan_supply(
                    vec![
                        SupplyCandidate {
                            facility_id: facility,
                            location_id: 1,
                            starts_at: start - 600,
                            ends_at: start - 300,
                            need_reduction: 1_000,
                            deadhead_seconds: 0,
                            cost_cents: 100,
                        },
                        manual.clone(),
                    ],
                    &SupplyPreferences {
                        preferred_facilities: vec![facility],
                        ..SupplyPreferences::default()
                    },
                    999,
                );
                assert_eq!(plan.selected.len(), 1);
                automatic_plans.push(plan);
                manual_selections.push(manual);
                needs.apply(FacilityKind::TreatmentPlant);
            }
            let from = u64::try_from(day % 2).unwrap();
            rotations
                .add(RotationLeg {
                    formation_id: 1,
                    location_from: from,
                    location_to: 1 - from,
                    starts_at: start,
                    ends_at: start + 100,
                    activity: RotationActivity::Service,
                })
                .unwrap();
            roster
                .assign(
                    &pool,
                    Duty {
                        pool_id: 1,
                        starts_at: start,
                        ends_at: start + 100,
                        class: class.clone(),
                        route_id: 1,
                    },
                )
                .unwrap();
            let readiness = VehicleReadiness {
                vehicle_id: 1,
                maintenance: &maintenance,
                maintenance_rules: &rules,
                needs,
                limits,
            };
            validate_timetable_release(
                &[PlannedService {
                    formation_id: 1,
                    personnel_pool_id: 1,
                    starts_at: start,
                    ends_at: start + 100,
                }],
                &rotations,
                &roster,
                &[readiness],
            )
            .unwrap();
            maintenance.accrue(86_400, 300);
            needs.accrue(
                NeedRates {
                    energy_per_km: 1,
                    sand_per_braking: 1,
                    water_per_passenger_hour: 1,
                    waste_per_passenger_hour: 2,
                    interior_per_passenger_hour: 1,
                    exterior_per_hour: 1,
                },
                300,
                10,
                100,
                5,
            );
        }
        let automatic = SupplyPlan {
            selected: automatic_plans
                .into_iter()
                .flat_map(|plan| plan.selected)
                .collect(),
            score: 0,
            optimum_bound: 0,
            gap: OptimizationGap {
                absolute: 0,
                permille: 0,
                largest_lever: None,
            },
        };
        let quality = assess_supply_plan_quality(&automatic, &manual_selections).unwrap();
        assert_eq!(quality.permille, 880);
        assert!(quality.target_reached);
    }

    #[derive(Default)]
    struct TestProcurementLedger {
        debits: Vec<(WorldId, u64, i64)>,
    }
    impl ProcurementLedger for TestProcurementLedger {
        fn debit_procurement(
            &mut self,
            world: WorldId,
            order: u64,
            amount: i64,
        ) -> Result<(), OperationsError> {
            self.debits.push((world, order, amount));
            Ok(())
        }
    }

    #[test]
    fn beschaffung_bucht_und_liefert_nicht_vorzeitig() {
        let offer = procurement_offer(
            1,
            ProcurementChannel::NewBuild,
            1_000,
            1_000,
            ProcurementLeadTimes {
                used_seconds: 100,
                new_build_periods: 3,
            },
            Some(interior()),
        )
        .unwrap();
        let mut ledger = TestProcurementLedger::default();
        let mut order =
            ProcurementOrder::place(1, 9, offer, 1_000_000, Some(interior()), &mut ledger).unwrap();
        assert_eq!(ledger.debits, vec![(1, 9, 1_000_000)]);
        assert_eq!(
            order.deliver(3_999),
            Err(OperationsError::ProcurementNotDue)
        );
        assert_eq!(order.deliver(4_000).unwrap(), interior());
        assert_eq!(
            order.deliver(4_001),
            Err(OperationsError::ProcurementAlreadyDelivered)
        );
    }
}
