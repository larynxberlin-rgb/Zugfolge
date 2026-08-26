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

/// Millisekunden seit der unveraenderlichen Weltepoche.
pub type SimMillis = i64;
/// Millimeter entlang eines unveraenderlichen Laufwegs.
pub type RouteMillimetres = i64;

/// Projektionsgueltigkeit fuer den produktiven 60-s-Scheduler plus 15-s-Marge.
pub const OPERATIONAL_PROJECTION_VALIDITY_MS: SimMillis = 75_000;

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
    pub fn position_at(&self, at_ms: SimMillis) -> Result<RouteMillimetres, OperationalError> {
        if at_ms < self.started_at_ms || at_ms > self.valid_until_ms {
            return Err(OperationalError::OutsideMotionValidity);
        }
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
        Ok(
            checked_i64(i128::from(self.start_route_mm).saturating_add(distance))?
                .min(self.authority_end_route_mm)
                .min(self.segment_end_route_mm),
        )
    }

    pub fn speed_at(&self, at_ms: SimMillis) -> Result<u32, OperationalError> {
        if at_ms < self.started_at_ms || at_ms > self.valid_until_ms {
            return Err(OperationalError::OutsideMotionValidity);
        }
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
                || template.authority_end_route_mm <= 0
                || template.release_after_tail_route_mm < 0
                || template.release_after_tail_route_mm > template.authority_end_route_mm
                || matching_routes
                    .iter()
                    .any(|route| template.authority_end_route_mm > route.length_mm())
            {
                return Err(OperationalError::InvalidInterlockingRoute(
                    template.id.clone(),
                ));
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
    fn route_version(&self, id: &str) -> Result<Option<RouteVersion>, OperationalError>;
    fn interlocking_route(
        &self,
        id: &str,
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

impl OperationalInfrastructure for OperationalInfraRelease {
    fn release_id(&self) -> &str {
        &self.id
    }

    fn binding_identity(&self) -> &str {
        &self.id
    }

    fn validate_attachment(&self) -> Result<(), OperationalError> {
        self.validate()
    }

    fn route_version(&self, id: &str) -> Result<Option<RouteVersion>, OperationalError> {
        Ok(self.route_versions.get(id).cloned())
    }

    fn interlocking_route(
        &self,
        id: &str,
    ) -> Result<Option<InterlockingRouteTemplate>, OperationalError> {
        Ok(self.interlocking_routes.get(id).cloned())
    }

    fn shunting_interlocking_routes(
        &self,
        minimum_authority_end_route_mm: RouteMillimetres,
    ) -> Result<Vec<InterlockingRouteTemplate>, OperationalError> {
        Ok(self
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
        Ok(self.platform_intervals.get(id).cloned())
    }

    fn edge_geometry(
        &self,
        edge_id: &str,
    ) -> Result<Option<Vec<EdgeGeometryPoint>>, OperationalError> {
        Ok(self.edge_geometries.get(edge_id).cloned())
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
    pub source_region_id: String,
    pub target_region_id: String,
    pub train: OperationalTrain,
    pub formation: FormationVersion,
    pub protected_resources: BTreeSet<String>,
    pub source_commit_sequence: u64,
    pub acknowledged: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledMotionEnd {
    at_ms: SimMillis,
    train_id: String,
    segment_started_at_ms: SimMillis,
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
    waiting_by_resource: BTreeMap<String, BTreeSet<String>>,
    pending_dispatch_requests: BTreeMap<String, DispatchRequest>,
}

impl OperationalWorld {
    pub fn new(
        world_id: impl Into<String>,
        region_id: impl Into<String>,
        now_ms: SimMillis,
        infra: OperationalInfraRelease,
    ) -> Result<Self, OperationalError> {
        infra.validate()?;
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
            waiting_by_resource: BTreeMap::new(),
            pending_dispatch_requests: BTreeMap::new(),
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
        vehicle_type.validate(powered)?;
        if self.vehicle_types.contains_key(&vehicle_type.id) {
            return Err(OperationalError::DuplicateId(vehicle_type.id));
        }
        self.vehicle_types
            .insert(vehicle_type.id.clone(), vehicle_type);
        Ok(())
    }

    pub fn register_vehicle(&mut self, vehicle: PhysicalVehicle) -> Result<(), OperationalError> {
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
            movement_kind_matches: template.movement_kind == train.movement_kind,
            route_template_matches: template.route_template_id == route.template_id,
            authority_path_resources_cover_route: route
                .legs
                .iter()
                .all(|leg| leg.block_ids.is_subset(&template.path_resources)),
            authority_end_matches_route: template.authority_end_route_mm == route.length_mm(),
            release_after_tail_within_authority: template.release_after_tail_route_mm >= 0
                && template.release_after_tail_route_mm <= template.authority_end_route_mm,
            resource_binding_count: template.all_resources().len(),
        })
    }

    pub fn materialize(&mut self, input: TrainMaterialization) -> Result<(), OperationalError> {
        let TrainMaterialization {
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
        let train = OperationalTrain {
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
        let (retiring_lock_ids, retiring_signal_ids, retained_signal_ids) = {
            let infrastructure = self.infrastructure()?;
            let mut retiring_lock_ids = BTreeSet::new();
            let mut retiring_signal_ids = BTreeSet::new();
            let mut retained_signal_ids = BTreeSet::new();
            for lock in self.route_locks.values() {
                let template = infrastructure
                    .interlocking_route(&lock.template_id)?
                    .ok_or_else(|| {
                        OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                    })?;
                if lock.train_id == train_id {
                    retiring_lock_ids.insert(lock.id.clone());
                    retiring_signal_ids.insert(template.signal_id);
                } else {
                    retained_signal_ids.insert(template.signal_id);
                }
            }
            (retiring_lock_ids, retiring_signal_ids, retained_signal_ids)
        };
        self.route_locks
            .retain(|lock_id, _| !retiring_lock_ids.contains(lock_id));
        for signal_id in retiring_signal_ids.difference(&retained_signal_ids) {
            self.signal_aspects.remove(signal_id);
        }
        self.trains.remove(train_id);
        self.scheduled_motion_ends
            .retain(|scheduled| scheduled.train_id != train_id);
        self.pending_dispatch_requests.remove(train_id);
        self.waiting_by_resource.retain(|_, waiting| {
            waiting.remove(train_id);
            !waiting.is_empty()
        });
        self.rebuild_resource_lifecycle();
        self.record("movement-retired", train_id, "route-complete-and-released")?;
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

    /// Sicherheitslogik: leitet alle Bedingungen selbst aus dem Weltzustand ab.
    pub fn lock_route(
        &mut self,
        train_id: &str,
        template_id: &str,
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
        let leg = route
            .leg_at(train.head_route_mm)
            .ok_or_else(|| OperationalError::IncompleteRoute(route.id.clone()))?;
        if route.template_id != template.route_template_id
            || template.authority_end_route_mm <= train.head_route_mm
            || template.authority_end_route_mm > route.length_mm()
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
            for resource in &resources {
                self.waiting_by_resource
                    .entry(resource.clone())
                    .or_default()
                    .insert(train_id.to_owned());
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
        self.record("route-locked", train_id, template_id)?;
        Ok(authority)
    }

    /// Deterministischer FDL: prueft Sicherheitsfaehigkeit und waehlt lexikographisch.
    pub fn dispatch(
        &mut self,
        requests: &[DispatchRequest],
    ) -> Result<Option<String>, OperationalError> {
        let mut candidates = requests.to_vec();
        candidates.sort_by(|left, right| right.key(self.now_ms).cmp(&left.key(self.now_ms)));
        for candidate in candidates {
            match self.lock_route(&candidate.train_id, &candidate.interlocking_route_id) {
                Ok(_) => {
                    self.record(
                        "dispatcher-decision",
                        &candidate.train_id,
                        format!("route={};lexicographic=v1", candidate.interlocking_route_id),
                    )?;
                    return Ok(Some(candidate.train_id));
                }
                Err(OperationalError::UnsafeRoute(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    /// Uebergibt Fahrten an den integrierten virtuellen Fahrdienstleiter. Nicht
    /// sichere Kandidaten bleiben im kanonischen Kernzustand vorgemerkt und
    /// werden ausschliesslich an fachlichen Freigabeereignissen erneut geprueft.
    pub fn submit_dispatch_requests(
        &mut self,
        requests: &[DispatchRequest],
    ) -> Result<Vec<String>, OperationalError> {
        for request in requests {
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
            if train.motion_segment.is_some() || train.authority.is_some() {
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
        let mut dispatched = Vec::new();
        loop {
            let candidates: Vec<DispatchRequest> = self
                .pending_dispatch_requests
                .values()
                .filter(|request| request.waiting_since_ms <= self.now_ms)
                .cloned()
                .collect();
            if candidates.is_empty() {
                break;
            }
            let Some(train_id) = self.dispatch(&candidates)? else {
                break;
            };
            self.pending_dispatch_requests.remove(&train_id);
            self.plan_motion(&train_id)?;
            dispatched.push(train_id);
        }
        Ok(dispatched)
    }

    /// Virtueller Lokfuehrer erzeugt den naechsten unveraenderlichen Abschnitt.
    pub fn plan_motion(&mut self, train_id: &str) -> Result<MotionSegment, OperationalError> {
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
        let mut limit = leg
            .speed_limit_mmps
            .min(formation.performance.maximum_speed_mmps);
        for effect in self.active_disruptions.values() {
            if let OperationalDisruption::SpeedRestriction {
                edge_id,
                maximum_speed_mmps,
            } = effect
            {
                if edge_id == &leg.edge_id {
                    limit = limit.min(*maximum_speed_mmps);
                }
            }
        }
        let remaining = authority.end_route_mm.saturating_sub(train.head_route_mm);
        let brake = formation.performance.service_brake_mmps2.max(1);
        let stopping_distance = stopping_distance_mm(train.speed_mmps, brake)?;
        let acceleration = if remaining <= stopping_distance {
            -i32::try_from(formation.performance.service_brake_mmps2)
                .map_err(|_| OperationalError::ArithmeticOverflow)?
        } else if train.speed_mmps < limit {
            i32::try_from(formation.performance.acceleration_mmps2)
                .map_err(|_| OperationalError::ArithmeticOverflow)?
        } else {
            0
        };
        // Ereignisgrenze ist Geschwindigkeitswechsel, Kantenende oder Fahrberechtigungsende.
        let infrastructure_boundary = authority
            .end_route_mm
            .min(leg.route_end_mm())
            .saturating_sub(train.head_route_mm)
            .max(0);
        let (duration_ms, distance_boundary) = if acceleration > 0 {
            let acceleration_boundary_ms = acceleration_brake_boundary_ms(
                train.speed_mmps,
                acceleration,
                brake,
                remaining,
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
            let brake_start_distance = remaining.saturating_sub(stopping_distance);
            let distance_boundary = infrastructure_boundary.min(brake_start_distance);
            (
                analytic_duration_ms(train.speed_mmps, acceleration, distance_boundary, limit)?,
                distance_boundary,
            )
        } else {
            (
                analytic_duration_ms(
                    train.speed_mmps,
                    acceleration,
                    infrastructure_boundary,
                    limit,
                )?,
                infrastructure_boundary,
            )
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
        self.record(
            "motion-segment-started",
            train_id,
            format!("valid-until={valid_until_ms}"),
        )?;
        Ok(segment)
    }

    /// Verarbeitet ausschliesslich faellige Ereignisse; kein Zug-Vollscan.
    pub fn advance_to(&mut self, target_ms: SimMillis) -> Result<(), OperationalError> {
        if target_ms < self.now_ms {
            return Err(OperationalError::TimeRegression);
        }
        loop {
            let Some(next) = self.scheduled_motion_ends.first().cloned() else {
                break;
            };
            if next.at_ms > target_ms {
                break;
            }
            self.scheduled_motion_ends.remove(&next);
            self.now_ms = next.at_ms;
            let current_started = self
                .trains
                .get(&next.train_id)
                .and_then(|train| train.motion_segment.as_ref())
                .map(|segment| segment.started_at_ms);
            if current_started != Some(next.segment_started_at_ms) {
                continue;
            }
            self.finish_motion_segment(&next.train_id)?;
        }
        self.now_ms = target_ms;
        Ok(())
    }

    fn finish_motion_segment(&mut self, train_id: &str) -> Result<(), OperationalError> {
        let (route_id, formation_id, segment) = {
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
            )
        };
        let head = segment.position_at(self.now_ms)?;
        let speed = segment.speed_at(self.now_ms)?;
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
        let blocks = blocks_for(&route, tail, head);
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
        for block in blocks {
            self.resource_lifecycle
                .insert(block, ResourceLifecycle::OccupiedByFormation);
        }
        self.release_routes_after_tail(train_id)?;
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
        self.rebuild_resource_lifecycle();
        self.record(
            "motion-segment-ended",
            train_id,
            format!("head={head};tail={tail}"),
        )?;
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
        if authority_remaining {
            self.plan_motion(train_id)?;
        } else if residual_speed > 0 {
            self.safe_stop(train_id, "authority-ended-with-residual-speed")?;
        } else {
            self.dispatch_pending()?;
        }
        Ok(())
    }

    fn release_routes_after_tail(&mut self, train_id: &str) -> Result<(), OperationalError> {
        let tail = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?
            .tail_route_mm;
        let release_ids: Vec<String> = self
            .route_locks
            .values()
            .filter(|lock| lock.train_id == train_id && tail >= lock.release_after_tail_route_mm)
            .map(|lock| lock.id.clone())
            .collect();
        for lock_id in release_ids {
            let lock = self
                .route_locks
                .remove(&lock_id)
                .expect("selected lock exists");
            let template = self
                .infrastructure()?
                .interlocking_route(&lock.template_id)?
                .ok_or_else(|| {
                    OperationalError::UnknownInterlockingRoute(lock.template_id.clone())
                })?;
            self.signal_aspects.remove(&template.signal_id);
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
            self.record("route-released-after-tail", train_id, lock.template_id)?;
        }
        Ok(())
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
        for train in self.trains.values() {
            for block in &train.occupied_blocks {
                self.resource_lifecycle
                    .insert(block.clone(), ResourceLifecycle::OccupiedByFormation);
            }
        }
    }

    pub fn safe_stop(&mut self, train_id: &str, reason: &str) -> Result<(), OperationalError> {
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
        self.signal_aspects
            .retain(|_, aspect| *aspect == SignalAspect::Failed);
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
        self.ensure_vehicles_available(train_id, &vehicle_ids)?;
        let formation =
            self.derive_formation(new_formation_id.into(), Some(predecessor), vehicle_ids)?;
        let route = self
            .infrastructure()?
            .route_version(&route_id)?
            .ok_or_else(|| OperationalError::UnknownRoute(route_id.clone()))?;
        let tail = head.saturating_sub(i64::from(formation.performance.length_mm));
        let intervals = intervals_for(&route, tail, head)?;
        self.ensure_intervals_free(train_id, &intervals)?;
        self.formations
            .insert(formation.id.clone(), formation.clone());
        let train = self.trains.get_mut(train_id).expect("train exists");
        train.formation_version_id = formation.id.clone();
        train.tail_route_mm = tail;
        train.occupied_intervals = intervals;
        train.occupied_blocks = blocks_for(&route, tail, head);
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
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?;
        if train.speed_mmps != 0 || train.motion_segment.is_some() {
            return Err(OperationalError::RouteChangeWhileMoving);
        }
        if train.authority.is_some()
            || self
                .route_locks
                .values()
                .any(|lock| lock.train_id == train_id)
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
        Ok(())
    }

    /// Rangierbedarf bis zur echten Bewegung: Materialisieren, sichern, fahren.
    pub fn execute_shunting_order(
        &mut self,
        train_id: &str,
        interlocking_route_id: &str,
    ) -> Result<(), OperationalError> {
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
        let disruption_id = disruption_id.into();
        if self.active_disruptions.contains_key(&disruption_id) {
            return Ok(());
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
                OperationalDisruption::SpeedRestriction { edge_id, .. } => train
                    .occupied_intervals
                    .iter()
                    .any(|interval| &interval.edge_id == edge_id),
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
        protected_resources: BTreeSet<String>,
    ) -> Result<RegionHandover, OperationalError> {
        let train = self
            .trains
            .get(train_id)
            .ok_or_else(|| OperationalError::UnknownTrain(train_id.to_owned()))?
            .clone();
        let formation = self.formations[&train.formation_version_id].clone();
        if protected_resources.is_empty() {
            return Err(OperationalError::UnprotectedHandover);
        }
        for resource in &protected_resources {
            self.resource_lifecycle
                .insert(resource.clone(), ResourceLifecycle::RouteLocked);
        }
        let handover = RegionHandover {
            id: handover_id.into(),
            source_region_id: self.region_id.clone(),
            target_region_id: target_region_id.into(),
            train,
            formation,
            protected_resources,
            source_commit_sequence: self.commit_sequence,
            acknowledged: false,
        };
        self.record("handover-prepared", train_id, &handover.target_region_id)?;
        Ok(handover)
    }

    pub fn accept_handover(
        &mut self,
        handover: &mut RegionHandover,
    ) -> Result<(), OperationalError> {
        if handover.target_region_id != self.region_id || handover.acknowledged {
            return Err(OperationalError::InvalidHandover);
        }
        let train_number_numeric_part = operational_train_number_numeric_part(
            &handover.train.train_number,
        )
        .ok_or_else(|| OperationalError::InvalidTrainNumber(handover.train.train_number.clone()))?;
        if self.trains.values().any(|train| {
            operational_train_number_numeric_part(&train.train_number)
                == Some(train_number_numeric_part)
        }) {
            return Err(OperationalError::DuplicateTrainNumber(
                train_number_numeric_part,
            ));
        }
        self.formations
            .insert(handover.formation.id.clone(), handover.formation.clone());
        self.ensure_intervals_free(&handover.train.id, &handover.train.occupied_intervals)?;
        if self
            .trains
            .insert(handover.train.id.clone(), handover.train.clone())
            .is_some()
        {
            return Err(OperationalError::DuplicateId(handover.train.id.clone()));
        }
        for resource in &handover.protected_resources {
            self.resource_lifecycle
                .insert(resource.clone(), ResourceLifecycle::RouteLocked);
        }
        handover.acknowledged = true;
        self.record(
            "handover-accepted",
            &handover.train.id,
            &handover.source_region_id,
        )?;
        Ok(())
    }

    pub fn finish_handover(&mut self, handover: &RegionHandover) -> Result<(), OperationalError> {
        if !handover.acknowledged || handover.source_region_id != self.region_id {
            return Err(OperationalError::InvalidHandover);
        }
        self.trains
            .remove(&handover.train.id)
            .ok_or_else(|| OperationalError::UnknownTrain(handover.train.id.clone()))?;
        for resource in &handover.protected_resources {
            self.resource_lifecycle
                .insert(resource.clone(), ResourceLifecycle::Free);
        }
        self.record(
            "handover-finished",
            &handover.train.id,
            &handover.target_region_id,
        )?;
        Ok(())
    }

    pub fn verify_invariants(&self) -> Result<(), OperationalError> {
        if self.events.last().map_or(0, |event| event.event_sequence) > self.event_sequence
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
        if self
            .pending_dispatch_requests
            .iter()
            .any(|(train_id, request)| {
                train_id != &request.train_id || !self.trains.contains_key(train_id)
            })
        {
            return Err(OperationalError::UnsafeState);
        }
        let trains: Vec<&OperationalTrain> = self.trains.values().collect();
        for (index, left) in trains.iter().enumerate() {
            if operational_train_number_numeric_part(&left.train_number).is_none()
                || left.tail_route_mm > left.head_route_mm
                || left
                    .authority
                    .as_ref()
                    .is_some_and(|a| left.head_route_mm > a.end_route_mm)
                || (matches!(left.motion_state, MotionState::Moving)
                    != left.motion_segment.is_some())
            {
                return Err(OperationalError::UnsafeState);
            }
            for right in trains.iter().skip(index + 1) {
                if operational_train_number_numeric_part(&left.train_number)
                    == operational_train_number_numeric_part(&right.train_number)
                {
                    return Err(OperationalError::DuplicateTrainNumber(
                        operational_train_number_numeric_part(&left.train_number)
                            .expect("left train number was validated"),
                    ));
                }
                if left
                    .occupied_intervals
                    .iter()
                    .any(|a| right.occupied_intervals.iter().any(|b| a.overlaps(b)))
                {
                    return Err(OperationalError::OccupiedTrack);
                }
            }
        }
        let locks: Vec<&RouteLock> = self.route_locks.values().collect();
        for (index, left) in locks.iter().enumerate() {
            for right in locks.iter().skip(index + 1) {
                if left.train_id != right.train_id && !left.resources.is_disjoint(&right.resources)
                {
                    return Err(OperationalError::UnsafeState);
                }
            }
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
        let mut hash = StateHasher::new("operational-world/v4");
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
            if result
                .last()
                .is_some_and(|point: &OperationalRouteGeometryPoint| point.route_mm == route_mm)
            {
                continue;
            }
            let mut point = edge_geometry_position(infra, &leg.edge_id, offset, leg.direction)?;
            point.route_mm = route_mm;
            result.push(point);
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
        .saturating_add(acceleration - 1)
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
    ArithmeticOverflow,
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
    UnprotectedHandover,
    InvalidHandover,
}

impl fmt::Display for OperationalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for OperationalError {}
