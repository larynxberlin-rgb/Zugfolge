//! Exakte, ereignisgesteuerte Betriebswirklichkeit der LiveMap-Engine.
//!
//! Dieses Modul ist der harte v2-Schnitt: Position, Belegung, Stellwerk,
//! Fahrberechtigung, FDL, Lokfuehrer, Rangieren und die beiden oeffentlichen
//! Projektionen lesen und schreiben denselben [`OperationalWorld`]. Es gibt
//! keinen Schaetzpfad. Nicht beweisbare Zustaende enden in [`MotionState::SafeStop`].

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use zugfolge_determinism::{StateHash, StateHasher};

mod passenger_stops;
use passenger_stops::ScheduledPassengerDeparture;
pub use passenger_stops::{
    MAX_PASSENGER_STOPS_PER_TRAIN, OperationalPassengerStop, OperationalPassengerStopFact,
    OperationalPassengerStopPlan, OperationalPassengerStopProgress,
    OperationalPassengerStopReceipt,
};
mod service_outcomes;
use service_outcomes::ServiceOutcomeState;
pub use service_outcomes::{
    ServiceConnectionAssessment, ServiceOutcomeBinding, ServiceOutcomePolicy,
    ServiceOutcomeProgress, ServiceVehicleCapacity,
};

/// Millisekunden seit der unveraenderlichen Weltepoche.
pub type SimMillis = i64;
/// Millimeter entlang eines unveraenderlichen Laufwegs.
pub type RouteMillimetres = i64;

/// Projektionsgueltigkeit fuer den produktiven 60-s-Scheduler plus 15-s-Marge.
pub const OPERATIONAL_PROJECTION_VALIDITY_MS: SimMillis = 75_000;
/// Harte Obergrenze fuer noch nicht von der Runtime abgenommene Fachereignisse.
pub const MAX_PENDING_OPERATIONAL_EVENTS: usize = 16_384;
/// Begrenztes Replay-Suffix abgeschlossener physischer Fortsetzungen.
pub const MAX_COMPLETED_MOVEMENT_CONTINUATION_RECEIPTS: usize = 1_024;
/// Versionierter Fachvertrag in docs/betriebsengine.md, Abschnitt 5.
pub const OPERATIONAL_MOTION_POLICY: &str = "operational-motion/v1";
/// 25 km/h, konservativ auf ganze mm/s abgerundet.
pub const SHUNTING_MAXIMUM_SPEED_MMPS: u32 = 6_944;

/// Deterministische Rundung fuer die analytische Bewegung.
///
/// Positive Zwischenwerte werden zur naechsten ganzen Zahl gerundet, exakte
/// Halben vom Nullpunkt weg. Negative Werte werden symmetrisch behandelt.
fn div_round_half_away(numerator: i128, denominator: i128) -> i128 {
    debug_assert!(denominator > 0);
    if numerator >= 0 {
        numerator.saturating_add(denominator / 2) / denominator
    } else {
        numerator.saturating_sub(denominator / 2) / denominator
    }
}

fn checked_i64(value: i128) -> Result<i64, OperationalError> {
    i64::try_from(value).map_err(|_| OperationalError::ArithmeticOverflow)
}

/// Art einer betrieblichen Bewegung.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MovementKind {
    Train,
    Shunting,
}

/// Zustand der exakten Bewegung.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MotionState {
    Standing,
    Moving,
    SafeStop { reason: String },
}

/// Kompakter öffentlicher Bewegungsstatus; der konkrete Haltegrund bleibt separat.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectedMotionState {
    Standing,
    Moving,
    SafeStop,
}

impl From<&MotionState> for ProjectedMotionState {
    fn from(value: &MotionState) -> Self {
        match value {
            MotionState::Standing => Self::Standing,
            MotionState::Moving => Self::Moving,
            MotionState::SafeStop { .. } => Self::SafeStop,
        }
    }
}

/// Richtung auf einer konkreten Gleiskante.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    Along,
    Against,
}

pub const PROTECTION_MODE_SELECTION_POLICY_V1: &str =
    "zugfolge-protection-mode-selection/conservative-v1";

const KNOWN_PROTECTION_SYSTEMS: [&str; 4] = ["etcs-level1", "etcs-level2", "lzb", "pzb"];
const CONSERVATIVE_PROTECTION_MODE_PRIORITY_V1: [&str; 4] =
    ["pzb", "lzb", "etcs-level1", "etcs-level2"];

/// Kanonische Lauflaengencodierung einer Moduswahl. Der erste Lauf beginnt bei
/// Leg 0, jeder weitere direkt hinter dem vorherigen Ende.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectionModeSelectionRun {
    pub through_route_leg_index: usize,
    pub selected_protection_system: String,
}

/// Ein Abschnitt eines vollstaendig validierten, gerichteten Laufwegs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteLeg {
    pub edge_id: String,
    pub direction: Direction,
    pub edge_entry_mm: i64,
    pub edge_exit_mm: i64,
    pub route_start_mm: RouteMillimetres,
    pub block_ids: BTreeSet<String>,
    pub speed_limit_mmps: u32,
    pub gradient_per_mille: i16,
    /// Alternative, auf diesem Leg streckenseitig nutzbare Betriebsmodi.
    pub available_protection_systems: Vec<String>,
    /// Systeme, die unabhaengig vom ausgewaehlten Betriebsmodus gemeinsam in
    /// der aktiven Zugspitze vorhanden sein muessen.
    pub simultaneously_required_protection_systems: Vec<String>,
}

impl RouteLeg {
    pub fn length_mm(&self) -> i64 {
        self.edge_exit_mm
            .abs_diff(self.edge_entry_mm)
            .try_into()
            .unwrap_or(i64::MAX)
    }

    pub fn route_end_mm(&self) -> i64 {
        self.route_start_mm.saturating_add(self.length_mm())
    }
}

/// Unveraenderliche Laufwegversion. Eine Umleitung erzeugt eine neue Instanz.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteVersion {
    pub id: String,
    pub template_id: String,
    pub predecessor_id: Option<String>,
    pub transition_route_mm: Option<RouteMillimetres>,
    pub legs: Vec<RouteLeg>,
}

impl RouteVersion {
    pub fn validate(&self) -> Result<(), OperationalError> {
        if self.id.is_empty() || self.template_id.is_empty() || self.legs.is_empty() {
            return Err(OperationalError::IncompleteRoute(self.id.clone()));
        }
        let mut expected = 0_i64;
        for leg in &self.legs {
            let direction_matches_offsets = match leg.direction {
                Direction::Along => leg.edge_exit_mm > leg.edge_entry_mm,
                Direction::Against => leg.edge_exit_mm < leg.edge_entry_mm,
            };
            if leg.edge_id.is_empty()
                || leg.length_mm() <= 0
                || !direction_matches_offsets
                || leg.route_start_mm != expected
                || leg.speed_limit_mmps == 0
                || !(-100..=100).contains(&leg.gradient_per_mille)
                || leg.block_ids.is_empty()
                || !canonical_protection_systems(&leg.available_protection_systems, false)
                || !canonical_protection_systems(
                    &leg.simultaneously_required_protection_systems,
                    true,
                )
                || leg
                    .simultaneously_required_protection_systems
                    .iter()
                    .any(|system| !leg.available_protection_systems.contains(system))
            {
                return Err(OperationalError::IncompleteRoute(self.id.clone()));
            }
            expected = leg.route_end_mm();
        }
        if self.predecessor_id.is_some() != self.transition_route_mm.is_some() {
            return Err(OperationalError::IncompleteRoute(self.id.clone()));
        }
        Ok(())
    }

    pub fn length_mm(&self) -> i64 {
        self.legs.last().map_or(0, RouteLeg::route_end_mm)
    }

    pub fn leg_at(&self, route_mm: i64) -> Option<&RouteLeg> {
        self.legs.iter().find(|leg| {
            route_mm >= leg.route_start_mm
                && (route_mm < leg.route_end_mm()
                    || route_mm == self.length_mm() && route_mm == leg.route_end_mm())
        })
    }
}

/// Exakt belegtes Intervall auf einer konkreten gerichteten Gleiskante.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrackInterval {
    pub edge_id: String,
    pub from_mm: i64,
    pub to_mm: i64,
    pub direction: Direction,
}

/// Releasegebundener Stuetzpunkt einer konkreten Gleiskante.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeGeometryPoint {
    pub edge_offset_mm: i64,
    pub latitude_e7: i32,
    pub longitude_e7: i32,
    pub bearing_milli_degrees: Option<u32>,
}

/// Auf eine unveraenderliche Laufwegversion gehobener Kartenpunkt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalRouteGeometryPoint {
    pub route_mm: RouteMillimetres,
    pub edge_id: String,
    pub edge_offset_mm: i64,
    pub latitude_e7: i32,
    pub longitude_e7: i32,
    pub bearing_milli_degrees: Option<u32>,
}

impl TrackInterval {
    pub fn overlaps(&self, other: &Self) -> bool {
        self.edge_id == other.edge_id && self.from_mm < other.to_mm && other.from_mm < self.to_mm
    }
}

/// Betriebliche Rolle eines physischen Fahrzeugtyps.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationalVehicleRole {
    PoweredUnit,
    Locomotive,
    Coach,
    ControlCar,
}

/// Antriebsart eines Operational-v2-Fahrzeugtyps.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationalVehicleTraction {
    /// Nicht angetriebenes Fahrzeug.
    Unpowered,
    /// Rein elektrischer Antrieb.
    Electric,
    /// Dieselantrieb.
    Diesel,
    /// Batterieantrieb mit den angegebenen Oberleitungs-Ladesystemen.
    Battery,
}

/// Vom Fahrzeug beherrschtes elektrisches Stromsystem.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationalPowerSystem {
    Ac15kv,
    Ac25kv,
    Dc750v,
    Dc1500v,
    Dc3000v,
}

impl OperationalVehicleRole {
    fn is_powered(self) -> bool {
        matches!(self, Self::PoweredUnit | Self::Locomotive)
    }
}

/// Physische Fuehrerstaende eines Fahrzeugtyps vor Einbaurichtung im Verband.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalControlStands {
    pub front: bool,
    pub rear: bool,
}

impl OperationalControlStands {
    fn at_formation_front(self, orientation: Direction) -> bool {
        match orientation {
            Direction::Along => self.front,
            Direction::Against => self.rear,
        }
    }

    fn at_formation_rear(self, orientation: Direction) -> bool {
        match orientation {
            Direction::Along => self.rear,
            Direction::Against => self.front,
        }
    }
}

/// Nenner fuer alle Basispunktwerte der gemeinsamen Fahrdynamikableitung.
pub const FORMATION_DYNAMICS_BASIS_POINTS: u16 = 10_000;
/// Obergrenze einer sichtbaren Anfahrbeschleunigungsannahme.
pub const MAX_FORMATION_ACCELERATION_MMPS2: u32 = 10_000;
/// Obergrenze eines abgeleiteten Bremswerts.
pub const MAX_FORMATION_BRAKE_MMPS2: u32 = 20_000;

/// Vollstaendige Rohparameter eines Fahrzeugtyps fuer die spaetere
/// formationsbezogene Fahrdynamikableitung.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleTypeRawFormationDynamics {
    pub brake_weight_kg: u64,
    pub maximum_acceleration_cap_mmps2: u32,
    pub service_brake_cap_mmps2: u32,
    pub emergency_brake_multiplier_basis_points: u16,
}

/// Rein ganzzahlige Eingabe fuer eine konkrete, bereits gekuppelte Formation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FormationDynamicsDerivationInput {
    pub total_mass_kg: u64,
    pub effective_starting_tractive_force_newtons: u64,
    pub total_brake_weight_kg: u64,
    pub maximum_acceleration_cap_mmps2: u32,
    pub service_brake_cap_mmps2: u32,
    pub emergency_brake_multiplier_basis_points: u16,
}

/// Deterministisches Ergebnis der gemeinsamen Fahrdynamikableitung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DerivedFormationDynamics {
    pub acceleration_mmps2: u32,
    pub service_brake_mmps2: u32,
    pub emergency_brake_mmps2: u32,
}

/// Fail-closed-Fehler des gemeinsamen Fahrdynamikvertrags.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FormationDynamicsDerivationError {
    InvalidInput,
    ArithmeticOverflow,
    InvalidOutput,
}

/// Leitet das Fahrprofil ausschliesslich aus den Rohwerten des tatsaechlich
/// gekuppelten Verbands ab. Die Rechnung verwendet weder Gleitkommazahlen noch
/// Uhr- oder Umgebungswerte und rundet bei jeder Division konservativ ab.
pub fn derive_formation_dynamics(
    input: FormationDynamicsDerivationInput,
) -> Result<DerivedFormationDynamics, FormationDynamicsDerivationError> {
    let powered = input.effective_starting_tractive_force_newtons > 0;
    if input.total_mass_kg == 0
        || input.total_brake_weight_kg == 0
        || (powered
            && !(1..=MAX_FORMATION_ACCELERATION_MMPS2)
                .contains(&input.maximum_acceleration_cap_mmps2))
        || (!powered && input.maximum_acceleration_cap_mmps2 != 0)
        || !(1..=MAX_FORMATION_BRAKE_MMPS2).contains(&input.service_brake_cap_mmps2)
        || !(FORMATION_DYNAMICS_BASIS_POINTS + 1..=30_000)
            .contains(&input.emergency_brake_multiplier_basis_points)
    {
        return Err(FormationDynamicsDerivationError::InvalidInput);
    }

    let acceleration_mmps2 = if powered {
        let theoretical = input
            .effective_starting_tractive_force_newtons
            .checked_mul(1_000)
            .ok_or(FormationDynamicsDerivationError::ArithmeticOverflow)?
            / input.total_mass_kg;
        input.maximum_acceleration_cap_mmps2.min(
            u32::try_from(theoretical)
                .map_err(|_| FormationDynamicsDerivationError::ArithmeticOverflow)?,
        )
    } else {
        0
    };
    let theoretical_service = input
        .total_brake_weight_kg
        .checked_mul(9_806)
        .ok_or(FormationDynamicsDerivationError::ArithmeticOverflow)?
        / input.total_mass_kg;
    let service_brake_mmps2 = input.service_brake_cap_mmps2.min(
        u32::try_from(theoretical_service)
            .map_err(|_| FormationDynamicsDerivationError::ArithmeticOverflow)?,
    );
    let emergency_brake_mmps2 = u64::from(service_brake_mmps2)
        .checked_mul(u64::from(input.emergency_brake_multiplier_basis_points))
        .ok_or(FormationDynamicsDerivationError::ArithmeticOverflow)?
        / u64::from(FORMATION_DYNAMICS_BASIS_POINTS);
    let emergency_brake_mmps2 = u32::try_from(emergency_brake_mmps2)
        .map_err(|_| FormationDynamicsDerivationError::ArithmeticOverflow)?;

    if (powered && acceleration_mmps2 == 0)
        || service_brake_mmps2 == 0
        || emergency_brake_mmps2 <= service_brake_mmps2
        || emergency_brake_mmps2 > MAX_FORMATION_BRAKE_MMPS2
    {
        return Err(FormationDynamicsDerivationError::InvalidOutput);
    }
    Ok(DerivedFormationDynamics {
        acceleration_mmps2,
        service_brake_mmps2,
        emergency_brake_mmps2,
    })
}

/// Physische Pflichtdaten eines Fahrzeugtyps. Nullwerte sind unzulaessig.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleType {
    pub id: String,
    /// `None` ist ausschliesslich der rueckwaertskompatible Operational-v2-Altpfad.
    /// Neue Releases muessen Rolle und Fuehrerstaende gemeinsam explizit setzen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<OperationalVehicleRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_stands: Option<OperationalControlStands>,
    /// `None` ist nur zusammen mit allen uebrigen Metadaten-Optionen der
    /// rueckwaertskompatible Legacy-Pfad.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub traction: Option<OperationalVehicleTraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub electric_systems: Option<Vec<OperationalPowerSystem>>,
    pub length_mm: u32,
    pub mass_kg: u64,
    pub maximum_speed_mmps: u32,
    pub power_watts: u64,
    pub starting_tractive_force_newtons: u32,
    /// Neue explizite Typmetadaten tragen diesen Rohblock vollstaendig. Sein
    /// Fehlen kennzeichnet ausschliesslich den unveraenderten Legacy-Pfad.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_formation_dynamics: Option<VehicleTypeRawFormationDynamics>,
    pub maximum_acceleration_mmps2: u32,
    pub service_brake_mmps2: u32,
    pub emergency_brake_mmps2: u32,
    pub protection_systems: BTreeSet<String>,
}

impl VehicleType {
    pub fn validate(&self, powered: bool) -> Result<(), OperationalError> {
        let complete = !self.id.is_empty()
            && self.length_mm > 0
            && self.mass_kg > 0
            && self.maximum_speed_mmps > 0
            && self.service_brake_mmps2 > 0
            && self.emergency_brake_mmps2 > self.service_brake_mmps2;
        let powered_complete = !powered
            || (self.power_watts > 0
                && self.starting_tractive_force_newtons > 0
                && self.maximum_acceleration_mmps2 > 0);
        let role_complete = match (
            self.role,
            self.control_stands,
            self.traction,
            self.electric_systems.as_deref(),
            self.raw_formation_dynamics,
        ) {
            // Ein rein alter v2-Datensatz bleibt ladbar. Die Formation darf
            // diesen Altpfad nicht mit expliziten Fahrzeugtypen mischen.
            (None, None, None, None, None) => true,
            (
                Some(role),
                Some(control_stands),
                Some(traction),
                Some(electric_systems),
                Some(raw),
            ) => {
                let has_control_stand = control_stands.front || control_stands.rear;
                let control_stands_match_role = match role {
                    OperationalVehicleRole::Coach => !has_control_stand,
                    OperationalVehicleRole::PoweredUnit
                    | OperationalVehicleRole::Locomotive
                    | OperationalVehicleRole::ControlCar => has_control_stand,
                };
                let drive_values_match_role = role.is_powered()
                    || (self.power_watts == 0
                        && self.starting_tractive_force_newtons == 0
                        && self.maximum_acceleration_mmps2 == 0);
                let systems_are_canonical =
                    electric_systems.windows(2).all(|items| items[0] < items[1]);
                let traction_matches_powered = match traction {
                    OperationalVehicleTraction::Unpowered => {
                        !powered && electric_systems.is_empty()
                    }
                    OperationalVehicleTraction::Diesel => powered && electric_systems.is_empty(),
                    OperationalVehicleTraction::Electric | OperationalVehicleTraction::Battery => {
                        powered && !electric_systems.is_empty()
                    }
                };
                let reference_matches_raw =
                    derive_formation_dynamics(FormationDynamicsDerivationInput {
                        total_mass_kg: self.mass_kg,
                        effective_starting_tractive_force_newtons: u64::from(
                            self.starting_tractive_force_newtons,
                        ),
                        total_brake_weight_kg: raw.brake_weight_kg,
                        maximum_acceleration_cap_mmps2: raw.maximum_acceleration_cap_mmps2,
                        service_brake_cap_mmps2: raw.service_brake_cap_mmps2,
                        emergency_brake_multiplier_basis_points: raw
                            .emergency_brake_multiplier_basis_points,
                    })
                    .is_ok_and(|expected| {
                        expected.acceleration_mmps2 == self.maximum_acceleration_mmps2
                            && expected.service_brake_mmps2 == self.service_brake_mmps2
                            && expected.emergency_brake_mmps2 == self.emergency_brake_mmps2
                    });
                role.is_powered() == powered
                    && control_stands_match_role
                    && drive_values_match_role
                    && systems_are_canonical
                    && traction_matches_powered
                    && reference_matches_raw
            }
            _ => false,
        };
        if complete && powered_complete && role_complete {
            Ok(())
        } else {
            Err(OperationalError::IncompleteVehicleType(self.id.clone()))
        }
    }
}

/// Konkrete technische Einschraenkung eines physischen Fahrzeugs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VehicleRestriction {
    PowerBasisPoints(u16),
    MaximumSpeed(u32),
    ServiceBrake(u32),
    EmergencyBrake(u32),
    ProtectionUnavailable(String),
    DoorAvailabilityBasisPoints(u16),
    Immobilized,
}

/// Mehrdimensionaler Fahrzeugzustand; Alter ist bewusst kein direkter Faktor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleCondition {
    pub mechanics_basis_points: u16,
    pub drive_basis_points: u16,
    pub brakes_basis_points: u16,
    pub kilometres_since_maintenance: u64,
    pub operating_hours_since_maintenance: u64,
    pub open_observations: u16,
}

/// Ein konkretes, weltgebundenes Fahrzeugasset.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhysicalVehicle {
    pub id: String,
    pub type_id: String,
    pub powered: bool,
    pub orientation: Direction,
    pub condition: VehicleCondition,
    pub restrictions: BTreeMap<String, VehicleRestriction>,
    pub history: Vec<String>,
}

/// Aus allen Fahrzeugen atomar abgeleitete Verbandswerte.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationPerformance {
    pub length_mm: u32,
    pub mass_kg: u64,
    pub maximum_speed_mmps: u32,
    pub power_watts: u64,
    pub acceleration_mmps2: u32,
    pub service_brake_mmps2: u32,
    pub emergency_brake_mmps2: u32,
    /// Nutzbarer Fuehrerstand am aeusseren Ende der Zugspitze.
    pub front_control_stand_available: bool,
    /// Nutzbarer Fuehrerstand am aeusseren Ende des Zugschlusses.
    pub rear_control_stand_available: bool,
    pub protection_systems: BTreeSet<String>,
    pub mobile: bool,
}

/// Unveraenderliche Zusammenstellungsversion.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormationVersion {
    pub id: String,
    pub predecessor_id: Option<String>,
    /// Autoritative Reihenfolge von Zugspitze nach Zugschluss.
    pub vehicle_ids: Vec<String>,
    pub performance: FormationPerformance,
}

/// Analytischer Bewegungsabschnitt. Positionsabfragen veraendern keinen Zustand.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MotionSegment {
    pub started_at_ms: SimMillis,
    pub valid_until_ms: SimMillis,
    pub start_route_mm: RouteMillimetres,
    pub start_speed_mmps: u32,
    pub acceleration_mmps2: i32,
    pub route_version_id: String,
    pub authority_end_route_mm: RouteMillimetres,
    pub segment_end_route_mm: RouteMillimetres,
}

impl MotionSegment {
    fn validate_bounds(&self) -> Result<(), OperationalError> {
        if self.start_route_mm < 0
            || self.segment_end_route_mm < self.start_route_mm
            || self.segment_end_route_mm > self.authority_end_route_mm
        {
            Err(OperationalError::UnsafeState)
        } else {
            Ok(())
        }
    }

    pub fn position_at(&self, at_ms: SimMillis) -> Result<RouteMillimetres, OperationalError> {
        if at_ms < self.started_at_ms || at_ms > self.valid_until_ms {
            return Err(OperationalError::OutsideMotionValidity);
        }
        self.validate_bounds()?;
        let elapsed = i128::from(at_ms.saturating_sub(self.started_at_ms));
        let velocity = i128::from(self.start_speed_mmps);
        let acceleration = i128::from(self.acceleration_mmps2);
        let velocity_distance = div_round_half_away(velocity.saturating_mul(elapsed), 1_000);
        let acceleration_distance = div_round_half_away(
            acceleration.saturating_mul(elapsed).saturating_mul(elapsed),
            2_000_000,
        );
        let distance = velocity_distance
            .saturating_add(acceleration_distance)
            .max(0);
        let position = checked_i64(i128::from(self.start_route_mm).saturating_add(distance))?
            .min(self.authority_end_route_mm)
            .min(self.segment_end_route_mm);
        // Ganzzahlige Millimeter koennen am Ende eines kurzen Bremsabschnitts
        // sowohl Weg als auch Restgeschwindigkeit auf null runden. Genau ein
        // nicht mehr darstellbares Millimeterquant wird am zeitlichen Ende auf
        // die bereits validierte Segment-/Authority-Grenze gehoben. Jeder
        // laengere Nullfortschritt bleibt unveraendert und scheitert danach in
        // `finish_motion_segment` fail-closed.
        if at_ms == self.valid_until_ms
            && self.valid_until_ms > self.started_at_ms
            && position == self.start_route_mm
            && self.start_route_mm.checked_add(1) == Some(self.segment_end_route_mm)
        {
            Ok(self.segment_end_route_mm)
        } else {
            Ok(position)
        }
    }

    pub fn speed_at(&self, at_ms: SimMillis) -> Result<u32, OperationalError> {
        if at_ms < self.started_at_ms || at_ms > self.valid_until_ms {
            return Err(OperationalError::OutsideMotionValidity);
        }
        self.validate_bounds()?;
        // Die Bremsgrenze wird vorab ereignisgesteuert berechnet. An der
        // harten Authority-Grenze klemmt der diskrete Millisekundenvertrag nur
        // noch den Rundungsrest auf Null; Kantenwechsel innerhalb der
        // Authority bleiben davon unberuehrt.
        if at_ms == self.valid_until_ms
            && self.segment_end_route_mm == self.authority_end_route_mm
            && self.position_at(at_ms)? == self.authority_end_route_mm
        {
            return Ok(0);
        }
        let elapsed = i128::from(at_ms.saturating_sub(self.started_at_ms));
        let speed = i128::from(self.start_speed_mmps).saturating_add(div_round_half_away(
            i128::from(self.acceleration_mmps2).saturating_mul(elapsed),
            1_000,
        ));
        u32::try_from(speed.max(0).min(i128::from(u32::MAX)))
            .map_err(|_| OperationalError::ArithmeticOverflow)
    }
}

/// Gemeinsame interne Fahrberechtigung fuer konventionell, LZB und ETCS.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MovementAuthority {
    pub id: String,
    pub train_id: String,
    pub route_version_id: String,
    pub end_route_mm: RouteMillimetres,
    pub issued_at_ms: SimMillis,
    pub source_route_lock_id: String,
}

/// Signalbegriff als reine Ableitung des Stellwerkszustands.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignalAspect {
    Stop,
    Proceed,
    ShuntingProceed,
    Failed,
}

/// Unveraenderliche Fahrstrassenvorlage aus dem InfraRelease.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InterlockingRouteTemplate {
    pub id: String,
    /// Bindet die Fahrstrasse an genau die kompatible Laufwegvorlage.
    pub route_template_id: String,
    /// Exakter Laufwegpunkt, an dem diese Fahrstrasse beginnen darf.
    pub authority_start_route_mm: RouteMillimetres,
    pub signal_id: String,
    pub movement_kind: MovementKind,
    pub path_resources: BTreeSet<String>,
    pub overlap_resources: BTreeSet<String>,
    pub flank_resources: BTreeSet<String>,
    pub switch_positions: BTreeMap<String, String>,
    pub authority_end_route_mm: RouteMillimetres,
    pub release_after_tail_route_mm: RouteMillimetres,
}

impl InterlockingRouteTemplate {
    fn all_resources(&self) -> BTreeSet<String> {
        self.path_resources
            .iter()
            .chain(&self.overlap_resources)
            .chain(&self.flank_resources)
            .cloned()
            .collect()
    }
}

/// Atomar verriegelte Fahrstrasse.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteLock {
    pub id: String,
    pub template_id: String,
    pub train_id: String,
    pub resources: BTreeSet<String>,
    pub release_after_tail_route_mm: RouteMillimetres,
    pub locked_at_ms: SimMillis,
}

/// Lebenszyklus einer Konfliktressource.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceLifecycle {
    Free,
    RouteLocked,
    EnteredByHead,
    OccupiedByFormation,
    ClearedByTail,
    ReleasePending,
}

/// Vollstaendige statische Betriebsgrundlage der Engine.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalInfraRelease {
    pub id: String,
    pub directed_edges: BTreeMap<String, i64>,
    pub edge_geometries: BTreeMap<String, Vec<EdgeGeometryPoint>>,
    pub route_versions: BTreeMap<String, RouteVersion>,
    pub interlocking_routes: BTreeMap<String, InterlockingRouteTemplate>,
    pub signals: BTreeSet<String>,
    pub switches: BTreeSet<String>,
    pub block_resources: BTreeSet<String>,
    pub platform_intervals: BTreeMap<String, TrackInterval>,
    pub region_boundaries: BTreeSet<String>,
    pub rzue_layout_id: String,
}

impl OperationalInfraRelease {
    pub fn validate(&self) -> Result<(), OperationalError> {
        if self.id.is_empty()
            || self.rzue_layout_id.is_empty()
            || self.directed_edges.is_empty()
            || self.route_versions.is_empty()
            || self.interlocking_routes.is_empty()
            || self.signals.is_empty()
            || self.block_resources.is_empty()
            || self.region_boundaries.iter().any(String::is_empty)
            || self.signals.iter().any(String::is_empty)
            || self.switches.iter().any(String::is_empty)
            || self.block_resources.iter().any(String::is_empty)
        {
            return Err(OperationalError::IncompleteInfraRelease);
        }
        if self.edge_geometries.len() != self.directed_edges.len() {
            return Err(OperationalError::IncompleteInfraRelease);
        }
        for (edge_id, length_mm) in &self.directed_edges {
            if edge_id.is_empty() || *length_mm <= 0 {
                return Err(OperationalError::IncompleteInfraRelease);
            }
            let Some(points) = self.edge_geometries.get(edge_id) else {
                return Err(OperationalError::UnknownEdge(edge_id.clone()));
            };
            if points.len() < 2
                || points.first().is_none_or(|point| point.edge_offset_mm != 0)
                || points
                    .last()
                    .is_none_or(|point| point.edge_offset_mm != *length_mm)
                || points.windows(2).any(|pair| {
                    pair[0].edge_offset_mm >= pair[1].edge_offset_mm
                        || pair[0]
                            .bearing_milli_degrees
                            .is_none_or(|bearing| bearing >= 360_000)
                })
                || points.iter().any(|point| {
                    !(-900_000_000..=900_000_000).contains(&point.latitude_e7)
                        || !(-1_800_000_000..=1_800_000_000).contains(&point.longitude_e7)
                })
                || points
                    .last()
                    .is_some_and(|point| point.bearing_milli_degrees.is_some())
            {
                return Err(OperationalError::InvalidEdgeGeometry(edge_id.clone()));
            }
        }
        for (route_id, route) in &self.route_versions {
            if route_id != &route.id {
                return Err(OperationalError::IncompleteRoute(route.id.clone()));
            }
            route.validate()?;
            if !self
                .interlocking_routes
                .values()
                .any(|template| template.route_template_id == route.template_id)
            {
                return Err(OperationalError::IncompleteRoute(route.id.clone()));
            }
            if let (Some(predecessor_id), Some(transition_route_mm)) =
                (&route.predecessor_id, route.transition_route_mm)
            {
                if predecessor_id == &route.id
                    || !self.route_versions.contains_key(predecessor_id)
                    || transition_route_mm < 0
                    || transition_route_mm > route.length_mm()
                {
                    return Err(OperationalError::IncompleteRoute(route.id.clone()));
                }
            }
            for leg in &route.legs {
                let Some(length) = self.directed_edges.get(&leg.edge_id) else {
                    return Err(OperationalError::UnknownEdge(leg.edge_id.clone()));
                };
                if leg.edge_entry_mm < 0
                    || leg.edge_exit_mm < 0
                    || leg.edge_entry_mm > *length
                    || leg.edge_exit_mm > *length
                    || !leg
                        .block_ids
                        .iter()
                        .all(|id| self.block_resources.contains(id))
                {
                    return Err(OperationalError::IncompleteRoute(route.id.clone()));
                }
            }
        }
        let mut train_route_keys = BTreeSet::new();
        for (template_id, template) in &self.interlocking_routes {
            let matching_routes: Vec<&RouteVersion> = self
                .route_versions
                .values()
                .filter(|route| route.template_id == template.route_template_id)
                .collect();
            if template_id != &template.id
                || template.route_template_id.is_empty()
                || matching_routes.is_empty()
                || !self.signals.contains(&template.signal_id)
                || !template
                    .switch_positions
                    .keys()
                    .all(|id| self.switches.contains(id))
                || template.path_resources.is_empty()
                || template.overlap_resources.is_empty()
                || template.flank_resources.is_empty()
                || !template.path_resources.is_subset(&self.block_resources)
                || !template.overlap_resources.is_subset(&self.block_resources)
                || !template.flank_resources.is_subset(&self.block_resources)
                || template.authority_start_route_mm < 0
                || template.authority_end_route_mm <= template.authority_start_route_mm
                || template.release_after_tail_route_mm < template.authority_start_route_mm
                || template.release_after_tail_route_mm > template.authority_end_route_mm
                || matching_routes
                    .iter()
                    .any(|route| template.authority_end_route_mm > route.length_mm())
                || (template.movement_kind == MovementKind::Train
                    && matching_routes.iter().any(|route| {
                        route
                            .legs
                            .iter()
                            .find(|leg| leg.route_start_mm == template.authority_start_route_mm)
                            .is_none_or(|leg| {
                                leg.route_end_mm() != template.authority_end_route_mm
                                    || leg.block_ids != template.path_resources
                            })
                    }))
                || (template.movement_kind == MovementKind::Train
                    && !train_route_keys.insert((
                        template.route_template_id.clone(),
                        template.authority_start_route_mm,
                    )))
            {
                return Err(OperationalError::InvalidInterlockingRoute(
                    template.id.clone(),
                ));
            }
        }
        for route in self.route_versions.values() {
            let shunting_templates = self
                .interlocking_routes
                .values()
                .filter(|template| {
                    template.movement_kind == MovementKind::Shunting
                        && template.route_template_id == route.template_id
                })
                .collect::<Vec<_>>();
            if matches!(
                shunting_templates.as_slice(),
                [template]
                    if template.authority_start_route_mm > 0
                        && template.authority_end_route_mm == route.length_mm()
            ) {
                continue;
            }
            for leg in &route.legs {
                if self
                    .interlocking_routes
                    .values()
                    .filter(|template| {
                        template.movement_kind == MovementKind::Train
                            && template.route_template_id == route.template_id
                            && template.authority_start_route_mm == leg.route_start_mm
                            && template.authority_end_route_mm == leg.route_end_mm()
                            && template.path_resources == leg.block_ids
                    })
                    .count()
                    != 1
                {
                    return Err(OperationalError::IncompleteRoute(route.id.clone()));
                }
            }
        }
        for (platform_id, interval) in &self.platform_intervals {
            let Some(edge_length) = self.directed_edges.get(&interval.edge_id) else {
                return Err(OperationalError::UnknownEdge(interval.edge_id.clone()));
            };
            if platform_id.is_empty()
                || interval.from_mm < 0
                || interval.from_mm >= interval.to_mm
                || interval.to_mm > *edge_length
            {
                return Err(OperationalError::UnknownPlatform(platform_id.clone()));
            }
        }
        Ok(())
    }
}

/// Kleiner, dateispeicherfaehiger Zugriff auf die unveraenderliche
/// Operational-v2-Infrastruktur. Implementierungen muessen ihre komplette
/// Release-/Hashbindung vor dem Anhaengen an eine Welt validiert haben.
pub trait OperationalInfrastructure: fmt::Debug + Send + Sync {
    fn release_id(&self) -> &str;
    fn binding_identity(&self) -> &str;
    fn validate_attachment(&self) -> Result<(), OperationalError>;
    /// Prueft konkrete Stoerungsziele gegen denselben gebundenen Release.
    fn contains_disruption_target(
        &self,
        effect: &OperationalDisruption,
    ) -> Result<bool, OperationalError>;
    fn route_version(&self, id: &str) -> Result<Option<RouteVersion>, OperationalError>;
    fn interlocking_route(
        &self,
        id: &str,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError>;
    /// Exakte Zugfahrstrasse fuer einen Laufweg und dessen aktuellen
    /// Authority-Anfang. Implementierungen muessen diese Abfrage indexiert
    /// bedienen; ein Scan aller Fahrstrassen gehoert nicht in den Hot Path.
    fn train_interlocking_route(
        &self,
        route_template_id: &str,
        authority_start_route_mm: RouteMillimetres,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError>;
    fn shunting_interlocking_routes(
        &self,
        minimum_authority_end_route_mm: RouteMillimetres,
    ) -> Result<Vec<InterlockingRouteTemplate>, OperationalError>;
    fn platform_interval(&self, id: &str) -> Result<Option<TrackInterval>, OperationalError>;
    fn edge_geometry(
        &self,
        edge_id: &str,
    ) -> Result<Option<Vec<EdgeGeometryPoint>>, OperationalError>;
}

/// Einmalig indexierte In-Memory-Sicht auf einen vollstaendigen Release.
/// Der abgeleitete Index ist kein persistierter Fachzustand.
#[derive(Clone, Debug, Eq, PartialEq)]
struct InMemoryOperationalInfrastructure {
    release: OperationalInfraRelease,
    binding_identity: String,
    train_route_index: BTreeMap<(String, RouteMillimetres), String>,
}

impl InMemoryOperationalInfrastructure {
    fn new(release: OperationalInfraRelease) -> Result<Self, OperationalError> {
        release.validate()?;
        let mut hash = StateHasher::new("operational-in-memory-infrastructure/v1");
        hash.bytes(
            "release",
            &serde_json::to_vec(&release).expect("serializable infrastructure"),
        );
        let binding_identity = hash.finish().to_hex();
        let train_route_index = release
            .interlocking_routes
            .values()
            .filter(|template| template.movement_kind == MovementKind::Train)
            .map(|template| {
                (
                    (
                        template.route_template_id.clone(),
                        template.authority_start_route_mm,
                    ),
                    template.id.clone(),
                )
            })
            .collect();
        Ok(Self {
            release,
            binding_identity,
            train_route_index,
        })
    }
}

impl OperationalInfrastructure for InMemoryOperationalInfrastructure {
    fn contains_disruption_target(
        &self,
        effect: &OperationalDisruption,
    ) -> Result<bool, OperationalError> {
        Ok(match effect {
            OperationalDisruption::ResourceClosed { resource_id }
            | OperationalDisruption::TrackDetectionFailed { resource_id } => {
                self.release.block_resources.contains(resource_id)
            }
            OperationalDisruption::SpeedRestriction {
                edge_id,
                maximum_speed_mmps,
            } => *maximum_speed_mmps > 0 && self.release.directed_edges.contains_key(edge_id),
            OperationalDisruption::SignalFailed { signal_id } => {
                self.release.signals.contains(signal_id)
            }
            OperationalDisruption::SwitchFailed { switch_id } => {
                self.release.switches.contains(switch_id)
            }
            OperationalDisruption::VehicleRestricted { .. } => true,
        })
    }
    fn release_id(&self) -> &str {
        &self.release.id
    }

    fn binding_identity(&self) -> &str {
        &self.binding_identity
    }

    fn validate_attachment(&self) -> Result<(), OperationalError> {
        self.release.validate()
    }

    fn route_version(&self, id: &str) -> Result<Option<RouteVersion>, OperationalError> {
        Ok(self.release.route_versions.get(id).cloned())
    }

    fn interlocking_route(
        &self,
        id: &str,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        Ok(self.release.interlocking_routes.get(id).cloned())
    }

    fn train_interlocking_route(
        &self,
        route_template_id: &str,
        authority_start_route_mm: RouteMillimetres,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        Ok(self
            .train_route_index
            .get(&(route_template_id.to_owned(), authority_start_route_mm))
            .and_then(|id| self.release.interlocking_routes.get(id))
            .cloned())
    }

    fn shunting_interlocking_routes(
        &self,
        minimum_authority_end_route_mm: RouteMillimetres,
    ) -> Result<Vec<InterlockingRouteTemplate>, OperationalError> {
        Ok(self
            .release
            .interlocking_routes
            .values()
            .filter(|route| {
                route.movement_kind == MovementKind::Shunting
                    && route.authority_end_route_mm >= minimum_authority_end_route_mm
            })
            .cloned()
            .collect())
    }

    fn platform_interval(&self, id: &str) -> Result<Option<TrackInterval>, OperationalError> {
        Ok(self.release.platform_intervals.get(id).cloned())
    }

    fn edge_geometry(
        &self,
        edge_id: &str,
    ) -> Result<Option<Vec<EdgeGeometryPoint>>, OperationalError> {
        Ok(self.release.edge_geometries.get(edge_id).cloned())
    }
}

#[derive(Clone)]
struct AttachedOperationalInfrastructure(Arc<dyn OperationalInfrastructure>);

impl fmt::Debug for AttachedOperationalInfrastructure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("AttachedOperationalInfrastructure")
            .field(&self.0.binding_identity())
            .finish()
    }
}

impl PartialEq for AttachedOperationalInfrastructure {
    fn eq(&self, other: &Self) -> bool {
        self.0.release_id() == other.0.release_id()
            && self.0.binding_identity() == other.0.binding_identity()
    }
}

impl Eq for AttachedOperationalInfrastructure {}

/// Laufender exakter Zustand einer Zug- oder Rangierbewegung.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalTrain {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passenger_stops: Option<OperationalPassengerStopProgress>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_outcome: Option<ServiceOutcomeProgress>,
    pub id: String,
    pub train_number: String,
    pub operator_id: String,
    pub movement_kind: MovementKind,
    pub route_version_id: String,
    pub formation_version_id: String,
    pub head_route_mm: RouteMillimetres,
    pub tail_route_mm: RouteMillimetres,
    pub speed_mmps: u32,
    pub direction: Direction,
    pub motion_state: MotionState,
    pub motion_segment: Option<MotionSegment>,
    pub authority: Option<MovementAuthority>,
    pub occupied_intervals: Vec<TrackInterval>,
    pub occupied_blocks: BTreeSet<String>,
    pub scheduled_departure_ms: Option<SimMillis>,
    pub public_passenger_stop: bool,
    pub waiting_reason: Option<String>,
}

/// Vollstaendiges typisiertes Materialisierungskommando der Engine.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainMaterialization {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_plan: Option<OperationalPassengerStopPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_outcome: Option<ServiceOutcomeBinding>,
    pub id: String,
    pub train_number: String,
    pub operator_id: String,
    pub movement_kind: MovementKind,
    pub route_version_id: String,
    pub formation_version_id: String,
    pub head_route_mm: i64,
    pub scheduled_departure_ms: Option<i64>,
    pub public_passenger_stop: bool,
}

/// Physische Orientierung zwischen zwei signierten Bewegungsabschnitten.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MovementContinuity {
    SameDirection,
    ReverseDirection,
}

impl MovementContinuity {
    fn contract_name(self) -> &'static str {
        match self {
            Self::SameDirection => "same-direction",
            Self::ReverseDirection => "reverse-direction",
        }
    }
}

/// Signierte, physisch lueckenlose Fortsetzung einer konkreten Bewegung.
///
/// Der Nachfolger wird nicht neu materialisiert. Sobald der Vorgaenger sein
/// echtes Laufwegende erreicht hat, ersetzt die Engine dessen betriebliche
/// Identitaet atomar und behaelt Formation, Fahrzeuge und Gleisbelegung bei.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MovementContinuation {
    pub id: String,
    pub predecessor_train_id: String,
    pub predecessor_base_route_version_id: String,
    pub successor: TrainMaterialization,
    pub successor_dispatch: DispatchRequest,
    pub not_before_ms: SimMillis,
    pub minimum_dwell_ms: SimMillis,
    pub continuity: MovementContinuity,
}

/// Kanonischer fachlicher Nummernteil: ASCII-dezimal und niemals laenger als
/// fuenf Stellen. Linienpraefixe bleiben reine Darstellung.
pub fn operational_train_number_numeric_part(value: &str) -> Option<u32> {
    if value.is_empty()
        || value.chars().count() > 200
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return None;
    }
    let digit_count = value
        .chars()
        .rev()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if !(1..=5).contains(&digit_count) {
        return None;
    }
    let numeric_part = value[value.len().checked_sub(digit_count)?..]
        .parse::<u32>()
        .ok()?;
    (1..=99_999).contains(&numeric_part).then_some(numeric_part)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalProgramTemplateValidation {
    pub resource_binding_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalProgramTemplatePredicates {
    pub formation_mobile: bool,
    pub head_within_route: bool,
    pub protection_compatible: bool,
    pub protection_mode_selection_policy_matches: bool,
    pub protection_mode_selections_match: bool,
    pub protection_mode_selection_runs: Vec<ProtectionModeSelectionRun>,
    pub protection_mode_selection_count: usize,
    pub movement_kind_matches: bool,
    pub route_template_matches: bool,
    pub authority_path_resources_cover_route: bool,
    pub authority_end_matches_route: bool,
    pub release_after_tail_within_authority: bool,
    pub resource_binding_count: usize,
}

impl OperationalProgramTemplatePredicates {
    pub fn is_valid(&self) -> bool {
        self.formation_mobile
            && self.head_within_route
            && self.protection_compatible
            && self.protection_mode_selection_policy_matches
            && self.protection_mode_selections_match
            && self.movement_kind_matches
            && self.route_template_matches
            && self.authority_path_resources_cover_route
            && self.authority_end_matches_route
            && self.release_after_tail_within_authority
    }

    pub fn failed_predicates(&self) -> Vec<&'static str> {
        [
            (!self.formation_mobile).then_some("formation-mobile"),
            (!self.head_within_route).then_some("head-within-route"),
            (!self.protection_compatible).then_some("protection-intersection"),
            (!self.protection_mode_selection_policy_matches)
                .then_some("protection-mode-selection-policy"),
            (!self.protection_mode_selections_match).then_some("protection-mode-selections"),
            (!self.movement_kind_matches).then_some("movement-kind"),
            (!self.route_template_matches).then_some("route-template"),
            (!self.authority_path_resources_cover_route)
                .then_some("authority-path-resources-cover-route"),
            (!self.authority_end_matches_route).then_some("authority-end"),
            (!self.release_after_tail_within_authority).then_some("release-after-tail"),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

fn canonical_protection_systems(systems: &[String], allow_empty: bool) -> bool {
    (allow_empty || !systems.is_empty())
        && systems
            .iter()
            .all(|system| KNOWN_PROTECTION_SYSTEMS.contains(&system.as_str()))
        && systems.windows(2).all(|pair| pair[0] < pair[1])
}

fn selected_protection_system<'route>(
    leg: &'route RouteLeg,
    formation_systems: &BTreeSet<String>,
) -> Option<&'route str> {
    if leg
        .simultaneously_required_protection_systems
        .iter()
        .any(|system| !formation_systems.contains(system))
    {
        return None;
    }
    CONSERVATIVE_PROTECTION_MODE_PRIORITY_V1
        .iter()
        .copied()
        .find(|system| {
            formation_systems.contains(*system)
                && leg
                    .available_protection_systems
                    .iter()
                    .any(|available| available == system)
        })
}

fn protection_mode_selection_runs(
    route: &RouteVersion,
    formation_systems: &BTreeSet<String>,
) -> Option<Vec<ProtectionModeSelectionRun>> {
    let mut runs: Vec<ProtectionModeSelectionRun> = Vec::new();
    for (index, leg) in route.legs.iter().enumerate() {
        let selected = selected_protection_system(leg, formation_systems)?.to_owned();
        if let Some(previous) = runs.last_mut()
            && previous.selected_protection_system == selected
        {
            previous.through_route_leg_index = index;
        } else {
            runs.push(ProtectionModeSelectionRun {
                through_route_leg_index: index,
                selected_protection_system: selected,
            });
        }
    }
    Some(runs)
}

fn protection_systems_compatible(leg: &RouteLeg, formation_systems: &BTreeSet<String>) -> bool {
    selected_protection_system(leg, formation_systems).is_some()
}

fn route_protection_compatible(route: &RouteVersion, formation: &FormationVersion) -> bool {
    route
        .legs
        .iter()
        .all(|leg| protection_systems_compatible(leg, &formation.performance.protection_systems))
}

/// Ein Fahrdienstleiterkandidat. Reihenfolge ist lexikographisch, kein Score.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchRequest {
    pub train_id: String,
    pub interlocking_route_id: String,
    pub committed_rank: u8,
    pub timetable_deviation_ms: i64,
    pub passenger_impact: u32,
    pub contractual_impact: u32,
    pub network_impact: u32,
    pub resource_consequence: u32,
    pub recovery_rank: u8,
    pub waiting_since_ms: SimMillis,
}

/// Fachlicher Anlass, aus dem der Rangierplaner selbst einen Fahrweg ableitet.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShuntingPurpose {
    Formation,
    LocomotiveRunAround,
    DirectionChange,
    Stabling,
    Supply,
    Workshop,
}

/// Automatischer Rangierbedarf ohne vom Spieler vorgegebenen Einzelweg.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomaticShuntingNeed {
    pub id: String,
    pub train_id: String,
    pub purpose: ShuntingPurpose,
    pub minimum_authority_end_route_mm: RouteMillimetres,
}

impl DispatchRequest {
    fn key(&self, now_ms: SimMillis) -> (u8, u8, i64, u32, u32, u32, u32, u8, i64, &str) {
        (
            0,
            self.committed_rank,
            self.timetable_deviation_ms,
            self.passenger_impact,
            self.contractual_impact,
            self.network_impact,
            self.resource_consequence,
            self.recovery_rank,
            now_ms.saturating_sub(self.waiting_since_ms),
            &self.train_id,
        )
    }
}

/// Konkrete Stoerungswirkung, nie eine kuenstlich addierte Verspaetung.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum OperationalDisruption {
    ResourceClosed {
        resource_id: String,
    },
    SpeedRestriction {
        edge_id: String,
        maximum_speed_mmps: u32,
    },
    SignalFailed {
        signal_id: String,
    },
    SwitchFailed {
        switch_id: String,
    },
    TrackDetectionFailed {
        resource_id: String,
    },
    VehicleRestricted {
        vehicle_id: String,
        restriction: VehicleRestriction,
    },
}

/// Persistiertes, fachliches Ereignis.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalEvent {
    pub event_sequence: u64,
    pub commit_sequence: u64,
    pub at_ms: SimMillis,
    pub kind: String,
    pub subject_id: String,
    pub detail: String,
}

/// Typisierte, committed Stoerungsprojektion fuer LiveMap und RZUE.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalDisruptionProjection {
    pub disruption_id: String,
    pub effect: OperationalDisruption,
}

/// Projektionstyp. Beide Sichten tragen denselben Commit.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectionKind {
    LiveMap,
    Rzue,
}

/// Gemeinsame Zugprojektion fuer LiveMap und RZUE.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalTrainProjection {
    pub train_id: String,
    pub train_number: String,
    pub operator_id: String,
    pub movement_kind: MovementKind,
    pub route_version_id: String,
    pub formation_version_id: String,
    pub head_route_mm: i64,
    pub tail_route_mm: i64,
    pub speed_mmps: u32,
    pub direction: Direction,
    pub motion_state: ProjectedMotionState,
    pub occupied_intervals: Vec<TrackInterval>,
    pub occupied_blocks: BTreeSet<String>,
    pub authority_end_route_mm: Option<i64>,
    /// Immer vorhandene exakte Kartenposition der Zugspitze, auch im Stillstand.
    pub head_geometry: OperationalRouteGeometryPoint,
    /// Fehlt nur, solange der Zugschluss noch ausserhalb des modellierten Laufwegs liegt.
    pub tail_geometry: Option<OperationalRouteGeometryPoint>,
    pub motion_segment: Option<MotionSegment>,
    pub motion_geometry: Vec<OperationalRouteGeometryPoint>,
    pub waiting_reason: Option<String>,
}

/// Snapshot eines committed state, gefiltert nach sichtbaren Korridoren.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalProjection {
    pub kind: ProjectionKind,
    pub world_id: String,
    pub region_id: String,
    pub infra_release_id: String,
    pub commit_sequence: u64,
    pub at_ms: SimMillis,
    pub stale_after_ms: SimMillis,
    pub trains: Vec<OperationalTrainProjection>,
    pub route_locks: Vec<RouteLock>,
    pub signals: BTreeMap<String, SignalAspect>,
    pub active_disruptions: Vec<OperationalDisruptionProjection>,
}

/// Atomare Uebergabe an einen anderen regionalen Single-Writer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegionHandover {
    pub id: String,
    pub world_id: String,
    pub infra_release_id: String,
    pub infra_binding_identity: String,
    pub source_region_id: String,
    pub target_region_id: String,
    pub at_ms: SimMillis,
    pub source_state_hash: String,
    pub source_event_sequence: u64,
    pub payload_hash: String,
    pub train: OperationalTrain,
    pub formation: FormationVersion,
    pub route: RouteVersion,
    pub vehicles: BTreeMap<String, PhysicalVehicle>,
    pub vehicle_types: BTreeMap<String, VehicleType>,
    pub route_locks: BTreeMap<String, RouteLock>,
    pub interlocking_routes: BTreeMap<String, InterlockingRouteTemplate>,
    pub switch_positions: BTreeMap<String, String>,
    pub active_disruptions: BTreeMap<String, OperationalDisruption>,
    pub dispatch_request: Option<DispatchRequest>,
    pub route_completed_at_ms: Option<SimMillis>,
    pub protected_resources: BTreeSet<String>,
    pub source_commit_sequence: u64,
    pub acknowledged: bool,
}

impl RegionHandover {
    fn calculate_payload_hash(&self) -> String {
        let mut canonical = self.clone();
        canonical.payload_hash.clear();
        canonical.acknowledged = false;
        let bytes = serde_json::to_vec(&canonical).expect("serializable handover");
        let mut hasher = StateHasher::new("operational-region-handover/v1");
        hasher.bytes("canonical-json", &bytes);
        hasher.finish().to_hex()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledMotionEnd {
    at_ms: SimMillis,
    train_id: String,
    segment_started_at_ms: SimMillis,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledContinuationDue {
    at_ms: SimMillis,
    continuation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MovementContinuationReceipt {
    payload_hash: String,
    completed_at_ms: SimMillis,
    completion_sequence: u64,
}

/// Kompakter Checkpoint; visuelle Mikropositionen sind nicht enthalten.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalCheckpoint {
    pub world: Box<OperationalWorld>,
    pub event_sequence: u64,
    pub state_hash: StateHash,
}

/// Die eine autoritative Betriebswirklichkeit einer Welt/Region.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalWorld {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_outcome_state: Option<ServiceOutcomeState>,
    pub world_id: String,
    pub region_id: String,
    pub infra_release_id: String,
    pub now_ms: SimMillis,
    pub commit_sequence: u64,
    pub event_sequence: u64,
    pub trains: BTreeMap<String, OperationalTrain>,
    pub vehicles: BTreeMap<String, PhysicalVehicle>,
    pub vehicle_types: BTreeMap<String, VehicleType>,
    pub formations: BTreeMap<String, FormationVersion>,
    pub route_locks: BTreeMap<String, RouteLock>,
    pub signal_aspects: BTreeMap<String, SignalAspect>,
    pub switch_positions: BTreeMap<String, String>,
    pub resource_lifecycle: BTreeMap<String, ResourceLifecycle>,
    pub active_disruptions: BTreeMap<String, OperationalDisruption>,
    pub events: Vec<OperationalEvent>,
    pub processed_command_ids: BTreeSet<String>,
    #[serde(skip)]
    infra: Option<AttachedOperationalInfrastructure>,
    scheduled_motion_ends: BTreeSet<ScheduledMotionEnd>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    scheduled_passenger_departures: BTreeSet<ScheduledPassengerDeparture>,
    scheduled_continuation_due: BTreeSet<ScheduledContinuationDue>,
    waiting_by_resource: BTreeMap<String, BTreeSet<String>>,
    continuations_waiting_by_resource: BTreeMap<String, BTreeSet<String>>,
    pending_dispatch_requests: BTreeMap<String, DispatchRequest>,
    pending_movement_continuations: BTreeMap<String, MovementContinuation>,
    completed_movement_continuations: BTreeMap<String, MovementContinuationReceipt>,
    route_completed_at_ms: BTreeMap<String, SimMillis>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    prepared_handovers: BTreeMap<String, RegionHandover>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    accepted_handovers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    finished_handovers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    handover_protection_by_train: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IntervalOwnerEnd {
    owner: usize,
    to_mm: i64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct TwoOwnerMaximum {
    highest: Option<IntervalOwnerEnd>,
    second_highest: Option<IntervalOwnerEnd>,
}

impl TwoOwnerMaximum {
    fn insert(&mut self, candidate: IntervalOwnerEnd) {
        if self
            .highest
            .is_some_and(|entry| entry.owner == candidate.owner)
        {
            if self
                .highest
                .is_some_and(|entry| candidate.to_mm > entry.to_mm)
            {
                self.highest = Some(candidate);
            }
            return;
        }
        if self
            .second_highest
            .is_some_and(|entry| entry.owner == candidate.owner)
        {
            if self
                .second_highest
                .is_some_and(|entry| candidate.to_mm > entry.to_mm)
            {
                self.second_highest = Some(candidate);
                if self
                    .highest
                    .zip(self.second_highest)
                    .is_some_and(|(highest, second)| second.to_mm > highest.to_mm)
                {
                    std::mem::swap(&mut self.highest, &mut self.second_highest);
                }
            }
            return;
        }
        match self.highest {
            None => self.highest = Some(candidate),
            Some(highest) if candidate.to_mm > highest.to_mm => {
                self.second_highest = Some(highest);
                self.highest = Some(candidate);
            }
            Some(_) => {
                if self
                    .second_highest
                    .is_none_or(|second| candidate.to_mm > second.to_mm)
                {
                    self.second_highest = Some(candidate);
                }
            }
        }
    }

    fn merge(&mut self, other: Self) {
        if let Some(highest) = other.highest {
            self.insert(highest);
        }
        if let Some(second_highest) = other.second_highest {
            self.insert(second_highest);
        }
    }

    fn highest_except(self, owner: usize) -> Option<i64> {
        self.highest
            .filter(|entry| entry.owner != owner)
            .or_else(|| self.second_highest.filter(|entry| entry.owner != owner))
            .map(|entry| entry.to_mm)
    }
}

fn cross_train_interval_overlap<'a>(
    intervals: impl IntoIterator<Item = (usize, &'a TrackInterval)>,
) -> bool {
    let mut indexed: Vec<(usize, &TrackInterval)> = intervals.into_iter().collect();
    indexed.sort_unstable_by(|left, right| {
        left.1
            .edge_id
            .cmp(&right.1.edge_id)
            .then_with(|| left.1.from_mm.cmp(&right.1.from_mm))
            .then_with(|| left.1.to_mm.cmp(&right.1.to_mm))
            .then_with(|| left.0.cmp(&right.0))
    });

    let mut edge_start = 0;
    while edge_start < indexed.len() {
        let mut edge_end = edge_start + 1;
        while edge_end < indexed.len()
            && indexed[edge_end].1.edge_id == indexed[edge_start].1.edge_id
        {
            edge_end += 1;
        }

        let mut starts: Vec<i64> = indexed[edge_start..edge_end]
            .iter()
            .map(|(_, interval)| interval.from_mm)
            .collect();
        starts.dedup();
        let mut prefix_maxima = vec![TwoOwnerMaximum::default(); starts.len() + 1];

        for (owner, interval) in &indexed[edge_start..edge_end] {
            // Fuer ein zuvor einsortiertes Intervall `left` gilt exakt dann
            // `left.overlaps(interval)`, wenn beide strikten Bedingungen
            // `left.from_mm < interval.to_mm` und
            // `interval.from_mm < left.to_mm` erfuellt sind. Der Fenwick-Index
            // liefert dafuer das groesste `to_mm` eines anderen Zuges aus dem
            // passenden Praefix der Startkoordinaten.
            let mut prefix_index = starts.partition_point(|from_mm| *from_mm < interval.to_mm);
            let mut maximum = TwoOwnerMaximum::default();
            while prefix_index > 0 {
                maximum.merge(prefix_maxima[prefix_index]);
                prefix_index &= prefix_index - 1;
            }
            if maximum
                .highest_except(*owner)
                .is_some_and(|to_mm| interval.from_mm < to_mm)
            {
                return true;
            }

            let mut update_index = starts
                .binary_search(&interval.from_mm)
                .expect("Intervallstart stammt aus dem komprimierten Index")
                + 1;
            while update_index < prefix_maxima.len() {
                prefix_maxima[update_index].insert(IntervalOwnerEnd {
                    owner: *owner,
                    to_mm: interval.to_mm,
                });
                update_index += update_index & update_index.wrapping_neg();
            }
        }

        edge_start = edge_end;
    }
    false
}

fn cross_train_route_lock_overlap<'a>(locks: impl IntoIterator<Item = &'a RouteLock>) -> bool {
    let mut owner_by_resource: BTreeMap<&str, &str> = BTreeMap::new();
    for lock in locks {
        for resource in &lock.resources {
            if let Some(owner) = owner_by_resource.get(resource.as_str()) {
                if *owner != lock.train_id {
                    return true;
                }
            } else {
                owner_by_resource.insert(resource, &lock.train_id);
            }
        }
    }
    false
}

fn continuation_graph_reaches(graph: &BTreeMap<&str, &str>, source: &str, target: &str) -> bool {
    let mut cursor = source;
    let mut visited = BTreeSet::new();
    while cursor != target {
        if !visited.insert(cursor) {
            return false;
        }
        let Some(next) = graph.get(cursor) else {
            return false;
        };
        cursor = next;
    }
    true
}

fn canonical_continuation_intervals(
    intervals: &[TrackInterval],
    reverse_direction: bool,
) -> Vec<TrackInterval> {
    let mut canonical = intervals
        .iter()
        .cloned()
        .map(|mut interval| {
            if reverse_direction {
                interval.direction = match interval.direction {
                    Direction::Along => Direction::Against,
                    Direction::Against => Direction::Along,
                };
            }
            interval
        })
        .collect::<Vec<_>>();
    canonical.sort();
    canonical
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PhysicalRouteSpan {
    edge_id: String,
    direction: Direction,
    from_mm: i64,
    to_mm: i64,
    block_ids: BTreeSet<String>,
    available_protection_systems: Vec<String>,
    simultaneously_required_protection_systems: Vec<String>,
}

fn spans_are_contiguous(
    direction: Direction,
    left_from_mm: i64,
    left_to_mm: i64,
    right_from_mm: i64,
    right_to_mm: i64,
) -> bool {
    match direction {
        Direction::Along => left_to_mm == right_from_mm,
        Direction::Against => left_from_mm == right_to_mm,
    }
}

fn physical_route_contract(route: &RouteVersion) -> Vec<PhysicalRouteSpan> {
    let mut result = Vec::<PhysicalRouteSpan>::new();
    for leg in &route.legs {
        let candidate = PhysicalRouteSpan {
            edge_id: leg.edge_id.clone(),
            direction: leg.direction,
            from_mm: leg.edge_entry_mm.min(leg.edge_exit_mm),
            to_mm: leg.edge_entry_mm.max(leg.edge_exit_mm),
            block_ids: leg.block_ids.clone(),
            available_protection_systems: leg.available_protection_systems.clone(),
            simultaneously_required_protection_systems: leg
                .simultaneously_required_protection_systems
                .clone(),
        };
        if let Some(previous) = result.last_mut()
            && previous.edge_id == candidate.edge_id
            && previous.direction == candidate.direction
            && previous.block_ids == candidate.block_ids
            && previous.available_protection_systems == candidate.available_protection_systems
            && previous.simultaneously_required_protection_systems
                == candidate.simultaneously_required_protection_systems
            && spans_are_contiguous(
                previous.direction,
                previous.from_mm,
                previous.to_mm,
                candidate.from_mm,
                candidate.to_mm,
            )
        {
            previous.from_mm = previous.from_mm.min(candidate.from_mm);
            previous.to_mm = previous.to_mm.max(candidate.to_mm);
        } else {
            result.push(candidate);
        }
    }
    result
}

fn merge_track_intervals_in_route_order(intervals: Vec<TrackInterval>) -> Vec<TrackInterval> {
    let mut result = Vec::<TrackInterval>::new();
    for candidate in intervals {
        if let Some(previous) = result.last_mut()
            && previous.edge_id == candidate.edge_id
            && previous.direction == candidate.direction
            && spans_are_contiguous(
                previous.direction,
                previous.from_mm,
                previous.to_mm,
                candidate.from_mm,
                candidate.to_mm,
            )
        {
            previous.from_mm = previous.from_mm.min(candidate.from_mm);
            previous.to_mm = previous.to_mm.max(candidate.to_mm);
        } else {
            result.push(candidate);
        }
    }
    result
}

fn physically_equivalent_predecessor_routes(
    actual: &RouteVersion,
    base: &RouteVersion,
    formation_length_mm: i64,
) -> Result<bool, OperationalError> {
    if actual.length_mm() != base.length_mm()
        || formation_length_mm <= 0
        || formation_length_mm > actual.length_mm()
        || physical_route_contract(actual) != physical_route_contract(base)
    {
        return Ok(false);
    }
    let terminal_start_mm = actual
        .length_mm()
        .checked_sub(formation_length_mm)
        .ok_or(OperationalError::ArithmeticOverflow)?;
    Ok(merge_track_intervals_in_route_order(intervals_for(
        actual,
        terminal_start_mm,
        actual.length_mm(),
    )?) == merge_track_intervals_in_route_order(intervals_for(
        base,
        terminal_start_mm,
        base.length_mm(),
    )?))
}

fn occupied_interval_length_mm(
    intervals: &[TrackInterval],
) -> Result<RouteMillimetres, OperationalError> {
    intervals.iter().try_fold(0_i64, |total, interval| {
        let length = interval
            .to_mm
            .checked_sub(interval.from_mm)
            .ok_or(OperationalError::ArithmeticOverflow)?;
        if length <= 0 {
            return Err(OperationalError::UnsafeState);
        }
        total
            .checked_add(length)
            .ok_or(OperationalError::ArithmeticOverflow)
    })
}

fn movement_continuation_payload_hash(continuation: &MovementContinuation) -> String {
    let bytes = serde_json::to_vec(continuation)
        .expect("MovementContinuation besitzt nur serialisierbare Vertragsfelder");
    let mut hash = StateHasher::new("movement-continuation/v1");
    hash.bytes("canonical-json", &bytes);
    hash.finish().to_hex()
}

impl OperationalWorld {
    pub fn new(
        world_id: impl Into<String>,
        region_id: impl Into<String>,
        now_ms: SimMillis,
        infra: OperationalInfraRelease,
    ) -> Result<Self, OperationalError> {
        let infra = InMemoryOperationalInfrastructure::new(infra)?;
        Self::new_with_infrastructure(world_id, region_id, now_ms, Arc::new(infra))
    }

    pub fn new_with_infrastructure(
        world_id: impl Into<String>,
        region_id: impl Into<String>,
        now_ms: SimMillis,
        infra: Arc<dyn OperationalInfrastructure>,
    ) -> Result<Self, OperationalError> {
        infra.validate_attachment()?;
        if infra.release_id().is_empty() {
            return Err(OperationalError::IncompleteInfraRelease);
        }
        Ok(Self {
            world_id: world_id.into(),
            region_id: region_id.into(),
            infra_release_id: infra.release_id().to_owned(),
            now_ms,
            commit_sequence: 0,
            event_sequence: 0,
            trains: BTreeMap::new(),
            vehicles: BTreeMap::new(),
            vehicle_types: BTreeMap::new(),
            formations: BTreeMap::new(),
            route_locks: BTreeMap::new(),
            // Halt ist der statische Grundzustand jedes Signals und wird nicht
            // millionenfach in dynamischen Checkpoints wiederholt. Diese Map
            // enthaelt ausschliesslich betriebliche Abweichungen.
            signal_aspects: BTreeMap::new(),
            switch_positions: BTreeMap::new(),
            resource_lifecycle: BTreeMap::new(),
            active_disruptions: BTreeMap::new(),
            events: Vec::new(),
            processed_command_ids: BTreeSet::new(),
            infra: Some(AttachedOperationalInfrastructure(infra)),
            scheduled_motion_ends: BTreeSet::new(),
            scheduled_passenger_departures: BTreeSet::new(),
            scheduled_continuation_due: BTreeSet::new(),
            waiting_by_resource: BTreeMap::new(),
            continuations_waiting_by_resource: BTreeMap::new(),
            pending_dispatch_requests: BTreeMap::new(),
            pending_movement_continuations: BTreeMap::new(),
            completed_movement_continuations: BTreeMap::new(),
            route_completed_at_ms: BTreeMap::new(),
            service_outcome_state: None,
            prepared_handovers: BTreeMap::new(),
            accepted_handovers: BTreeMap::new(),
            finished_handovers: BTreeMap::new(),
            handover_protection_by_train: BTreeMap::new(),
        })
    }

    pub fn attach_infrastructure(
        &mut self,
        infra: Arc<dyn OperationalInfrastructure>,
    ) -> Result<(), OperationalError> {
        infra.validate_attachment()?;
        if infra.release_id() != self.infra_release_id {
            return Err(OperationalError::ForeignInfrastructureBinding);
        }
        self.infra = Some(AttachedOperationalInfrastructure(infra));
        for train in self.trains.values() {
            if self
                .infrastructure()?
                .route_version(&train.route_version_id)?
                .is_none()
            {
                return Err(OperationalError::UnknownRoute(
                    train.route_version_id.clone(),
                ));
            }
        }
        for lock in self.route_locks.values() {
            if self
                .infrastructure()?
                .interlocking_route(&lock.template_id)?
                .is_none()
            {
                return Err(OperationalError::UnknownInterlockingRoute(
                    lock.template_id.clone(),
                ));
            }
        }
        self.verify_invariants()?;
        Ok(())
    }

    fn infrastructure(&self) -> Result<&dyn OperationalInfrastructure, OperationalError> {
        self.infra
            .as_ref()
            .map(|infra| infra.0.as_ref())
            .ok_or(OperationalError::MissingInfrastructureBinding)
    }

    fn record(
        &mut self,
        kind: &str,
        subject_id: &str,
        detail: impl Into<String>,
    ) -> Result<(), OperationalError> {
        if self.events.len() >= MAX_PENDING_OPERATIONAL_EVENTS {
            return Err(OperationalError::EventBudgetExceeded);
        }
        self.event_sequence = self
            .event_sequence
            .checked_add(1)
            .ok_or(OperationalError::ArithmeticOverflow)?;
        self.events.push(OperationalEvent {
            event_sequence: self.event_sequence,
            // Initialisierungsereignisse gehoeren zu Commit 0. Die Runtime
            // bindet neue Ereignisse nach erfolgreichem Kommando atomar an
            // genau den folgenden Commit.
            commit_sequence: self.commit_sequence,
            at_ms: self.now_ms,
            kind: kind.to_owned(),
            subject_id: subject_id.to_owned(),
            detail: detail.into(),
        });
        Ok(())
    }

    /// Schliesst genau ein erfolgreich angewendetes Runtime-Kommando ab.
    /// Alle seit dem letzten Commit entstandenen Fachereignisse werden an
    /// denselben atomaren Commit gebunden; ereignislose Kommandos zaehlen
    /// trotzdem genau einmal.
    pub fn commit_runtime_command(&mut self) -> Result<u64, OperationalError> {
        self.commit_sequence = self
            .commit_sequence
            .checked_add(1)
            .ok_or(OperationalError::ArithmeticOverflow)?;
        for event in &mut self.events {
            event.commit_sequence = self.commit_sequence;
        }
        Ok(self.commit_sequence)
    }

    /// Registriert einen vollstaendigen Fahrzeugtyp. Laufzeit-Fallbacks gibt es nicht.
    pub fn register_vehicle_type(
        &mut self,
        vehicle_type: VehicleType,
        powered: bool,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        vehicle_type.validate(powered)?;
        if self.vehicle_types.contains_key(&vehicle_type.id) {
            return Err(OperationalError::DuplicateId(vehicle_type.id));
        }
        self.vehicle_types
            .insert(vehicle_type.id.clone(), vehicle_type);
        Ok(())
    }

    pub fn register_vehicle(&mut self, vehicle: PhysicalVehicle) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let Some(vehicle_type) = self.vehicle_types.get(&vehicle.type_id) else {
            return Err(OperationalError::UnknownVehicleType(vehicle.type_id));
        };
        vehicle_type.validate(vehicle.powered)?;
        if self.vehicles.insert(vehicle.id.clone(), vehicle).is_some() {
            return Err(OperationalError::DuplicateId("vehicle".to_owned()));
        }
        Ok(())
    }

    fn derive_formation(
        &self,
        id: String,
        predecessor_id: Option<String>,
        vehicle_ids: Vec<String>,
    ) -> Result<FormationVersion, OperationalError> {
        if id.is_empty() || vehicle_ids.is_empty() {
            return Err(OperationalError::InvalidFormation(id));
        }
        let mut length = 0_u64;
        let mut mass = 0_u64;
        let mut maximum_speed = u32::MAX;
        let mut power = 0_u64;
        let mut acceleration = 0_u32;
        let mut service_brake = u32::MAX;
        let mut emergency_brake = u32::MAX;
        let mut raw_starting_tractive_force = 0_u64;
        let mut raw_brake_weight = 0_u64;
        let mut raw_acceleration_cap = u32::MAX;
        let mut raw_service_brake_cap = u32::MAX;
        let mut raw_emergency_brake_multiplier = u16::MAX;
        let mut restricted_service_brake = u32::MAX;
        let mut restricted_emergency_brake = u32::MAX;
        let mut legacy_powered_protection: Option<BTreeSet<String>> = None;
        let mut front_tip_protection = BTreeSet::new();
        let mut front_control_stand_available = false;
        let mut rear_control_stand_available = false;
        let mut explicit_metadata: Option<bool> = None;
        let mut powered_configuration: Option<(
            OperationalVehicleTraction,
            &[OperationalPowerSystem],
        )> = None;
        let mut has_usable_drive = false;
        let mut seen = BTreeSet::new();
        for (index, vehicle_id) in vehicle_ids.iter().enumerate() {
            if !seen.insert(vehicle_id) {
                return Err(OperationalError::InvalidFormation(id));
            }
            let vehicle = self
                .vehicles
                .get(vehicle_id)
                .ok_or_else(|| OperationalError::UnknownVehicle(vehicle_id.clone()))?;
            let kind = self
                .vehicle_types
                .get(&vehicle.type_id)
                .ok_or_else(|| OperationalError::UnknownVehicleType(vehicle.type_id.clone()))?;
            let vehicle_has_explicit_metadata = kind.role.is_some();
            match explicit_metadata {
                None => explicit_metadata = Some(vehicle_has_explicit_metadata),
                Some(expected) if expected != vehicle_has_explicit_metadata => {
                    // Der Legacy-Pfad darf explizite Fuehrerstandsdaten nicht
                    // teilweise ueberstimmen oder umgehen.
                    return Err(OperationalError::InvalidFormation(id));
                }
                Some(_) => {}
            }
            if vehicle_has_explicit_metadata && vehicle.powered {
                let traction = kind
                    .traction
                    .expect("validierter expliziter Typ besitzt Traktion");
                let electric_systems = kind
                    .electric_systems
                    .as_deref()
                    .expect("validierter expliziter Typ besitzt Stromsysteme");
                if let Some((expected_traction, expected_systems)) = powered_configuration {
                    if traction != expected_traction || electric_systems != expected_systems {
                        return Err(OperationalError::InvalidFormation(id));
                    }
                } else {
                    powered_configuration = Some((traction, electric_systems));
                }
            }
            if vehicle_has_explicit_metadata {
                length = length
                    .checked_add(u64::from(kind.length_mm))
                    .ok_or(OperationalError::ArithmeticOverflow)?;
                mass = mass
                    .checked_add(kind.mass_kg)
                    .ok_or(OperationalError::ArithmeticOverflow)?;
                let raw = kind
                    .raw_formation_dynamics
                    .expect("validierter expliziter Typ besitzt Rohdynamik");
                raw_brake_weight = raw_brake_weight
                    .checked_add(raw.brake_weight_kg)
                    .ok_or(OperationalError::ArithmeticOverflow)?;
                raw_service_brake_cap = raw_service_brake_cap.min(raw.service_brake_cap_mmps2);
                raw_emergency_brake_multiplier =
                    raw_emergency_brake_multiplier.min(raw.emergency_brake_multiplier_basis_points);
            } else {
                length = length.saturating_add(u64::from(kind.length_mm));
                mass = mass.saturating_add(kind.mass_kg);
            }
            maximum_speed = maximum_speed.min(kind.maximum_speed_mmps);
            service_brake = service_brake.min(kind.service_brake_mmps2);
            emergency_brake = emergency_brake.min(kind.emergency_brake_mmps2);
            let mut vehicle_power = kind.power_watts;
            let mut vehicle_protection = kind.protection_systems.clone();
            let mut immobilized = false;
            for restriction in vehicle.restrictions.values() {
                match restriction {
                    VehicleRestriction::PowerBasisPoints(bp) => {
                        if vehicle.powered {
                            if vehicle_has_explicit_metadata
                                && (*bp == 0 || *bp > FORMATION_DYNAMICS_BASIS_POINTS)
                            {
                                return Err(OperationalError::InvalidFormation(id));
                            }
                            // Fleet Authority fuehrt Leistung in ganzen kW.
                            // Deshalb ist das kW-Raster Teil des gemeinsamen
                            // Vertrags und wird vor jeder assetlokalen
                            // Basispunktrestriktion angewandt.
                            vehicle_power = if vehicle_has_explicit_metadata {
                                (vehicle_power / 1_000)
                                    .checked_mul(u64::from(*bp))
                                    .ok_or(OperationalError::ArithmeticOverflow)?
                                    / u64::from(FORMATION_DYNAMICS_BASIS_POINTS)
                                    * 1_000
                            } else {
                                ((vehicle_power / 1_000).saturating_mul(u64::from(*bp)) / 10_000)
                                    .saturating_mul(1_000)
                            };
                        }
                    }
                    VehicleRestriction::MaximumSpeed(speed) => {
                        maximum_speed = maximum_speed.min(*speed)
                    }
                    VehicleRestriction::ServiceBrake(brake) => {
                        service_brake = service_brake.min(*brake);
                        restricted_service_brake = restricted_service_brake.min(*brake);
                    }
                    VehicleRestriction::EmergencyBrake(brake) => {
                        emergency_brake = emergency_brake.min(*brake);
                        restricted_emergency_brake = restricted_emergency_brake.min(*brake);
                    }
                    VehicleRestriction::ProtectionUnavailable(system) => {
                        vehicle_protection.remove(system);
                    }
                    VehicleRestriction::Immobilized => immobilized = true,
                    VehicleRestriction::DoorAvailabilityBasisPoints(_) => {}
                }
            }
            if vehicle.powered && (immobilized || vehicle_power == 0) {
                vehicle_protection.clear();
            }
            if let Some(control_stands) = kind.control_stands {
                if index == 0 {
                    front_control_stand_available =
                        control_stands.at_formation_front(vehicle.orientation);
                    front_tip_protection = vehicle_protection.clone();
                }
                if index + 1 == vehicle_ids.len() {
                    rear_control_stand_available =
                        control_stands.at_formation_rear(vehicle.orientation);
                }
            }
            if vehicle.powered && !immobilized && vehicle_power > 0 {
                has_usable_drive = true;
                power = if vehicle_has_explicit_metadata {
                    power
                        .checked_add(vehicle_power)
                        .ok_or(OperationalError::ArithmeticOverflow)?
                } else {
                    power.saturating_add(vehicle_power)
                };
                if vehicle_has_explicit_metadata {
                    // PowerBasisPoints schraenkt die kontinuierliche Leistung
                    // auf dem Authority-kW-Raster ein. Die belegte
                    // Anfahrzugkraft bleibt bei positiver Restleistung
                    // unveraendert; erst null kW oder Immobilized nimmt den
                    // Antrieb vollstaendig aus der Rohsumme.
                    raw_starting_tractive_force = raw_starting_tractive_force
                        .checked_add(u64::from(kind.starting_tractive_force_newtons))
                        .ok_or(OperationalError::ArithmeticOverflow)?;
                    raw_acceleration_cap = raw_acceleration_cap.min(
                        kind.raw_formation_dynamics
                            .expect("validierter expliziter Typ besitzt Rohdynamik")
                            .maximum_acceleration_cap_mmps2,
                    );
                } else {
                    acceleration = acceleration.saturating_add(kind.maximum_acceleration_mmps2);
                }
                legacy_powered_protection = Some(match legacy_powered_protection {
                    None => vehicle_protection,
                    Some(existing) => existing
                        .intersection(&vehicle_protection)
                        .cloned()
                        .collect(),
                });
            }
        }
        let explicit_metadata = explicit_metadata.unwrap_or(false);
        let protection_systems = if explicit_metadata {
            if has_usable_drive && !front_control_stand_available {
                return Err(OperationalError::InvalidFormation(id));
            }
            if front_control_stand_available {
                front_tip_protection
            } else {
                BTreeSet::new()
            }
        } else {
            // Rueckwaertskompatibler Operational-v2-Altpfad: Alte Typen
            // kannten weder Rolle noch Fuehrerstaende und bleiben deshalb in
            // beiden Richtungen fahrbar, sobald ein nutzbarer Antrieb besteht.
            front_control_stand_available = has_usable_drive;
            rear_control_stand_available = has_usable_drive;
            legacy_powered_protection.unwrap_or_default()
        };
        if explicit_metadata {
            let raw_acceleration_cap = if has_usable_drive {
                raw_acceleration_cap
            } else {
                0
            };
            let derived = derive_formation_dynamics(FormationDynamicsDerivationInput {
                total_mass_kg: mass,
                effective_starting_tractive_force_newtons: raw_starting_tractive_force,
                total_brake_weight_kg: raw_brake_weight,
                maximum_acceleration_cap_mmps2: raw_acceleration_cap,
                service_brake_cap_mmps2: raw_service_brake_cap,
                emergency_brake_multiplier_basis_points: raw_emergency_brake_multiplier,
            })
            .map_err(|_| OperationalError::InvalidFormation(id.clone()))?;
            acceleration = derived.acceleration_mmps2;
            service_brake = derived.service_brake_mmps2.min(restricted_service_brake);
            emergency_brake = derived
                .emergency_brake_mmps2
                .min(restricted_emergency_brake);
            if service_brake == 0
                || emergency_brake == 0
                || emergency_brake <= service_brake
                || (has_usable_drive && acceleration == 0)
            {
                return Err(OperationalError::InvalidFormation(id));
            }
        }
        let length_mm = u32::try_from(length).map_err(|_| OperationalError::ArithmeticOverflow)?;
        Ok(FormationVersion {
            id,
            predecessor_id,
            vehicle_ids,
            performance: FormationPerformance {
                length_mm,
                mass_kg: mass,
                maximum_speed_mmps: maximum_speed,
                power_watts: power,
                acceleration_mmps2: acceleration,
                service_brake_mmps2: service_brake,
                emergency_brake_mmps2: emergency_brake,
                front_control_stand_available,
                rear_control_stand_available,
                protection_systems,
                mobile: has_usable_drive,
            },
        })
    }

    pub fn create_formation(
        &mut self,
        id: impl Into<String>,
        predecessor_id: Option<String>,
        vehicle_ids: Vec<String>,
    ) -> Result<FormationVersion, OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let formation = self.derive_formation(id.into(), predecessor_id, vehicle_ids)?;
        if self
            .formations
            .insert(formation.id.clone(), formation.clone())
            .is_some()
        {
            return Err(OperationalError::DuplicateId(formation.id));
        }
        self.record(
            "formation-version-created",
            &formation.id,
            "atomically-derived",
        )?;
        Ok(formation)
    }

    /// Materialisiert nur eine Fahrt mit lueckenlosem Laufweg und vollstaendiger Formation.
    pub fn validate_train_program_template(
        &self,
        train: &TrainMaterialization,
        dispatch_interlocking_route_id: &str,
    ) -> Result<(), OperationalError> {
        self.validate_train_program_template_with_evidence(train, dispatch_interlocking_route_id)
            .map(|_| ())
    }

    pub fn validate_train_program_template_with_evidence(
        &self,
        train: &TrainMaterialization,
        dispatch_interlocking_route_id: &str,
    ) -> Result<OperationalProgramTemplateValidation, OperationalError> {
        let predicates =
            self.inspect_train_program_template(train, dispatch_interlocking_route_id)?;
        if !predicates.is_valid() {
            return Err(OperationalError::InvalidProgramTemplate(train.id.clone()));
        }
        Ok(OperationalProgramTemplateValidation {
            resource_binding_count: predicates.resource_binding_count,
        })
    }

    /// Prueft alle unabhaengigen Bindungen einer Programmvorlage, ohne beim
    /// ersten booleschen Predicate abzubrechen. Aufloesungsfehler fuer Route,
    /// Formation oder Fahrstrasse bleiben harte Fehler.
    pub fn inspect_train_program_template(
        &self,
        train: &TrainMaterialization,
        dispatch_interlocking_route_id: &str,
    ) -> Result<OperationalProgramTemplatePredicates, OperationalError> {
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        route.validate()?;
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(train.formation_version_id.clone())
            })?;
        let selections =
            protection_mode_selection_runs(&route, &formation.performance.protection_systems)
                .unwrap_or_default();
        self.inspect_train_program_template_with_protection_modes(
            train,
            dispatch_interlocking_route_id,
            PROTECTION_MODE_SELECTION_POLICY_V1,
            &selections,
        )
    }

    /// Prueft die vom Builder signierte, kompakte Moduswahl gegen jede
    /// Laufwegkante und die aktive Zugspitze. Die Lauflaengencodierung muss
    /// exakt der deterministischen konservativen v1-Auswahl entsprechen.
    pub fn inspect_train_program_template_with_protection_modes(
        &self,
        train: &TrainMaterialization,
        dispatch_interlocking_route_id: &str,
        selection_policy: &str,
        selection_runs: &[ProtectionModeSelectionRun],
    ) -> Result<OperationalProgramTemplatePredicates, OperationalError> {
        self.validate_passenger_stop_plan(train)?;
        if train.id.is_empty()
            || operational_train_number_numeric_part(&train.train_number).is_none()
            || train.operator_id.is_empty()
            || dispatch_interlocking_route_id.is_empty()
        {
            return Err(OperationalError::UnsafeMaterialization(train.id.clone()));
        }
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        route.validate()?;
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(train.formation_version_id.clone())
            })?;
        let template = self
            .infrastructure()?
            .interlocking_route(dispatch_interlocking_route_id)?
            .ok_or_else(|| {
                OperationalError::UnknownInterlockingRoute(
                    dispatch_interlocking_route_id.to_owned(),
                )
            })?;
        let mut movement_route_templates = Vec::new();
        let mut authority_cursor = train.head_route_mm;
        if train.movement_kind == MovementKind::Train {
            let mut seen_authority_starts = BTreeSet::new();
            while authority_cursor < route.length_mm()
                && seen_authority_starts.insert(authority_cursor)
            {
                let Some(segment_template) = self
                    .infrastructure()?
                    .train_interlocking_route(&route.template_id, authority_cursor)?
                else {
                    break;
                };
                authority_cursor = segment_template.authority_end_route_mm;
                movement_route_templates.push(segment_template);
            }
        } else if template.authority_start_route_mm == train.head_route_mm {
            authority_cursor = template.authority_end_route_mm;
            movement_route_templates.push(template.clone());
        }
        let route_resources: BTreeSet<String> = movement_route_templates
            .iter()
            .flat_map(InterlockingRouteTemplate::all_resources)
            .collect();
        let expected_selections =
            protection_mode_selection_runs(&route, &formation.performance.protection_systems);
        Ok(OperationalProgramTemplatePredicates {
            formation_mobile: formation.performance.mobile,
            head_within_route: train.head_route_mm >= 0 && train.head_route_mm <= route.length_mm(),
            protection_compatible: expected_selections.is_some(),
            protection_mode_selection_policy_matches: selection_policy
                == PROTECTION_MODE_SELECTION_POLICY_V1,
            protection_mode_selections_match: expected_selections
                .as_deref()
                .is_some_and(|expected| expected == selection_runs),
            protection_mode_selection_runs: selection_runs.to_vec(),
            protection_mode_selection_count: route.legs.len(),
            movement_kind_matches: template.movement_kind == train.movement_kind
                && movement_route_templates
                    .iter()
                    .all(|segment| segment.movement_kind == train.movement_kind),
            route_template_matches: template.route_template_id == route.template_id
                && movement_route_templates.first().map(|segment| &segment.id)
                    == Some(&template.id)
                && movement_route_templates
                    .iter()
                    .all(|segment| segment.route_template_id == route.template_id),
            authority_path_resources_cover_route: route
                .legs
                .iter()
                .filter(|leg| leg.route_start_mm >= train.head_route_mm)
                .all(|leg| {
                    movement_route_templates.iter().any(|segment| {
                        segment.authority_start_route_mm == leg.route_start_mm
                            && segment.authority_end_route_mm == leg.route_end_mm()
                            && segment.path_resources == leg.block_ids
                    })
                }),
            authority_end_matches_route: authority_cursor == route.length_mm(),
            release_after_tail_within_authority: !movement_route_templates.is_empty()
                && movement_route_templates.iter().all(|segment| {
                    segment.release_after_tail_route_mm >= segment.authority_start_route_mm
                        && segment.release_after_tail_route_mm <= segment.authority_end_route_mm
                }),
            resource_binding_count: route_resources.len(),
        })
    }

    pub fn materialize(&mut self, input: TrainMaterialization) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        if self.trains.contains_key(&input.id) {
            return Err(OperationalError::DuplicateId(input.id));
        }
        self.validate_passenger_stop_plan(&input)?;
        let service_input = input.clone();
        let TrainMaterialization {
            stop_plan,
            service_outcome: _,
            id,
            train_number,
            operator_id,
            movement_kind,
            route_version_id,
            formation_version_id,
            head_route_mm,
            scheduled_departure_ms,
            public_passenger_stop,
        } = input;
        let train_number_numeric_part = operational_train_number_numeric_part(&train_number)
            .ok_or_else(|| OperationalError::InvalidTrainNumber(train_number.clone()))?;
        if self.trains.values().any(|train| {
            operational_train_number_numeric_part(&train.train_number)
                == Some(train_number_numeric_part)
        }) {
            return Err(OperationalError::DuplicateTrainNumber(
                train_number_numeric_part,
            ));
        }
        let route = self
            .infrastructure()?
            .route_version(&route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(route_version_id.clone()))?;
        route.validate()?;
        let formation = self
            .formations
            .get(&formation_version_id)
            .ok_or_else(|| OperationalError::UnknownFormation(formation_version_id.clone()))?;
        if !formation.performance.mobile || head_route_mm < 0 || head_route_mm > route.length_mm() {
            return Err(OperationalError::UnsafeMaterialization(id));
        }
        if !route_protection_compatible(&route, formation) {
            return Err(OperationalError::IncompatibleProtectionSystem(id));
        }
        self.ensure_vehicles_available(&id, &formation.vehicle_ids)?;
        let tail = head_route_mm.saturating_sub(i64::from(formation.performance.length_mm));
        let intervals = intervals_for(&route, tail, head_route_mm)?;
        self.ensure_intervals_free(&id, &intervals)?;
        let occupied_blocks = blocks_for(&route, tail, head_route_mm);
        let direction = route
            .leg_at(head_route_mm)
            .ok_or_else(|| OperationalError::IncompleteRoute(route.id.clone()))?
            .direction;
        let service_outcome =
            self.start_service_outcome(&service_input, &service_input.formation_version_id)?;
        let train = OperationalTrain {
            passenger_stops: stop_plan.map(OperationalPassengerStopProgress::new),
            service_outcome,
            id: id.clone(),
            train_number,
            operator_id,
            movement_kind,
            route_version_id,
            formation_version_id,
            head_route_mm,
            tail_route_mm: tail,
            speed_mmps: 0,
            direction,
            motion_state: MotionState::Standing,
            motion_segment: None,
            authority: None,
            occupied_intervals: intervals,
            occupied_blocks: occupied_blocks.clone(),
            scheduled_departure_ms,
            public_passenger_stop,
            waiting_reason: None,
        };
        if self.trains.insert(id.clone(), train).is_some() {
            return Err(OperationalError::DuplicateId(id));
        }
        for block in occupied_blocks {
            self.resource_lifecycle
                .insert(block, ResourceLifecycle::OccupiedByFormation);
        }
        self.record("movement-materialized", &id, "exact-route-and-formation")?;
        self.record_passenger_arrival(&id)?;
        self.refresh_route_completion(&id)?;
        self.progress_movement_continuations()?;
        Ok(())
    }

    /// Rust-interne Ergonomiegrenze fuer fachliche Szenarien. Die persistierte
    /// und native Grenze verwendet ausschliesslich [`TrainMaterialization`].
    #[allow(
        clippy::too_many_arguments,
        reason = "Szenariohelfer spiegelt das typisierte Materialisierungskommando feldgenau"
    )]
    pub fn materialize_train(
        &mut self,
        id: impl Into<String>,
        train_number: impl Into<String>,
        operator_id: impl Into<String>,
        movement_kind: MovementKind,
        route_version_id: impl Into<String>,
        formation_version_id: impl Into<String>,
        head_route_mm: i64,
        scheduled_departure_ms: Option<i64>,
        public_passenger_stop: bool,
    ) -> Result<(), OperationalError> {
        self.materialize(TrainMaterialization {
            stop_plan: None,
            service_outcome: None,
            id: id.into(),
            train_number: train_number.into(),
            operator_id: operator_id.into(),
            movement_kind,
            route_version_id: route_version_id.into(),
            formation_version_id: formation_version_id.into(),
            head_route_mm,
            scheduled_departure_ms,
            public_passenger_stop,
        })
    }

    /// Entfernt eine vollstaendig beendete Fahrt, ohne Fahrzeug-, Belegungs-
    /// oder Fahrstrassenreste zu hinterlassen. Ein zu fruehes Retirement wird
    /// strikt abgelehnt; die Runtime kann dadurch den gesamten Tagesgrenzen-
    /// Batch atomar verwerfen.
    pub fn retire_train(&mut self, train_id: &str) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        if train.head_route_mm != route.length_mm()
            || train.speed_mmps != 0
            || train.motion_segment.is_some()
            || train.authority.is_some()
            || self
                .pending_movement_continuations
                .values()
                .any(|continuation| continuation.predecessor_train_id == train_id)
        {
            return Err(OperationalError::TrainNotRetirable(train_id.to_owned()));
        }

        // Eine Fahrstrasse mit Freigabepunkt am Laufwegende kann bei positiver
        // Zuglaenge nicht mehr durch die Schlussfreigabe erreicht werden: Der
        // Zugkopf darf das Laufwegende nicht ueberfahren. Solche bis zum Ende
        // schuetzenden Locks werden deshalb erst hier gemeinsam mit dem
        // vollstaendig beendeten Zug freigegeben. Alle Signalreferenzen werden
        // vor der ersten Mutation aufgeloest, damit ein defekter Infra-Anhang
        // nicht zu einer teilweisen Freigabe fuehren kann.
        let (retiring_lock_ids, retiring_signal_ids, retained_signal_ids, retiring_resources) = {
            let infrastructure = self.infrastructure()?;
            let mut retiring_lock_ids = BTreeSet::new();
            let mut retiring_signal_ids = BTreeSet::new();
            let mut retained_signal_ids = BTreeSet::new();
            let mut retiring_resources = BTreeSet::new();
            for lock in self.route_locks.values() {
                let template = infrastructure
                    .interlocking_route(&lock.template_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                    })?;
                if lock.train_id == train_id {
                    retiring_lock_ids.insert(lock.id.clone());
                    retiring_signal_ids.insert(template.signal_id);
                    retiring_resources.extend(lock.resources.iter().cloned());
                } else {
                    retained_signal_ids.insert(template.signal_id);
                }
            }
            (
                retiring_lock_ids,
                retiring_signal_ids,
                retained_signal_ids,
                retiring_resources,
            )
        };
        self.route_locks
            .retain(|lock_id, _| !retiring_lock_ids.contains(lock_id));
        for signal_id in retiring_signal_ids.difference(&retained_signal_ids) {
            self.signal_aspects.remove(signal_id);
        }
        self.trains.remove(train_id);
        self.scheduled_passenger_departures
            .retain(|entry| entry.train_id != train_id);
        self.handover_protection_by_train.remove(train_id);
        self.scheduled_motion_ends
            .retain(|scheduled| scheduled.train_id != train_id);
        self.pending_dispatch_requests.remove(train_id);
        self.route_completed_at_ms.remove(train_id);
        self.waiting_by_resource.retain(|_, waiting| {
            waiting.remove(train_id);
            !waiting.is_empty()
        });
        self.rebuild_resource_lifecycle();
        self.wake_movement_continuations_for_resources(&retiring_resources)?;
        self.record("movement-retired", train_id, "route-complete-and-released")?;
        self.progress_movement_continuations()?;
        self.dispatch_pending()?;
        Ok(())
    }

    fn ensure_intervals_free(
        &self,
        except_train_id: &str,
        intervals: &[TrackInterval],
    ) -> Result<(), OperationalError> {
        if self.trains.values().any(|train| {
            train.id != except_train_id
                && train
                    .occupied_intervals
                    .iter()
                    .any(|existing| intervals.iter().any(|new| existing.overlaps(new)))
        }) {
            Err(OperationalError::OccupiedTrack)
        } else {
            Ok(())
        }
    }

    fn ensure_vehicles_available(
        &self,
        except_train_id: &str,
        vehicle_ids: &[String],
    ) -> Result<(), OperationalError> {
        if self.trains.values().any(|train| {
            train.id != except_train_id
                && self
                    .formations
                    .get(&train.formation_version_id)
                    .is_some_and(|formation| {
                        formation
                            .vehicle_ids
                            .iter()
                            .any(|vehicle_id| vehicle_ids.contains(vehicle_id))
                    })
        }) {
            Err(OperationalError::VehicleAlreadyMaterialized)
        } else {
            Ok(())
        }
    }

    fn validate_continuation_intervals(
        &self,
        continuation: &MovementContinuation,
        predecessor_route_id: &str,
        predecessor_formation_id: &str,
        predecessor_intervals: &[TrackInterval],
    ) -> Result<
        (
            RouteVersion,
            Vec<TrackInterval>,
            BTreeSet<String>,
            Direction,
        ),
        OperationalError,
    > {
        if continuation.successor.formation_version_id != predecessor_formation_id {
            return Err(OperationalError::MovementContinuationFormationMismatch(
                continuation.id.clone(),
            ));
        }
        let formation = self
            .formations
            .get(predecessor_formation_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(predecessor_formation_id.to_owned())
            })?;
        let predecessor_route = self
            .infrastructure()?
            .route_version(predecessor_route_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(predecessor_route_id.to_owned()))?;
        let target_route = self
            .infrastructure()?
            .route_version(&continuation.successor.route_version_id)?
            .ok_or_else(|| {
                OperationalError::UnknownRoute(continuation.successor.route_version_id.clone())
            })?;
        if target_route.predecessor_id.as_deref()
            != Some(continuation.predecessor_base_route_version_id.as_str())
            || target_route.transition_route_mm != Some(continuation.successor.head_route_mm)
        {
            return Err(OperationalError::DiscontinuousMovementContinuation(
                continuation.id.clone(),
            ));
        }
        let formation_length = i64::from(formation.performance.length_mm);
        if continuation.predecessor_base_route_version_id != predecessor_route_id {
            let predecessor_base_route = self
                .infrastructure()?
                .route_version(&continuation.predecessor_base_route_version_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownRoute(
                        continuation.predecessor_base_route_version_id.clone(),
                    )
                })?;
            if !physically_equivalent_predecessor_routes(
                &predecessor_route,
                &predecessor_base_route,
                formation_length,
            )? {
                return Err(OperationalError::DiscontinuousMovementContinuation(
                    continuation.id.clone(),
                ));
            }
        }
        if continuation.successor.head_route_mm < formation_length
            || continuation.successor.head_route_mm >= target_route.length_mm()
        {
            return Err(OperationalError::DiscontinuousMovementContinuation(
                continuation.id.clone(),
            ));
        }
        let target_tail = continuation
            .successor
            .head_route_mm
            .checked_sub(formation_length)
            .ok_or(OperationalError::ArithmeticOverflow)?;
        let target_intervals = intervals_for(
            &target_route,
            target_tail,
            continuation.successor.head_route_mm,
        )?;
        if occupied_interval_length_mm(predecessor_intervals)? != formation_length
            || occupied_interval_length_mm(&target_intervals)? != formation_length
        {
            return Err(OperationalError::DiscontinuousMovementContinuation(
                continuation.id.clone(),
            ));
        }
        let expected = canonical_continuation_intervals(
            predecessor_intervals,
            continuation.continuity == MovementContinuity::ReverseDirection,
        );
        if expected != canonical_continuation_intervals(&target_intervals, false) {
            return Err(OperationalError::DiscontinuousMovementContinuation(
                continuation.id.clone(),
            ));
        }
        if continuation.continuity == MovementContinuity::ReverseDirection
            && (!formation.performance.front_control_stand_available
                || !formation.performance.rear_control_stand_available)
        {
            return Err(OperationalError::ReversalWithoutControlStands(
                continuation.id.clone(),
            ));
        }
        let direction = target_route
            .leg_at(continuation.successor.head_route_mm)
            .ok_or_else(|| OperationalError::IncompleteRoute(target_route.id.clone()))?
            .direction;
        let occupied_blocks = blocks_for(
            &target_route,
            target_tail,
            continuation.successor.head_route_mm,
        );
        Ok((target_route, target_intervals, occupied_blocks, direction))
    }

    fn known_continuation_predecessor(&self, train_id: &str) -> Option<(String, String, bool)> {
        if let Some(train) = self.trains.get(train_id) {
            return Some((
                train.route_version_id.clone(),
                train.formation_version_id.clone(),
                train.public_passenger_stop,
            ));
        }
        self.pending_movement_continuations
            .values()
            .find(|candidate| candidate.successor.id == train_id)
            .map(|candidate| {
                (
                    candidate.successor.route_version_id.clone(),
                    candidate.successor.formation_version_id.clone(),
                    candidate.successor.public_passenger_stop,
                )
            })
    }

    fn validate_known_continuation_binding(
        &self,
        continuation: &MovementContinuation,
    ) -> Result<(), OperationalError> {
        let Some((source_route_id, source_formation_id, source_public_passenger_stop)) =
            self.known_continuation_predecessor(&continuation.predecessor_train_id)
        else {
            return Ok(());
        };
        let expected_dwell_ms = if source_public_passenger_stop {
            300_000
        } else {
            0
        };
        if continuation.minimum_dwell_ms != expected_dwell_ms {
            return Err(OperationalError::InvalidMovementContinuationTimes(
                continuation.id.clone(),
            ));
        }
        let formation = self
            .formations
            .get(&source_formation_id)
            .ok_or_else(|| OperationalError::UnknownFormation(source_formation_id.clone()))?;
        let source_route = self
            .infrastructure()?
            .route_version(&source_route_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(source_route_id.clone()))?;
        let source_head = source_route.length_mm();
        let source_tail = source_head
            .checked_sub(i64::from(formation.performance.length_mm))
            .ok_or(OperationalError::ArithmeticOverflow)?;
        let source_intervals = intervals_for(&source_route, source_tail, source_head)?;
        self.validate_continuation_intervals(
            continuation,
            &source_route_id,
            &source_formation_id,
            &source_intervals,
        )?;
        Ok(())
    }

    /// Native statische Vorpruefung eines signierten Basisgraph-Links. Die
    /// spaetere Tagesinstanz erbt die tatsaechliche Formation des Vorgaengers;
    /// schon hier muessen damit Zielroute, Fahrstrasse, Zugsicherung und
    /// physische Terminalintervalle exakt funktionieren.
    pub fn validate_movement_continuation_template(
        &self,
        continuation_id: &str,
        predecessor: &TrainMaterialization,
        predecessor_base_route_version_id: &str,
        successor: &TrainMaterialization,
        successor_dispatch_interlocking_route_id: &str,
        continuity: MovementContinuity,
    ) -> Result<(), OperationalError> {
        let predecessor_formation = self
            .formations
            .get(&predecessor.formation_version_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(predecessor.formation_version_id.clone())
            })?;
        let predecessor_route = self
            .infrastructure()?
            .route_version(&predecessor.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(predecessor.route_version_id.clone()))?;
        let predecessor_head = predecessor_route.length_mm();
        let predecessor_tail = predecessor_head
            .checked_sub(i64::from(predecessor_formation.performance.length_mm))
            .ok_or(OperationalError::ArithmeticOverflow)?;
        let predecessor_intervals =
            intervals_for(&predecessor_route, predecessor_tail, predecessor_head)?;
        let mut physical_successor = successor.clone();
        physical_successor.formation_version_id = predecessor.formation_version_id.clone();
        self.validate_train_program_template(
            &physical_successor,
            successor_dispatch_interlocking_route_id,
        )?;
        let continuation = MovementContinuation {
            id: continuation_id.to_owned(),
            predecessor_train_id: predecessor.id.clone(),
            predecessor_base_route_version_id: predecessor_base_route_version_id.to_owned(),
            successor: physical_successor,
            successor_dispatch: DispatchRequest {
                train_id: successor.id.clone(),
                interlocking_route_id: successor_dispatch_interlocking_route_id.to_owned(),
                committed_rank: 0,
                timetable_deviation_ms: 0,
                passenger_impact: 0,
                contractual_impact: 0,
                network_impact: 0,
                resource_consequence: 0,
                recovery_rank: 0,
                waiting_since_ms: 0,
            },
            not_before_ms: 0,
            minimum_dwell_ms: 0,
            continuity,
        };
        self.validate_continuation_intervals(
            &continuation,
            &predecessor.route_version_id,
            &predecessor.formation_version_id,
            &predecessor_intervals,
        )?;
        Ok(())
    }

    fn validate_movement_continuation(
        &self,
        continuation: &MovementContinuation,
    ) -> Result<(), OperationalError> {
        if continuation.id.is_empty()
            || continuation.predecessor_train_id.is_empty()
            || continuation.predecessor_base_route_version_id.is_empty()
            || continuation.successor.id.is_empty()
            || continuation.successor.id == continuation.predecessor_train_id
            || continuation.not_before_ms < 0
            || continuation.minimum_dwell_ms < 0
            || continuation.successor_dispatch.train_id != continuation.successor.id
            || continuation
                .successor_dispatch
                .interlocking_route_id
                .is_empty()
            || continuation.successor_dispatch.waiting_since_ms != continuation.not_before_ms
            || (continuation.successor.public_passenger_stop
                && continuation.successor.scheduled_departure_ms
                    != Some(continuation.not_before_ms))
        {
            return Err(OperationalError::InvalidMovementContinuation(
                continuation.id.clone(),
            ));
        }
        self.validate_train_program_template(
            &continuation.successor,
            &continuation.successor_dispatch.interlocking_route_id,
        )?;
        if self.trains.contains_key(&continuation.successor.id) {
            return Err(OperationalError::MovementContinuationTargetOccupied(
                continuation.successor.id.clone(),
            ));
        }
        let successor_number =
            operational_train_number_numeric_part(&continuation.successor.train_number)
                .ok_or_else(|| {
                    OperationalError::InvalidTrainNumber(
                        continuation.successor.train_number.clone(),
                    )
                })?;
        if self
            .pending_movement_continuations
            .values()
            .any(|existing| {
                existing.predecessor_train_id == continuation.predecessor_train_id
                    || existing.successor.id == continuation.successor.id
            })
        {
            return Err(OperationalError::DuplicateMovementContinuationLink(
                continuation.id.clone(),
            ));
        }

        let mut outgoing: BTreeMap<&str, &str> = self
            .pending_movement_continuations
            .values()
            .map(|candidate| {
                (
                    candidate.predecessor_train_id.as_str(),
                    candidate.successor.id.as_str(),
                )
            })
            .collect();
        outgoing.insert(
            continuation.predecessor_train_id.as_str(),
            continuation.successor.id.as_str(),
        );
        let mut cursor = continuation.successor.id.as_str();
        let mut visited = BTreeSet::new();
        while let Some(next) = outgoing.get(cursor) {
            if *next == continuation.predecessor_train_id || !visited.insert(cursor) {
                return Err(OperationalError::CyclicMovementContinuation(
                    continuation.id.clone(),
                ));
            }
            cursor = next;
        }

        // Eine vorab gebundene Tageskette darf die Nummer eines noch lebenden
        // Vorfahren wiederverwenden. Jeder Weg bis zur unmittelbaren Quelle
        // muss bereits explizit gebunden sein; fremde aktive Nummern bleiben
        // gesperrt. Bei der Aktivierung gilt weiterhin die strikte Live-Pruefung.
        if self.trains.values().any(|train| {
            if operational_train_number_numeric_part(&train.train_number) != Some(successor_number)
            {
                return false;
            }
            !continuation_graph_reaches(&outgoing, &train.id, &continuation.predecessor_train_id)
        }) {
            return Err(OperationalError::MovementContinuationTargetOccupied(
                continuation.successor.id.clone(),
            ));
        }

        self.validate_known_continuation_binding(continuation)
    }

    /// Registriert eine explizite signierte Fortsetzung. Eine noch nicht
    /// materialisierte Quelle ist zulaessig, damit ganze Tagesketten vorab
    /// gebunden werden koennen; die physische Quelle wird spaetestens bei der
    /// Aktivierung gegen den unveraenderten Kettenvertrag geprueft.
    pub fn queue_movement_continuation(
        &mut self,
        continuation: MovementContinuation,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        if let Some(existing) = self.pending_movement_continuations.get(&continuation.id) {
            if existing != &continuation {
                return Err(OperationalError::ConflictingMovementContinuationId(
                    continuation.id,
                ));
            }
            let mut staged = self.clone();
            staged
                .continuations_waiting_by_resource
                .retain(|_, waiting| {
                    waiting.remove(&continuation.id);
                    !waiting.is_empty()
                });
            if let Some(predecessor) = staged.trains.get_mut(&continuation.predecessor_train_id)
                && predecessor.waiting_reason.as_deref()
                    == Some("waiting-for-movement-continuation")
            {
                predecessor.waiting_reason = None;
            }
            staged.refresh_continuation_schedule()?;
            staged.progress_movement_continuations()?;
            *self = staged;
            return Ok(());
        }
        if let Some(existing) = self.completed_movement_continuations.get(&continuation.id) {
            return if existing.payload_hash == movement_continuation_payload_hash(&continuation) {
                Ok(())
            } else {
                Err(OperationalError::ConflictingMovementContinuationId(
                    continuation.id,
                ))
            };
        }
        let mut staged = self.clone();
        staged.validate_movement_continuation(&continuation)?;
        staged.plan_service_outcome(&continuation.successor)?;
        let continuation_id = continuation.id.clone();
        let detail = format!(
            "from={};to={};continuity={}",
            continuation.predecessor_train_id,
            continuation.successor.id,
            continuation.continuity.contract_name()
        );
        staged
            .pending_movement_continuations
            .insert(continuation_id.clone(), continuation);
        let pending = staged
            .pending_movement_continuations
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for candidate in &pending {
            staged.validate_known_continuation_binding(candidate)?;
        }
        staged.record("movement-continuation-queued", &continuation_id, detail)?;
        staged.refresh_continuation_schedule()?;
        staged.progress_movement_continuations()?;
        *self = staged;
        Ok(())
    }

    fn physical_route_complete(&self, train_id: &str) -> Result<bool, OperationalError> {
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        Ok(train.head_route_mm == route.length_mm()
            && train.speed_mmps == 0
            && train.motion_segment.is_none()
            && train.authority.is_none())
    }

    fn refresh_route_completion(&mut self, train_id: &str) -> Result<(), OperationalError> {
        if self.physical_route_complete(train_id)? {
            self.complete_service_outcome(train_id)?;
            self.route_completed_at_ms
                .entry(train_id.to_owned())
                .or_insert(self.now_ms);
        } else {
            self.route_completed_at_ms.remove(train_id);
        }
        self.refresh_continuation_schedule()
    }

    fn refresh_continuation_schedule(&mut self) -> Result<(), OperationalError> {
        let mut scheduled = BTreeSet::new();
        for continuation in self.pending_movement_continuations.values() {
            if self
                .continuations_waiting_by_resource
                .values()
                .any(|waiting| waiting.contains(&continuation.id))
            {
                continue;
            }
            if self
                .trains
                .get(&continuation.predecessor_train_id)
                .is_none_or(|train| !matches!(train.motion_state, MotionState::Standing))
            {
                continue;
            }
            let Some(completed_at_ms) = self
                .route_completed_at_ms
                .get(&continuation.predecessor_train_id)
            else {
                continue;
            };
            let dwell_due = completed_at_ms
                .checked_add(continuation.minimum_dwell_ms)
                .ok_or_else(|| {
                    OperationalError::InvalidMovementContinuationTimes(continuation.id.clone())
                })?;
            scheduled.insert(ScheduledContinuationDue {
                at_ms: continuation.not_before_ms.max(dwell_due),
                continuation_id: continuation.id.clone(),
            });
        }
        self.scheduled_continuation_due = scheduled;
        Ok(())
    }

    fn register_movement_continuation_wait(
        &mut self,
        continuation: &MovementContinuation,
        resources: &BTreeSet<String>,
    ) {
        for resource in resources {
            self.continuations_waiting_by_resource
                .entry(resource.clone())
                .or_default()
                .insert(continuation.id.clone());
        }
        if let Some(predecessor) = self.trains.get_mut(&continuation.predecessor_train_id) {
            predecessor.waiting_reason = Some("waiting-for-movement-continuation".to_owned());
        }
    }

    fn wake_movement_continuations_for_resources(
        &mut self,
        resources: &BTreeSet<String>,
    ) -> Result<(), OperationalError> {
        let continuation_ids: BTreeSet<String> = resources
            .iter()
            .filter_map(|resource| self.continuations_waiting_by_resource.get(resource))
            .flatten()
            .cloned()
            .collect();
        if continuation_ids.is_empty() {
            return Ok(());
        }
        self.continuations_waiting_by_resource.retain(|_, waiting| {
            waiting.retain(|id| !continuation_ids.contains(id));
            !waiting.is_empty()
        });
        for continuation_id in continuation_ids {
            let Some(continuation) = self.pending_movement_continuations.get(&continuation_id)
            else {
                continue;
            };
            if let Some(predecessor) = self.trains.get_mut(&continuation.predecessor_train_id)
                && predecessor.waiting_reason.as_deref()
                    == Some("waiting-for-movement-continuation")
            {
                predecessor.waiting_reason = None;
            }
        }
        self.refresh_continuation_schedule()
    }

    fn activate_movement_continuation(
        &mut self,
        continuation_id: &str,
    ) -> Result<bool, OperationalError> {
        let continuation = self
            .pending_movement_continuations
            .get(continuation_id)
            .ok_or_else(|| {
                OperationalError::UnknownMovementContinuation(continuation_id.to_owned())
            })?
            .clone();
        let Some(predecessor) = self.trains.get(&continuation.predecessor_train_id).cloned() else {
            return Ok(false);
        };
        if !self.physical_route_complete(&predecessor.id)?
            || !matches!(predecessor.motion_state, MotionState::Standing)
        {
            return Ok(false);
        }
        let completed_at_ms = *self
            .route_completed_at_ms
            .get(&predecessor.id)
            .ok_or(OperationalError::UnsafeState)?;
        let due_ms = continuation.not_before_ms.max(
            completed_at_ms
                .checked_add(continuation.minimum_dwell_ms)
                .ok_or_else(|| {
                    OperationalError::InvalidMovementContinuationTimes(continuation.id.clone())
                })?,
        );
        if self.now_ms < due_ms {
            return Ok(false);
        }
        self.validate_train_program_template(
            &continuation.successor,
            &continuation.successor_dispatch.interlocking_route_id,
        )?;
        let (_target_route, target_intervals, mut target_blocks, target_direction) = self
            .validate_continuation_intervals(
                &continuation,
                &predecessor.route_version_id,
                &predecessor.formation_version_id,
                &predecessor.occupied_intervals,
            )?;
        if let Some(protection) = self.handover_protection_by_train.get(&predecessor.id) {
            target_blocks.extend(protection.iter().cloned());
        }
        let successor_number =
            operational_train_number_numeric_part(&continuation.successor.train_number)
                .ok_or_else(|| {
                    OperationalError::InvalidTrainNumber(
                        continuation.successor.train_number.clone(),
                    )
                })?;
        if self.trains.values().any(|train| {
            train.id != predecessor.id
                && (train.id == continuation.successor.id
                    || operational_train_number_numeric_part(&train.train_number)
                        == Some(successor_number))
        }) {
            return Err(OperationalError::MovementContinuationTargetOccupied(
                continuation.successor.id.clone(),
            ));
        }
        let mut temporarily_blocked_resources = BTreeSet::new();
        for train in self
            .trains
            .values()
            .filter(|train| train.id != predecessor.id)
        {
            let physically_overlaps = train.occupied_intervals.iter().any(|existing| {
                target_intervals
                    .iter()
                    .any(|target| existing.overlaps(target))
            });
            temporarily_blocked_resources
                .extend(train.occupied_blocks.intersection(&target_blocks).cloned());
            if physically_overlaps {
                temporarily_blocked_resources.extend(train.occupied_blocks.iter().cloned());
            }
        }
        for lock in self
            .route_locks
            .values()
            .filter(|lock| lock.train_id != predecessor.id)
        {
            temporarily_blocked_resources
                .extend(lock.resources.intersection(&target_blocks).cloned());
        }
        if !temporarily_blocked_resources.is_empty() {
            self.register_movement_continuation_wait(&continuation, &temporarily_blocked_resources);
            return Ok(false);
        }

        let predecessor_lock_ids: BTreeSet<String> = self
            .route_locks
            .values()
            .filter(|lock| lock.train_id == predecessor.id)
            .map(|lock| lock.id.clone())
            .collect();
        let released_resources: BTreeSet<String> = self
            .route_locks
            .iter()
            .filter(|(lock_id, _)| predecessor_lock_ids.contains(*lock_id))
            .flat_map(|(_, lock)| lock.resources.iter().cloned())
            .collect();
        self.route_locks
            .retain(|lock_id, _| !predecessor_lock_ids.contains(lock_id));
        self.trains.remove(&predecessor.id);
        if let Some(protection) = self.handover_protection_by_train.remove(&predecessor.id) {
            self.handover_protection_by_train
                .insert(continuation.successor.id.clone(), protection);
        }
        self.scheduled_motion_ends
            .retain(|scheduled| scheduled.train_id != predecessor.id);
        self.pending_dispatch_requests.remove(&predecessor.id);
        self.waiting_by_resource.retain(|_, waiting| {
            waiting.remove(&predecessor.id);
            !waiting.is_empty()
        });
        self.continuations_waiting_by_resource.retain(|_, waiting| {
            waiting.remove(&continuation.id);
            !waiting.is_empty()
        });
        self.route_completed_at_ms.remove(&predecessor.id);

        let formation_length = i64::from(
            self.formations[&predecessor.formation_version_id]
                .performance
                .length_mm,
        );
        let service_outcome =
            self.start_service_outcome(&continuation.successor, &predecessor.formation_version_id)?;
        let successor = OperationalTrain {
            passenger_stops: continuation
                .successor
                .stop_plan
                .clone()
                .map(OperationalPassengerStopProgress::new),
            service_outcome,
            id: continuation.successor.id.clone(),
            train_number: continuation.successor.train_number.clone(),
            operator_id: continuation.successor.operator_id.clone(),
            movement_kind: continuation.successor.movement_kind,
            route_version_id: continuation.successor.route_version_id.clone(),
            formation_version_id: predecessor.formation_version_id.clone(),
            head_route_mm: continuation.successor.head_route_mm,
            tail_route_mm: continuation
                .successor
                .head_route_mm
                .checked_sub(formation_length)
                .ok_or(OperationalError::ArithmeticOverflow)?,
            speed_mmps: 0,
            direction: target_direction,
            motion_state: MotionState::Standing,
            motion_segment: None,
            authority: None,
            occupied_intervals: target_intervals,
            occupied_blocks: target_blocks,
            scheduled_departure_ms: continuation.successor.scheduled_departure_ms,
            public_passenger_stop: continuation.successor.public_passenger_stop,
            waiting_reason: None,
        };
        self.trains.insert(successor.id.clone(), successor);
        self.pending_dispatch_requests.insert(
            continuation.successor.id.clone(),
            continuation.successor_dispatch.clone(),
        );
        self.pending_movement_continuations.remove(&continuation.id);
        let completion_sequence = self
            .event_sequence
            .checked_add(1)
            .ok_or(OperationalError::ArithmeticOverflow)?;
        self.completed_movement_continuations.insert(
            continuation.id.clone(),
            MovementContinuationReceipt {
                payload_hash: movement_continuation_payload_hash(&continuation),
                completed_at_ms: self.now_ms,
                completion_sequence,
            },
        );
        while self.completed_movement_continuations.len()
            > MAX_COMPLETED_MOVEMENT_CONTINUATION_RECEIPTS
        {
            let oldest = self
                .completed_movement_continuations
                .iter()
                .min_by(|(left_id, left), (right_id, right)| {
                    (left.completion_sequence, left_id.as_str())
                        .cmp(&(right.completion_sequence, right_id.as_str()))
                })
                .map(|(id, _)| id.clone())
                .expect("uebergrosses Continuation-Receiptfenster ist nicht leer");
            self.completed_movement_continuations.remove(&oldest);
        }
        self.record(
            "movement-continued",
            &continuation.successor.id,
            format!(
                "chain={};from={};to={};continuity={}",
                continuation.id,
                predecessor.id,
                continuation.successor.id,
                continuation.continuity.contract_name()
            ),
        )?;
        self.record_passenger_arrival(&continuation.successor.id)?;
        self.rebuild_resource_lifecycle();
        self.rebuild_signal_aspects()?;
        self.wake_movement_continuations_for_resources(&released_resources)?;
        self.refresh_route_completion(&continuation.successor.id)?;
        Ok(true)
    }

    fn progress_movement_continuations(&mut self) -> Result<Vec<String>, OperationalError> {
        let mut staged = self.clone();
        let mut activated = Vec::new();
        loop {
            staged.refresh_continuation_schedule()?;
            let due = staged
                .scheduled_continuation_due
                .iter()
                .take_while(|scheduled| scheduled.at_ms <= staged.now_ms)
                .map(|scheduled| scheduled.continuation_id.clone())
                .collect::<Vec<_>>();
            if due.is_empty() {
                break;
            }
            for continuation_id in due {
                if staged.activate_movement_continuation(&continuation_id)? {
                    activated.push(continuation_id);
                }
            }
        }
        staged.refresh_continuation_schedule()?;
        if !activated.is_empty() {
            staged.dispatch_pending()?;
        }
        *self = staged;
        Ok(activated)
    }

    /// Sicherheitslogik: leitet alle Bedingungen selbst aus dem Weltzustand ab.
    pub fn lock_route(
        &mut self,
        train_id: &str,
        template_id: &str,
    ) -> Result<MovementAuthority, OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        self.lock_route_at(train_id, template_id, false, true)
    }

    /// Verriegelt entweder eine neue Fahrstrasse am stehenden Zugkopf oder
    /// eine lueckenlose Fortsetzung am Ende der bereits gesicherten Authority.
    /// Die Fortsetzung wird nur vor Bewegungsbeginn vorgezogen; jeder Lock
    /// behaelt trotzdem seinen eigenen Zugschluss-Freigabepunkt.
    fn lock_route_at(
        &mut self,
        train_id: &str,
        template_id: &str,
        continuation: bool,
        register_wait: bool,
    ) -> Result<MovementAuthority, OperationalError> {
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        let template = self
            .infrastructure()?
            .interlocking_route(template_id)?
            .ok_or_else(|| OperationalError::UnknownInterlockingRoute(template_id.to_owned()))?;
        if template.movement_kind != train.movement_kind {
            return Err(OperationalError::WrongMovementKind);
        }
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(train.formation_version_id.clone())
            })?;
        let expected_start = if continuation {
            train
                .authority
                .as_ref()
                .map(|authority| authority.end_route_mm)
                .ok_or_else(|| OperationalError::UnsafeRoute(template_id.to_owned()))?
        } else {
            train.head_route_mm
        };
        let leg = route
            .leg_at(expected_start)
            .ok_or_else(|| OperationalError::IncompleteRoute(route.id.clone()))?;
        if route.template_id != template.route_template_id
            || template.authority_start_route_mm != expected_start
            || template.authority_end_route_mm <= expected_start
            || template.authority_end_route_mm > route.length_mm()
            || train.speed_mmps != 0
            || !matches!(train.motion_state, MotionState::Standing)
            || train.motion_segment.is_some()
            || (continuation != train.authority.is_some())
            || (continuation && train.movement_kind != MovementKind::Train)
            || !protection_systems_compatible(leg, &formation.performance.protection_systems)
        {
            return Err(OperationalError::UnsafeRoute(template_id.to_owned()));
        }
        let resources = template.all_resources();
        let disrupted = self.active_disruptions.values().any(|effect| match effect {
            OperationalDisruption::ResourceClosed { resource_id }
            | OperationalDisruption::TrackDetectionFailed { resource_id } => {
                resources.contains(resource_id)
            }
            OperationalDisruption::SignalFailed { signal_id } => signal_id == &template.signal_id,
            OperationalDisruption::SwitchFailed { switch_id } => {
                template.switch_positions.contains_key(switch_id)
            }
            OperationalDisruption::SpeedRestriction { .. }
            | OperationalDisruption::VehicleRestricted { .. } => false,
        });
        let incompatible_lock = self
            .route_locks
            .values()
            .any(|lock| lock.train_id != train_id && !lock.resources.is_disjoint(&resources));
        let occupied_by_other = self.trains.values().any(|candidate| {
            candidate.id != train_id && !candidate.occupied_blocks.is_disjoint(&resources)
        });
        if disrupted || incompatible_lock || occupied_by_other {
            if register_wait && self.pending_dispatch_requests.contains_key(train_id) {
                for resource in &resources {
                    self.waiting_by_resource
                        .entry(resource.clone())
                        .or_default()
                        .insert(train_id.to_owned());
                }
                self.trains
                    .get_mut(train_id)
                    .expect("train exists")
                    .waiting_reason = Some("waiting-for-route-lock".to_owned());
            }
            return Err(OperationalError::UnsafeRoute(template_id.to_owned()));
        }
        for (switch, position) in &template.switch_positions {
            self.switch_positions
                .insert(switch.clone(), position.clone());
        }
        let lock_id = format!(
            "{}:{}:{}",
            self.event_sequence
                .checked_add(1)
                .ok_or(OperationalError::ArithmeticOverflow)?,
            train_id,
            template_id
        );
        let lock = RouteLock {
            id: lock_id.clone(),
            template_id: template_id.to_owned(),
            train_id: train_id.to_owned(),
            resources: resources.clone(),
            release_after_tail_route_mm: template.release_after_tail_route_mm,
            locked_at_ms: self.now_ms,
        };
        for resource in &resources {
            self.resource_lifecycle
                .insert(resource.clone(), ResourceLifecycle::RouteLocked);
        }
        self.signal_aspects.insert(
            template.signal_id.clone(),
            if train.movement_kind == MovementKind::Train {
                SignalAspect::Proceed
            } else {
                SignalAspect::ShuntingProceed
            },
        );
        let authority = MovementAuthority {
            id: format!("authority:{lock_id}"),
            train_id: train_id.to_owned(),
            route_version_id: train.route_version_id.clone(),
            end_route_mm: template.authority_end_route_mm,
            issued_at_ms: self.now_ms,
            source_route_lock_id: lock_id.clone(),
        };
        self.route_locks.insert(lock_id, lock);
        self.trains
            .get_mut(train_id)
            .expect("train exists")
            .authority = Some(authority.clone());
        self.waiting_by_resource.retain(|_, waiting| {
            waiting.remove(train_id);
            !waiting.is_empty()
        });
        self.record("route-locked", train_id, template_id)?;
        Ok(authority)
    }

    /// Sichert vor dem Anfahren so viele lueckenlose Zugfahrstrassen wie
    /// konfliktfrei verfuegbar sind. Die gemeinsame Authority reicht dadurch
    /// bis zum ersten echten Konflikt, ohne die einzelnen Fahrstrassenlocks zu
    /// einem gesamthaften All-or-nothing-Lock zu verschmelzen.
    fn extend_available_train_authority(&mut self, train_id: &str) -> Result<(), OperationalError> {
        loop {
            let (route_template_id, authority_end_route_mm, route_length_mm) = {
                let train = self
                    .trains
                    .get(train_id)
                    .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
                let route = self
                    .infrastructure()?
                    .route_version(&train.route_version_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownRoute(train.route_version_id.clone())
                    })?;
                let authority_end_route_mm = train
                    .authority
                    .as_ref()
                    .ok_or(OperationalError::NoAuthority)?
                    .end_route_mm;
                let route_length_mm = route.length_mm();
                (route.template_id, authority_end_route_mm, route_length_mm)
            };
            if authority_end_route_mm == route_length_mm {
                return Ok(());
            }
            let Some(next) = self
                .infrastructure()?
                .train_interlocking_route(&route_template_id, authority_end_route_mm)?
            else {
                return Ok(());
            };
            match self.lock_route_at(train_id, &next.id, true, false) {
                Ok(_) => {}
                Err(OperationalError::UnsafeRoute(_)) => return Ok(()),
                Err(error) => return Err(error),
            }
        }
    }

    /// Deterministischer FDL: prueft Sicherheitsfaehigkeit und waehlt lexikographisch.
    pub fn dispatch(
        &mut self,
        requests: &[DispatchRequest],
    ) -> Result<Option<String>, OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let mut candidates = requests.iter().collect::<Vec<_>>();
        candidates.sort_by(|left, right| right.key(self.now_ms).cmp(&left.key(self.now_ms)));
        for candidate in candidates {
            if self.dispatch_candidate(candidate)? {
                return Ok(Some(candidate.train_id.clone()));
            }
        }
        Ok(None)
    }

    fn dispatch_candidate(
        &mut self,
        candidate: &DispatchRequest,
    ) -> Result<bool, OperationalError> {
        match self.lock_route(&candidate.train_id, &candidate.interlocking_route_id) {
            Ok(_) => {
                self.record(
                    "dispatcher-decision",
                    &candidate.train_id,
                    format!("route={};lexicographic=v1", candidate.interlocking_route_id),
                )?;
                Ok(true)
            }
            Err(OperationalError::UnsafeRoute(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Uebergibt Fahrten an den integrierten virtuellen Fahrdienstleiter. Nicht
    /// sichere Kandidaten bleiben im kanonischen Kernzustand vorgemerkt und
    /// werden ausschliesslich an fachlichen Freigabeereignissen erneut geprueft.
    pub fn submit_dispatch_requests(
        &mut self,
        requests: &[DispatchRequest],
    ) -> Result<Vec<String>, OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let mut submitted = BTreeMap::new();
        for request in requests {
            if submitted
                .insert(&request.train_id, request)
                .is_some_and(|existing| existing != request)
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
            if request.train_id.is_empty()
                || request.interlocking_route_id.is_empty()
                || request.waiting_since_ms > self.now_ms
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
            let train = self
                .trains
                .get(&request.train_id)
                .ok_or_else(|| OperationalError::UnknownTrain(request.train_id.clone()))?;
            if train.speed_mmps != 0
                || !matches!(train.motion_state, MotionState::Standing)
                || train.motion_segment.is_some()
                || train.authority.is_some()
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
            let template = self
                .infrastructure()?
                .interlocking_route(&request.interlocking_route_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownInterlockingRoute(
                        request.interlocking_route_id.clone(),
                    )
                })?;
            if template.movement_kind != train.movement_kind {
                return Err(OperationalError::WrongMovementKind);
            }
            let route = self
                .infrastructure()?
                .route_version(&train.route_version_id)?
                .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
            if template.route_template_id != route.template_id
                || template.authority_start_route_mm != train.head_route_mm
                || train.head_route_mm == route.length_mm()
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
            if train.movement_kind == MovementKind::Train
                && self
                    .infrastructure()?
                    .train_interlocking_route(&route.template_id, train.head_route_mm)?
                    .is_none_or(|indexed| indexed.id != request.interlocking_route_id)
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
            if self
                .pending_dispatch_requests
                .get(&request.train_id)
                .is_some_and(|existing| existing != request)
            {
                return Err(OperationalError::InvalidDispatchRequest(
                    request.train_id.clone(),
                ));
            }
        }
        for request in requests {
            self.pending_dispatch_requests
                .insert(request.train_id.clone(), request.clone());
        }
        self.dispatch_pending()
    }

    fn dispatch_pending(&mut self) -> Result<Vec<String>, OperationalError> {
        let requests = self.pending_dispatch_requests.values().cloned().collect();
        self.dispatch_pending_requests(requests)
    }

    fn dispatch_waiting_for_resources(
        &mut self,
        resources: &BTreeSet<String>,
    ) -> Result<Vec<String>, OperationalError> {
        let train_ids = resources
            .iter()
            .filter_map(|resource| self.waiting_by_resource.get(resource))
            .flat_map(|waiting| waiting.iter().cloned())
            .collect::<BTreeSet<_>>();
        let requests = train_ids
            .iter()
            .filter_map(|train_id| self.pending_dispatch_requests.get(train_id).cloned())
            .collect();
        self.dispatch_pending_requests(requests)
    }

    fn dispatch_pending_requests(
        &mut self,
        requests: Vec<DispatchRequest>,
    ) -> Result<Vec<String>, OperationalError> {
        let mut dispatched = Vec::new();
        let mut candidates = Vec::new();
        let mut completed = Vec::new();
        let mut missing_route = Vec::new();
        for mut request in requests {
            if request.waiting_since_ms > self.now_ms {
                continue;
            }
            let train = self
                .trains
                .get(&request.train_id)
                .ok_or_else(|| OperationalError::UnknownTrain(request.train_id.clone()))?;
            let route = self
                .infrastructure()?
                .route_version(&train.route_version_id)?
                .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
            if train.head_route_mm == route.length_mm() {
                completed.push(train.id.clone());
                continue;
            }
            if self.passenger_stop_waiting(&request.train_id) {
                continue;
            }
            if train.speed_mmps != 0
                || !matches!(train.motion_state, MotionState::Standing)
                || train.motion_segment.is_some()
                || train.authority.is_some()
            {
                continue;
            }
            let template = if train.movement_kind == MovementKind::Train {
                self.infrastructure()?
                    .train_interlocking_route(&route.template_id, train.head_route_mm)?
            } else {
                self.infrastructure()?
                    .interlocking_route(&request.interlocking_route_id)?
                    .filter(|template| template.authority_start_route_mm == train.head_route_mm)
            };
            let Some(template) = template else {
                missing_route.push(train.id.clone());
                continue;
            };
            request.interlocking_route_id = template.id;
            candidates.push(request);
        }
        for train_id in completed {
            self.pending_dispatch_requests.remove(&train_id);
            self.waiting_by_resource.retain(|_, waiting| {
                waiting.remove(&train_id);
                !waiting.is_empty()
            });
            if let Some(train) = self.trains.get_mut(&train_id)
                && matches!(
                    train.waiting_reason.as_deref(),
                    Some("waiting-for-route-lock" | "missing-route-authority")
                )
            {
                train.waiting_reason = None;
            }
        }
        for train_id in missing_route {
            self.waiting_by_resource.retain(|_, waiting| {
                waiting.remove(&train_id);
                !waiting.is_empty()
            });
            self.trains
                .get_mut(&train_id)
                .expect("pending train exists")
                .waiting_reason = Some("missing-route-authority".to_owned());
        }
        // Zuteilungen fuegen nur Locks hinzu. Ein zuvor unsicherer Kandidat
        // kann daher innerhalb dieses Batches nicht sicher werden; jede
        // Anfrage wird einmal in der unveraenderten Prioritaetsfolge geprueft.
        candidates.sort_by(|left, right| right.key(self.now_ms).cmp(&left.key(self.now_ms)));
        for candidate in candidates {
            if !self.dispatch_candidate(&candidate)? {
                continue;
            }
            let train_id = candidate.train_id;
            if self.trains[&train_id].movement_kind == MovementKind::Train {
                self.extend_available_train_authority(&train_id)?;
            }
            self.plan_motion(&train_id)?;
            dispatched.push(train_id);
        }
        Ok(dispatched)
    }

    /// Virtueller Lokfuehrer erzeugt den naechsten unveraenderlichen Abschnitt.
    pub fn plan_motion(&mut self, train_id: &str) -> Result<MotionSegment, OperationalError> {
        if self
            .prepared_handovers
            .values()
            .any(|handover| handover.train.id == train_id)
        {
            return Err(OperationalError::InvalidHandover);
        }
        if self.passenger_stop_waiting(train_id) {
            return Err(OperationalError::PassengerDepartureTooEarly);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(|| {
                OperationalError::UnknownFormation(train.formation_version_id.clone())
            })?;
        let route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        let authority = train
            .authority
            .as_ref()
            .ok_or(OperationalError::NoAuthority)?;
        if train.passenger_stops.is_some() && train.motion_segment.is_some() {
            return Err(OperationalError::UnsafeState);
        }
        let motion_end_route_mm = self
            .passenger_braking_target(train)
            .map_or(authority.end_route_mm, |stop| {
                stop.min(authority.end_route_mm)
            });
        if authority.route_version_id != train.route_version_id
            || authority.end_route_mm < train.head_route_mm
            || !formation.performance.mobile
        {
            self.safe_stop(train_id, "invalid-authority-or-formation")?;
            return Err(OperationalError::UnsafeState);
        }
        if train.public_passenger_stop
            && train
                .scheduled_departure_ms
                .is_some_and(|departure| self.now_ms < departure)
        {
            return Err(OperationalError::PassengerDepartureTooEarly);
        }
        let leg = route
            .leg_at(train.head_route_mm)
            .ok_or_else(|| OperationalError::IncompleteRoute(route.id.clone()))?;
        if !protection_systems_compatible(leg, &formation.performance.protection_systems) {
            self.safe_stop(train_id, "incompatible-protection-system")?;
            return Err(OperationalError::IncompatibleProtectionSystem(
                train_id.to_owned(),
            ));
        }
        let leg_limit = |profile: &RouteLeg| {
            let mut limit = profile
                .speed_limit_mmps
                .min(formation.performance.maximum_speed_mmps);
            if train.movement_kind == MovementKind::Shunting {
                limit = limit.min(SHUNTING_MAXIMUM_SPEED_MMPS);
            }
            for effect in self.active_disruptions.values() {
                if let OperationalDisruption::SpeedRestriction {
                    edge_id,
                    maximum_speed_mmps,
                } = effect
                    && edge_id == &profile.edge_id
                {
                    limit = limit.min(*maximum_speed_mmps);
                }
            }
            limit
        };
        // Eine Erhoehung gilt erst hinter dem Zugschluss; eine Reduktion bereits
        // an der Spitze. Bei Profilwechseln ist die gesamte Formation gebunden.
        let mut limit = leg_limit(leg);
        let mut maximum_gradient = directed_gradient(leg)?;
        let mut minimum_gradient = maximum_gradient;
        let mut next_tail_boundary = authority.end_route_mm;
        for profile in &route.legs {
            if profile.route_end_mm() > train.tail_route_mm
                && profile.route_start_mm <= train.head_route_mm
            {
                limit = limit.min(leg_limit(profile));
                maximum_gradient = maximum_gradient.max(directed_gradient(profile)?);
            }
            if profile.route_end_mm() > train.tail_route_mm
                && profile.route_start_mm < authority.end_route_mm
            {
                minimum_gradient = minimum_gradient.min(directed_gradient(profile)?);
            }
            let boundary = profile
                .route_end_mm()
                .saturating_add(i64::from(formation.performance.length_mm));
            if boundary > train.head_route_mm {
                next_tail_boundary = next_tail_boundary.min(boundary);
            }
        }
        let grade_acceleration = |gradient: i32| -> i128 {
            // g=9.80665 m/s²; Steigung belastet Traktion, Gefaelle die Bremse.
            div_round_half_away(i128::from(gradient) * 980_665, 100_000)
        };
        let traction = i128::from(formation.performance.acceleration_mmps2)
            - grade_acceleration(maximum_gradient);
        let brake = i128::from(formation.performance.service_brake_mmps2)
            + grade_acceleration(minimum_gradient);
        if traction <= 0 || brake <= 0 {
            self.safe_stop(train_id, "insufficient-gradient-traction-or-braking")?;
            return Err(OperationalError::UnsafeState);
        }
        let traction = i32::try_from(traction).map_err(|_| OperationalError::ArithmeticOverflow)?;
        let brake = u32::try_from(brake).map_err(|_| OperationalError::ArithmeticOverflow)?;
        // Jede folgende Vmax bildet ein Bremsziel. Der aequivalente Weg bis
        // Geschwindigkeit null erlaubt dieselbe Integer-Huellkurve wie ein Halt.
        let mut remaining = motion_end_route_mm.saturating_sub(train.head_route_mm);
        let mut target_speed = 0;
        for profile in &route.legs {
            if profile.route_start_mm > train.head_route_mm
                && profile.route_start_mm < motion_end_route_mm
            {
                let target_limit = leg_limit(profile);
                let equivalent = profile
                    .route_start_mm
                    .saturating_sub(train.head_route_mm)
                    .saturating_add(stopping_distance_mm(target_limit, brake)?);
                if equivalent < remaining {
                    remaining = equivalent;
                    target_speed = target_limit;
                }
            }
        }
        let stopping_distance = stopping_distance_mm(train.speed_mmps, brake)?;
        let rounding_margin = if target_speed > 0 {
            i64::from(train.speed_mmps.div_ceil(1_000)).saturating_add(2)
        } else {
            0
        };
        let acceleration = if train.speed_mmps > limit
            || remaining <= stopping_distance.saturating_add(rounding_margin)
        {
            -i32::try_from(brake).map_err(|_| OperationalError::ArithmeticOverflow)?
        } else if train.speed_mmps < limit {
            // Auch bei weniger als einem ms bis Vmax darf Rundung keine
            // Geschwindigkeitsueberschreitung erzeugen.
            traction.min(
                i32::try_from(limit.saturating_sub(train.speed_mmps).saturating_mul(1_000))
                    .unwrap_or(i32::MAX),
            )
        } else {
            0
        };
        // Ereignisgrenze ist Geschwindigkeitswechsel, Kantenende oder Fahrberechtigungsende.
        let infrastructure_boundary = authority
            .end_route_mm
            .min(motion_end_route_mm)
            .min(leg.route_end_mm())
            .min(next_tail_boundary)
            .saturating_sub(train.head_route_mm)
            .max(0);
        let (duration_ms, distance_boundary) = if acceleration > 0 {
            let acceleration_boundary_ms = acceleration_brake_boundary_ms(
                train.speed_mmps,
                acceleration,
                brake,
                remaining.saturating_sub(rounding_margin),
                limit,
            )?;
            let duration_ms = first_boundary_or_event_ms(
                train.speed_mmps,
                acceleration,
                infrastructure_boundary,
                acceleration_boundary_ms.max(1),
            );
            let covered = checked_i64(kinematic_distance_mm(
                train.speed_mmps,
                acceleration,
                duration_ms,
            ))?
            .min(infrastructure_boundary)
            .max(0);
            (duration_ms, covered)
        } else if acceleration == 0 {
            let brake_start_distance = remaining
                .saturating_sub(stopping_distance)
                .saturating_sub(rounding_margin)
                .max(1);
            let distance_boundary = infrastructure_boundary.min(brake_start_distance);
            (
                analytic_duration_ms(train.speed_mmps, acceleration, distance_boundary, limit)?,
                distance_boundary,
            )
        } else {
            let target_speed = if train.speed_mmps > limit {
                limit
            } else {
                target_speed.min(limit)
            };
            let to_target = ((i64::from(train.speed_mmps.saturating_sub(target_speed)) * 1_000
                + i64::from(brake)
                - 1)
                / i64::from(brake))
            .max(1);
            let duration = first_boundary_or_event_ms(
                train.speed_mmps,
                acceleration,
                infrastructure_boundary,
                to_target,
            );
            let covered = if target_speed == 0 {
                infrastructure_boundary
            } else {
                checked_i64(kinematic_distance_mm(
                    train.speed_mmps,
                    acceleration,
                    duration,
                ))?
                .min(infrastructure_boundary)
                .max(0)
            };
            (duration, covered)
        };
        let valid_until_ms = self.now_ms.saturating_add(duration_ms.max(1));
        let segment = MotionSegment {
            started_at_ms: self.now_ms,
            valid_until_ms,
            start_route_mm: train.head_route_mm,
            start_speed_mmps: train.speed_mmps,
            acceleration_mmps2: acceleration,
            route_version_id: train.route_version_id.clone(),
            authority_end_route_mm: authority.end_route_mm,
            segment_end_route_mm: train.head_route_mm.saturating_add(distance_boundary),
        };
        let train = self.trains.get_mut(train_id).expect("train exists");
        train.motion_segment = Some(segment.clone());
        train.motion_state = MotionState::Moving;
        train.waiting_reason = None;
        self.scheduled_motion_ends.insert(ScheduledMotionEnd {
            at_ms: valid_until_ms,
            train_id: train_id.to_owned(),
            segment_started_at_ms: self.now_ms,
        });
        self.record_passenger_departure(train_id)?;
        self.record(
            "motion-segment-started",
            train_id,
            format!("valid-until={valid_until_ms}"),
        )?;
        Ok(segment)
    }

    /// Verarbeitet ausschliesslich faellige Ereignisse; kein Zug-Vollscan.
    pub fn advance_to(&mut self, target_ms: SimMillis) -> Result<(), OperationalError> {
        if target_ms > passenger_stops::MAX_STOP_CONTRACT_INTEGER
            && self
                .trains
                .values()
                .any(|train| train.passenger_stops.is_some())
        {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        // Prepare friert den regionalen Writer bis zum bestaetigten Commit ein.
        // Der Zielwriter ist ab Accept die einzige bewegliche Autoritaet.
        if !self.prepared_handovers.is_empty() && target_ms != self.now_ms {
            return Err(OperationalError::InvalidHandover);
        }
        if target_ms < self.now_ms {
            return Err(OperationalError::TimeRegression);
        }
        self.refresh_continuation_schedule()?;
        loop {
            let next_motion_ms = self
                .scheduled_motion_ends
                .first()
                .map(|scheduled| scheduled.at_ms);
            let next_continuation_ms = self
                .scheduled_continuation_due
                .first()
                .map(|scheduled| scheduled.at_ms);
            let next_passenger_ms = self
                .scheduled_passenger_departures
                .first()
                .map(|scheduled| scheduled.at_ms);
            let Some(next_at_ms) = [next_motion_ms, next_continuation_ms, next_passenger_ms]
                .into_iter()
                .flatten()
                .min()
            else {
                break;
            };
            if next_at_ms > target_ms {
                break;
            }
            self.now_ms = next_at_ms;
            loop {
                let Some(next) = self.scheduled_motion_ends.first().cloned() else {
                    break;
                };
                if next.at_ms != next_at_ms {
                    break;
                }
                self.scheduled_motion_ends.remove(&next);
                let current_started = self
                    .trains
                    .get(&next.train_id)
                    .and_then(|train| train.motion_segment.as_ref())
                    .map(|segment| segment.started_at_ms);
                if current_started == Some(next.segment_started_at_ms) {
                    self.finish_motion_segment(&next.train_id)?;
                }
            }
            self.progress_passenger_departures()?;
            self.progress_movement_continuations()?;
        }
        self.now_ms = target_ms;
        self.progress_movement_continuations()?;
        Ok(())
    }

    fn finish_motion_segment(&mut self, train_id: &str) -> Result<(), OperationalError> {
        let (route_id, formation_id, segment, previous_blocks) = {
            let train = self
                .trains
                .get(train_id)
                .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
            (
                train.route_version_id.clone(),
                train.formation_version_id.clone(),
                train
                    .motion_segment
                    .clone()
                    .ok_or(OperationalError::UnsafeState)?,
                train.occupied_blocks.clone(),
            )
        };
        let head = segment.position_at(self.now_ms)?;
        let speed = segment.speed_at(self.now_ms)?;
        if segment.segment_end_route_mm > segment.start_route_mm && head == segment.start_route_mm {
            return Err(OperationalError::UnsafeState);
        }
        let route = self
            .infrastructure()?
            .route_version(&route_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(route_id.clone()))?;
        let length = self
            .formations
            .get(&formation_id)
            .ok_or_else(|| OperationalError::UnknownFormation(formation_id.clone()))?
            .performance
            .length_mm;
        let tail = head.saturating_sub(i64::from(length));
        let intervals = intervals_for(&route, tail, head)?;
        self.ensure_intervals_free(train_id, &intervals)?;
        let mut blocks = blocks_for(&route, tail, head);
        if let Some(protection) = self.handover_protection_by_train.get(train_id) {
            blocks.extend(protection.iter().cloned());
        }
        {
            let train = self.trains.get_mut(train_id).expect("train exists");
            if head
                > train
                    .authority
                    .as_ref()
                    .map_or(train.head_route_mm, |a| a.end_route_mm)
            {
                return Err(OperationalError::AuthorityExceeded);
            }
            train.head_route_mm = head;
            train.tail_route_mm = tail;
            train.speed_mmps = speed;
            train.occupied_intervals = intervals;
            train.occupied_blocks = blocks.clone();
            train.direction = route
                .leg_at(head)
                .ok_or_else(|| OperationalError::IncompleteRoute(route.id.clone()))?
                .direction;
            train.motion_segment = None;
            train.motion_state = if speed == 0 {
                MotionState::Standing
            } else {
                MotionState::Moving
            };
        }
        for block in &blocks {
            self.resource_lifecycle
                .insert(block.clone(), ResourceLifecycle::OccupiedByFormation);
        }
        let mut released_resources = self.release_routes_after_tail(train_id)?;
        if self
            .trains
            .get(train_id)
            .and_then(|train| train.authority.as_ref())
            .is_some_and(|authority| head >= authority.end_route_mm)
        {
            self.trains
                .get_mut(train_id)
                .expect("train exists")
                .authority = None;
        }
        let changed_resources = previous_blocks
            .union(&self.trains[train_id].occupied_blocks)
            .cloned()
            .collect();
        self.refresh_resource_lifecycle(&changed_resources);
        let cleared_blocks = previous_blocks
            .difference(&blocks)
            .cloned()
            .collect::<BTreeSet<_>>();
        self.wake_movement_continuations_for_resources(&cleared_blocks)?;
        released_resources.extend(cleared_blocks);
        self.record(
            "motion-segment-ended",
            train_id,
            format!("head={head};tail={tail}"),
        )?;
        self.record_passenger_arrival(train_id)?;
        let (authority_remaining, residual_speed) = {
            let train = self.trains.get(train_id).expect("train exists");
            (
                train
                    .authority
                    .as_ref()
                    .is_some_and(|authority| authority.end_route_mm > train.head_route_mm),
                train.speed_mmps,
            )
        };
        if authority_remaining && !self.passenger_stop_waiting(train_id) {
            self.plan_motion(train_id)?;
            self.dispatch_waiting_for_resources(&released_resources)?;
        } else if authority_remaining {
            self.dispatch_waiting_for_resources(&released_resources)?;
        } else if residual_speed > 0 {
            self.safe_stop(train_id, "authority-ended-with-residual-speed")?;
        } else {
            self.refresh_route_completion(train_id)?;
            self.progress_movement_continuations()?;
            self.dispatch_pending()?;
        }
        Ok(())
    }

    fn release_routes_after_tail(
        &mut self,
        train_id: &str,
    ) -> Result<BTreeSet<String>, OperationalError> {
        let (tail, terminal_route_length, terminal_complete) = {
            let train = self
                .trains
                .get(train_id)
                .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
            let route = self
                .infrastructure()?
                .route_version(&train.route_version_id)?
                .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
            let route_length = route.length_mm();
            (
                train.tail_route_mm,
                route_length,
                train.head_route_mm == route_length
                    && train.speed_mmps == 0
                    && train.motion_segment.is_none(),
            )
        };
        let releases: Vec<(String, InterlockingRouteTemplate, bool)> = {
            let infrastructure = self.infrastructure()?;
            let mut releases = Vec::new();
            for lock in self
                .route_locks
                .values()
                .filter(|lock| lock.train_id == train_id)
            {
                let template = infrastructure
                    .interlocking_route(&lock.template_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                    })?;
                let terminal_release = terminal_complete
                    && template.authority_end_route_mm == terminal_route_length
                    && lock.release_after_tail_route_mm == terminal_route_length
                    && tail < lock.release_after_tail_route_mm;
                if tail >= lock.release_after_tail_route_mm || terminal_release {
                    releases.push((lock.id.clone(), template, terminal_release));
                }
            }
            releases
        };
        let mut released_resources = BTreeSet::new();
        for (lock_id, template, terminal_release) in releases {
            let lock = self
                .route_locks
                .remove(&lock_id)
                .expect("selected lock exists");
            released_resources.extend(lock.resources.iter().cloned());
            if terminal_release {
                self.trains
                    .get_mut(train_id)
                    .expect("train exists")
                    .occupied_blocks
                    .extend(template.overlap_resources.iter().cloned());
            }
            for resource in &lock.resources {
                self.resource_lifecycle.remove(resource);
            }
            if self.trains.get(train_id).is_some_and(|train| {
                train.authority.as_ref().is_some_and(|authority| {
                    authority.source_route_lock_id == lock_id
                        && train.head_route_mm >= authority.end_route_mm
                })
            }) {
                self.trains
                    .get_mut(train_id)
                    .expect("train exists")
                    .authority = None;
            }
            self.record(
                if terminal_release {
                    "route-released-at-terminal"
                } else {
                    "route-released-after-tail"
                },
                train_id,
                lock.template_id,
            )?;
        }
        if !released_resources.is_empty() {
            self.rebuild_signal_aspects()?;
            self.refresh_resource_lifecycle(&released_resources);
        }
        self.wake_movement_continuations_for_resources(&released_resources)?;
        Ok(released_resources)
    }

    fn refresh_resource_lifecycle(&mut self, resources: &BTreeSet<String>) {
        for resource in resources {
            let state = if self
                .trains
                .values()
                .any(|train| train.occupied_blocks.contains(resource))
            {
                Some(ResourceLifecycle::OccupiedByFormation)
            } else if self
                .route_locks
                .values()
                .any(|lock| lock.resources.contains(resource))
                || self
                    .prepared_handovers
                    .values()
                    .any(|handover| handover.protected_resources.contains(resource))
            {
                Some(ResourceLifecycle::RouteLocked)
            } else {
                None
            };
            if let Some(state) = state {
                self.resource_lifecycle.insert(resource.clone(), state);
            } else {
                self.resource_lifecycle.remove(resource);
            }
        }
    }

    fn rebuild_resource_lifecycle(&mut self) {
        // `Free` ist der statische Grundzustand und wird nicht im dynamischen
        // Checkpoint materialisiert. Nur aktive Abweichungen werden gespeichert.
        self.resource_lifecycle.clear();
        for lock in self.route_locks.values() {
            for resource in &lock.resources {
                self.resource_lifecycle
                    .insert(resource.clone(), ResourceLifecycle::RouteLocked);
            }
        }
        for handover in self.prepared_handovers.values() {
            for resource in &handover.protected_resources {
                self.resource_lifecycle
                    .insert(resource.clone(), ResourceLifecycle::RouteLocked);
            }
        }
        for train in self.trains.values() {
            for block in &train.occupied_blocks {
                self.resource_lifecycle
                    .insert(block.clone(), ResourceLifecycle::OccupiedByFormation);
            }
        }
    }

    /// Signalbegriffe sind eine reine, referenzgezaehlte Projektion der noch
    /// aktiven Fahrstrassen und Signalstoerungen. Das Entfernen eines Locks
    /// darf deshalb niemals den von einem zweiten Lock getragenen Begriff
    /// pauschal loeschen.
    fn rebuild_signal_aspects(&mut self) -> Result<(), OperationalError> {
        let mut aspects = BTreeMap::new();
        for disruption in self.active_disruptions.values() {
            if let OperationalDisruption::SignalFailed { signal_id } = disruption {
                aspects.insert(signal_id.clone(), SignalAspect::Failed);
            }
        }
        for lock in self.route_locks.values() {
            let Some(train) = self.trains.get(&lock.train_id) else {
                return Err(OperationalError::UnsafeState);
            };
            if matches!(train.motion_state, MotionState::SafeStop { .. }) {
                continue;
            }
            let template = self
                .infrastructure()?
                .interlocking_route(&lock.template_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                })?;
            let expected = if template.movement_kind == MovementKind::Train {
                SignalAspect::Proceed
            } else {
                SignalAspect::ShuntingProceed
            };
            match aspects.get(&template.signal_id) {
                Some(SignalAspect::Failed) => {}
                Some(aspect) if *aspect == expected => {}
                Some(_) => return Err(OperationalError::UnsafeState),
                None => {
                    aspects.insert(template.signal_id, expected);
                }
            }
        }
        self.signal_aspects = aspects;
        Ok(())
    }

    pub fn safe_stop(&mut self, train_id: &str, reason: &str) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let train = self
            .trains
            .get_mut(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        train.speed_mmps = 0;
        train.motion_segment = None;
        train.motion_state = MotionState::SafeStop {
            reason: reason.to_owned(),
        };
        train.waiting_reason = Some(reason.to_owned());
        train.authority = None;
        self.scheduled_motion_ends
            .retain(|scheduled| scheduled.train_id != train_id);
        self.scheduled_passenger_departures
            .retain(|scheduled| scheduled.train_id != train_id);
        self.pending_dispatch_requests.remove(train_id);
        self.waiting_by_resource.retain(|_, waiting| {
            waiting.remove(train_id);
            !waiting.is_empty()
        });
        let continuation_ids: BTreeSet<String> = self
            .pending_movement_continuations
            .values()
            .filter(|continuation| continuation.predecessor_train_id == train_id)
            .map(|continuation| continuation.id.clone())
            .collect();
        self.continuations_waiting_by_resource.retain(|_, waiting| {
            waiting.retain(|id| !continuation_ids.contains(id));
            !waiting.is_empty()
        });
        self.rebuild_signal_aspects()?;
        self.refresh_continuation_schedule()?;
        self.record("safe-stop", train_id, reason)?;
        Ok(())
    }

    /// Atomare Zusammenstellungsveraenderung im Stillstand.
    pub fn change_formation(
        &mut self,
        train_id: &str,
        new_formation_id: impl Into<String>,
        vehicle_ids: Vec<String>,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        if train.speed_mmps != 0 || matches!(train.motion_state, MotionState::Moving) {
            return Err(OperationalError::FormationChangeWhileMoving);
        }
        let predecessor = train.formation_version_id.clone();
        let route_id = train.route_version_id.clone();
        let head = train.head_route_mm;
        let previous_tail = train.tail_route_mm;
        let previous_occupied_blocks = train.occupied_blocks.clone();
        self.ensure_vehicles_available(train_id, &vehicle_ids)?;
        let formation =
            self.derive_formation(new_formation_id.into(), Some(predecessor), vehicle_ids)?;
        if let Some(progress) = &train.passenger_stops {
            self.validate_stop_geometry_for_formation(
                &progress.plan,
                &formation,
                progress.next_stop_index,
            )?;
        }
        let route = self
            .infrastructure()?
            .route_version(&route_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(route_id.clone()))?;
        let tail = head.saturating_sub(i64::from(formation.performance.length_mm));
        let intervals = intervals_for(&route, tail, head)?;
        self.ensure_intervals_free(train_id, &intervals)?;
        let previous_geometric_blocks = blocks_for(&route, previous_tail, head);
        let retained_protection_resources: BTreeSet<String> = previous_occupied_blocks
            .difference(&previous_geometric_blocks)
            .cloned()
            .collect();
        let mut occupied_blocks = blocks_for(&route, tail, head);
        occupied_blocks.extend(retained_protection_resources);
        self.formations
            .insert(formation.id.clone(), formation.clone());
        let train = self.trains.get_mut(train_id).expect("train exists");
        train.formation_version_id = formation.id.clone();
        train.tail_route_mm = tail;
        train.occupied_intervals = intervals;
        train.occupied_blocks = occupied_blocks;
        self.rebuild_resource_lifecycle();
        self.update_service_capacity(train_id);
        self.record("formation-changed", train_id, formation.id)?;
        Ok(())
    }

    /// Wechselt nur im Stillstand und ohne alte Fahrberechtigung auf eine
    /// unveraenderliche Laufwegversion. Der bereits belegte physische Abschnitt
    /// muss in beiden Versionen exakt identisch sein; dadurch kann weder Kopf
    /// noch Schluss beim Umleiten springen.
    pub fn reroute_train(
        &mut self,
        train_id: &str,
        route_version_id: &str,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        // Ein anderer Laufweg benoetigt einen neu zertifizierten Haltplan.
        // Das bisherige Reroute-Kommando darf seine Anker nicht still umdeuten.
        if train.passenger_stops.is_some() {
            return Err(OperationalError::InvalidPassengerStopPlan);
        }
        if train.speed_mmps != 0 || train.motion_segment.is_some() {
            return Err(OperationalError::RouteChangeWhileMoving);
        }
        if train.authority.is_some()
            || self
                .route_locks
                .values()
                .any(|lock| lock.train_id == train_id)
            || self.pending_dispatch_requests.contains_key(train_id)
        {
            return Err(OperationalError::RerouteWhileAuthorized);
        }
        let current_route = self
            .infrastructure()?
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        let next_route = self
            .infrastructure()?
            .route_version(route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(route_version_id.to_owned()))?;
        if next_route.predecessor_id.as_deref() != Some(current_route.id.as_str())
            || next_route
                .transition_route_mm
                .is_none_or(|transition| transition < train.head_route_mm)
            || intervals_for(&next_route, train.tail_route_mm, train.head_route_mm)?
                != train.occupied_intervals
        {
            return Err(OperationalError::DiscontinuousReroute(
                route_version_id.to_owned(),
            ));
        }
        let next_direction = next_route
            .leg_at(train.head_route_mm)
            .ok_or_else(|| OperationalError::IncompleteRoute(next_route.id.clone()))?
            .direction;
        let train = self.trains.get_mut(train_id).expect("train exists");
        train.route_version_id = route_version_id.to_owned();
        train.direction = next_direction;
        self.record("route-version-changed", train_id, route_version_id)?;
        self.refresh_route_completion(train_id)?;
        self.progress_movement_continuations()?;
        Ok(())
    }

    /// Rangierbedarf bis zur echten Bewegung: Materialisieren, sichern, fahren.
    pub fn execute_shunting_order(
        &mut self,
        train_id: &str,
        interlocking_route_id: &str,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let kind = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?
            .movement_kind;
        if kind != MovementKind::Shunting {
            return Err(OperationalError::WrongMovementKind);
        }
        self.record(
            "shunting-order-derived",
            train_id,
            "formation-and-facility-demand",
        )?;
        self.lock_route(train_id, interlocking_route_id)?;
        self.plan_motion(train_id)?;
        self.record("shunting-order-executing", train_id, interlocking_route_id)?;
        Ok(())
    }

    /// Leitet den Fahrweg stabil aus dem fachlichen Bedarf ab und fuehrt ihn
    /// ueber dasselbe Stellwerk und denselben Lokfuehrer wie Zugfahrten aus.
    pub fn execute_automatic_shunting(
        &mut self,
        need: &AutomaticShuntingNeed,
    ) -> Result<String, OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        if need.id.is_empty() || need.minimum_authority_end_route_mm <= 0 {
            return Err(OperationalError::InvalidShuntingNeed);
        }
        let train = self
            .trains
            .get(&need.train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(need.train_id.clone()))?;
        if train.movement_kind != MovementKind::Shunting {
            return Err(OperationalError::WrongMovementKind);
        }
        let candidates: Vec<String> = self
            .infrastructure()?
            .shunting_interlocking_routes(need.minimum_authority_end_route_mm)?
            .into_iter()
            .map(|route| route.id.clone())
            .collect();
        for route_id in candidates {
            if self.lock_route(&need.train_id, &route_id).is_err() {
                continue;
            }
            self.record(
                "shunting-plan-derived",
                &need.train_id,
                format!(
                    "need={};purpose={:?};route={route_id}",
                    need.id, need.purpose
                ),
            )?;
            self.plan_motion(&need.train_id)?;
            self.record("shunting-plan-executing", &need.train_id, &need.id)?;
            return Ok(route_id);
        }
        Err(OperationalError::NoSafeShuntingRoute)
    }

    /// Aktiviert eine konkrete Wirkung. Aufhebung ist ein eigener autoritativer Vorgang.
    pub fn activate_disruption(
        &mut self,
        disruption_id: impl Into<String>,
        effect: OperationalDisruption,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        let disruption_id = disruption_id.into();
        if let Some(existing) = self.active_disruptions.get(&disruption_id) {
            return if existing == &effect {
                Ok(())
            } else {
                Err(OperationalError::UnsafeState)
            };
        }
        if disruption_id.trim().is_empty()
            || !self.infrastructure()?.contains_disruption_target(&effect)?
            || matches!(&effect, OperationalDisruption::VehicleRestricted { vehicle_id, .. } if !self.vehicles.contains_key(vehicle_id))
        {
            return Err(OperationalError::UnsafeState);
        }
        let infrastructure_affected: Vec<String> = self
            .trains
            .values()
            .filter(|train| match &effect {
                OperationalDisruption::ResourceClosed { resource_id }
                | OperationalDisruption::TrackDetectionFailed { resource_id } => {
                    train.occupied_blocks.contains(resource_id)
                        || self.route_locks.values().any(|lock| {
                            lock.train_id == train.id && lock.resources.contains(resource_id)
                        })
                }
                OperationalDisruption::SpeedRestriction { edge_id, .. } => {
                    train
                        .occupied_intervals
                        .iter()
                        .any(|interval| &interval.edge_id == edge_id)
                        || self
                            .infrastructure()
                            .and_then(|infrastructure| {
                                Ok(infrastructure
                                    .route_version(&train.route_version_id)?
                                    .is_some_and(|route| {
                                        route.legs.iter().any(|leg| {
                                            &leg.edge_id == edge_id
                                                && leg.route_start_mm >= train.head_route_mm
                                                && train.authority.as_ref().is_some_and(
                                                    |authority| {
                                                        leg.route_start_mm < authority.end_route_mm
                                                    },
                                                )
                                        })
                                    }))
                            })
                            .unwrap_or(true)
                }
                OperationalDisruption::SignalFailed { signal_id } => self
                    .route_locks
                    .values()
                    .filter(|lock| lock.train_id == train.id)
                    .try_fold(false, |affected, lock| {
                        Ok::<_, OperationalError>(
                            affected
                                || self
                                    .infrastructure()?
                                    .interlocking_route(&lock.template_id)?
                                    .is_some_and(|route| &route.signal_id == signal_id),
                        )
                    })
                    .unwrap_or(true),
                OperationalDisruption::SwitchFailed { switch_id } => self
                    .route_locks
                    .values()
                    .filter(|lock| lock.train_id == train.id)
                    .try_fold(false, |affected, lock| {
                        Ok::<_, OperationalError>(
                            affected
                                || self
                                    .infrastructure()?
                                    .interlocking_route(&lock.template_id)?
                                    .is_some_and(|route| {
                                        route.switch_positions.contains_key(switch_id)
                                    }),
                        )
                    })
                    .unwrap_or(true),
                OperationalDisruption::VehicleRestricted { .. } => false,
            })
            .map(|train| train.id.clone())
            .collect();
        for train_id in infrastructure_affected {
            self.safe_stop(&train_id, "infrastructure-disruption")?;
        }
        if let OperationalDisruption::VehicleRestricted {
            vehicle_id,
            restriction,
        } = &effect
        {
            let vehicle = self
                .vehicles
                .get_mut(vehicle_id)
                .ok_or_else(|| OperationalError::UnknownVehicle(vehicle_id.clone()))?;
            vehicle
                .restrictions
                .insert(disruption_id.clone(), restriction.clone());
            vehicle.history.push(format!("{}:activated", disruption_id));
            let affected: Vec<String> = self
                .trains
                .values()
                .filter(|train| {
                    self.formations
                        .get(&train.formation_version_id)
                        .is_some_and(|formation| formation.vehicle_ids.contains(vehicle_id))
                })
                .map(|train| train.id.clone())
                .collect();
            for train_id in affected {
                // Jede technische Aenderung beendet einen laufenden analytischen
                // Abschnitt, bevor die abgeleiteten Verbandswerte atomar wechseln.
                self.safe_stop(&train_id, "vehicle-restriction-changed")?;
                let old = self.trains[&train_id].formation_version_id.clone();
                let vehicle_ids = self.formations[&old].vehicle_ids.clone();
                let new_id = format!("{old}:disruption:{disruption_id}");
                self.change_formation(&train_id, new_id, vehicle_ids)?;
            }
        }
        match &effect {
            OperationalDisruption::SignalFailed { signal_id } => {
                self.signal_aspects
                    .insert(signal_id.clone(), SignalAspect::Failed);
            }
            OperationalDisruption::SwitchFailed { switch_id } => {
                self.switch_positions.remove(switch_id);
            }
            _ => {}
        }
        self.active_disruptions
            .insert(disruption_id.clone(), effect);
        self.record(
            "disruption-activated",
            &disruption_id,
            "concrete-resource-or-vehicle",
        )?;
        Ok(())
    }

    pub fn clear_disruption(
        &mut self,
        disruption_id: &str,
        release_reference: &str,
    ) -> Result<(), OperationalError> {
        if !self.prepared_handovers.is_empty() {
            return Err(OperationalError::InvalidHandover);
        }
        if release_reference.trim().is_empty() {
            return Err(OperationalError::MissingTechnicalRelease);
        }
        let Some(effect) = self.active_disruptions.get(disruption_id).cloned() else {
            return Ok(());
        };
        if let OperationalDisruption::VehicleRestricted { vehicle_id, .. } = &effect {
            if let Some(vehicle) = self.vehicles.get_mut(vehicle_id) {
                vehicle.restrictions.remove(disruption_id);
                vehicle
                    .history
                    .push(format!("{}:released:{}", disruption_id, release_reference));
            }
            let affected: Vec<String> = self
                .trains
                .values()
                .filter(|train| {
                    self.formations
                        .get(&train.formation_version_id)
                        .is_some_and(|formation| formation.vehicle_ids.contains(vehicle_id))
                })
                .map(|train| train.id.clone())
                .collect();
            for train_id in affected {
                self.safe_stop(&train_id, "vehicle-restriction-released")?;
                let old = self.trains[&train_id].formation_version_id.clone();
                let vehicle_ids = self.formations[&old].vehicle_ids.clone();
                let new_id = format!("{old}:released:{disruption_id}");
                self.change_formation(&train_id, new_id, vehicle_ids)?;
            }
        }
        self.active_disruptions.remove(disruption_id);
        self.rebuild_signal_aspects()?;
        self.record("disruption-cleared", disruption_id, release_reference)?;
        self.dispatch_pending()?;
        Ok(())
    }

    /// Einheitliche Formel `platform-stop/v1`: 15 s je angefangene 10 % Ueberhang,
    /// Qualitaetsmalus = Ueberhang-Basispunkte * Fahrgastzahl / 100.
    pub fn short_platform_effect(
        &self,
        train_id: &str,
        platform_id: &str,
        passengers: u32,
    ) -> Result<(u32, u64), OperationalError> {
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        let formation = &self.formations[&train.formation_version_id];
        let platform = self
            .infrastructure()?
            .platform_interval(platform_id)?
            .ok_or_else(|| OperationalError::UnknownPlatform(platform_id.to_owned()))?;
        let usable = platform.to_mm.saturating_sub(platform.from_mm);
        let length = i64::from(formation.performance.length_mm);
        if usable <= 0 {
            return Err(OperationalError::UnknownPlatform(platform_id.to_owned()));
        }
        let overhang = length.saturating_sub(usable).max(0);
        let overhang_bp = overhang.saturating_mul(10_000).saturating_add(length - 1) / length;
        let ten_percent_steps = overhang_bp.saturating_add(999) / 1_000;
        let dwell_seconds = u32::try_from(ten_percent_steps.saturating_mul(15))
            .map_err(|_| OperationalError::ArithmeticOverflow)?;
        let quality = u64::try_from(overhang_bp)
            .map_err(|_| OperationalError::ArithmeticOverflow)?
            .saturating_mul(u64::from(passengers))
            / 100;
        Ok((dwell_seconds, quality))
    }

    /// Beide Sichten werden aus demselben Commit und demselben Zugdatensatz gebaut.
    pub fn project(
        &self,
        kind: ProjectionKind,
        visible_edges: &BTreeSet<String>,
    ) -> Result<OperationalProjection, OperationalError> {
        let trains = self
            .trains
            .values()
            .filter(|train| {
                visible_edges.is_empty()
                    || train
                        .occupied_intervals
                        .iter()
                        .any(|interval| visible_edges.contains(&interval.edge_id))
            })
            .map(
                |train| -> Result<OperationalTrainProjection, OperationalError> {
                    let route = self
                        .infrastructure()?
                        .route_version(&train.route_version_id)?
                        .ok_or_else(|| {
                            OperationalError::UnknownRoute(train.route_version_id.clone())
                        })?;
                    let motion_geometry = match &train.motion_segment {
                        Some(segment) => route_geometry_for(
                            self.infrastructure()?,
                            &route,
                            segment.start_route_mm,
                            segment.segment_end_route_mm,
                        )?,
                        None => Vec::new(),
                    };
                    Ok(OperationalTrainProjection {
                        train_id: train.id.clone(),
                        train_number: train.train_number.clone(),
                        operator_id: train.operator_id.clone(),
                        movement_kind: train.movement_kind,
                        route_version_id: train.route_version_id.clone(),
                        formation_version_id: train.formation_version_id.clone(),
                        head_route_mm: train.head_route_mm,
                        tail_route_mm: train.tail_route_mm,
                        speed_mmps: train.speed_mmps,
                        direction: train.direction,
                        motion_state: ProjectedMotionState::from(&train.motion_state),
                        occupied_intervals: train.occupied_intervals.clone(),
                        occupied_blocks: train.occupied_blocks.clone(),
                        authority_end_route_mm: train
                            .authority
                            .as_ref()
                            .map(|authority| authority.end_route_mm),
                        head_geometry: route_geometry_position(
                            self.infrastructure()?,
                            &route,
                            train.head_route_mm,
                        )?
                        .ok_or(OperationalError::UnsafeState)?,
                        tail_geometry: route_geometry_position(
                            self.infrastructure()?,
                            &route,
                            train.tail_route_mm,
                        )?,
                        motion_segment: train.motion_segment.clone(),
                        motion_geometry,
                        waiting_reason: train.waiting_reason.clone(),
                    })
                },
            )
            .collect::<Result<Vec<_>, _>>()?;
        Ok(OperationalProjection {
            kind,
            world_id: self.world_id.clone(),
            region_id: self.region_id.clone(),
            infra_release_id: self.infra_release_id.clone(),
            commit_sequence: self.commit_sequence,
            at_ms: self.now_ms,
            stale_after_ms: self
                .now_ms
                .saturating_add(OPERATIONAL_PROJECTION_VALIDITY_MS),
            trains,
            route_locks: self.route_locks.values().cloned().collect(),
            signals: self.signal_aspects.clone(),
            active_disruptions: self
                .active_disruptions
                .iter()
                .map(|(disruption_id, effect)| OperationalDisruptionProjection {
                    disruption_id: disruption_id.clone(),
                    effect: effect.clone(),
                })
                .collect(),
        })
    }

    pub fn checkpoint(&self) -> OperationalCheckpoint {
        let state_hash = self.state_hash();
        let mut world = self.clone();
        // Das append-only Log liegt ausserhalb des kompakten Checkpoints. Seine
        // Sequenz bleibt gebunden; visuelle oder historische Ereignisbytes
        // gehoeren nicht in den kanonischen Fachzustand.
        world.events.clear();
        OperationalCheckpoint {
            world: Box::new(world),
            event_sequence: self.event_sequence,
            state_hash,
        }
    }

    pub fn restore(checkpoint: &OperationalCheckpoint) -> Result<Self, OperationalError> {
        let world = checkpoint.world.as_ref().clone();
        if world.event_sequence != checkpoint.event_sequence
            || world.state_hash() != checkpoint.state_hash
        {
            return Err(OperationalError::InvalidCheckpoint);
        }
        world.verify_invariants()?;
        Ok(world)
    }

    pub fn begin_handover(
        &mut self,
        handover_id: impl Into<String>,
        train_id: &str,
        target_region_id: impl Into<String>,
        mut protected_resources: BTreeSet<String>,
    ) -> Result<RegionHandover, OperationalError> {
        let id = handover_id.into();
        let target_region_id = target_region_id.into();
        if protected_resources.is_empty() {
            return Err(OperationalError::UnprotectedHandover);
        }
        if let Some(previous_protection) = self.handover_protection_by_train.get(train_id) {
            protected_resources.extend(previous_protection.iter().cloned());
        }
        if let Some(existing) = self.prepared_handovers.get(&id) {
            if existing.train.id == train_id
                && existing.target_region_id == target_region_id
                && existing.protected_resources == protected_resources
            {
                return Ok(existing.clone());
            }
            return Err(OperationalError::InvalidHandover);
        }
        if id.is_empty()
            || target_region_id.is_empty()
            || target_region_id == self.region_id
            || self.finished_handovers.contains_key(&id)
            || !self.prepared_handovers.is_empty()
            || self
                .pending_movement_continuations
                .values()
                .any(|link| link.predecessor_train_id == train_id)
        {
            return Err(OperationalError::InvalidHandover);
        }
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?
            .clone();
        let formation = self
            .formations
            .get(&train.formation_version_id)
            .ok_or_else(|| OperationalError::UnknownFormation(train.formation_version_id.clone()))?
            .clone();
        let infra = self.infrastructure()?;
        let route = infra
            .route_version(&train.route_version_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(train.route_version_id.clone()))?;
        let route_locks = self
            .route_locks
            .iter()
            .filter(|(_, lock)| lock.train_id == train_id)
            .map(|(id, lock)| (id.clone(), lock.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut interlocking_routes = BTreeMap::new();
        let mut switch_positions = BTreeMap::new();
        for lock in route_locks.values() {
            let template = infra
                .interlocking_route(&lock.template_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                })?;
            switch_positions.extend(template.switch_positions.clone());
            interlocking_routes.insert(template.id.clone(), template);
        }
        let mut vehicles = BTreeMap::new();
        let mut vehicle_types = BTreeMap::new();
        for vehicle_id in &formation.vehicle_ids {
            let vehicle = self
                .vehicles
                .get(vehicle_id)
                .ok_or_else(|| OperationalError::UnknownVehicle(vehicle_id.clone()))?
                .clone();
            let kind = self
                .vehicle_types
                .get(&vehicle.type_id)
                .ok_or_else(|| OperationalError::UnknownVehicleType(vehicle.type_id.clone()))?
                .clone();
            vehicle_types.insert(kind.id.clone(), kind);
            vehicles.insert(vehicle.id.clone(), vehicle);
        }
        if self.route_locks.values().any(|lock| {
            lock.train_id != train_id && !lock.resources.is_disjoint(&protected_resources)
        }) || self.trains.values().any(|other| {
            other.id != train_id && !other.occupied_blocks.is_disjoint(&protected_resources)
        }) {
            return Err(OperationalError::UnprotectedHandover);
        }
        let mut handover = RegionHandover {
            id,
            world_id: self.world_id.clone(),
            infra_release_id: self.infra_release_id.clone(),
            infra_binding_identity: infra.binding_identity().to_owned(),
            source_region_id: self.region_id.clone(),
            target_region_id,
            at_ms: self.now_ms,
            source_state_hash: self.state_hash().to_hex(),
            source_event_sequence: self.event_sequence,
            payload_hash: String::new(),
            train,
            formation,
            route,
            vehicles,
            vehicle_types,
            route_locks,
            interlocking_routes,
            switch_positions,
            active_disruptions: self.active_disruptions.clone(),
            dispatch_request: self.pending_dispatch_requests.get(train_id).cloned(),
            route_completed_at_ms: self.route_completed_at_ms.get(train_id).copied(),
            protected_resources,
            source_commit_sequence: self.commit_sequence,
            acknowledged: false,
        };
        handover.payload_hash = handover.calculate_payload_hash();
        // Alle falliblen Pruefungen/Events werden vor der sichtbaren Mutation ausgefuehrt.
        let mut candidate = self.clone();
        candidate.record("handover-prepared", train_id, &handover.target_region_id)?;
        candidate
            .prepared_handovers
            .insert(handover.id.clone(), handover.clone());
        candidate.rebuild_resource_lifecycle();
        candidate.verify_invariants()?;
        *self = candidate;
        Ok(handover)
    }

    pub fn accept_handover(
        &mut self,
        handover: &mut RegionHandover,
    ) -> Result<(), OperationalError> {
        if handover.world_id != self.world_id
            || handover.infra_release_id != self.infra_release_id
            || handover.infra_binding_identity != self.infrastructure()?.binding_identity()
            || handover.target_region_id != self.region_id
            || handover.source_region_id == self.region_id
            || handover.id.is_empty()
            || handover.source_region_id.is_empty()
            || handover.payload_hash != handover.calculate_payload_hash()
        {
            return Err(OperationalError::InvalidHandover);
        }
        if let Some(receipt) = self.accepted_handovers.get(&handover.id) {
            if receipt != &handover.payload_hash {
                return Err(OperationalError::InvalidHandover);
            }
            handover.acknowledged = true;
            return Ok(());
        }
        if handover.acknowledged
            || handover.at_ms != self.now_ms
            || handover.source_state_hash.len() != 64
            || self.trains.contains_key(&handover.train.id)
            || self.formations.contains_key(&handover.formation.id)
            || handover
                .vehicles
                .keys()
                .any(|id| self.vehicles.contains_key(id))
            || handover
                .vehicle_types
                .iter()
                .any(|(id, kind)| self.vehicle_types.get(id).is_some_and(|own| own != kind))
            || handover
                .route_locks
                .keys()
                .any(|id| self.route_locks.contains_key(id))
            || !self.prepared_handovers.is_empty()
            || self.active_disruptions != handover.active_disruptions
        {
            return Err(OperationalError::InvalidHandover);
        }
        let infra = self.infrastructure()?;
        if infra.route_version(&handover.route.id)?.as_ref() != Some(&handover.route)
            || handover.train.route_version_id != handover.route.id
            || handover.train.formation_version_id != handover.formation.id
        {
            return Err(OperationalError::InvalidHandover);
        }
        for (id, template) in &handover.interlocking_routes {
            if infra.interlocking_route(id)?.as_ref() != Some(template) {
                return Err(OperationalError::InvalidHandover);
            }
        }
        for (id, position) in &handover.switch_positions {
            if self
                .switch_positions
                .get(id)
                .is_some_and(|own| own != position)
            {
                return Err(OperationalError::InvalidHandover);
            }
        }
        let transferred_resources = handover
            .route_locks
            .values()
            .flat_map(|lock| lock.resources.iter())
            .chain(handover.protected_resources.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        if self
            .route_locks
            .values()
            .any(|lock| !lock.resources.is_disjoint(&transferred_resources))
            || self
                .trains
                .values()
                .any(|train| !train.occupied_blocks.is_disjoint(&transferred_resources))
        {
            return Err(OperationalError::UnprotectedHandover);
        }
        self.ensure_intervals_free(&handover.train.id, &handover.train.occupied_intervals)?;
        let mut candidate = self.clone();
        candidate.vehicles.extend(handover.vehicles.clone());
        candidate
            .vehicle_types
            .extend(handover.vehicle_types.clone());
        if candidate.derive_formation(
            handover.formation.id.clone(),
            handover.formation.predecessor_id.clone(),
            handover.formation.vehicle_ids.clone(),
        )? != handover.formation
        {
            return Err(OperationalError::InvalidHandover);
        }
        candidate
            .formations
            .insert(handover.formation.id.clone(), handover.formation.clone());
        candidate.adopt_service_outcome(&handover.train)?;
        candidate
            .trains
            .insert(handover.train.id.clone(), handover.train.clone());
        candidate.schedule_passenger_departure(&handover.train.id);
        candidate
            .trains
            .get_mut(&handover.train.id)
            .expect("transferred train")
            .occupied_blocks
            .extend(handover.protected_resources.iter().cloned());
        candidate.handover_protection_by_train.insert(
            handover.train.id.clone(),
            handover.protected_resources.clone(),
        );
        candidate.route_locks.extend(handover.route_locks.clone());
        candidate
            .switch_positions
            .extend(handover.switch_positions.clone());
        if let Some(segment) = &handover.train.motion_segment {
            if segment.started_at_ms > self.now_ms || segment.valid_until_ms < self.now_ms {
                return Err(OperationalError::InvalidHandover);
            }
            candidate.scheduled_motion_ends.insert(ScheduledMotionEnd {
                at_ms: segment.valid_until_ms,
                train_id: handover.train.id.clone(),
                segment_started_at_ms: segment.started_at_ms,
            });
        }
        if let Some(request) = &handover.dispatch_request {
            candidate
                .pending_dispatch_requests
                .insert(handover.train.id.clone(), request.clone());
        }
        if let Some(at_ms) = handover.route_completed_at_ms {
            candidate
                .route_completed_at_ms
                .insert(handover.train.id.clone(), at_ms);
        }
        candidate
            .accepted_handovers
            .insert(handover.id.clone(), handover.payload_hash.clone());
        candidate.rebuild_resource_lifecycle();
        candidate.rebuild_signal_aspects()?;
        candidate.record(
            "handover-accepted",
            &handover.train.id,
            &handover.source_region_id,
        )?;
        candidate.verify_invariants()?;
        *self = candidate;
        handover.acknowledged = true;
        Ok(())
    }

    pub fn finish_handover(&mut self, handover: &RegionHandover) -> Result<(), OperationalError> {
        if !handover.acknowledged
            || handover.world_id != self.world_id
            || handover.infra_release_id != self.infra_release_id
            || handover.source_region_id != self.region_id
            || handover.payload_hash != handover.calculate_payload_hash()
        {
            return Err(OperationalError::InvalidHandover);
        }
        if let Some(receipt) = self.finished_handovers.get(&handover.id) {
            return if receipt == &handover.payload_hash {
                Ok(())
            } else {
                Err(OperationalError::InvalidHandover)
            };
        }
        if self
            .prepared_handovers
            .get(&handover.id)
            .is_none_or(|prepared| prepared.payload_hash != handover.payload_hash)
            || self.trains.get(&handover.train.id) != Some(&handover.train)
        {
            return Err(OperationalError::InvalidHandover);
        }
        let mut candidate = self.clone();
        candidate.trains.remove(&handover.train.id);
        candidate
            .handover_protection_by_train
            .remove(&handover.train.id);
        candidate
            .route_locks
            .retain(|_, lock| lock.train_id != handover.train.id);
        candidate
            .scheduled_motion_ends
            .retain(|event| event.train_id != handover.train.id);
        candidate
            .scheduled_passenger_departures
            .retain(|event| event.train_id != handover.train.id);
        candidate
            .pending_dispatch_requests
            .remove(&handover.train.id);
        candidate.route_completed_at_ms.remove(&handover.train.id);
        for waiting in candidate.waiting_by_resource.values_mut() {
            waiting.remove(&handover.train.id);
        }
        candidate
            .waiting_by_resource
            .retain(|_, waiting| !waiting.is_empty());
        // Historische Formationen duerfen nicht als zweite Fahrzeugreserve weiterleben.
        candidate.formations.retain(|_, formation| {
            formation
                .vehicle_ids
                .iter()
                .all(|id| !handover.vehicles.contains_key(id))
        });
        candidate
            .vehicles
            .retain(|id, _| !handover.vehicles.contains_key(id));
        candidate.release_service_plan(&handover.train);
        candidate.prepared_handovers.remove(&handover.id);
        candidate
            .finished_handovers
            .insert(handover.id.clone(), handover.payload_hash.clone());
        candidate.rebuild_resource_lifecycle();
        candidate.rebuild_signal_aspects()?;
        candidate.record(
            "handover-finished",
            &handover.train.id,
            &handover.target_region_id,
        )?;
        candidate.verify_invariants()?;
        *self = candidate;
        Ok(())
    }

    pub fn verify_invariants(&self) -> Result<(), OperationalError> {
        self.verify_passenger_stops()?;
        self.verify_service_outcomes()?;
        for (id, handover) in &self.prepared_handovers {
            if id != &handover.id
                || handover.acknowledged
                || handover.world_id != self.world_id
                || handover.source_region_id != self.region_id
                || handover.target_region_id == self.region_id
                || handover.infra_release_id != self.infra_release_id
                || handover.at_ms != self.now_ms
                || handover.payload_hash != handover.calculate_payload_hash()
                || self.trains.get(&handover.train.id) != Some(&handover.train)
                || handover
                    .protected_resources
                    .iter()
                    .any(|resource| !self.resource_lifecycle.contains_key(resource))
            {
                return Err(OperationalError::InvalidHandover);
            }
        }
        for (train_id, protection) in &self.handover_protection_by_train {
            if protection.is_empty()
                || self
                    .trains
                    .get(train_id)
                    .is_none_or(|train| !protection.is_subset(&train.occupied_blocks))
            {
                return Err(OperationalError::InvalidHandover);
            }
        }
        for receipts in [&self.accepted_handovers, &self.finished_handovers] {
            if receipts.iter().any(|(id, hash)| {
                id.is_empty()
                    || hash.len() != 64
                    || !hash
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) {
                return Err(OperationalError::InvalidHandover);
            }
        }
        if self.events.len() > MAX_PENDING_OPERATIONAL_EVENTS
            || self.events.last().map_or(0, |event| event.event_sequence) > self.event_sequence
            || self
                .events
                .windows(2)
                .any(|pair| pair[0].event_sequence >= pair[1].event_sequence)
            || self
                .events
                .iter()
                .any(|event| event.commit_sequence > self.commit_sequence)
        {
            return Err(OperationalError::UnsafeState);
        }
        for (train_id, request) in &self.pending_dispatch_requests {
            let Some(train) = self.trains.get(train_id) else {
                return Err(OperationalError::UnsafeState);
            };
            if train_id != &request.train_id
                || request.train_id.is_empty()
                || request.interlocking_route_id.is_empty()
                || request.waiting_since_ms > self.now_ms
                || matches!(train.motion_state, MotionState::SafeStop { .. })
            {
                return Err(OperationalError::UnsafeState);
            }
            if self.infra.is_some() {
                let Some(initial_template) = self
                    .infrastructure()?
                    .interlocking_route(&request.interlocking_route_id)?
                else {
                    return Err(OperationalError::UnsafeState);
                };
                let route = self
                    .infrastructure()?
                    .route_version(&train.route_version_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownRoute(train.route_version_id.clone())
                    })?;
                if initial_template.movement_kind != train.movement_kind
                    || initial_template.route_template_id != route.template_id
                    || initial_template.authority_start_route_mm > train.head_route_mm
                    || train.head_route_mm == route.length_mm()
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
        }
        for (resource, waiting) in &self.waiting_by_resource {
            if resource.is_empty() || waiting.is_empty() {
                return Err(OperationalError::UnsafeState);
            }
            for train_id in waiting {
                let Some(train) = self.trains.get(train_id) else {
                    return Err(OperationalError::UnsafeState);
                };
                if !self.pending_dispatch_requests.contains_key(train_id)
                    || train.speed_mmps != 0
                    || !matches!(train.motion_state, MotionState::Standing)
                    || train.motion_segment.is_some()
                    || train.authority.is_some()
                    || train.waiting_reason.as_deref() != Some("waiting-for-route-lock")
                {
                    return Err(OperationalError::UnsafeState);
                }
                if self.infra.is_some() {
                    let route = self
                        .infrastructure()?
                        .route_version(&train.route_version_id)?
                        .ok_or_else(|| {
                            OperationalError::UnknownRoute(train.route_version_id.clone())
                        })?;
                    let template = if train.movement_kind == MovementKind::Train {
                        self.infrastructure()?
                            .train_interlocking_route(&route.template_id, train.head_route_mm)?
                    } else {
                        self.infrastructure()?.interlocking_route(
                            &self.pending_dispatch_requests[train_id].interlocking_route_id,
                        )?
                    }
                    .ok_or(OperationalError::UnsafeState)?;
                    let expected = template.all_resources();
                    let actual: BTreeSet<String> = self
                        .waiting_by_resource
                        .iter()
                        .filter(|(_, candidates)| candidates.contains(train_id))
                        .map(|(resource, _)| resource.clone())
                        .collect();
                    if !expected.contains(resource) || actual != expected {
                        return Err(OperationalError::UnsafeState);
                    }
                }
            }
        }
        let mut continuation_ids = BTreeSet::new();
        let mut continuation_predecessors = BTreeSet::new();
        let mut continuation_successors = BTreeSet::new();
        let mut continuation_graph = BTreeMap::new();
        for (stored_id, continuation) in &self.pending_movement_continuations {
            if stored_id != &continuation.id
                || continuation.id.is_empty()
                || continuation.predecessor_train_id.is_empty()
                || continuation.successor.id.is_empty()
                || continuation.predecessor_train_id == continuation.successor.id
                || continuation.not_before_ms < 0
                || continuation.minimum_dwell_ms < 0
                || continuation.successor_dispatch.train_id != continuation.successor.id
                || continuation.successor_dispatch.waiting_since_ms != continuation.not_before_ms
                || (continuation.successor.public_passenger_stop
                    && continuation.successor.scheduled_departure_ms
                        != Some(continuation.not_before_ms))
                || !continuation_ids.insert(continuation.id.as_str())
                || !continuation_predecessors.insert(continuation.predecessor_train_id.as_str())
                || !continuation_successors.insert(continuation.successor.id.as_str())
            {
                return Err(OperationalError::UnsafeState);
            }
            continuation_graph.insert(
                continuation.predecessor_train_id.as_str(),
                continuation.successor.id.as_str(),
            );
        }
        for (resource, continuation_ids) in &self.continuations_waiting_by_resource {
            if resource.is_empty() || continuation_ids.is_empty() {
                return Err(OperationalError::UnsafeState);
            }
            for continuation_id in continuation_ids {
                let Some(continuation) = self.pending_movement_continuations.get(continuation_id)
                else {
                    return Err(OperationalError::UnsafeState);
                };
                let Some(predecessor) = self.trains.get(&continuation.predecessor_train_id) else {
                    return Err(OperationalError::UnsafeState);
                };
                if !matches!(predecessor.motion_state, MotionState::Standing)
                    || predecessor.waiting_reason.as_deref()
                        != Some("waiting-for-movement-continuation")
                    || !self.route_completed_at_ms.contains_key(&predecessor.id)
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
        }
        let mut receipt_sequences = BTreeSet::new();
        if self.completed_movement_continuations.len()
            > MAX_COMPLETED_MOVEMENT_CONTINUATION_RECEIPTS
        {
            return Err(OperationalError::UnsafeState);
        }
        for (continuation_id, receipt) in &self.completed_movement_continuations {
            if continuation_id.is_empty()
                || self
                    .pending_movement_continuations
                    .contains_key(continuation_id)
                || receipt.payload_hash.len() != 64
                || !receipt
                    .payload_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || receipt.completed_at_ms > self.now_ms
                || receipt.completion_sequence > self.event_sequence
                || !receipt_sequences.insert(receipt.completion_sequence)
            {
                return Err(OperationalError::UnsafeState);
            }
        }
        for start in continuation_graph.keys() {
            let mut cursor = *start;
            let mut visited = BTreeSet::new();
            while let Some(next) = continuation_graph.get(cursor) {
                if !visited.insert(cursor) {
                    return Err(OperationalError::UnsafeState);
                }
                cursor = next;
            }
        }
        for continuation in self.pending_movement_continuations.values() {
            if self.trains.contains_key(&continuation.successor.id)
                || self.trains.values().any(|train| {
                    !continuation_graph_reaches(
                        &continuation_graph,
                        &train.id,
                        &continuation.predecessor_train_id,
                    ) && operational_train_number_numeric_part(&train.train_number)
                        == operational_train_number_numeric_part(
                            &continuation.successor.train_number,
                        )
                })
                || self
                    .trains
                    .get(&continuation.predecessor_train_id)
                    .is_some_and(|predecessor| {
                        predecessor.formation_version_id
                            != continuation.successor.formation_version_id
                    })
            {
                return Err(OperationalError::UnsafeState);
            }
            if self.infra.is_some() {
                self.validate_train_program_template(
                    &continuation.successor,
                    &continuation.successor_dispatch.interlocking_route_id,
                )?;
                self.validate_known_continuation_binding(continuation)?;
            }
        }
        let mut expected_continuation_due = BTreeSet::new();
        for continuation in self.pending_movement_continuations.values() {
            if self
                .continuations_waiting_by_resource
                .values()
                .any(|waiting| waiting.contains(&continuation.id))
            {
                continue;
            }
            if self
                .trains
                .get(&continuation.predecessor_train_id)
                .is_some_and(|train| matches!(train.motion_state, MotionState::Standing))
                && let Some(completed_at_ms) = self
                    .route_completed_at_ms
                    .get(&continuation.predecessor_train_id)
            {
                expected_continuation_due.insert(ScheduledContinuationDue {
                    at_ms: continuation.not_before_ms.max(
                        completed_at_ms
                            .checked_add(continuation.minimum_dwell_ms)
                            .ok_or(OperationalError::UnsafeState)?,
                    ),
                    continuation_id: continuation.id.clone(),
                });
            }
        }
        if expected_continuation_due != self.scheduled_continuation_due {
            return Err(OperationalError::UnsafeState);
        }
        for (train_id, completed_at_ms) in &self.route_completed_at_ms {
            let Some(train) = self.trains.get(train_id) else {
                return Err(OperationalError::UnsafeState);
            };
            if *completed_at_ms > self.now_ms
                || train.speed_mmps != 0
                || train.motion_segment.is_some()
                || train.authority.is_some()
            {
                return Err(OperationalError::UnsafeState);
            }
            if self.infra.is_some() && !self.physical_route_complete(train_id)? {
                return Err(OperationalError::UnsafeState);
            }
        }
        let mut train_numbers = BTreeSet::new();
        for train in self.trains.values() {
            let Some(train_number) = operational_train_number_numeric_part(&train.train_number)
            else {
                return Err(OperationalError::UnsafeState);
            };
            if train.tail_route_mm > train.head_route_mm
                || train
                    .authority
                    .as_ref()
                    .is_some_and(|authority| train.head_route_mm > authority.end_route_mm)
                || (matches!(train.motion_state, MotionState::Moving)
                    != train.motion_segment.is_some())
            {
                return Err(OperationalError::UnsafeState);
            }
            if let Some(authority) = &train.authority {
                let Some(source_lock) = self.route_locks.get(&authority.source_route_lock_id)
                else {
                    return Err(OperationalError::UnsafeState);
                };
                if source_lock.train_id != train.id
                    || authority.train_id != train.id
                    || authority.route_version_id != train.route_version_id
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
            if !train_numbers.insert(train_number) {
                return Err(OperationalError::DuplicateTrainNumber(train_number));
            }
        }
        if cross_train_interval_overlap(self.trains.values().enumerate().flat_map(
            |(owner, train)| {
                train
                    .occupied_intervals
                    .iter()
                    .map(move |interval| (owner, interval))
            },
        )) {
            return Err(OperationalError::OccupiedTrack);
        }
        if cross_train_route_lock_overlap(self.route_locks.values()) {
            return Err(OperationalError::UnsafeState);
        }
        if self.infra.is_some() {
            let mut backed_signals = BTreeSet::new();
            for lock in self.route_locks.values() {
                let Some(train) = self.trains.get(&lock.train_id) else {
                    return Err(OperationalError::UnsafeState);
                };
                let template = self
                    .infrastructure()?
                    .interlocking_route(&lock.template_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                    })?;
                let route = self
                    .infrastructure()?
                    .route_version(&train.route_version_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownRoute(train.route_version_id.clone())
                    })?;
                if template.route_template_id != route.template_id
                    || template.movement_kind != train.movement_kind
                    || (!matches!(train.motion_state, MotionState::SafeStop { .. })
                        && template.authority_start_route_mm > train.head_route_mm
                        && train.authority.as_ref().is_none_or(|authority| {
                            authority.end_route_mm < template.authority_end_route_mm
                        }))
                    || lock.resources != template.all_resources()
                    || lock.release_after_tail_route_mm != template.release_after_tail_route_mm
                {
                    return Err(OperationalError::UnsafeState);
                }
                if train.authority.as_ref().is_some_and(|authority| {
                    authority.source_route_lock_id == lock.id
                        && authority.end_route_mm != template.authority_end_route_mm
                }) {
                    return Err(OperationalError::UnsafeState);
                }
                backed_signals.insert((template.signal_id.clone(), template.movement_kind));
                let expected_aspect = if template.movement_kind == MovementKind::Train {
                    SignalAspect::Proceed
                } else {
                    SignalAspect::ShuntingProceed
                };
                if !matches!(train.motion_state, MotionState::SafeStop { .. })
                    && self.signal_aspects.get(&template.signal_id) != Some(&expected_aspect)
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
            for (signal_id, aspect) in &self.signal_aspects {
                let expected_movement = match aspect {
                    SignalAspect::Proceed => Some(MovementKind::Train),
                    SignalAspect::ShuntingProceed => Some(MovementKind::Shunting),
                    SignalAspect::Stop | SignalAspect::Failed => None,
                };
                if let Some(expected_movement) = expected_movement {
                    if !backed_signals.contains(&(signal_id.clone(), expected_movement)) {
                        return Err(OperationalError::UnsafeState);
                    }
                }
            }
        }
        let mut owners_by_block: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for train in self.trains.values() {
            for block in &train.occupied_blocks {
                owners_by_block.entry(block).or_default().insert(&train.id);
            }
        }
        if self.route_locks.values().any(|lock| {
            lock.resources.iter().any(|resource| {
                owners_by_block
                    .get(resource.as_str())
                    .is_some_and(|owners| owners.iter().any(|owner| *owner != lock.train_id))
            })
        }) {
            return Err(OperationalError::UnsafeState);
        }
        Ok(())
    }

    pub fn state_hash(&self) -> StateHash {
        let mut canonical = self.clone();
        // Ereignisbytes liegen im append-only Tail ausserhalb des Checkpoints.
        // Die statische Infrastruktur ist bewusst nicht serialisiert. Ihre
        // signierte Dateibindung gehoert zur aeusseren RuntimeState-Grenze.
        canonical.events.clear();
        let bytes = serde_json::to_vec(&canonical)
            .expect("OperationalWorld besitzt ausschliesslich serialisierbare Zustandsfelder");
        let mut hash = StateHasher::new("operational-world/v5");
        hash.bytes("motion-policy", OPERATIONAL_MOTION_POLICY.as_bytes());
        hash.bytes("canonical-json", &bytes);
        hash.finish()
    }
}

fn intervals_for(
    route: &RouteVersion,
    tail_route_mm: i64,
    head_route_mm: i64,
) -> Result<Vec<TrackInterval>, OperationalError> {
    if tail_route_mm > head_route_mm || head_route_mm < 0 || head_route_mm > route.length_mm() {
        return Err(OperationalError::UnsafeState);
    }
    let occupied_start = tail_route_mm.max(0);
    let mut result = Vec::new();
    for leg in &route.legs {
        let from_route = occupied_start.max(leg.route_start_mm);
        let to_route = head_route_mm.min(leg.route_end_mm());
        if from_route >= to_route {
            continue;
        }
        let relative_from = from_route.saturating_sub(leg.route_start_mm);
        let relative_to = to_route.saturating_sub(leg.route_start_mm);
        let (a, b) = match leg.direction {
            Direction::Along => (
                leg.edge_entry_mm.saturating_add(relative_from),
                leg.edge_entry_mm.saturating_add(relative_to),
            ),
            Direction::Against => (
                leg.edge_entry_mm.saturating_sub(relative_to),
                leg.edge_entry_mm.saturating_sub(relative_from),
            ),
        };
        result.push(TrackInterval {
            edge_id: leg.edge_id.clone(),
            from_mm: a.min(b),
            to_mm: a.max(b),
            direction: leg.direction,
        });
    }
    Ok(result)
}

fn blocks_for(route: &RouteVersion, tail_route_mm: i64, head_route_mm: i64) -> BTreeSet<String> {
    let start = tail_route_mm.max(0);
    route
        .legs
        .iter()
        .filter(|leg| start < leg.route_end_mm() && head_route_mm > leg.route_start_mm)
        .flat_map(|leg| leg.block_ids.iter().cloned())
        .collect()
}

fn edge_geometry_position(
    infra: &dyn OperationalInfrastructure,
    edge_id: &str,
    edge_offset_mm: i64,
    direction: Direction,
) -> Result<OperationalRouteGeometryPoint, OperationalError> {
    let points = infra
        .edge_geometry(edge_id)?
        .ok_or_else(|| OperationalError::UnknownEdge(edge_id.to_owned()))?;
    if points.len() < 2 {
        return Err(OperationalError::InvalidEdgeGeometry(edge_id.to_owned()));
    }
    let mut end_index = points
        .iter()
        .position(|point| point.edge_offset_mm >= edge_offset_mm)
        .unwrap_or(points.len() - 1);
    if end_index == 0 {
        end_index = 1;
    }
    let start = &points[end_index - 1];
    let end = &points[end_index];
    let numerator = i128::from(edge_offset_mm.saturating_sub(start.edge_offset_mm));
    let denominator = i128::from(end.edge_offset_mm.saturating_sub(start.edge_offset_mm));
    let interpolate = |left: i32, right: i32| {
        i32::try_from(i128::from(left).saturating_add(div_round_half_away(
            i128::from(right.saturating_sub(left)).saturating_mul(numerator),
            denominator,
        )))
        .expect("validated E7 interpolation remains in range")
    };
    let bearing = start.bearing_milli_degrees.map(|bearing| match direction {
        Direction::Along => bearing,
        Direction::Against => bearing.saturating_add(180_000) % 360_000,
    });
    Ok(OperationalRouteGeometryPoint {
        route_mm: 0,
        edge_id: edge_id.to_owned(),
        edge_offset_mm,
        latitude_e7: interpolate(start.latitude_e7, end.latitude_e7),
        longitude_e7: interpolate(start.longitude_e7, end.longitude_e7),
        bearing_milli_degrees: bearing,
    })
}

fn route_geometry_position(
    infra: &dyn OperationalInfrastructure,
    route: &RouteVersion,
    route_mm: i64,
) -> Result<Option<OperationalRouteGeometryPoint>, OperationalError> {
    if route_mm < 0 || route_mm > route.length_mm() {
        return Ok(None);
    }
    let Some(leg) = route.leg_at(route_mm) else {
        return Ok(None);
    };
    let distance_on_leg = route_mm.saturating_sub(leg.route_start_mm);
    let edge_offset_mm = match leg.direction {
        Direction::Along => leg.edge_entry_mm.saturating_add(distance_on_leg),
        Direction::Against => leg.edge_entry_mm.saturating_sub(distance_on_leg),
    };
    let mut point = edge_geometry_position(infra, &leg.edge_id, edge_offset_mm, leg.direction)?;
    point.route_mm = route_mm;
    Ok(Some(point))
}

fn route_geometry_for(
    infra: &dyn OperationalInfrastructure,
    route: &RouteVersion,
    start_route_mm: i64,
    end_route_mm: i64,
) -> Result<Vec<OperationalRouteGeometryPoint>, OperationalError> {
    let mut result = Vec::new();
    for leg in &route.legs {
        let start = start_route_mm.max(leg.route_start_mm);
        let end = end_route_mm.min(leg.route_end_mm());
        if start >= end {
            // Am Kantenende gehoert die exakte Spitze bereits zur folgenden
            // Kante. Beide Stuetzpunkte tragen denselben Laufwegmillimeter,
            // aber jeweils ihren eigenen Kantenoffset und Richtungswinkel.
            if start_route_mm < end_route_mm && end_route_mm == leg.route_start_mm {
                let mut point =
                    edge_geometry_position(infra, &leg.edge_id, leg.edge_entry_mm, leg.direction)?;
                point.route_mm = end_route_mm;
                if result
                    .last()
                    .is_none_or(|previous: &OperationalRouteGeometryPoint| {
                        previous.route_mm != point.route_mm || previous.edge_id != point.edge_id
                    })
                {
                    result.push(point);
                }
            }
            continue;
        }
        let edge_offset = |route_mm: i64| match leg.direction {
            Direction::Along => leg
                .edge_entry_mm
                .saturating_add(route_mm.saturating_sub(leg.route_start_mm)),
            Direction::Against => leg
                .edge_entry_mm
                .saturating_sub(route_mm.saturating_sub(leg.route_start_mm)),
        };
        let mut candidates = vec![(start, edge_offset(start)), (end, edge_offset(end))];
        let geometry = infra
            .edge_geometry(&leg.edge_id)?
            .ok_or_else(|| OperationalError::UnknownEdge(leg.edge_id.clone()))?;
        for point in &geometry {
            let route_mm = match leg.direction {
                Direction::Along => leg
                    .route_start_mm
                    .saturating_add(point.edge_offset_mm.saturating_sub(leg.edge_entry_mm)),
                Direction::Against => leg
                    .route_start_mm
                    .saturating_add(leg.edge_entry_mm.saturating_sub(point.edge_offset_mm)),
            };
            if route_mm > start && route_mm < end {
                candidates.push((route_mm, point.edge_offset_mm));
            }
        }
        candidates.sort_unstable();
        for (route_mm, offset) in candidates {
            let mut point = edge_geometry_position(infra, &leg.edge_id, offset, leg.direction)?;
            point.route_mm = route_mm;
            if result.last().is_none_or(|previous| {
                previous.route_mm != point.route_mm || previous.edge_id != point.edge_id
            }) {
                result.push(point);
            }
        }
    }
    Ok(result)
}

fn kinematic_distance_mm(start_speed_mmps: u32, acceleration_mmps2: i32, elapsed_ms: i64) -> i128 {
    let elapsed = i128::from(elapsed_ms);
    let velocity_distance =
        div_round_half_away(i128::from(start_speed_mmps).saturating_mul(elapsed), 1_000);
    let acceleration_distance = div_round_half_away(
        i128::from(acceleration_mmps2)
            .saturating_mul(elapsed)
            .saturating_mul(elapsed),
        2_000_000,
    );
    velocity_distance
        .saturating_add(acceleration_distance)
        .max(0)
}

fn kinematic_speed_mmps(start_speed_mmps: u32, acceleration_mmps2: i32, elapsed_ms: i64) -> i128 {
    i128::from(start_speed_mmps)
        .saturating_add(div_round_half_away(
            i128::from(acceleration_mmps2).saturating_mul(i128::from(elapsed_ms)),
            1_000,
        ))
        .max(0)
}

fn stopping_distance_for_speed(speed_mmps: i128, brake_mmps2: u32) -> i128 {
    let denominator = i128::from(brake_mmps2.max(1)).saturating_mul(2);
    speed_mmps
        .saturating_mul(speed_mmps)
        .saturating_add(denominator - 1)
        / denominator
}

fn directed_gradient(leg: &RouteLeg) -> Result<i32, OperationalError> {
    if !(-100..=100).contains(&leg.gradient_per_mille) {
        return Err(OperationalError::IncompleteRoute(leg.edge_id.clone()));
    }
    Ok(match leg.direction {
        Direction::Along => i32::from(leg.gradient_per_mille),
        Direction::Against => -i32::from(leg.gradient_per_mille),
    })
}

fn stopping_distance_mm(speed_mmps: u32, brake_mmps2: u32) -> Result<i64, OperationalError> {
    checked_i64(stopping_distance_for_speed(
        i128::from(speed_mmps),
        brake_mmps2,
    ))
}

/// Erste diskrete Millisekundengrenze, an der nach der Beschleunigung genau
/// noch der Bremsweg bis zum Authority-Ende verbleibt. Die binäre Suche ist
/// deterministisch und wird nur beim Erzeugen eines neuen Fachereignisses
/// ausgeführt; zwischen Ereignissen findet keinerlei Polling statt.
fn acceleration_brake_boundary_ms(
    start_speed_mmps: u32,
    acceleration_mmps2: i32,
    brake_mmps2: u32,
    remaining_mm: i64,
    speed_limit_mmps: u32,
) -> Result<i64, OperationalError> {
    let acceleration = i64::from(acceleration_mmps2.unsigned_abs().max(1));
    let to_limit_ms = i64::from(speed_limit_mmps.saturating_sub(start_speed_mmps))
        .saturating_mul(1_000)
        .saturating_add(499)
        / acceleration;
    let required = |elapsed_ms| {
        let speed = kinematic_speed_mmps(start_speed_mmps, acceleration_mmps2, elapsed_ms);
        kinematic_distance_mm(start_speed_mmps, acceleration_mmps2, elapsed_ms)
            .saturating_add(stopping_distance_for_speed(speed, brake_mmps2))
    };
    if required(0) >= i128::from(remaining_mm) {
        return Ok(0);
    }
    if required(to_limit_ms) < i128::from(remaining_mm) {
        return Ok(to_limit_ms.max(1));
    }
    let mut low = 1_i64;
    let mut high = to_limit_ms.max(1);
    while low < high {
        let middle = low.saturating_add(high.saturating_sub(low) / 2);
        if required(middle) >= i128::from(remaining_mm) {
            high = middle;
        } else {
            low = middle.saturating_add(1);
        }
    }
    Ok(low)
}

fn analytic_duration_ms(
    start_speed_mmps: u32,
    acceleration_mmps2: i32,
    distance_mm: i64,
    speed_limit_mmps: u32,
) -> Result<i64, OperationalError> {
    if distance_mm <= 0 {
        return Ok(1);
    }
    if acceleration_mmps2 > 0 {
        let delta_speed = speed_limit_mmps.saturating_sub(start_speed_mmps);
        let acceleration = i64::from(acceleration_mmps2.unsigned_abs().max(1));
        let to_limit = i64::from(delta_speed)
            .saturating_mul(1_000)
            .saturating_add(acceleration - 1)
            / acceleration;
        return Ok(first_boundary_or_event_ms(
            start_speed_mmps,
            acceleration_mmps2,
            distance_mm,
            to_limit.max(1),
        ));
    }
    if acceleration_mmps2 < 0 {
        let deceleration = i64::from(acceleration_mmps2.unsigned_abs().max(1));
        let to_stop = i64::from(start_speed_mmps)
            .saturating_mul(1_000)
            .saturating_add(deceleration - 1)
            / deceleration;
        return Ok(first_boundary_or_event_ms(
            start_speed_mmps,
            acceleration_mmps2,
            distance_mm,
            to_stop.max(1),
        ));
    }
    if start_speed_mmps == 0 {
        return Err(OperationalError::UnsafeState);
    }
    Ok(distance_mm
        .saturating_mul(1_000)
        .saturating_add(i64::from(start_speed_mmps) - 1)
        / i64::from(start_speed_mmps))
}

fn first_boundary_or_event_ms(
    start_speed_mmps: u32,
    acceleration_mmps2: i32,
    distance_mm: i64,
    event_ms: i64,
) -> i64 {
    let distance_at = |elapsed_ms: i64| {
        let elapsed = i128::from(elapsed_ms);
        let velocity_distance =
            div_round_half_away(i128::from(start_speed_mmps).saturating_mul(elapsed), 1_000);
        let acceleration_distance = div_round_half_away(
            i128::from(acceleration_mmps2)
                .saturating_mul(elapsed)
                .saturating_mul(elapsed),
            2_000_000,
        );
        velocity_distance
            .saturating_add(acceleration_distance)
            .max(0)
    };
    if distance_at(event_ms) < i128::from(distance_mm) {
        return event_ms;
    }
    let mut low = 1_i64;
    let mut high = event_ms;
    while low < high {
        let middle = low.saturating_add(high.saturating_sub(low) / 2);
        if distance_at(middle) >= i128::from(distance_mm) {
            high = middle;
        } else {
            low = middle.saturating_add(1);
        }
    }
    low
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OperationalError {
    InvalidPassengerStopPlan,
    InvalidServiceOutcome,
    ArithmeticOverflow,
    EventBudgetExceeded,
    OutsideMotionValidity,
    IncompleteInfraRelease,
    MissingInfrastructureBinding,
    ForeignInfrastructureBinding,
    InfrastructureAccess(String),
    IncompleteRoute(String),
    UnknownEdge(String),
    InvalidInterlockingRoute(String),
    InvalidEdgeGeometry(String),
    IncompleteVehicleType(String),
    UnknownVehicleType(String),
    UnknownVehicle(String),
    UnknownFormation(String),
    UnknownRoute(String),
    UnknownTrain(String),
    UnknownInterlockingRoute(String),
    UnknownPlatform(String),
    DuplicateId(String),
    InvalidTrainNumber(String),
    DuplicateTrainNumber(u32),
    InvalidFormation(String),
    UnsafeMaterialization(String),
    InvalidProgramTemplate(String),
    IncompatibleProtectionSystem(String),
    OccupiedTrack,
    UnsafeRoute(String),
    WrongMovementKind,
    VehicleAlreadyMaterialized,
    InvalidDispatchRequest(String),
    TrainNotRetirable(String),
    InvalidShuntingNeed,
    NoSafeShuntingRoute,
    NoAuthority,
    UnsafeState,
    PassengerDepartureTooEarly,
    TimeRegression,
    AuthorityExceeded,
    FormationChangeWhileMoving,
    MissingTechnicalRelease,
    InvalidCheckpoint,
    RouteChangeWhileMoving,
    RerouteWhileAuthorized,
    DiscontinuousReroute(String),
    InvalidMovementContinuation(String),
    UnknownMovementContinuation(String),
    ConflictingMovementContinuationId(String),
    DuplicateMovementContinuationLink(String),
    CyclicMovementContinuation(String),
    InvalidMovementContinuationTimes(String),
    DiscontinuousMovementContinuation(String),
    ReversalWithoutControlStands(String),
    MovementContinuationFormationMismatch(String),
    MovementContinuationTargetOccupied(String),
    UnprotectedHandover,
    InvalidHandover,
}

impl fmt::Display for OperationalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for OperationalError {}

#[cfg(test)]
mod invariant_tests {
    use super::*;

    fn interval(edge_id: &str, from_mm: i64, to_mm: i64, direction: Direction) -> TrackInterval {
        TrackInterval {
            edge_id: edge_id.to_owned(),
            from_mm,
            to_mm,
            direction,
        }
    }

    fn equivalence_leg(
        edge_id: &str,
        edge_entry_mm: i64,
        edge_exit_mm: i64,
        route_start_mm: i64,
        protection: &str,
    ) -> RouteLeg {
        RouteLeg {
            edge_id: edge_id.to_owned(),
            direction: Direction::Along,
            edge_entry_mm,
            edge_exit_mm,
            route_start_mm,
            block_ids: BTreeSet::from([format!("block:{edge_id}")]),
            speed_limit_mmps: 20_000,
            gradient_per_mille: 0,
            available_protection_systems: vec![protection.to_owned()],
            simultaneously_required_protection_systems: Vec::new(),
        }
    }

    #[test]
    fn predecessor_route_equivalence_normalizes_splits_but_not_length_or_protection() {
        let base = RouteVersion {
            id: "route:base".to_owned(),
            template_id: "template:base".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![
                equivalence_leg("edge:a", 0, 10_000, 0, "pzb"),
                equivalence_leg("edge:b", 0, 10_000, 10_000, "pzb"),
            ],
        };
        let qualified = RouteVersion {
            id: "route:qualified".to_owned(),
            template_id: "template:qualified".to_owned(),
            predecessor_id: Some("route:movement".to_owned()),
            transition_route_mm: Some(15_000),
            legs: vec![
                equivalence_leg("edge:a", 0, 5_000, 0, "pzb"),
                equivalence_leg("edge:a", 5_000, 10_000, 5_000, "pzb"),
                equivalence_leg("edge:b", 0, 10_000, 10_000, "pzb"),
            ],
        };
        assert!(physically_equivalent_predecessor_routes(&qualified, &base, 15_000).unwrap());

        let mut wrong_length = qualified.clone();
        wrong_length.legs[2].edge_exit_mm = 11_000;
        assert!(!physically_equivalent_predecessor_routes(&wrong_length, &base, 15_000).unwrap());

        let mut wrong_protection = qualified;
        wrong_protection.legs[1].available_protection_systems = vec!["lzb".to_owned()];
        assert!(
            !physically_equivalent_predecessor_routes(&wrong_protection, &base, 15_000,).unwrap()
        );
    }

    fn train(
        id: &str,
        train_number: &str,
        occupied_intervals: Vec<TrackInterval>,
    ) -> OperationalTrain {
        OperationalTrain {
            passenger_stops: None,
            service_outcome: None,
            id: id.to_owned(),
            train_number: train_number.to_owned(),
            operator_id: "operator:test".to_owned(),
            movement_kind: MovementKind::Train,
            route_version_id: "route:test".to_owned(),
            formation_version_id: "formation:test".to_owned(),
            head_route_mm: 0,
            tail_route_mm: 0,
            speed_mmps: 0,
            direction: Direction::Along,
            motion_state: MotionState::Standing,
            motion_segment: None,
            authority: None,
            occupied_intervals,
            occupied_blocks: BTreeSet::new(),
            scheduled_departure_ms: None,
            public_passenger_stop: false,
            waiting_reason: None,
        }
    }

    fn lock(id: &str, train_id: &str, resources: &[&str]) -> RouteLock {
        RouteLock {
            id: id.to_owned(),
            template_id: "interlocking:test".to_owned(),
            train_id: train_id.to_owned(),
            resources: resources
                .iter()
                .map(|resource| (*resource).to_owned())
                .collect(),
            release_after_tail_route_mm: 0,
            locked_at_ms: 0,
        }
    }

    fn world(trains: Vec<OperationalTrain>, locks: Vec<RouteLock>) -> OperationalWorld {
        OperationalWorld {
            world_id: "world:test".to_owned(),
            region_id: "region:test".to_owned(),
            infra_release_id: "infra:test".to_owned(),
            now_ms: 0,
            commit_sequence: 0,
            event_sequence: 0,
            trains: trains
                .into_iter()
                .map(|train| (train.id.clone(), train))
                .collect(),
            vehicles: BTreeMap::new(),
            vehicle_types: BTreeMap::new(),
            formations: BTreeMap::new(),
            route_locks: locks
                .into_iter()
                .map(|lock| (lock.id.clone(), lock))
                .collect(),
            signal_aspects: BTreeMap::new(),
            switch_positions: BTreeMap::new(),
            resource_lifecycle: BTreeMap::new(),
            active_disruptions: BTreeMap::new(),
            events: Vec::new(),
            processed_command_ids: BTreeSet::new(),
            infra: None,
            handover_protection_by_train: BTreeMap::new(),
            service_outcome_state: None,
            prepared_handovers: BTreeMap::new(),
            accepted_handovers: BTreeMap::new(),
            finished_handovers: BTreeMap::new(),
            scheduled_motion_ends: BTreeSet::new(),
            scheduled_passenger_departures: BTreeSet::new(),
            scheduled_continuation_due: BTreeSet::new(),
            waiting_by_resource: BTreeMap::new(),
            continuations_waiting_by_resource: BTreeMap::new(),
            pending_dispatch_requests: BTreeMap::new(),
            pending_movement_continuations: BTreeMap::new(),
            completed_movement_continuations: BTreeMap::new(),
            route_completed_at_ms: BTreeMap::new(),
        }
    }

    fn directed_edge_offsets(direction: Direction, length_mm: i64) -> (i64, i64) {
        match direction {
            Direction::Along => (0, length_mm),
            Direction::Against => (length_mm, 0),
        }
    }

    fn edge_geometry(length_mm: i64, longitude_e7: i32) -> Vec<EdgeGeometryPoint> {
        vec![
            EdgeGeometryPoint {
                edge_offset_mm: 0,
                latitude_e7: 0,
                longitude_e7,
                bearing_milli_degrees: Some(0),
            },
            EdgeGeometryPoint {
                edge_offset_mm: length_mm,
                latitude_e7: 0,
                longitude_e7: longitude_e7.saturating_add(1),
                bearing_milli_degrees: None,
            },
        ]
    }

    fn one_millimetre_world(
        direction: Direction,
        continuation_direction: Option<Direction>,
    ) -> OperationalWorld {
        let (edge_entry_mm, edge_exit_mm) = directed_edge_offsets(direction, 1);
        let mut legs = vec![RouteLeg {
            edge_id: "edge:one-millimetre".to_owned(),
            direction,
            edge_entry_mm,
            edge_exit_mm,
            route_start_mm: 0,
            block_ids: BTreeSet::from(["block:path:first".to_owned()]),
            speed_limit_mmps: 20_000,
            gradient_per_mille: 0,
            available_protection_systems: vec!["pzb".to_owned()],
            simultaneously_required_protection_systems: Vec::new(),
        }];
        let mut directed_edges = BTreeMap::from([("edge:one-millimetre".to_owned(), 1)]);
        let mut edge_geometries =
            BTreeMap::from([("edge:one-millimetre".to_owned(), edge_geometry(1, 0))]);
        let mut block_resources = BTreeSet::from([
            "block:path:first".to_owned(),
            "block:overlap".to_owned(),
            "block:flank".to_owned(),
        ]);
        if let Some(continuation_direction) = continuation_direction {
            let (edge_entry_mm, edge_exit_mm) =
                directed_edge_offsets(continuation_direction, 1_000);
            legs.push(RouteLeg {
                edge_id: "edge:continuation".to_owned(),
                direction: continuation_direction,
                edge_entry_mm,
                edge_exit_mm,
                route_start_mm: 1,
                block_ids: BTreeSet::from(["block:path:continuation".to_owned()]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: 0,
                available_protection_systems: vec!["pzb".to_owned()],
                simultaneously_required_protection_systems: Vec::new(),
            });
            directed_edges.insert("edge:continuation".to_owned(), 1_000);
            edge_geometries.insert("edge:continuation".to_owned(), edge_geometry(1_000, 1));
            block_resources.insert("block:path:continuation".to_owned());
        }
        let route = RouteVersion {
            id: "route:one-millimetre".to_owned(),
            template_id: "route-template:one-millimetre".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs,
        };
        let interlocking = InterlockingRouteTemplate {
            id: "interlocking:one-millimetre".to_owned(),
            route_template_id: route.template_id.clone(),
            authority_start_route_mm: 0,
            signal_id: "signal:one-millimetre".to_owned(),
            movement_kind: MovementKind::Train,
            path_resources: BTreeSet::from(["block:path:first".to_owned()]),
            overlap_resources: BTreeSet::from(["block:overlap".to_owned()]),
            flank_resources: BTreeSet::from(["block:flank".to_owned()]),
            switch_positions: BTreeMap::new(),
            authority_end_route_mm: 1,
            release_after_tail_route_mm: 1,
        };
        let mut interlocking_routes = BTreeMap::from([(interlocking.id.clone(), interlocking)]);
        let mut signals = BTreeSet::from(["signal:one-millimetre".to_owned()]);
        if continuation_direction.is_some() {
            let continuation = InterlockingRouteTemplate {
                id: "interlocking:continuation".to_owned(),
                route_template_id: route.template_id.clone(),
                authority_start_route_mm: 1,
                signal_id: "signal:continuation".to_owned(),
                movement_kind: MovementKind::Train,
                path_resources: BTreeSet::from(["block:path:continuation".to_owned()]),
                overlap_resources: BTreeSet::from(["block:overlap".to_owned()]),
                flank_resources: BTreeSet::from(["block:flank".to_owned()]),
                switch_positions: BTreeMap::new(),
                authority_end_route_mm: 1_001,
                release_after_tail_route_mm: 1_001,
            };
            signals.insert(continuation.signal_id.clone());
            interlocking_routes.insert(continuation.id.clone(), continuation);
        }
        let infrastructure = OperationalInfraRelease {
            id: "infra:one-millimetre".to_owned(),
            directed_edges,
            edge_geometries,
            route_versions: BTreeMap::from([(route.id.clone(), route)]),
            interlocking_routes,
            signals,
            switches: BTreeSet::new(),
            block_resources,
            platform_intervals: BTreeMap::new(),
            region_boundaries: BTreeSet::new(),
            rzue_layout_id: "rzue:one-millimetre".to_owned(),
        };
        let mut world = OperationalWorld::new(
            "world:one-millimetre",
            "region:one-millimetre",
            0,
            infrastructure,
        )
        .unwrap();
        world
            .register_vehicle_type(
                VehicleType {
                    id: "type:one-millimetre".to_owned(),
                    role: Some(OperationalVehicleRole::PoweredUnit),
                    control_stands: Some(OperationalControlStands {
                        front: true,
                        rear: true,
                    }),
                    traction: Some(OperationalVehicleTraction::Electric),
                    electric_systems: Some(vec![OperationalPowerSystem::Ac15kv]),
                    length_mm: 1,
                    mass_kg: 1,
                    maximum_speed_mmps: 20_000,
                    power_watts: 1,
                    starting_tractive_force_newtons: 1,
                    raw_formation_dynamics: Some(VehicleTypeRawFormationDynamics {
                        brake_weight_kg: 1,
                        maximum_acceleration_cap_mmps2: 900,
                        service_brake_cap_mmps2: 900,
                        emergency_brake_multiplier_basis_points: 13_334,
                    }),
                    maximum_acceleration_mmps2: 900,
                    service_brake_mmps2: 900,
                    emergency_brake_mmps2: 1_200,
                    protection_systems: BTreeSet::from(["pzb".to_owned()]),
                },
                true,
            )
            .unwrap();
        world
            .register_vehicle(PhysicalVehicle {
                id: "vehicle:one-millimetre".to_owned(),
                type_id: "type:one-millimetre".to_owned(),
                powered: true,
                orientation: direction,
                condition: VehicleCondition {
                    mechanics_basis_points: 10_000,
                    drive_basis_points: 10_000,
                    brakes_basis_points: 10_000,
                    kilometres_since_maintenance: 0,
                    operating_hours_since_maintenance: 0,
                    open_observations: 0,
                },
                restrictions: BTreeMap::new(),
                history: Vec::new(),
            })
            .unwrap();
        world
            .create_formation(
                "formation:one-millimetre",
                None,
                vec!["vehicle:one-millimetre".to_owned()],
            )
            .unwrap();
        world
            .materialize_train(
                "train:one-millimetre",
                "RB 1",
                "operator:test",
                MovementKind::Train,
                "route:one-millimetre",
                "formation:one-millimetre",
                0,
                None,
                false,
            )
            .unwrap();
        world
            .lock_route("train:one-millimetre", "interlocking:one-millimetre")
            .unwrap();
        if continuation_direction.is_some() {
            world
                .extend_available_train_authority("train:one-millimetre")
                .unwrap();
        }
        world.plan_motion("train:one-millimetre").unwrap();
        world.events.clear();
        world
    }

    fn quadratic_interval_overlap(intervals: &[(usize, TrackInterval)]) -> bool {
        intervals.iter().enumerate().any(|(left_index, left)| {
            intervals
                .iter()
                .skip(left_index + 1)
                .any(|right| left.0 != right.0 && left.1.overlaps(&right.1))
        })
    }

    fn indexed_interval_overlap(intervals: &[(usize, TrackInterval)]) -> bool {
        cross_train_interval_overlap(intervals.iter().map(|(owner, interval)| (*owner, interval)))
    }

    #[test]
    fn indexed_interval_check_matches_quadratic_contract_for_all_pair_shapes() {
        let mut variants = Vec::new();
        for edge_id in ["edge:a", "edge:b"] {
            for direction in [Direction::Along, Direction::Against] {
                for from_mm in -2..=2 {
                    for to_mm in -2..=2 {
                        variants.push(interval(edge_id, from_mm, to_mm, direction));
                    }
                }
            }
        }

        for left in &variants {
            for right in &variants {
                for right_owner in [0, 1] {
                    let intervals = [(0, left.clone()), (right_owner, right.clone())];
                    assert_eq!(
                        indexed_interval_overlap(&intervals),
                        quadratic_interval_overlap(&intervals),
                        "left={left:?} right={right:?} right_owner={right_owner}"
                    );
                }
            }
        }
    }

    #[test]
    fn indexed_interval_check_matches_quadratic_contract_for_owner_mixtures() {
        let mut variants = Vec::new();
        for from_mm in -1..=1 {
            for to_mm in -1..=1 {
                variants.push(interval("edge:a", from_mm, to_mm, Direction::Along));
            }
        }

        for first in &variants {
            for second in &variants {
                for third in &variants {
                    for second_owner in 0..=2 {
                        for third_owner in 0..=2 {
                            let intervals = [
                                (0, first.clone()),
                                (second_owner, second.clone()),
                                (third_owner, third.clone()),
                            ];
                            assert_eq!(
                                indexed_interval_overlap(&intervals),
                                quadratic_interval_overlap(&intervals),
                                "intervals={intervals:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn verify_invariants_allows_one_train_to_overlap_its_own_state() {
        let train = train(
            "train:1",
            "RE 1",
            vec![
                interval("edge:a", 0, 20, Direction::Along),
                interval("edge:a", 10, 30, Direction::Against),
            ],
        );
        let world = world(
            vec![train],
            vec![
                lock("lock:1", "train:1", &["resource:shared"]),
                lock("lock:2", "train:1", &["resource:shared", "resource:other"]),
            ],
        );

        assert_eq!(world.verify_invariants(), Ok(()));
    }

    #[test]
    fn incremental_resource_refresh_matches_full_reference_with_shared_locks() {
        let mut state = world(
            vec![train("t", "RB 1", Vec::new())],
            vec![
                lock("one", "t", &["shared", "first"]),
                lock("two", "t", &["shared", "second"]),
            ],
        );
        state.rebuild_resource_lifecycle();
        let resources = ["shared", "first", "second", "occupied"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        for step in 0..4 {
            match step {
                0 => {
                    state
                        .trains
                        .get_mut("t")
                        .unwrap()
                        .occupied_blocks
                        .insert("occupied".into());
                }
                1 => {
                    state.route_locks.remove("one");
                }
                2 => {
                    state
                        .trains
                        .get_mut("t")
                        .unwrap()
                        .occupied_blocks
                        .insert("shared".into());
                    state.route_locks.remove("two");
                }
                _ => {
                    state.trains.get_mut("t").unwrap().occupied_blocks.clear();
                }
            }
            state.refresh_resource_lifecycle(&resources);
            let incremental = state.resource_lifecycle.clone();
            state.rebuild_resource_lifecycle();
            assert_eq!(incremental, state.resource_lifecycle, "step={step}");
        }
    }

    #[test]
    fn verify_invariants_rejects_each_cross_train_conflict() {
        let left = train(
            "train:1",
            "RE 1",
            vec![interval("edge:a", 0, 20, Direction::Along)],
        );
        let overlapping = train(
            "train:2",
            "RE 2",
            vec![interval("edge:a", 10, 30, Direction::Against)],
        );
        assert_eq!(
            world(vec![left.clone(), overlapping], Vec::new()).verify_invariants(),
            Err(OperationalError::OccupiedTrack)
        );

        let disjoint = train(
            "train:2",
            "RE 2",
            vec![interval("edge:a", 20, 30, Direction::Along)],
        );
        assert_eq!(
            world(
                vec![left.clone(), disjoint.clone()],
                vec![
                    lock("lock:1", "train:1", &["resource:shared"]),
                    lock("lock:2", "train:2", &["resource:shared"]),
                ],
            )
            .verify_invariants(),
            Err(OperationalError::UnsafeState)
        );

        let mut duplicate_number = disjoint;
        duplicate_number.train_number = left.train_number.clone();
        assert_eq!(
            world(vec![left, duplicate_number], Vec::new()).verify_invariants(),
            Err(OperationalError::DuplicateTrainNumber(1))
        );
    }

    #[test]
    fn terminal_one_millimetre_rounding_reaches_authority_in_both_edge_directions() {
        for direction in [Direction::Along, Direction::Against] {
            let mut world = one_millimetre_world(direction, None);

            world.advance_to(60_000).unwrap();

            let train = &world.trains["train:one-millimetre"];
            assert_eq!(train.head_route_mm, 1, "direction={direction:?}");
            assert_eq!(train.tail_route_mm, 0, "direction={direction:?}");
            assert_eq!(train.speed_mmps, 0, "direction={direction:?}");
            assert_eq!(train.direction, direction);
            assert_eq!(train.motion_state, MotionState::Standing);
            assert!(train.motion_segment.is_none());
            assert!(train.authority.is_none());
            assert!(world.scheduled_motion_ends.is_empty());
            assert!(world.route_locks.is_empty());
            assert_eq!(world.events.len(), 4);
            assert_eq!(world.verify_invariants(), Ok(()));
        }
    }

    #[test]
    fn internal_one_millimetre_leg_boundary_keeps_motion_occupation_and_lock() {
        let mut world = one_millimetre_world(Direction::Along, Some(Direction::Against));
        let first_segment_end_ms = world.trains["train:one-millimetre"]
            .motion_segment
            .as_ref()
            .unwrap()
            .valid_until_ms;

        world.advance_to(first_segment_end_ms).unwrap();

        let train = &world.trains["train:one-millimetre"];
        assert_eq!(train.head_route_mm, 1);
        assert_eq!(train.tail_route_mm, 0);
        assert!(train.speed_mmps > 0);
        assert_eq!(train.direction, Direction::Against);
        assert_eq!(train.motion_state, MotionState::Moving);
        let continuation = train.motion_segment.as_ref().unwrap();
        assert_eq!(continuation.start_route_mm, 1);
        assert!(continuation.segment_end_route_mm > 1);
        assert!(continuation.valid_until_ms > first_segment_end_ms);
        assert_eq!(train.authority.as_ref().unwrap().end_route_mm, 1_001);
        assert_eq!(
            train.occupied_intervals,
            vec![TrackInterval {
                edge_id: "edge:one-millimetre".to_owned(),
                from_mm: 0,
                to_mm: 1,
                direction: Direction::Along,
            }]
        );
        assert_eq!(
            train.occupied_blocks,
            BTreeSet::from(["block:path:first".to_owned()])
        );
        assert_eq!(world.route_locks.len(), 2);
        assert_eq!(world.scheduled_motion_ends.len(), 1);
        assert_eq!(
            world.signal_aspects["signal:one-millimetre"],
            SignalAspect::Proceed
        );
        assert_eq!(world.events.len(), 2);
        assert_eq!(world.verify_invariants(), Ok(()));
    }

    #[test]
    fn motion_boundary_snap_is_end_only_and_fail_closed_for_invalid_bounds() {
        let terminal_braking = MotionSegment {
            started_at_ms: 0,
            valid_until_ms: 2,
            start_route_mm: 0,
            start_speed_mmps: 1,
            acceleration_mmps2: -900,
            route_version_id: "route:test".to_owned(),
            authority_end_route_mm: 1,
            segment_end_route_mm: 1,
        };
        assert_eq!(terminal_braking.position_at(1), Ok(0));
        assert_eq!(terminal_braking.position_at(2), Ok(1));
        assert_eq!(terminal_braking.speed_at(2), Ok(0));

        let zero_length = MotionSegment {
            segment_end_route_mm: 0,
            ..terminal_braking.clone()
        };
        assert_eq!(zero_length.position_at(2), Ok(0));

        let zero_duration = MotionSegment {
            started_at_ms: 2,
            ..terminal_braking.clone()
        };
        assert_eq!(zero_duration.position_at(2), Ok(0));

        let two_millimetre_zero_progress = MotionSegment {
            authority_end_route_mm: 2,
            segment_end_route_mm: 2,
            ..terminal_braking.clone()
        };
        assert_eq!(two_millimetre_zero_progress.position_at(2), Ok(0));

        let counterrunning = MotionSegment {
            start_route_mm: 1,
            segment_end_route_mm: 0,
            ..terminal_braking.clone()
        };
        assert_eq!(
            counterrunning.position_at(2),
            Err(OperationalError::UnsafeState)
        );
        assert_eq!(
            counterrunning.speed_at(2),
            Err(OperationalError::UnsafeState)
        );

        let beyond_authority = MotionSegment {
            authority_end_route_mm: 1,
            segment_end_route_mm: 2,
            ..terminal_braking.clone()
        };
        assert_eq!(
            beyond_authority.position_at(2),
            Err(OperationalError::UnsafeState)
        );
        assert_eq!(
            beyond_authority.speed_at(2),
            Err(OperationalError::UnsafeState)
        );

        let negative_route_position = MotionSegment {
            start_route_mm: -1,
            authority_end_route_mm: 0,
            segment_end_route_mm: 0,
            ..terminal_braking
        };
        assert_eq!(
            negative_route_position.position_at(2),
            Err(OperationalError::UnsafeState)
        );
        assert_eq!(
            negative_route_position.speed_at(2),
            Err(OperationalError::UnsafeState)
        );
    }

    #[test]
    fn longer_zero_progress_segment_finishes_fail_closed_without_mutation() {
        let mut world = one_millimetre_world(Direction::Along, Some(Direction::Against));
        let manipulated = MotionSegment {
            started_at_ms: 0,
            valid_until_ms: 2,
            start_route_mm: 0,
            start_speed_mmps: 1,
            acceleration_mmps2: -900,
            route_version_id: "route:one-millimetre".to_owned(),
            authority_end_route_mm: 1_001,
            segment_end_route_mm: 2,
        };
        world.now_ms = manipulated.valid_until_ms;
        world
            .trains
            .get_mut("train:one-millimetre")
            .unwrap()
            .motion_segment = Some(manipulated);
        let train_before = world.trains["train:one-millimetre"].clone();

        assert_eq!(
            world.finish_motion_segment("train:one-millimetre"),
            Err(OperationalError::UnsafeState)
        );
        assert_eq!(world.trains["train:one-millimetre"], train_before);
        assert!(world.events.is_empty());
        assert_eq!(world.route_locks.len(), 2);
    }

    #[test]
    fn motion_boundary_snap_does_not_mask_position_overflow() {
        let segment = MotionSegment {
            started_at_ms: 0,
            valid_until_ms: 1_000,
            start_route_mm: i64::MAX - 1,
            start_speed_mmps: u32::MAX,
            acceleration_mmps2: 0,
            route_version_id: "route:test".to_owned(),
            authority_end_route_mm: i64::MAX,
            segment_end_route_mm: i64::MAX,
        };

        assert_eq!(
            segment.position_at(segment.valid_until_ms),
            Err(OperationalError::ArithmeticOverflow)
        );
    }

    #[test]
    fn record_enforces_pending_event_budget_without_partial_mutation() {
        let mut world = world(Vec::new(), Vec::new());
        world.events = (1..MAX_PENDING_OPERATIONAL_EVENTS)
            .map(|sequence| OperationalEvent {
                event_sequence: u64::try_from(sequence).unwrap(),
                commit_sequence: 0,
                at_ms: 0,
                kind: "existing".to_owned(),
                subject_id: "subject:test".to_owned(),
                detail: String::new(),
            })
            .collect();
        world.event_sequence = u64::try_from(world.events.len()).unwrap();

        world
            .record("at-budget", "subject:test", "accepted")
            .unwrap();
        assert_eq!(world.events.len(), MAX_PENDING_OPERATIONAL_EVENTS);
        assert_eq!(world.verify_invariants(), Ok(()));
        let event_sequence_at_limit = world.event_sequence;

        assert_eq!(
            world.record("over-budget", "subject:test", "rejected"),
            Err(OperationalError::EventBudgetExceeded)
        );
        assert_eq!(world.events.len(), MAX_PENDING_OPERATIONAL_EVENTS);
        assert_eq!(world.event_sequence, event_sequence_at_limit);
        assert_eq!(world.events.last().unwrap().kind, "at-budget");
    }
}
