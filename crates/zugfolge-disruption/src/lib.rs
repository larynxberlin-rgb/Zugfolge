//! M8: versionierte Störungsursachen, Baustellen, Ersatzplanung und regionale
//! virtuelle Fahrdienstleiter.
//!
//! Das Crate bleibt ein reiner Kernvertrag: explizite Simulationszeit und
//! Integer-Cent hinein, auditierbare Ereignisse hinaus. Es kennt weder Uhr,
//! Datenbank noch Provider-Netzwerk. Knappheit wird ausschließlich über den
//! vorhandenen [`zugfolge_conflict::CapacityLedger`] entschieden.

use core::fmt;
use std::collections::BTreeMap;

use zugfolge_conflict::{
    CapacityLedger, ConflictResource, ResourceExclusions, ResourceReservation,
};
use zugfolge_determinism::{Rng, SimTime, StateHash, StateHasher, Substream, WorldSeed};

mod calibration;
mod cause_codes;

pub use calibration::{
    DAILY_RESTRICTION_CALIBRATION_VERSION, DAILY_RESTRICTION_WEIGHTS, DAILY_SPEED_WEIGHTS,
    DWELL_DELAY_SECONDS_PER_10_000_STOPS, DWELL_INCIDENT_WEIGHTS, DWELL_INCIDENTS_PER_10_000_STOPS,
    DailyRestrictionClass, DailyRestrictionWeight, INFRASTRUCTURE_INCIDENT_WEIGHTS,
    INFRASTRUCTURE_INCIDENTS_PER_100_DAYS, PRIMARY_CAUSE_CALIBRATION_VERSION,
    PRIMARY_CAUSE_WEIGHTS, PrimaryCauseGroup, PrimaryCauseWeight,
    SEQUENCE_DELAY_SHARE_BASIS_POINTS, SPONTANEOUS_INCIDENT_CALIBRATION_VERSION, SpeedWeight,
    SpontaneousIncidentClass, SpontaneousIncidentWeight, VEHICLE_INCIDENT_WEIGHTS,
    VEHICLE_INCIDENTS_PER_10_000_TRAIN_RUNS,
};
pub use cause_codes::{
    CauseResponsibility, CauseType, DELAY_CAUSE_CATALOG, DELAY_CAUSE_CATALOG_VERSION,
    DelayCauseCode, FINE_CAUSE_CATALOG_2023, FINE_CAUSE_CATALOG_VERSION, FineCauseCode,
    FineCauseEffectFamily, FineCauseGeneration, FineCauseSimulationDisposition,
    PASSENGER_INFORMATION_CATALOG, PassengerInformationCode, RealisticFineCauseCoverage,
    delay_cause_code, fine_cause_code, fine_cause_simulation_disposition,
};

const SECONDS_PER_DAY: i64 = 86_400;

/// Modus einer Störungsquelle für geplante oder ungeplante Ereignisse.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DisruptionMode {
    /// Freigegebener externer Provider; ohne Rechtefreigabe fail-closed.
    Realistic,
    /// Deterministischer Generator aus dem Weltseed.
    Simulated,
    /// Ausschließlich auditierte Spielleiterkommandos.
    Manual,
}

/// Versioniertes, rein ganzzahliges Generatorprofil.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationProfile {
    /// Stabile Profilkennung.
    pub id: String,
    /// Anzahl geplanter Bauereignisse je Fahrplanperiode.
    pub events_per_period: u32,
    /// Kleinste Schwere in Basispunkten.
    pub minimum_severity_basis_points: u32,
    /// Größte Schwere in Basispunkten.
    pub maximum_severity_basis_points: u32,
    /// Kürzeste Dauer in Sekunden.
    pub minimum_duration_seconds: i64,
    /// Längste Dauer in Sekunden.
    pub maximum_duration_seconds: i64,
    /// Kleinster Vorlauf einer geplanten Baustelle.
    pub minimum_notice_seconds: i64,
    /// Größter Vorlauf einer geplanten Baustelle.
    pub maximum_notice_seconds: i64,
    /// Anzahl tagesaktueller Einschränkungen je simuliertem Netztag.
    pub daily_restrictions_per_day: u32,
    /// Spontane Infrastrukturstörungen je 100 Tage des abgebildeten Netzes.
    pub infrastructure_incidents_per_100_days: u32,
    /// Technische Fahrzeugstörungen je 10.000 tatsächlich angebotene Fahrten.
    pub vehicle_incidents_per_10_000_train_runs: u32,
    /// Verlängerte Fahrgastwechsel je 10.000 tatsächlich angebotene Halte.
    pub dwell_incidents_per_10_000_stops: u32,
}

impl SimulationProfile {
    /// Fiktives, versioniertes Pilotprofil für Tests und erste Spielwelten.
    #[must_use]
    pub fn pilot(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            events_per_period: 6,
            minimum_severity_basis_points: 1_000,
            maximum_severity_basis_points: 8_000,
            minimum_duration_seconds: 1_800,
            maximum_duration_seconds: 21 * SECONDS_PER_DAY,
            minimum_notice_seconds: 7 * SECONDS_PER_DAY,
            maximum_notice_seconds: 21 * SECONDS_PER_DAY,
            daily_restrictions_per_day: 4,
            infrastructure_incidents_per_100_days: INFRASTRUCTURE_INCIDENTS_PER_100_DAYS,
            vehicle_incidents_per_10_000_train_runs: VEHICLE_INCIDENTS_PER_10_000_TRAIN_RUNS,
            dwell_incidents_per_10_000_stops: DWELL_INCIDENTS_PER_10_000_STOPS,
        }
    }

    fn validate(&self) -> Result<(), DisruptionError> {
        if self.id.trim().is_empty()
            || self.events_per_period == 0
            || self.minimum_severity_basis_points > self.maximum_severity_basis_points
            || self.maximum_severity_basis_points > 10_000
            || self.minimum_duration_seconds <= 0
            || self.minimum_duration_seconds > self.maximum_duration_seconds
            || self.minimum_notice_seconds < 0
            || self.minimum_notice_seconds > self.maximum_notice_seconds
            || self.daily_restrictions_per_day == 0
            || self.infrastructure_incidents_per_100_days > 100_000
            || self.vehicle_incidents_per_10_000_train_runs > 10_000
            || self.dwell_incidents_per_10_000_stops > 10_000
        {
            return Err(DisruptionError::InvalidProfile);
        }
        Ok(())
    }
}

/// Je Welt gepinnte, versionierte Störungsrichtlinie.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisruptionPolicy {
    world_id: u64,
    version: u32,
    planned_works_mode: DisruptionMode,
    operational_incident_mode: DisruptionMode,
    provider_set_id: Option<String>,
    simulation_profile: SimulationProfile,
    ruleset_version: String,
    valid_from: SimTime,
    valid_until: Option<SimTime>,
}

impl DisruptionPolicy {
    /// Baut eine gültige Policy; Realistic benötigt eine explizite
    /// Provider-Set-Kennung, wird dadurch aber noch nicht freigeschaltet.
    #[allow(
        clippy::too_many_arguments,
        reason = "versionierter Policyvertrag mit Pflichtfeldern"
    )]
    pub fn new(
        world_id: u64,
        version: u32,
        planned_works_mode: DisruptionMode,
        operational_incident_mode: DisruptionMode,
        provider_set_id: Option<String>,
        simulation_profile: SimulationProfile,
        ruleset_version: impl Into<String>,
        valid_from: SimTime,
        valid_until: Option<SimTime>,
    ) -> Result<Self, DisruptionError> {
        simulation_profile.validate()?;
        let ruleset_version = ruleset_version.into();
        if world_id == 0
            || version == 0
            || ruleset_version.trim().is_empty()
            || valid_until.is_some_and(|until| until <= valid_from)
        {
            return Err(DisruptionError::InvalidPolicy);
        }
        let needs_provider = matches!(planned_works_mode, DisruptionMode::Realistic)
            || matches!(operational_incident_mode, DisruptionMode::Realistic);
        if needs_provider
            && provider_set_id
                .as_ref()
                .is_none_or(|id| id.trim().is_empty())
        {
            return Err(DisruptionError::ProviderRequired);
        }
        Ok(Self {
            world_id,
            version,
            planned_works_mode,
            operational_incident_mode,
            provider_set_id,
            simulation_profile,
            ruleset_version,
            valid_from,
            valid_until,
        })
    }

    /// Welt der Policy.
    #[must_use]
    pub const fn world_id(&self) -> u64 {
        self.world_id
    }

    /// Monotone Policyversion.
    #[must_use]
    pub const fn version(&self) -> u32 {
        self.version
    }

    /// Modus geplanter Baustellen.
    #[must_use]
    pub const fn planned_works_mode(&self) -> DisruptionMode {
        self.planned_works_mode
    }

    /// Modus ungeplanter Betriebsstörungen.
    #[must_use]
    pub const fn operational_incident_mode(&self) -> DisruptionMode {
        self.operational_incident_mode
    }

    /// Gepinntes Generatorprofil.
    #[must_use]
    pub const fn simulation_profile(&self) -> &SimulationProfile {
        &self.simulation_profile
    }
}

/// Angekündigte Policyänderung zum Fahrplanstichtag.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyChange {
    /// Welt der Änderung.
    pub world_id: u64,
    /// Zeitpunkt der Beantragung.
    pub requested_at: SimTime,
    /// Veröffentlichter Fahrplanstichtag.
    pub effective_at: SimTime,
    /// Auditierte Akteurskennung.
    pub requested_by: String,
    /// Pflichtbegründung.
    pub reason: String,
    /// Neuer Baustellenmodus.
    pub planned_works_mode: DisruptionMode,
    /// Neuer Störungsmodus.
    pub operational_incident_mode: DisruptionMode,
    /// Optionales Provider-Set.
    pub provider_set_id: Option<String>,
    /// Neues Generatorprofil.
    pub simulation_profile: SimulationProfile,
    /// Neue Regelversion.
    pub ruleset_version: String,
}

/// Revisionssicherer Nachweis einer Policyänderung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyAudit {
    /// Welt der Änderung.
    pub world_id: u64,
    /// Alte Policyversion.
    pub previous_version: u32,
    /// Neue Policyversion.
    pub next_version: u32,
    /// Antragsteller.
    pub actor_id: String,
    /// Begründung.
    pub reason: String,
    /// Wirksamer Stichtag.
    pub effective_at: SimTime,
}

/// Geplante Baustelle oder ungeplante Betriebsstörung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisruptionKind {
    /// Mit Vorlauf veröffentlichte Baustelle.
    PlannedWorks,
    /// Ungeplante Echtzeitstörung.
    OperationalIncident,
}

/// Fahrtrichtung, für die eine Einschränkung gilt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestrictionDirection {
    /// Beide Fahrtrichtungen.
    Both,
    /// Regelrichtung der betroffenen Ressource.
    RegularDirection,
    /// Gegenrichtung der betroffenen Ressource.
    OppositeDirection,
}

/// Verkehrsart, für die eine Einschränkung gilt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestrictionTraffic {
    /// Alle Züge und Rangierfahrten.
    All,
    /// Nur Reiseverkehr.
    Passenger,
    /// Nur Güterverkehr.
    Freight,
}

/// Geltungsbereich einer Einschränkung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestrictionScope {
    /// Betroffene Richtung.
    pub direction: RestrictionDirection,
    /// Betroffene Verkehrsart.
    pub traffic: RestrictionTraffic,
    /// Optional nur diese Zugläufe; leer bedeutet keine Zugnummernfilterung.
    pub train_run_ids: Vec<String>,
}

impl RestrictionScope {
    /// Uneingeschränkter Geltungsbereich.
    #[must_use]
    pub const fn all() -> Self {
        Self {
            direction: RestrictionDirection::Both,
            traffic: RestrictionTraffic::All,
            train_run_ids: Vec::new(),
        }
    }
}

/// Eine konkrete, über Konfliktressourcen wirksame Einschränkung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisruptionEffect {
    /// Vollständige Sperrung aller benannten Ressourcen.
    Closure,
    /// Beide Richtungen teilen sich eine Ressource mit Restkapazität.
    SingleTrack {
        /// Gemeinsame Konfliktressource.
        shared_resource: ConflictResource,
        /// Verbleibende Parallelkapazität.
        remaining_capacity: u32,
    },
    /// Ganzzahlige neue Höchstgeschwindigkeit.
    SpeedRestriction {
        /// Höchstgeschwindigkeit in Millimetern je Sekunde.
        maximum_speed_mm_per_second: u32,
    },
    /// Belegung wird auf ein anderes Bahnsteiggleis geplant.
    PlatformChange {
        /// Ersatzgleis als echte Konfliktressource.
        replacement: ConflictResource,
    },
    /// Züge werden vor einer Konfliktressource kontrolliert zurückgehalten.
    TrafficHold {
        /// Höchste Haltezeit je Dispositionsentscheidung.
        maximum_hold_seconds: u32,
    },
    /// Ein alternativer Laufweg wird gegen echte Restkapazität geprüft.
    RouteDeviation {
        /// Konfliktressourcen des abweichenden Laufwegs.
        alternative_resources: Vec<ConflictResource>,
    },
    /// Die Befahrbarkeit hängt von ganzzahligen Fahrzeugeigenschaften ab.
    VehicleRestriction {
        /// Größte zulässige Achslast in Kilogramm.
        maximum_axle_load_kg: u32,
        /// Größte zulässige Zuglänge in Millimetern.
        maximum_train_length_mm: u32,
    },
    /// Nur ein Teil eines Bahnsteigs darf genutzt werden.
    PlatformUsableLength {
        /// Nutzbare Länge in Millimetern.
        maximum_usable_length_mm: u32,
    },
}

/// Mechanische Wirkungsklasse einer Einschränkung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationalImpact {
    /// Verändert die Belegbarkeit einer Konfliktressource.
    Capacity,
    /// Verändert Fahr- oder Haltezeit.
    RunningTime,
    /// Verändert die Zulässigkeit eines Fahrzeugs oder Zugverbands.
    VehicleEligibility,
    /// Verändert die nutzbare Bahnsteigkante.
    PlatformEligibility,
}

impl DisruptionEffect {
    /// Prüft die Auswirkung gegen ihre Ausgangsressourcen.
    pub fn validate(&self, resources: &[ConflictResource]) -> Result<(), DisruptionError> {
        if resources.is_empty() {
            return Err(DisruptionError::MissingResource);
        }
        match self {
            Self::SingleTrack {
                remaining_capacity, ..
            } if *remaining_capacity == 0 => Err(DisruptionError::InvalidEffect),
            Self::SpeedRestriction {
                maximum_speed_mm_per_second,
            } if *maximum_speed_mm_per_second == 0 => Err(DisruptionError::InvalidEffect),
            Self::TrafficHold {
                maximum_hold_seconds,
            } if *maximum_hold_seconds == 0 => Err(DisruptionError::InvalidEffect),
            Self::RouteDeviation {
                alternative_resources,
            } if alternative_resources.is_empty() => Err(DisruptionError::InvalidEffect),
            Self::VehicleRestriction {
                maximum_axle_load_kg,
                maximum_train_length_mm,
            } if *maximum_axle_load_kg == 0 || *maximum_train_length_mm == 0 => {
                Err(DisruptionError::InvalidEffect)
            }
            Self::PlatformUsableLength {
                maximum_usable_length_mm,
            } if *maximum_usable_length_mm == 0 => Err(DisruptionError::InvalidEffect),
            Self::PlatformChange { replacement }
                if !matches!(replacement, ConflictResource::Track(_)) =>
            {
                Err(DisruptionError::InvalidEffect)
            }
            _ => Ok(()),
        }
    }

    /// Ressourcen, die die echte Konflikt-/Fahrdynamikprüfung erneut prüfen muss.
    #[must_use]
    pub fn affected_resources(&self, original: &[ConflictResource]) -> Vec<ConflictResource> {
        let mut resources = original.to_vec();
        match self {
            Self::SingleTrack {
                shared_resource, ..
            } => resources.push(*shared_resource),
            Self::PlatformChange { replacement } => resources.push(*replacement),
            Self::RouteDeviation {
                alternative_resources,
            } => resources.extend(alternative_resources.iter().copied()),
            Self::Closure
            | Self::SpeedRestriction { .. }
            | Self::TrafficHold { .. }
            | Self::VehicleRestriction { .. }
            | Self::PlatformUsableLength { .. } => {}
        }
        resources.sort_unstable();
        resources.dedup();
        resources
    }

    /// Liefert die Wirkung, die der aktuelle Simulationskern tatsächlich
    /// abbildet. Wirkungslose Referenzeinträge werden gar nicht erzeugt.
    #[must_use]
    pub const fn operational_impact(&self) -> OperationalImpact {
        match self {
            Self::Closure | Self::SingleTrack { .. } | Self::PlatformChange { .. } => {
                OperationalImpact::Capacity
            }
            Self::SpeedRestriction { .. }
            | Self::TrafficHold { .. }
            | Self::RouteDeviation { .. } => OperationalImpact::RunningTime,
            Self::VehicleRestriction { .. } => OperationalImpact::VehicleEligibility,
            Self::PlatformUsableLength { .. } => OperationalImpact::PlatformEligibility,
        }
    }
}

/// Herkunft eines simulierten Ereignisses.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GeneratedSourceKind {
    /// Statistisch kalibriertes Primärereignis.
    SimulatedIncident,
    /// Interne, nicht im Infrastrukturfeed enthaltene Realistik-Luecke.
    SimulatedRealisticGap,
    /// Tagesaktuelle Einschränkung aus dem transparenten Tagesmodell.
    SimulatedDailyRestriction,
    /// Auditierter manueller Eingriff.
    Manual,
}

/// Herkunft eines simulierten Ereignisses.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedSource {
    /// Für Oberfläche und Audit sichtbare Herkunftsart.
    pub kind: GeneratedSourceKind,
    /// Benannter Seed-Substream.
    pub substream: String,
    /// Gepinntes Infra-Release.
    pub infra_release: String,
    /// Gepinntes Simulationsprofil.
    pub simulation_profile: String,
    /// Gepinnte Regelversion.
    pub ruleset_version: String,
    /// Gepinnte Statistik- oder Modellkalibrierung.
    pub calibration_version: String,
}

/// Vollständiges, deterministisch erzeugtes Ereignis.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedDisruption {
    /// Welt des Ereignisses.
    pub world_id: u64,
    /// Stabile Ereigniskennung.
    pub id: String,
    /// Baustelle oder Betriebsstörung.
    pub kind: DisruptionKind,
    /// Beginn einschließlich.
    pub starts_at: SimTime,
    /// Ende ausschließlich.
    pub ends_at: SimTime,
    /// Veröffentlichungszeitpunkt.
    pub published_at: SimTime,
    /// Schwere in Basispunkten.
    pub severity_basis_points: u32,
    /// Betroffene Ressourcen.
    pub resources: Vec<ConflictResource>,
    /// Fachliche Auswirkung.
    pub effect: DisruptionEffect,
    /// Richtungs-, Verkehrsart- und Zuglaufgeltung.
    pub scope: RestrictionScope,
    /// Hauptkennung der unmittelbar wirkenden Verspätungsursache.
    pub cause_code: u8,
    /// Markenfreie Feinkennung der unmittelbar wirkenden Ursache.
    pub fine_cause_id: String,
    /// Auditierbare Generatorherkunft.
    pub source: GeneratedSource,
}

/// Infrastrukturbezug für spontan auftretende technische Störungen.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InfrastructureIncidentExposure {
    /// Stabile, releasegebundene Ressourcenkennung.
    pub resource_id: String,
    /// Echte Konfliktressource.
    pub resource: ConflictResource,
    /// Belastung der Ressource in Basispunkten.
    pub load_basis_points: u32,
}

/// Eine im Erzeugungsfenster tatsächlich angebotene Zugfahrt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrainRunIncidentExposure {
    /// Stabile Zuglaufkennung.
    pub train_run_id: String,
    /// Ressource, an der der Zug beim Ereignis zurückgehalten werden kann.
    pub resource: ConflictResource,
}

/// Ein im Erzeugungsfenster tatsächlich angebotener Fahrgasthalt.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PassengerStopIncidentExposure {
    /// Stabile Zuglaufkennung.
    pub train_run_id: String,
    /// Bahnsteig- oder Halteressource.
    pub resource: ConflictResource,
}

/// Getrennte Bezugsgrößen für eine statistisch nachvollziehbare Simulation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpontaneousIncidentExposure {
    /// Technische Infrastruktur des abgebildeten Netzes.
    pub infrastructure: Vec<InfrastructureIncidentExposure>,
    /// Tatsächlich angebotene Fahrten im Zeitraum.
    pub train_runs: Vec<TrainRunIncidentExposure>,
    /// Tatsächlich angebotene Fahrgasthalte im Zeitraum.
    pub passenger_stops: Vec<PassengerStopIncidentExposure>,
}

fn draw_spontaneous_class(
    rng: &mut Rng,
    weights: &[SpontaneousIncidentWeight],
) -> Result<SpontaneousIncidentClass, DisruptionError> {
    let total = weights
        .iter()
        .try_fold(0_u64, |sum, item| sum.checked_add(u64::from(item.weight)))
        .ok_or(DisruptionError::Overflow)?;
    if total == 0 {
        return Err(DisruptionError::InvalidProfile);
    }
    let draw = rng.below(total);
    let mut cumulative = 0_u64;
    for weight in weights {
        cumulative = cumulative.saturating_add(u64::from(weight.weight));
        if draw < cumulative {
            return Ok(weight.class);
        }
    }
    Err(DisruptionError::InvalidProfile)
}

fn draw_rate_count(
    rng: &mut Rng,
    exposure: u64,
    rate: u32,
    denominator: u64,
) -> Result<u32, DisruptionError> {
    let numerator = u128::from(exposure)
        .checked_mul(u128::from(rate))
        .ok_or(DisruptionError::Overflow)?;
    let whole = numerator / u128::from(denominator);
    let remainder = numerator % u128::from(denominator);
    let extra = u32::from(remainder > 0 && u128::from(rng.below(denominator)) < remainder);
    u32::try_from(whole)
        .map(|value| value.saturating_add(extra))
        .map_err(|_| DisruptionError::Overflow)
}

fn draw_infrastructure_index(
    rng: &mut Rng,
    resources: &[InfrastructureIncidentExposure],
) -> Result<usize, DisruptionError> {
    let total = resources
        .iter()
        .try_fold(0_u64, |sum, item| {
            sum.checked_add(u64::from(item.load_basis_points.max(1)))
        })
        .ok_or(DisruptionError::Overflow)?;
    let draw = rng.below(total);
    let mut cumulative = 0_u64;
    for (index, resource) in resources.iter().enumerate() {
        cumulative = cumulative.saturating_add(u64::from(resource.load_basis_points.max(1)));
        if draw < cumulative {
            return Ok(index);
        }
    }
    Err(DisruptionError::InvalidGenerationWindow)
}

fn spontaneous_incident(
    class: SpontaneousIncidentClass,
    rng: &mut Rng,
) -> Result<(DisruptionEffect, u8, &'static str, i64), DisruptionError> {
    let variable = |rng: &mut Rng, minimum: i64, span: u64| -> Result<i64, DisruptionError> {
        Ok(minimum
            .saturating_add(i64::try_from(rng.below(span)).map_err(|_| DisruptionError::Overflow)?))
    };
    let incident = match class {
        SpontaneousIncidentClass::Interlocking => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 1_800,
            },
            25,
            "signalling.interlocking",
            variable(rng, 300, 6_901)?,
        ),
        SpontaneousIncidentClass::Signal => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 900,
            },
            25,
            "signalling.signal",
            variable(rng, 120, 1_681)?,
        ),
        SpontaneousIncidentClass::TrackOccupation => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 1_200,
            },
            25,
            "signalling.track-occupation",
            variable(rng, 180, 2_521)?,
        ),
        SpontaneousIncidentClass::Switch => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 1_800,
            },
            26,
            "switch.drive",
            variable(rng, 300, 5_101)?,
        ),
        SpontaneousIncidentClass::VehicleBrake => {
            let (code, fine) = match rng.below(3) {
                0 => (62, "coach.brake"),
                1 => (63, "freight-wagon.brake"),
                _ => (64, "traction-unit.brake"),
            };
            (
                DisruptionEffect::TrafficHold {
                    maximum_hold_seconds: 1_800,
                },
                code,
                fine,
                variable(rng, 300, 3_301)?,
            )
        }
        SpontaneousIncidentClass::VehicleTrainProtection => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 1_800,
            },
            64,
            "traction-unit.train-protection",
            variable(rng, 300, 3_301)?,
        ),
        SpontaneousIncidentClass::VehicleOtherTechnical => {
            let (code, fine) = match rng.below(13) {
                0 => (62, "coach.climate"),
                1 => (62, "coach.power"),
                2 => (62, "coach.control-car"),
                3 => (62, "coach.door"),
                4 => (63, "freight-wagon.hotbox"),
                5 => (63, "freight-wagon.air"),
                6 => (63, "freight-wagon.loading-system"),
                7 => (63, "freight-wagon.brake"),
                8 => (64, "traction-unit.drive"),
                9 => (64, "traction-unit.running-gear"),
                10 => (64, "traction-unit.pantograph"),
                11 => (64, "traction-unit.control-system"),
                _ => (64, "traction-unit.brake"),
            };
            (
                DisruptionEffect::TrafficHold {
                    maximum_hold_seconds: 1_800,
                },
                code,
                fine,
                variable(rng, 300, 6_901)?,
            )
        }
        SpontaneousIncidentClass::VehicleDoor => {
            let (code, fine) = if rng.below(2) == 0 {
                (62, "coach.door")
            } else {
                (64, "traction-unit.door-control")
            };
            (
                DisruptionEffect::TrafficHold {
                    maximum_hold_seconds: 900,
                },
                code,
                fine,
                variable(rng, 60, 841)?,
            )
        }
        SpontaneousIncidentClass::DwellPassengerVolume => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 420,
            },
            50,
            "dwell.passenger-volume",
            variable(rng, 112, 301)?,
        ),
        SpontaneousIncidentClass::DwellAccessibility => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 360,
            },
            50,
            "dwell.accessibility",
            variable(rng, 80, 271)?,
        ),
        SpontaneousIncidentClass::DwellPassengerBehaviour => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 420,
            },
            50,
            "dwell.passenger-behavior",
            variable(rng, 112, 301)?,
        ),
        SpontaneousIncidentClass::DwellDispatch => (
            DisruptionEffect::TrafficHold {
                maximum_hold_seconds: 300,
            },
            50,
            "dwell.dispatch",
            variable(rng, 50, 242)?,
        ),
    };
    Ok(incident)
}

/// Erzeugt Ursachen aus genau dem benannten `disruption`-Substream.
pub fn generate_disruptions(
    policy: &DisruptionPolicy,
    seed: WorldSeed,
    infra_release: &str,
    period_start: SimTime,
    period_end: SimTime,
    resources: &[(String, ConflictResource, u32)],
    spontaneous_exposure: &SpontaneousIncidentExposure,
) -> Result<Vec<GeneratedDisruption>, DisruptionError> {
    if !matches!(policy.planned_works_mode, DisruptionMode::Simulated)
        && !matches!(
            policy.operational_incident_mode,
            DisruptionMode::Simulated | DisruptionMode::Realistic
        )
    {
        return Err(DisruptionError::WrongMode);
    }
    if infra_release.trim().is_empty() || period_end <= period_start {
        return Err(DisruptionError::InvalidGenerationWindow);
    }
    let profile = &policy.simulation_profile;
    profile.validate()?;
    let mut rng = seed.substream(Substream::Disruption);
    let span = u64::try_from(period_end.seconds().saturating_sub(period_start.seconds()))
        .map_err(|_| DisruptionError::InvalidGenerationWindow)?;
    let severity_span = u64::from(
        profile
            .maximum_severity_basis_points
            .saturating_sub(profile.minimum_severity_basis_points)
            .saturating_add(1),
    );
    if matches!(policy.planned_works_mode, DisruptionMode::Simulated) && resources.is_empty() {
        return Err(DisruptionError::InvalidGenerationWindow);
    }
    let notice_span = u64::try_from(
        profile
            .maximum_notice_seconds
            .saturating_sub(profile.minimum_notice_seconds)
            .saturating_add(1),
    )
    .map_err(|_| DisruptionError::InvalidProfile)?;
    let mut generated = Vec::new();
    let planned_count = if matches!(policy.planned_works_mode, DisruptionMode::Simulated) {
        profile.events_per_period
    } else {
        0
    };
    let resource_count = u64::try_from(resources.len()).map_err(|_| DisruptionError::Overflow)?;
    for ordinal in 0..planned_count {
        let index =
            usize::try_from(rng.below(resource_count)).map_err(|_| DisruptionError::Overflow)?;
        let (resource_id, resource, load_basis_points) = &resources[index];
        let weighted_offset = rng.below(span);
        let load_shift = u64::from(*load_basis_points).saturating_mul(span) / 20_000;
        let offset = weighted_offset.saturating_sub(load_shift);
        let starts_at = period_start
            .plus_seconds(i64::try_from(offset).map_err(|_| DisruptionError::Overflow)?);
        let duration_span = u64::try_from(
            profile
                .maximum_duration_seconds
                .saturating_sub(profile.minimum_duration_seconds)
                .saturating_add(1),
        )
        .map_err(|_| DisruptionError::InvalidProfile)?;
        let duration = profile.minimum_duration_seconds.saturating_add(
            i64::try_from(rng.below(duration_span)).map_err(|_| DisruptionError::Overflow)?,
        );
        let ends_at = starts_at.plus_seconds(duration).min(period_end);
        let notice = profile.minimum_notice_seconds.saturating_add(
            i64::try_from(rng.below(notice_span)).map_err(|_| DisruptionError::Overflow)?,
        );
        let code = if ordinal % 4 == 0 { 31 } else { 32 };
        let fine_id = if code == 31 {
            "construction.work-zone"
        } else {
            "construction.overrun"
        };
        let effect = if ordinal % 3 == 0 {
            DisruptionEffect::Closure
        } else if ordinal % 3 == 1 {
            DisruptionEffect::SingleTrack {
                shared_resource: *resource,
                remaining_capacity: 1,
            }
        } else {
            DisruptionEffect::SpeedRestriction {
                maximum_speed_mm_per_second: 20_000,
            }
        };
        effect.validate(&[*resource])?;
        let severity = profile.minimum_severity_basis_points.saturating_add(
            u32::try_from(rng.below(severity_span)).map_err(|_| DisruptionError::Overflow)?,
        );
        generated.push(GeneratedDisruption {
            world_id: policy.world_id,
            id: format!("planned-{}-{}-{ordinal}", seed.period(), resource_id),
            kind: DisruptionKind::PlannedWorks,
            starts_at,
            ends_at,
            published_at: starts_at.plus_seconds(notice.saturating_neg()),
            severity_basis_points: severity,
            resources: vec![*resource],
            effect,
            scope: RestrictionScope::all(),
            cause_code: code,
            fine_cause_id: fine_id.into(),
            source: GeneratedSource {
                kind: GeneratedSourceKind::SimulatedIncident,
                substream: Substream::Disruption.name().into(),
                infra_release: infra_release.into(),
                simulation_profile: profile.id.clone(),
                ruleset_version: policy.ruleset_version.clone(),
                calibration_version: PRIMARY_CAUSE_CALIBRATION_VERSION.into(),
            },
        });
    }

    if matches!(
        policy.operational_incident_mode,
        DisruptionMode::Simulated | DisruptionMode::Realistic
    ) {
        let span_seconds =
            u64::try_from(period_end.seconds().saturating_sub(period_start.seconds()))
                .map_err(|_| DisruptionError::InvalidGenerationWindow)?;
        // REALISTIC bezieht Infrastrukturereignisse aus dem Provider. Nur die
        // dort systematisch fehlenden EVU-/Fahrgastereignisse werden ergaenzt.
        let infrastructure_count =
            if matches!(policy.operational_incident_mode, DisruptionMode::Realistic)
                || spontaneous_exposure.infrastructure.is_empty()
            {
                0
            } else {
                draw_rate_count(
                    &mut rng,
                    span_seconds,
                    profile.infrastructure_incidents_per_100_days,
                    100 * u64::try_from(SECONDS_PER_DAY).map_err(|_| DisruptionError::Overflow)?,
                )?
            };
        let vehicle_count = draw_rate_count(
            &mut rng,
            u64::try_from(spontaneous_exposure.train_runs.len())
                .map_err(|_| DisruptionError::Overflow)?,
            profile.vehicle_incidents_per_10_000_train_runs,
            10_000,
        )?;
        let dwell_count = draw_rate_count(
            &mut rng,
            u64::try_from(spontaneous_exposure.passenger_stops.len())
                .map_err(|_| DisruptionError::Overflow)?,
            profile.dwell_incidents_per_10_000_stops,
            10_000,
        )?;

        for ordinal in 0..infrastructure_count
            .saturating_add(vehicle_count)
            .saturating_add(dwell_count)
        {
            let (class, resource_id, resource, train_run_id) = if ordinal < infrastructure_count {
                let index =
                    draw_infrastructure_index(&mut rng, &spontaneous_exposure.infrastructure)?;
                let exposure = &spontaneous_exposure.infrastructure[index];
                (
                    draw_spontaneous_class(&mut rng, INFRASTRUCTURE_INCIDENT_WEIGHTS)?,
                    exposure.resource_id.clone(),
                    exposure.resource,
                    None,
                )
            } else if ordinal < infrastructure_count.saturating_add(vehicle_count) {
                let count = u64::try_from(spontaneous_exposure.train_runs.len())
                    .map_err(|_| DisruptionError::Overflow)?;
                if count == 0 {
                    return Err(DisruptionError::InvalidGenerationWindow);
                }
                let index =
                    usize::try_from(rng.below(count)).map_err(|_| DisruptionError::Overflow)?;
                let exposure = &spontaneous_exposure.train_runs[index];
                (
                    draw_spontaneous_class(&mut rng, VEHICLE_INCIDENT_WEIGHTS)?,
                    format!("train-{}", exposure.train_run_id),
                    exposure.resource,
                    Some(exposure.train_run_id.clone()),
                )
            } else {
                let count = u64::try_from(spontaneous_exposure.passenger_stops.len())
                    .map_err(|_| DisruptionError::Overflow)?;
                if count == 0 {
                    return Err(DisruptionError::InvalidGenerationWindow);
                }
                let index =
                    usize::try_from(rng.below(count)).map_err(|_| DisruptionError::Overflow)?;
                let exposure = &spontaneous_exposure.passenger_stops[index];
                (
                    draw_spontaneous_class(&mut rng, DWELL_INCIDENT_WEIGHTS)?,
                    format!("stop-{}-{index}", exposure.train_run_id),
                    exposure.resource,
                    Some(exposure.train_run_id.clone()),
                )
            };
            let offset = rng.below(span);
            let starts_at = period_start
                .plus_seconds(i64::try_from(offset).map_err(|_| DisruptionError::Overflow)?);
            let (effect, cause_code, fine_cause_id, duration) =
                spontaneous_incident(class, &mut rng)?;
            effect.validate(&[resource])?;
            let ends_at = starts_at.plus_seconds(duration).min(period_end);
            if ends_at <= starts_at {
                continue;
            }
            let severity = profile.minimum_severity_basis_points.saturating_add(
                u32::try_from(rng.below(severity_span)).map_err(|_| DisruptionError::Overflow)?,
            );
            generated.push(GeneratedDisruption {
                world_id: policy.world_id,
                id: format!("spontaneous-{}-{}-{ordinal}", seed.period(), resource_id),
                kind: DisruptionKind::OperationalIncident,
                starts_at,
                ends_at,
                published_at: starts_at,
                severity_basis_points: severity,
                resources: vec![resource],
                effect,
                scope: RestrictionScope {
                    direction: RestrictionDirection::Both,
                    traffic: RestrictionTraffic::All,
                    train_run_ids: train_run_id.into_iter().collect(),
                },
                cause_code,
                fine_cause_id: fine_cause_id.into(),
                source: GeneratedSource {
                    kind: if matches!(policy.operational_incident_mode, DisruptionMode::Realistic) {
                        GeneratedSourceKind::SimulatedRealisticGap
                    } else {
                        GeneratedSourceKind::SimulatedIncident
                    },
                    substream: Substream::Disruption.name().into(),
                    infra_release: infra_release.into(),
                    simulation_profile: profile.id.clone(),
                    ruleset_version: policy.ruleset_version.clone(),
                    calibration_version: SPONTANEOUS_INCIDENT_CALIBRATION_VERSION.into(),
                },
            });
        }
    }
    generated.sort_by_key(|event| (event.published_at, event.starts_at, event.id.clone()));
    Ok(generated)
}

fn draw_daily_class(rng: &mut Rng, phase: u64) -> DailyRestrictionClass {
    let total: u64 = DAILY_RESTRICTION_WEIGHTS
        .iter()
        .map(|weight| u64::from(weight.sample_count))
        .sum();
    let draw = rng.below(total).saturating_add(phase) % total;
    let mut cumulative = 0_u64;
    for weight in DAILY_RESTRICTION_WEIGHTS {
        cumulative = cumulative.saturating_add(u64::from(weight.sample_count));
        if draw < cumulative {
            return weight.class;
        }
    }
    DailyRestrictionClass::OperationalCondition
}

fn draw_daily_speed_mm_per_second(rng: &mut Rng, phase: u64) -> u32 {
    let total: u64 = DAILY_SPEED_WEIGHTS
        .iter()
        .map(|weight| u64::from(weight.sample_count))
        .sum();
    let draw = rng.below(total).saturating_add(phase) % total;
    let mut cumulative = 0_u64;
    for weight in DAILY_SPEED_WEIGHTS {
        cumulative = cumulative.saturating_add(u64::from(weight.sample_count));
        if draw < cumulative {
            return weight.kilometres_per_hour.saturating_mul(1_000_000) / 3_600;
        }
    }
    11_111
}

/// Erzeugt die tagesaktuelle Einschränkungsschicht auch für eine
/// `REALISTIC`-Welt vollständig aus einem offen ausgewiesenen Modell.
///
/// Das ist kein stiller Provider-Fallback: `source.kind` und die gepinnte
/// Kalibrierung weisen jedes Ereignis als Simulation aus. Externe
/// Echtzeitereignisse bleiben weiterhin fail-closed im Providerregister.
pub fn generate_daily_restrictions(
    policy: &DisruptionPolicy,
    seed: WorldSeed,
    infra_release: &str,
    day_start: SimTime,
    resources: &[(String, ConflictResource, u32)],
) -> Result<Vec<GeneratedDisruption>, DisruptionError> {
    if matches!(policy.planned_works_mode, DisruptionMode::Manual)
        && matches!(policy.operational_incident_mode, DisruptionMode::Manual)
    {
        return Err(DisruptionError::WrongMode);
    }
    if resources.is_empty() || infra_release.trim().is_empty() {
        return Err(DisruptionError::InvalidGenerationWindow);
    }
    policy.simulation_profile.validate()?;
    let mut rng = seed.substream(Substream::DailyRestriction);
    let day_phase = day_start.seconds().unsigned_abs() / u64::try_from(SECONDS_PER_DAY).unwrap();
    let resource_count = u64::try_from(resources.len()).map_err(|_| DisruptionError::Overflow)?;
    let mut generated = Vec::new();

    let target_count = usize::try_from(policy.simulation_profile.daily_restrictions_per_day)
        .map_err(|_| DisruptionError::Overflow)?;
    let mut ordinal = 0_u32;
    while generated.len() < target_count {
        let phase = day_phase.saturating_add(u64::from(ordinal));
        let index =
            usize::try_from(rng.below(resource_count).saturating_add(phase) % resource_count)
                .map_err(|_| DisruptionError::Overflow)?;
        let (resource_id, resource, load_basis_points) = &resources[index];
        let alternative = resources[(index.saturating_add(1)) % resources.len()].1;
        let class = draw_daily_class(&mut rng, phase);
        if class == DailyRestrictionClass::RadioUnavailable {
            ordinal = ordinal.saturating_add(1);
            continue;
        }
        let (effect, cause_code, fine_cause_id) = match class {
            DailyRestrictionClass::NumericSpeed => (
                DisruptionEffect::SpeedRestriction {
                    maximum_speed_mm_per_second: draw_daily_speed_mm_per_second(&mut rng, phase),
                },
                30,
                "speed-restriction.asset-condition",
            ),
            DailyRestrictionClass::RadioUnavailable => unreachable!("oben wirkungslos gefiltert"),
            DailyRestrictionClass::TrainProtection => (
                DisruptionEffect::SpeedRestriction {
                    maximum_speed_mm_per_second: 11_111,
                },
                25,
                "signalling.train-protection",
            ),
            DailyRestrictionClass::LevelCrossing => (
                DisruptionEffect::SpeedRestriction {
                    maximum_speed_mm_per_second: 5_555,
                },
                24,
                "level-crossing.drive",
            ),
            DailyRestrictionClass::TextualCondition => match ordinal % 3 {
                0 => (
                    DisruptionEffect::TrafficHold {
                        maximum_hold_seconds: 1_800,
                    },
                    25,
                    "signalling.interlocking",
                ),
                1 => (
                    DisruptionEffect::RouteDeviation {
                        alternative_resources: vec![alternative],
                    },
                    25,
                    "signalling.remote-control",
                ),
                _ => (
                    DisruptionEffect::VehicleRestriction {
                        maximum_axle_load_kg: 20_000,
                        maximum_train_length_mm: 180_000,
                    },
                    22,
                    "structure.bridge",
                ),
            },
            DailyRestrictionClass::OperationalCondition => match ordinal % 4 {
                0 => (
                    DisruptionEffect::SingleTrack {
                        shared_resource: *resource,
                        remaining_capacity: 1,
                    },
                    23,
                    "track.superstructure",
                ),
                1 => (DisruptionEffect::Closure, 23, "track.rail-break"),
                2 => (
                    DisruptionEffect::RouteDeviation {
                        alternative_resources: vec![alternative],
                    },
                    31,
                    "construction.diversion",
                ),
                _ => (
                    DisruptionEffect::PlatformUsableLength {
                        maximum_usable_length_mm: 161_000,
                    },
                    47,
                    "station.platform",
                ),
            },
        };
        effect.validate(&[*resource])?;
        let duration_seconds = 3 * 3_600
            + i64::try_from(rng.below(u64::try_from(45 * 3_600).unwrap()))
                .map_err(|_| DisruptionError::Overflow)?;
        let severity = 1_000_u32.saturating_add(*load_basis_points / 2).min(10_000);
        generated.push(GeneratedDisruption {
            world_id: policy.world_id,
            id: format!(
                "daily-restriction-{}-{}-{ordinal}",
                day_start.seconds(),
                resource_id
            ),
            kind: DisruptionKind::PlannedWorks,
            starts_at: day_start,
            ends_at: day_start.plus_seconds(duration_seconds),
            published_at: day_start,
            severity_basis_points: severity,
            resources: vec![*resource],
            effect,
            scope: RestrictionScope {
                direction: match ordinal % 3 {
                    0 => RestrictionDirection::Both,
                    1 => RestrictionDirection::RegularDirection,
                    _ => RestrictionDirection::OppositeDirection,
                },
                traffic: match ordinal % 5 {
                    1 => RestrictionTraffic::Passenger,
                    2 => RestrictionTraffic::Freight,
                    _ => RestrictionTraffic::All,
                },
                train_run_ids: Vec::new(),
            },
            cause_code,
            fine_cause_id: fine_cause_id.into(),
            source: GeneratedSource {
                kind: GeneratedSourceKind::SimulatedDailyRestriction,
                substream: Substream::DailyRestriction.name().into(),
                infra_release: infra_release.into(),
                simulation_profile: policy.simulation_profile.id.clone(),
                ruleset_version: policy.ruleset_version.clone(),
                calibration_version: DAILY_RESTRICTION_CALIBRATION_VERSION.into(),
            },
        });
        ordinal = ordinal.saturating_add(1);
    }
    generated.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(generated)
}

/// Autorisierungsrolle für manuelle Ursachen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActorRole {
    /// Normales Spielerkonto ohne Eingriffsrecht.
    Player,
    /// Weltisolierter Spielleiter bzw. Weltadministrator.
    WorldAdmin,
}

/// Autorisierter Weltkontext eines Kommandos.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorldScope {
    /// Gebundene Welt.
    pub world_id: u64,
    /// Auditierte Akteurskennung.
    pub actor_id: String,
    /// Serverseitig festgestellte Rolle.
    pub role: ActorRole,
}

/// Pflichtfelder einer manuellen Störung oder Baustelle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualDisruptionCommand {
    /// Zielwelt.
    pub world_id: u64,
    /// Idempotente Kommandokennung.
    pub command_id: String,
    /// Beginn einschließlich.
    pub starts_at: SimTime,
    /// Ende ausschließlich.
    pub ends_at: SimTime,
    /// Nicht leere Ursache.
    pub cause: String,
    /// Hauptkennung der unmittelbar wirkenden Verspätungsursache.
    pub cause_code: u8,
    /// Markenfreie Feinkennung unterhalb der Hauptkennung.
    pub fine_cause_id: String,
    /// Echte Konfliktressourcen.
    pub affected_resources: Vec<ConflictResource>,
    /// Geprüfte Auswirkung.
    pub effect: DisruptionEffect,
}

/// Auditdatensatz eines manuellen Eingriffs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualAudit {
    /// Welt des Eingriffs.
    pub world_id: u64,
    /// Akteur.
    pub actor_id: String,
    /// Kommandokennung.
    pub command_id: String,
    /// Protokollierte Ursache.
    pub cause: String,
    /// Protokollierte Hauptkennung.
    pub cause_code: u8,
    /// Protokollierte Feinkennung.
    pub fine_cause_id: String,
}

/// Ergebnis eines autorisierten manuellen Kommandos.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualCreation {
    /// Erzeugte Störung.
    pub disruption: GeneratedDisruption,
    /// Unveränderlicher Auditnachweis.
    pub audit: ManualAudit,
}

/// Veröffentlichung einer geplanten Baustelle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConstructionNotice {
    /// Welt der Baustelle.
    pub world_id: u64,
    /// Stabile Baustellenkennung.
    pub id: String,
    /// Veröffentlichung.
    pub published_at: SimTime,
    /// Beginn.
    pub starts_at: SimTime,
    /// Ende.
    pub ends_at: SimTime,
    /// Betroffene Konfliktressourcen.
    pub resources: Vec<ConflictResource>,
    /// Verbleibende Kapazität.
    pub remaining_capacity: u32,
}

impl ConstructionNotice {
    /// Baut eine Baustellenankündigung mit echtem Planungsfenster.
    pub fn new(
        world_id: u64,
        id: impl Into<String>,
        published_at: SimTime,
        starts_at: SimTime,
        ends_at: SimTime,
        resources: Vec<ConflictResource>,
        remaining_capacity: u32,
    ) -> Result<Self, DisruptionError> {
        let id = id.into();
        if world_id == 0
            || id.trim().is_empty()
            || resources.is_empty()
            || published_at >= starts_at
            || starts_at >= ends_at
        {
            return Err(DisruptionError::InvalidConstructionNotice);
        }
        Ok(Self {
            world_id,
            id,
            published_at,
            starts_at,
            ends_at,
            resources,
            remaining_capacity,
        })
    }

    /// Vorlauf in Sekunden.
    #[must_use]
    pub const fn lead_time_seconds(&self) -> i64 {
        self.starts_at
            .seconds()
            .saturating_sub(self.published_at.seconds())
    }
}

/// Betriebliche Art einer konkurrierenden Bewegung.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum MovementKind {
    /// Fahrgastgebundene Zugfahrt.
    Passenger = 0,
    /// Leerfahrt.
    EmptyStock = 1,
    /// Güterzug.
    Freight = 2,
    /// Zusatzfahrt.
    Supplementary = 3,
    /// Automatisierte Rangierfahrt.
    Shunting = 4,
}

/// Explizites Früh-/Soll-/Spätfenster an einem Halt oder einer Betriebsstelle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DepartureWindow {
    /// Früheste zulässige Abfahrt.
    pub earliest: SimTime,
    /// Planmäßige Abfahrt.
    pub scheduled: SimTime,
    /// Späteste zulässige Abfahrt.
    pub latest: SimTime,
}

/// Form der für genau diese Zugfahrt erteilten Abfahrtszustimmung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DepartureAuthority {
    /// Keine Zustimmung erteilt.
    None,
    /// Fahrtstellung eines Hauptsignals.
    MainSignal,
    /// Führungsgröße der Führerraumsignalisierung.
    CabSignalling,
    /// Zulässiges Ersatz- oder Vorsichtsignal.
    SubstituteSignal,
    /// Schriftlicher oder elektronischer Befehl für die konkrete Fahrt.
    WrittenOrder,
    /// In der örtlich zugelassenen Situation mündlich erteilte Zustimmung.
    VerbalConsent,
}

impl DepartureAuthority {
    const fn is_granted(self) -> bool {
        !matches!(self, Self::None)
    }
}

/// Prüfnachweis der sicherheitsrelevanten Fahrstraßenbedingungen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RouteSafetyProof {
    /// Fahrstraße ist eingestellt und gegen Umstellen gesichert.
    pub route_set_and_locked: bool,
    /// Fahrweg ist bis zum Zielpunkt frei geprüft.
    pub route_proved_clear: bool,
    /// Erforderlicher Durchrutschweg ist frei geprüft.
    pub overlap_proved_clear: bool,
    /// Erforderlicher Flankenschutz ist hergestellt.
    pub flank_protection_proved: bool,
}

impl RouteSafetyProof {
    /// Vollständiger Nachweis für eine regulär gesicherte Fahrstraße.
    #[must_use]
    pub const fn secured() -> Self {
        Self {
            route_set_and_locked: true,
            route_proved_clear: true,
            overlap_proved_clear: true,
            flank_protection_proved: true,
        }
    }

    const fn is_complete(self) -> bool {
        self.route_set_and_locked
            && self.route_proved_clear
            && self.overlap_proved_clear
            && self.flank_protection_proved
    }
}

/// Eine vom regionalen virtuellen Fahrdienstleiter zu koordinierende Bewegung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Movement {
    /// Welt der Bewegung.
    pub world_id: u64,
    /// Bewegungskennung.
    pub id: u64,
    /// EVU-Kennung.
    pub operator_id: u64,
    /// Fahrttyp.
    pub kind: MovementKind,
    /// Explizites Abfahrtsrecht.
    pub departure: DepartureWindow,
    /// Zeitpunkt der Dispositionsanfrage.
    pub requested_at: SimTime,
    /// Ressourcen und Zeitfenster bei Abfahrt zur frühesten Zeit.
    pub reservations: Vec<(ConflictResource, SimTime, SimTime)>,
    /// Mindesthaltezeit ist erfüllt.
    pub minimum_dwell_met: bool,
    /// Fahrstraße bzw. Freigabe ist gesichert.
    /// Ausführbarer Nachweis der Fahrstraßensicherung.
    pub route_safety: RouteSafetyProof,
    /// Für genau diese Bewegung erteilte Abfahrtszustimmung.
    pub departure_authority: DepartureAuthority,
    /// Personal und Fahrzeug sind gebunden und bereit.
    pub personnel_and_vehicle_ready: bool,
    /// Zahl gefährdeter Anschlüsse.
    pub affected_connections: u32,
    /// Vertragliche Wirkung in Cent.
    pub contract_effect_cents: i64,
    /// Netzstabilitätsrang; kleiner ist besser.
    pub network_stability_rank: u32,
    /// Umlauf-/Fahrzeugfolgenrang; kleiner ist besser.
    pub rotation_effect_rank: u32,
    /// Wiederherstellbarkeitsrang; kleiner ist besser.
    pub recoverability_rank: u32,
    /// Notwendige Bewegung für die Betriebswiederaufnahme.
    pub essential_for_recovery: bool,
    /// Beginn der aktuellen Wartephase.
    pub waiting_since: SimTime,
}

/// Protokollierte Ursache des Abfahrtausgangs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DepartureCause {
    /// Explizit zulässige Frühfahrt.
    PermittedEarlyDeparture,
    /// Planmäßige oder verspätete Abfahrt ohne weiteren Konflikt.
    ScheduledOrDelayedDeparture,
    /// Eine konkrete Ressource ist bereits belegt.
    ResourceConflict,
    /// Sicherheits- oder Freigabebedingung fehlt.
    MissingOperationalRelease,
    /// Fahrweg, Durchrutschweg oder Flankenschutz ist nicht vollständig nachgewiesen.
    MissingRouteProof,
    /// Für diese Fahrt fehlt eine zulässige Abfahrtszustimmung.
    MissingDepartureConsent,
    /// Das ausdrückliche Abfahrtsfenster ist noch nicht offen oder abgelaufen.
    OutsideDepartureWindow,
}

/// Vollständige Erklärung einer virtuellen Fdl-Entscheidung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchExplanation {
    /// Versionierte Entscheidungsregel.
    pub rule: String,
    /// Betroffene Ressourcen.
    pub resources: Vec<ConflictResource>,
    /// Geprüfte lexikographische Kriterien.
    pub criteria: Vec<String>,
    /// Geprüfte Bewegungen und Gründe.
    pub checked_alternatives: Vec<String>,
    /// Stabile Gleichstandsauflösung.
    pub stable_tiebreak: u64,
}

/// Ergebnis für eine Bewegung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MovementDecision {
    /// Bewegung.
    pub movement_id: u64,
    /// Tatsächliche Abfahrt oder `None` beim Warten/Ausfall.
    pub departure_at: Option<SimTime>,
    /// Konkrete Ursache.
    pub cause: DepartureCause,
    /// Auditierbare Erklärung.
    pub explanation: DispatchExplanation,
}

/// Serverautoritärer, regionaler Koordinator über den echten CapacityLedger.
#[derive(Clone, Debug)]
pub struct VirtualDispatcher {
    world_id: u64,
    ledger: CapacityLedger,
    maximum_shunting_wait_seconds: i64,
    next_reservation_id: u64,
}

impl VirtualDispatcher {
    /// Baut einen regionalen Koordinator.
    #[must_use]
    pub fn new(
        world_id: u64,
        exclusions: ResourceExclusions,
        maximum_shunting_wait_seconds: i64,
    ) -> Self {
        Self {
            world_id,
            ledger: CapacityLedger::new(exclusions),
            maximum_shunting_wait_seconds,
            next_reservation_id: 1,
        }
    }

    /// Koordiniert eine Ereignismenge lexikographisch und bitstabil.
    pub fn coordinate(
        &mut self,
        at: SimTime,
        mut movements: Vec<Movement>,
    ) -> Result<Vec<MovementDecision>, DisruptionError> {
        if movements
            .iter()
            .any(|movement| movement.world_id != self.world_id)
        {
            return Err(DisruptionError::WrongWorld);
        }
        movements.sort_by_key(|movement| {
            movement_rank(movement, at, self.maximum_shunting_wait_seconds)
        });
        let alternatives = movements
            .iter()
            .map(|movement| format!("Bewegung {} ({:?})", movement.id, movement.kind))
            .collect::<Vec<_>>();
        let mut decisions = Vec::new();
        for movement in movements {
            let desired = desired_departure(&movement, at)?;
            let resources = movement
                .reservations
                .iter()
                .map(|item| item.0)
                .collect::<Vec<_>>();
            let mut explanation = DispatchExplanation {
                rule: "virtual-dispatcher/rule-408-2025-v2".into(),
                resources,
                criteria: vec![
                    "Sicherheit und Konfliktfreiheit".into(),
                    "Fahrwegprüfung, Durchrutschweg und Flankenschutz".into(),
                    "individuelle Zustimmung zur Abfahrt".into(),
                    "Fahrgastwirkung und Anschlüsse".into(),
                    "Vertragsfolgen".into(),
                    "Netzstabilität".into(),
                    "Umlauf und Fahrzeug".into(),
                    "Wiederherstellbarkeit".into(),
                    "operative Präferenz".into(),
                ],
                checked_alternatives: alternatives.clone(),
                stable_tiebreak: movement.id,
            };
            let Some(departure_at) = desired else {
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: None,
                    cause: DepartureCause::OutsideDepartureWindow,
                    explanation,
                });
                continue;
            };
            if !movement.minimum_dwell_met || !movement.personnel_and_vehicle_ready {
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: None,
                    cause: DepartureCause::MissingOperationalRelease,
                    explanation,
                });
                continue;
            }
            if !movement.route_safety.is_complete() {
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: None,
                    cause: DepartureCause::MissingRouteProof,
                    explanation,
                });
                continue;
            }
            if !movement.departure_authority.is_granted() {
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: None,
                    cause: DepartureCause::MissingDepartureConsent,
                    explanation,
                });
                continue;
            }
            let shift = departure_at
                .seconds()
                .saturating_sub(movement.departure.earliest.seconds());
            let mut tentative = self.ledger.clone();
            let start_id = self.next_reservation_id;
            let mut reservation_id = start_id;
            let mut accepted = true;
            for (resource, starts_at, ends_at) in &movement.reservations {
                let reservation = ResourceReservation::new(
                    self.world_id,
                    reservation_id,
                    *resource,
                    starts_at.plus_seconds(shift),
                    ends_at.plus_seconds(shift),
                )
                .map_err(|_| DisruptionError::InvalidMovement)?;
                if tentative.try_reserve(reservation).is_err() {
                    accepted = false;
                    break;
                }
                reservation_id = reservation_id.saturating_add(1);
            }
            if accepted {
                self.ledger = tentative;
                self.next_reservation_id = reservation_id;
                let early = departure_at < movement.departure.scheduled;
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: Some(departure_at),
                    cause: if early {
                        DepartureCause::PermittedEarlyDeparture
                    } else {
                        DepartureCause::ScheduledOrDelayedDeparture
                    },
                    explanation,
                });
            } else {
                explanation.checked_alternatives.push(format!(
                    "Bewegung {} wartet wegen konkret ausgeschöpfter Konfliktressource",
                    movement.id
                ));
                decisions.push(MovementDecision {
                    movement_id: movement.id,
                    departure_at: None,
                    cause: DepartureCause::ResourceConflict,
                    explanation,
                });
            }
        }
        decisions.sort_by_key(|decision| decision.movement_id);
        Ok(decisions)
    }
}

fn movement_rank(
    movement: &Movement,
    at: SimTime,
    maximum_shunting_wait_seconds: i64,
) -> (u8, u8, u32, i64, u32, u32, u32, u8, u64) {
    let released = movement.minimum_dwell_met
        && movement.route_safety.is_complete()
        && movement.departure_authority.is_granted()
        && movement.personnel_and_vehicle_ready;
    let starved_recovery = movement.kind == MovementKind::Shunting
        && movement.essential_for_recovery
        && at
            .seconds()
            .saturating_sub(movement.waiting_since.seconds())
            >= maximum_shunting_wait_seconds;
    (
        u8::from(!released),
        u8::from(!starved_recovery),
        u32::MAX.saturating_sub(movement.affected_connections),
        movement.contract_effect_cents,
        movement.network_stability_rank,
        movement.rotation_effect_rank,
        movement.recoverability_rank,
        movement.kind as u8,
        movement.id,
    )
}

fn desired_departure(movement: &Movement, at: SimTime) -> Result<Option<SimTime>, DisruptionError> {
    if movement.departure.earliest > movement.departure.scheduled
        || movement.departure.scheduled > movement.departure.latest
    {
        return Err(DisruptionError::InvalidMovement);
    }
    let can_run_early = matches!(
        movement.kind,
        MovementKind::EmptyStock
            | MovementKind::Freight
            | MovementKind::Supplementary
            | MovementKind::Shunting
    );
    let desired = if can_run_early {
        at.max(movement.departure.earliest)
    } else {
        at.max(movement.departure.scheduled)
    };
    Ok((desired <= movement.departure.latest).then_some(desired))
}

/// Versionierte Integer-Cent-Sätze aus dem je Welt gepinnten EconomyRelease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EconomyRates {
    /// Releasekennung.
    pub release_id: String,
    /// Umleitungskosten je Fall.
    pub reroute_cents: i64,
    /// Kurzwendekosten je Fall.
    pub short_turn_cents: i64,
    /// Taktausdünnung je entfallener Fahrt.
    pub thinning_cents_per_run: i64,
    /// Linienzusammenlegung je Fall.
    pub merge_cents: i64,
    /// SEV-Kosten je betroffener Fahrt.
    pub rail_replacement_cents_per_run: i64,
    /// Minderung je betroffener Fahrt.
    pub reduction_cents_per_run: i64,
    /// Pönale je betroffener Fahrt.
    pub penalty_cents_per_run: i64,
}

impl EconomyRates {
    /// Fiktive, ausdrücklich nicht produktive Testsätze.
    #[must_use]
    pub fn test(release_id: impl Into<String>) -> Self {
        Self {
            release_id: release_id.into(),
            reroute_cents: 40_000,
            short_turn_cents: 65_000,
            thinning_cents_per_run: 20_000,
            merge_cents: 80_000,
            rail_replacement_cents_per_run: 120_000,
            reduction_cents_per_run: 10_000,
            penalty_cents_per_run: 90_000,
        }
    }
}

/// Fachliche Ersatzmaßnahme mit allen Durchführbarkeitsfeldern.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Alternative {
    /// Umleitung über knappe Restkapazität.
    Reroute {
        /// Knappe Konfliktressource.
        resource: ConflictResource,
        /// Beginn der Belegung.
        starts_at: SimTime,
        /// Ende der Belegung.
        ends_at: SimTime,
        /// Streckenkenntnis vorhanden.
        route_knowledge: bool,
        /// Zugsicherung kompatibel.
        train_protection: bool,
        /// Elektrifizierung kompatibel.
        electrification: bool,
        /// Zuglänge zulässig.
        train_length: bool,
        /// Fahrzeug geeignet.
        vehicle_suitable: bool,
    },
    /// Vorzeitige Wende.
    ShortTurn {
        /// Wendeanlage ist vorhanden.
        turning_possible: bool,
        /// Gleiskapazität ist frei.
        track_capacity: bool,
    },
    /// Taktausdünnung.
    ThinOut {
        /// Entfallende Fahrten.
        removed_runs: u32,
        /// Vertrag lässt die Maßnahme zu.
        contract_allows: bool,
        /// Umlauf bleibt ausführbar.
        rotation_feasible: bool,
        /// Personal bleibt ausführbar.
        personnel_feasible: bool,
    },
    /// Linienzusammenlegung.
    MergeLines {
        /// Fahrzeugbestand reicht.
        vehicle_feasible: bool,
        /// Personalbestand reicht.
        personnel_feasible: bool,
        /// Umläufe bleiben ausführbar.
        rotation_feasible: bool,
        /// Vertrag lässt die Maßnahme zu.
        contract_allows: bool,
    },
    /// Schienenersatzverkehr, ausschließlich als Pflicht/Kosten/Bewertung.
    RailReplacement {
        /// Betroffene Fahrten.
        affected_runs: u32,
    },
}

/// Antrag eines EVU im gemeinsamen Ersatzplanungslauf.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplacementRequest {
    /// Welt.
    pub world_id: u64,
    /// EVU.
    pub operator_id: u64,
    /// Stabile Antragskennung.
    pub id: String,
    /// Einreichung.
    pub submitted_at: SimTime,
    /// Veröffentlichte Frist.
    pub deadline: SimTime,
    /// Geordnete Maßnahmen; gute Handplanung steht vor dem Standardfallback.
    pub alternatives: Vec<Alternative>,
}

impl ReplacementRequest {
    /// Komfortkonstruktor für eine Umleitung mit teurem SEV-Fallback.
    #[must_use]
    #[allow(
        clippy::too_many_arguments,
        reason = "knapper Testszenario-Konstruktor"
    )]
    pub fn reroute(
        world_id: u64,
        operator_id: u64,
        id: impl Into<String>,
        submitted_at: SimTime,
        deadline: SimTime,
        resource: ConflictResource,
        starts_at: SimTime,
        ends_at: SimTime,
    ) -> Self {
        Self {
            world_id,
            operator_id,
            id: id.into(),
            submitted_at,
            deadline,
            alternatives: vec![
                Alternative::Reroute {
                    resource,
                    starts_at,
                    ends_at,
                    route_knowledge: true,
                    train_protection: true,
                    electrification: true,
                    train_length: true,
                    vehicle_suitable: true,
                },
                Alternative::RailReplacement { affected_runs: 5 },
            ],
        }
    }
}

/// Vertragliche Behandlung eines Ersatzkonzepts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractTreatment {
    /// Fristgerechtes plausibles Konzept: Minderung.
    Reduction,
    /// Spätes, unplausibles oder fehlendes Konzept: Pönale.
    Penalty,
}

/// Ergebnis der Vertragsprüfung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractSettlement {
    /// Minderung oder Pönale.
    pub treatment: ContractTreatment,
    /// Betrag in Integer-Cent.
    pub amount_cents: i64,
    /// Erklärung.
    pub explanation: String,
}

/// Ausgeglichene Buchungsanweisung für den bestehenden Ledger.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LedgerEntry {
    /// Kostenart bzw. Gegenkonto.
    pub account: String,
    /// Vorzeichenbehafteter Betrag in Cent.
    pub amount_cents: i64,
}

/// Ergebnis eines EVU im Ersatzplanungslauf.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplacementOutcome {
    /// EVU.
    pub operator_id: u64,
    /// Antragskennung.
    pub request_id: String,
    /// Tatsächlich ausgewählte Maßnahme.
    pub selected: Alternative,
    /// Jede verworfene Maßnahme mit konkretem Grund.
    pub rejections: Vec<String>,
    /// Kosten in Integer-Cent.
    pub cost_cents: i64,
    /// Vertragliche Folge.
    pub contract: ContractSettlement,
    /// Ausgeglichene Ledgeranweisungen.
    pub ledger_entries: Vec<LedgerEntry>,
    /// Transparente Gesamterklärung.
    pub explanation: String,
}

/// Gemeinsamer, seed-deterministischer Ersatzplanungslauf gegen Restkapazität.
pub fn run_replacement_planning(
    seed: WorldSeed,
    exclusions: ResourceExclusions,
    rates: &EconomyRates,
    mut requests: Vec<ReplacementRequest>,
) -> Result<Vec<ReplacementOutcome>, DisruptionError> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    let world_id = requests[0].world_id;
    if requests.iter().any(|request| request.world_id != world_id) {
        return Err(DisruptionError::WrongWorld);
    }
    requests.sort_by_key(|request| (request.submitted_at, request.id.clone()));
    let mut rng = seed.substream(Substream::Tiebreak);
    let mut ordered = Vec::with_capacity(requests.len());
    let mut index = 0;
    while index < requests.len() {
        let submitted_at = requests[index].submitted_at;
        let mut end = index + 1;
        while end < requests.len() && requests[end].submitted_at == submitted_at {
            end += 1;
        }
        let permutation = rng.permutation(end - index);
        for offset in permutation {
            ordered.push(requests[index + offset].clone());
        }
        index = end;
    }
    let mut ledger = CapacityLedger::new(exclusions);
    let mut reservation_id = 1_u64;
    let mut outcomes = Vec::new();
    for request in ordered {
        if request.id.trim().is_empty() || request.alternatives.is_empty() {
            return Err(DisruptionError::InvalidReplacementRequest);
        }
        let mut rejections = Vec::new();
        let mut selected = None;
        for alternative in &request.alternatives {
            match check_alternative(alternative, world_id, reservation_id, &mut ledger) {
                Ok(()) => {
                    selected = Some(alternative.clone());
                    if matches!(alternative, Alternative::Reroute { .. }) {
                        reservation_id = reservation_id.saturating_add(1);
                    }
                    break;
                }
                Err(reason) => rejections.push(reason),
            }
        }
        let selected = selected.unwrap_or(Alternative::RailReplacement { affected_runs: 5 });
        let affected_runs = alternative_affected_runs(&selected);
        let cost_cents = alternative_cost(&selected, rates);
        let timely = request.submitted_at <= request.deadline;
        let contract = settle_replacement_contract(rates, timely, true, false, affected_runs);
        let ledger_entries = balanced_ledger_entries(&selected, cost_cents);
        outcomes.push(ReplacementOutcome {
            operator_id: request.operator_id,
            request_id: request.id.clone(),
            selected: selected.clone(),
            rejections,
            cost_cents,
            contract,
            ledger_entries,
            explanation: format!(
                "Ersatzplanung {}: {:?}; EconomyRelease {}; Restkapazität konfliktgeprüft",
                request.id, selected, rates.release_id
            ),
        });
    }
    outcomes.sort_by_key(|outcome| outcome.operator_id);
    Ok(outcomes)
}

fn check_alternative(
    alternative: &Alternative,
    world_id: u64,
    reservation_id: u64,
    ledger: &mut CapacityLedger,
) -> Result<(), String> {
    match alternative {
        Alternative::Reroute {
            resource,
            starts_at,
            ends_at,
            route_knowledge,
            train_protection,
            electrification,
            train_length,
            vehicle_suitable,
        } => {
            for (accepted, name) in [
                (*route_knowledge, "Streckenkenntnis"),
                (*train_protection, "Zugsicherung"),
                (*electrification, "Elektrifizierung"),
                (*train_length, "Zuglänge"),
                (*vehicle_suitable, "Fahrzeugeignung"),
            ] {
                if !accepted {
                    return Err(format!("Umleitung abgelehnt: {name} fehlt oder ist unzulässig"));
                }
            }
            let reservation = ResourceReservation::new(
                world_id,
                reservation_id,
                *resource,
                *starts_at,
                *ends_at,
            )
            .map_err(|_| "Umleitung abgelehnt: ungültiges Zeitfenster".to_owned())?;
            ledger
                .try_reserve(reservation)
                .map_err(|_| "Umleitung abgelehnt: Restkapazität der Konfliktressource ausgeschöpft".to_owned())
        }
        Alternative::ShortTurn {
            turning_possible,
            track_capacity,
        } if !turning_possible || !track_capacity => {
            Err("Kurzwende abgelehnt: Wendemöglichkeit oder Gleiskapazität fehlt".into())
        }
        Alternative::ThinOut {
            contract_allows,
            rotation_feasible,
            personnel_feasible,
            ..
        } if !contract_allows || !rotation_feasible || !personnel_feasible => {
            Err("Taktausdünnung abgelehnt: Vertrag, Umlauf oder Personal nicht durchführbar".into())
        }
        Alternative::MergeLines {
            vehicle_feasible,
            personnel_feasible,
            rotation_feasible,
            contract_allows,
        } if !vehicle_feasible || !personnel_feasible || !rotation_feasible || !contract_allows => {
            Err("Linienzusammenlegung abgelehnt: Fahrzeug, Personal, Umlauf oder Vertrag nicht durchführbar".into())
        }
        Alternative::RailReplacement { affected_runs } if *affected_runs == 0 => {
            Err("SEV abgelehnt: keine betroffene Fahrt".into())
        }
        _ => Ok(()),
    }
}

fn alternative_affected_runs(alternative: &Alternative) -> u32 {
    match alternative {
        Alternative::ThinOut { removed_runs, .. } => *removed_runs,
        Alternative::RailReplacement { affected_runs } => *affected_runs,
        Alternative::Reroute { .. }
        | Alternative::ShortTurn { .. }
        | Alternative::MergeLines { .. } => 1,
    }
}

fn alternative_cost(alternative: &Alternative, rates: &EconomyRates) -> i64 {
    match alternative {
        Alternative::Reroute { .. } => rates.reroute_cents,
        Alternative::ShortTurn { .. } => rates.short_turn_cents,
        Alternative::ThinOut { removed_runs, .. } => rates
            .thinning_cents_per_run
            .saturating_mul(i64::from(*removed_runs)),
        Alternative::MergeLines { .. } => rates.merge_cents,
        Alternative::RailReplacement { affected_runs } => rates
            .rail_replacement_cents_per_run
            .saturating_mul(i64::from(*affected_runs)),
    }
}

fn balanced_ledger_entries(alternative: &Alternative, cost_cents: i64) -> Vec<LedgerEntry> {
    let account = match alternative {
        Alternative::RailReplacement { .. } => "rail-replacement-service",
        Alternative::Reroute { .. } => "reroute",
        Alternative::ShortTurn { .. } => "short-turn",
        Alternative::ThinOut { .. } => "service-reduction",
        Alternative::MergeLines { .. } => "line-merge",
    };
    vec![
        LedgerEntry {
            account: account.into(),
            amount_cents: cost_cents,
        },
        LedgerEntry {
            account: "cash-clearing".into(),
            amount_cents: cost_cents.saturating_neg(),
        },
    ]
}

/// Prüft Minderung statt Pönale ohne Gleitkommazahlen.
#[must_use]
pub fn settle_replacement_contract(
    rates: &EconomyRates,
    timely: bool,
    plausible: bool,
    omitted: bool,
    affected_runs: u32,
) -> ContractSettlement {
    let treatment = if timely && plausible && !omitted {
        ContractTreatment::Reduction
    } else {
        ContractTreatment::Penalty
    };
    let per_run = match treatment {
        ContractTreatment::Reduction => rates.reduction_cents_per_run,
        ContractTreatment::Penalty => rates.penalty_cents_per_run,
    };
    let amount_cents = per_run.saturating_mul(i64::from(affected_runs));
    ContractSettlement {
        treatment,
        amount_cents,
        explanation: match treatment {
            ContractTreatment::Reduction => {
                "fristgerechtes, plausibles und durchführbares Ersatzkonzept: Minderung".into()
            }
            ContractTreatment::Penalty => {
                "verspätetes, unplausibles oder unterlassenes Ersatzkonzept: Pönale".into()
            }
        },
    }
}

/// Sicherer, konfliktfreier und bewusst teurer Nichtstun-Fallback.
#[must_use]
pub fn automatic_standard_plan(
    _world_id: u64,
    operator_id: u64,
    request_id: impl Into<String>,
    rates: &EconomyRates,
    affected_runs: u32,
) -> ReplacementOutcome {
    let selected = Alternative::RailReplacement { affected_runs };
    let cost_cents = alternative_cost(&selected, rates);
    ReplacementOutcome {
        operator_id,
        request_id: request_id.into(),
        selected: selected.clone(),
        rejections: vec![
            "Kein fristgerechtes Spieler-Ersatzkonzept; sicherer Standardfallback".into(),
        ],
        cost_cents,
        contract: settle_replacement_contract(rates, false, false, true, affected_runs),
        ledger_entries: balanced_ledger_entries(&selected, cost_cents),
        explanation:
            "Automatik: Taktausdünnung und SEV; sicher, konfliktfrei und wirtschaftlich nachteilig"
                .into(),
    }
}

/// Rechtefreigabestatus eines realistischen Providers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RightsStatus {
    /// Vertraglich freigegeben.
    Approved,
    /// Prüfung läuft.
    UnderReview,
    /// Import und produktive Aktivierung blockiert.
    Blocked,
}

/// Generischer Providerregistereintrag ohne produktiven Adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRecord {
    /// Providerkennung.
    pub id: String,
    /// Dokumentierter Rechtestatus.
    pub rights_status: RightsStatus,
    /// Kommerzielle Nutzung erlaubt.
    pub commercial_use: bool,
    /// Speicherung für Replay/Audit erlaubt.
    pub replay_storage: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct ProviderState {
    enabled: bool,
    last_safe_at: Option<SimTime>,
    visible_disruption_ids: Vec<String>,
}

/// Ergebnis eines Providerausfalls: letzter sicherer Stand, niemals Simulation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderFallback {
    /// Sichtbar bleibende Ereignisse.
    pub visible_disruption_ids: Vec<String>,
    /// Muss immer falsch bleiben.
    pub switched_to_simulation: bool,
    /// Ausfallzeitpunkt.
    pub failed_at: SimTime,
    /// Auditgrund.
    pub reason: String,
}

/// Rechtegeprüftes Quellenregister für den deaktivierten Realistic-Modus.
#[derive(Clone, Debug, Default)]
pub struct ProviderRegistry {
    records: BTreeMap<String, ProviderRecord>,
    states: BTreeMap<String, ProviderState>,
}

impl ProviderRegistry {
    /// Leeres Register.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registriert Metadaten, aktiviert aber keinen Adapter.
    pub fn register(&mut self, record: ProviderRecord) -> Result<(), DisruptionError> {
        if record.id.trim().is_empty() || self.records.contains_key(&record.id) {
            return Err(DisruptionError::InvalidProvider);
        }
        self.states
            .insert(record.id.clone(), ProviderState::default());
        self.records.insert(record.id.clone(), record);
        Ok(())
    }

    /// Aktiviert ausschließlich eine vollständig freigegebene Quelle.
    pub fn enable(&mut self, id: &str) -> Result<(), DisruptionError> {
        let record = self
            .records
            .get(id)
            .ok_or(DisruptionError::UnknownProvider)?;
        if record.rights_status != RightsStatus::Approved
            || !record.commercial_use
            || !record.replay_storage
        {
            return Err(DisruptionError::RightsNotApproved);
        }
        self.states
            .get_mut(id)
            .ok_or(DisruptionError::UnknownProvider)?
            .enabled = true;
        Ok(())
    }

    /// Hinterlegt einen bereits geprüften sicheren Stand für Ausfallanzeige.
    pub fn seed_last_safe(
        &mut self,
        id: &str,
        fetched_at: SimTime,
        mut visible_disruption_ids: Vec<String>,
    ) -> Result<(), DisruptionError> {
        let state = self
            .states
            .get_mut(id)
            .ok_or(DisruptionError::UnknownProvider)?;
        visible_disruption_ids.sort();
        visible_disruption_ids.dedup();
        state.last_safe_at = Some(fetched_at);
        state.visible_disruption_ids = visible_disruption_ids;
        Ok(())
    }

    /// Liefert bei Ausfall den letzten sicheren Stand ohne Moduswechsel.
    pub fn provider_failed(
        &self,
        id: &str,
        failed_at: SimTime,
        reason: impl Into<String>,
    ) -> Result<ProviderFallback, DisruptionError> {
        let state = self
            .states
            .get(id)
            .ok_or(DisruptionError::UnknownProvider)?;
        Ok(ProviderFallback {
            visible_disruption_ids: state.visible_disruption_ids.clone(),
            switched_to_simulation: false,
            failed_at,
            reason: reason.into(),
        })
    }
}

/// Providerfehler als explizites Runtimekommando.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderFailure {
    /// Welt.
    pub world_id: u64,
    /// Provider-Set.
    pub provider_set_id: String,
    /// Fehlerzeitpunkt.
    pub failed_at: SimTime,
    /// Fehlergrund.
    pub reason: String,
}

/// Auditierbare betriebliche Entscheidung infolge einer Störung.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecisionRecord {
    /// Welt.
    pub world_id: u64,
    /// Stabile Entscheidungskennung.
    pub decision_id: String,
    /// Betroffenes EVU.
    pub operator_id: u64,
    /// Betroffene Fahrt oder betriebliche Bewegung.
    pub movement_id: String,
    /// Ereigniszeit.
    pub at: SimTime,
    /// Konkrete Maßnahme.
    pub action: String,
    /// Hauptkennung der Ursache.
    pub cause_code: u8,
    /// Betroffene Konfliktressource.
    pub affected_resource: String,
    /// Ergebnis und Ablehnungsbegründung.
    pub explanation: String,
}

/// Append-only Runtimekommando.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeCommand {
    /// Veröffentlicht eine Baustelle.
    PublishConstruction(ConstructionNotice),
    /// Protokolliert einen Providerausfall.
    RecordProviderFailure(ProviderFailure),
    /// Protokolliert eine Frühfahrt, Warte-, Ersatz- oder Wiederanlaufentscheidung.
    RecordDecision(DecisionRecord),
}

/// Append-only M8-Ereignis mit `world_id` und Sequenz.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeEvent {
    /// Welt.
    pub world_id: u64,
    /// Lückenlose Sequenz.
    pub sequence: u64,
    /// Expliziter Ereigniszeitpunkt.
    pub at: SimTime,
    /// Versionierter Typ.
    pub event_type: String,
    /// Fachliche Kennung.
    pub subject_id: String,
    /// Erklärung.
    pub explanation: String,
    /// Optionales EVU der Entscheidung.
    pub operator_id: Option<u64>,
    /// Optionaler Verspätungsursachencode.
    pub cause_code: Option<u8>,
    /// Optional betroffene Konfliktressource.
    pub affected_resource: Option<String>,
}

/// Revisionsfähiger M8-Zustand für Replay und Resume.
#[derive(Clone, Debug)]
pub struct DisruptionRuntime {
    policy: DisruptionPolicy,
    schedule_boundary: SimTime,
    pending_policy: Option<DisruptionPolicy>,
    events: Vec<RuntimeEvent>,
}

impl DisruptionRuntime {
    /// Baut den weltgebundenen Zustand.
    pub fn new(
        policy: DisruptionPolicy,
        schedule_boundary: SimTime,
    ) -> Result<Self, DisruptionError> {
        if schedule_boundary <= policy.valid_from {
            return Err(DisruptionError::InvalidScheduleBoundary);
        }
        Ok(Self {
            policy,
            schedule_boundary,
            pending_policy: None,
            events: Vec::new(),
        })
    }

    /// Aktive Policy.
    #[must_use]
    pub const fn policy(&self) -> &DisruptionPolicy {
        &self.policy
    }

    /// Plant eine auditierte Änderung exakt zum Stichtag.
    pub fn schedule_policy_change(
        &mut self,
        change: PolicyChange,
    ) -> Result<PolicyAudit, DisruptionError> {
        if change.world_id != self.policy.world_id {
            return Err(DisruptionError::WrongWorld);
        }
        if change.effective_at != self.schedule_boundary
            || change.requested_at >= change.effective_at
        {
            return Err(DisruptionError::InvalidScheduleBoundary);
        }
        if change.requested_by.trim().is_empty() || change.reason.trim().len() < 8 {
            return Err(DisruptionError::InvalidAudit);
        }
        let next_version = self.policy.version.saturating_add(1);
        let next = DisruptionPolicy::new(
            self.policy.world_id,
            next_version,
            change.planned_works_mode,
            change.operational_incident_mode,
            change.provider_set_id,
            change.simulation_profile,
            change.ruleset_version,
            change.effective_at,
            None,
        )?;
        self.pending_policy = Some(next);
        Ok(PolicyAudit {
            world_id: self.policy.world_id,
            previous_version: self.policy.version,
            next_version,
            actor_id: change.requested_by,
            reason: change.reason,
            effective_at: change.effective_at,
        })
    }

    /// Aktiviert eine vorgemerkte Änderung nie vor dem Stichtag.
    pub fn advance_policy(&mut self, at: SimTime) -> Result<(), DisruptionError> {
        if at >= self.schedule_boundary {
            if let Some(next) = self.pending_policy.take() {
                self.policy = next;
            }
        }
        Ok(())
    }

    /// Autorisiert und validiert einen manuellen Eingriff.
    pub fn create_manual(
        scope: &WorldScope,
        command: &ManualDisruptionCommand,
    ) -> Result<ManualCreation, DisruptionError> {
        if scope.world_id != command.world_id {
            return Err(DisruptionError::WrongWorld);
        }
        if scope.role != ActorRole::WorldAdmin {
            return Err(DisruptionError::Unauthorized);
        }
        if scope.actor_id.trim().is_empty()
            || command.command_id.trim().is_empty()
            || command.cause.trim().len() < 8
            || command.fine_cause_id.trim().is_empty()
            || command.starts_at >= command.ends_at
            || command.affected_resources.is_empty()
        {
            return Err(DisruptionError::InvalidManualCommand);
        }
        let cause = delay_cause_code(command.cause_code)
            .filter(|entry| {
                matches!(
                    entry.cause_type,
                    CauseType::Primary | CauseType::DangerousEvent
                )
            })
            .ok_or(DisruptionError::InvalidCauseCode)?;
        let fine_cause = fine_cause_code(&command.fine_cause_id, cause.code)
            .ok_or(DisruptionError::InvalidFineCauseCode)?;
        command.effect.validate(&command.affected_resources)?;
        Ok(ManualCreation {
            disruption: GeneratedDisruption {
                world_id: command.world_id,
                id: command.command_id.clone(),
                kind: DisruptionKind::OperationalIncident,
                starts_at: command.starts_at,
                ends_at: command.ends_at,
                published_at: command.starts_at,
                severity_basis_points: 10_000,
                resources: command.affected_resources.clone(),
                effect: command.effect.clone(),
                scope: RestrictionScope::all(),
                cause_code: cause.code,
                fine_cause_id: fine_cause.id.into(),
                source: GeneratedSource {
                    kind: GeneratedSourceKind::Manual,
                    substream: "manual".into(),
                    infra_release: "server-pinned".into(),
                    simulation_profile: "manual".into(),
                    ruleset_version: "disruption-rules/v1".into(),
                    calibration_version: "manual".into(),
                },
            },
            audit: ManualAudit {
                world_id: command.world_id,
                actor_id: scope.actor_id.clone(),
                command_id: command.command_id.clone(),
                cause: command.cause.clone(),
                cause_code: cause.code,
                fine_cause_id: fine_cause.id.into(),
            },
        })
    }

    /// Wendet ein Kommando append-only an.
    pub fn apply(&mut self, command: &RuntimeCommand) -> Result<(), DisruptionError> {
        let (
            world_id,
            at,
            event_type,
            subject_id,
            explanation,
            operator_id,
            cause_code,
            affected_resource,
        ) = match command {
            RuntimeCommand::PublishConstruction(notice) => (
                notice.world_id,
                notice.published_at,
                "disruption.construction-published/v1",
                notice.id.clone(),
                format!(
                    "Baustelle mit {} Sekunden Vorlauf und Restkapazität {}",
                    notice.lead_time_seconds(),
                    notice.remaining_capacity
                ),
                None,
                None,
                None,
            ),
            RuntimeCommand::RecordProviderFailure(failure) => (
                failure.world_id,
                failure.failed_at,
                "disruption.provider-failed/v1",
                failure.provider_set_id.clone(),
                format!(
                    "Provider ausgefallen; letzter sicherer Stand bleibt sichtbar: {}",
                    failure.reason
                ),
                None,
                None,
                None,
            ),
            RuntimeCommand::RecordDecision(decision) => (
                decision.world_id,
                decision.at,
                "disruption.decision/v1",
                decision.decision_id.clone(),
                format!(
                    "{} für Bewegung {}: {}",
                    decision.action, decision.movement_id, decision.explanation
                ),
                Some(decision.operator_id),
                Some(decision.cause_code),
                Some(decision.affected_resource.clone()),
            ),
        };
        if world_id != self.policy.world_id {
            return Err(DisruptionError::WrongWorld);
        }
        let sequence = u64::try_from(self.events.len())
            .map_err(|_| DisruptionError::Overflow)?
            .saturating_add(1);
        self.events.push(RuntimeEvent {
            world_id,
            sequence,
            at,
            event_type: event_type.into(),
            subject_id,
            explanation,
            operator_id,
            cause_code,
            affected_resource,
        });
        Ok(())
    }

    /// Replay desselben Kommandologs.
    pub fn replay(
        policy: DisruptionPolicy,
        schedule_boundary: SimTime,
        commands: &[RuntimeCommand],
    ) -> Result<Self, DisruptionError> {
        let mut runtime = Self::new(policy, schedule_boundary)?;
        for command in commands {
            runtime.apply(command)?;
        }
        Ok(runtime)
    }

    /// Resume ab exklusiver Sequenz.
    #[must_use]
    pub fn events_after(&self, sequence: u64) -> Vec<RuntimeEvent> {
        let first = self
            .events
            .partition_point(|event| event.sequence <= sequence);
        self.events[first..].to_vec()
    }

    /// Kanonischer Zustands-Hash für Restart und Replay.
    #[must_use]
    pub fn state_hash(&self) -> StateHash {
        let mut hasher = StateHasher::new("disruption-runtime/v1");
        hasher.uint("world_id", self.policy.world_id);
        hasher.uint("policy_version", u64::from(self.policy.version));
        hasher.text("ruleset_version", &self.policy.ruleset_version);
        hasher.text("simulation_profile", &self.policy.simulation_profile.id);
        hasher.seq("events", self.events.len());
        for event in &self.events {
            hasher.uint("sequence", event.sequence);
            hasher.int("at", event.at.seconds());
            hasher.text("event_type", &event.event_type);
            hasher.text("subject_id", &event.subject_id);
            hasher.text("explanation", &event.explanation);
            hasher.uint("operator_id", event.operator_id.unwrap_or_default());
            hasher.uint(
                "cause_code",
                u64::from(event.cause_code.unwrap_or_default()),
            );
            hasher.text(
                "affected_resource",
                event.affected_resource.as_deref().unwrap_or(""),
            );
        }
        hasher.finish()
    }
}

/// Fehler des M8-Kernvertrags.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum DisruptionError {
    /// Ungültige Policy.
    InvalidPolicy,
    /// Ungültiges Simulationsprofil.
    InvalidProfile,
    /// Realistic benötigt ein Provider-Set.
    ProviderRequired,
    /// Falscher Modus für den Aufruf.
    WrongMode,
    /// Ungültiges Generatorfenster.
    InvalidGenerationWindow,
    /// Pflichtressource fehlt.
    MissingResource,
    /// Ungültige Auswirkung.
    InvalidEffect,
    /// Falsche Welt.
    WrongWorld,
    /// Nicht autorisiert.
    Unauthorized,
    /// Ungültiges manuelles Kommando.
    InvalidManualCommand,
    /// Unbekannte oder für die Aktion ungeeignete Ursachenkennung.
    InvalidCauseCode,
    /// Unbekannte oder nicht zur Hauptkennung passende Feinkodierung.
    InvalidFineCauseCode,
    /// Ungültige Baustellenankündigung.
    InvalidConstructionNotice,
    /// Ungültiger Fahrplanstichtag.
    InvalidScheduleBoundary,
    /// Ungültige Auditfelder.
    InvalidAudit,
    /// Ungültige Bewegung.
    InvalidMovement,
    /// Ungültiger Ersatzantrag.
    InvalidReplacementRequest,
    /// Ungültiger Provider.
    InvalidProvider,
    /// Provider unbekannt.
    UnknownProvider,
    /// Rechtefreigabe fehlt.
    RightsNotApproved,
    /// Ganzzahlige Grenze überschritten.
    Overflow,
}

impl fmt::Display for DisruptionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidPolicy => "DisruptionPolicy ist ungültig",
            Self::InvalidProfile => "Simulationsprofil ist ungültig",
            Self::ProviderRequired => "REALISTIC benötigt ein benanntes Provider-Set",
            Self::WrongMode => "Aufruf ist im aktiven Störungsmodus nicht zulässig",
            Self::InvalidGenerationWindow => "Generatorfenster ist ungültig",
            Self::MissingResource => "mindestens eine Konfliktressource ist Pflicht",
            Self::InvalidEffect => "Störungswirkung ist ungültig",
            Self::WrongWorld => "world_id stimmt nicht mit dem Weltkontext überein",
            Self::Unauthorized => "Akteur ist für den manuellen Modus nicht autorisiert",
            Self::InvalidManualCommand => "manuelles Störungskommando hat fehlende Pflichtfelder",
            Self::InvalidCauseCode => "Verspätungsursachencode ist unbekannt oder ungeeignet",
            Self::InvalidFineCauseCode => {
                "Feinkodierung ist unbekannt oder passt nicht zur Hauptkennung"
            }
            Self::InvalidConstructionNotice => "Baustellenankündigung ist ungültig",
            Self::InvalidScheduleBoundary => {
                "Policywechsel liegt nicht am veröffentlichten Fahrplanstichtag"
            }
            Self::InvalidAudit => "Auditakteur oder Begründung ist ungültig",
            Self::InvalidMovement => "betriebliche Bewegung oder Abfahrtsfenster ist ungültig",
            Self::InvalidReplacementRequest => "Ersatzantrag ist ungültig",
            Self::InvalidProvider => "Providerregistereintrag ist ungültig",
            Self::UnknownProvider => "Provider ist unbekannt",
            Self::RightsNotApproved => {
                "kommerzielle Nutzung und Replay-Speicherung sind nicht freigegeben"
            }
            Self::Overflow => "ganzzahliger Zustandswert überschreitet die unterstützte Grenze",
        })
    }
}

impl core::error::Error for DisruptionError {}
