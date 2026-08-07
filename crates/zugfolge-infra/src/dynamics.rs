//! Fahrdynamik und Fahrzeitrechner — **M1.10**.
//!
//! `docs/monorepo.md` 3 sagt es ausdrücklich: **`infra-pipeline` ist die
//! einzige Domäne ohne `no-floats`** — genau, weil dieses eine Modul einmalig
//! mit Gleitkomma rechnet und dabei ganzzahlige Fahrzeittabellen ausgibt.
//! Alles, was hinein- und herausgeht — [`Length`], [`Speed`], [`Gradient`],
//! [`Acceleration`] — bleibt ganzzahlig (Invariante 3); nur die Physik dazwischen
//! rechnet in `f64`.
//!
//! ## Das Verfahren
//!
//! Ein [`RunPath`] ist ein Fahrweg als lückenlose Folge von [`RunSegment`]s —
//! Länge, zulässige Geschwindigkeit (schon das Minimum aus Zug- und
//! Streckengeschwindigkeit, [`TrainCharacteristics::effective_speed_limit`])
//! und Neigung in Fahrtrichtung. [`RunPath::push_track_range`] baut ihn aus
//! einem [`Track`], geschnitten an jeder Bandgrenze von Vmax- oder
//! Neigungsprofil, und prüft dabei die Zugsicherungs- und
//! Antriebskompatibilität — ein Fahrweg, den der Zug gar nicht befahren dürfte,
//! bekommt gar keine Fahrzeit.
//!
//! [`derive_running_time_table`] rechnet darüber die **maximal mögliche
//! Geschwindigkeit an jeder Segmentgrenze** in zwei Durchgängen — rückwärts die
//! Bremskurve vor jeder Beschränkung, vorwärts das tatsächlich Erreichbare aus
//! Einstiegsgeschwindigkeit und Anfahrvermögen — und integriert daraus je
//! Segment ein Trapez- oder Dreiecksgeschwindigkeitsprofil (Beschleunigung,
//! Beharrung, Bremsung) zu einer Zeit. Die Neigung wirkt dabei auf beide
//! Vermögen: Steigung mindert das Anfahr-, Gefälle mindert das Bremsvermögen —
//! `sin θ ≈ Gefälle ‰ / 1000`, die im Bahnbau übliche Kleinwinkelnäherung.
//! Reicht ein Vermögen unter der Neigung nicht mehr aus, meldet das Verfahren
//! [`InfraError::InsufficientTraction`] oder [`InfraError::InsufficientBraking`]
//! statt eine unmögliche Fahrt zu berechnen.
//!
//! ## Was hier bewusst nicht steht
//!
//! **Masse geht nicht in die Rechnung ein.** Anfahr- und Bremsvermögen
//! ([`TrainCharacteristics`], M1.9) sind bereits Beschleunigungswerte, in denen
//! sie aufgeht — ein Fahrwiderstandsmodell (Laufwiderstand, Luftwiderstand)
//! bräuchte weitere Kennwerte, die keine der genannten Quellen für die
//! Zugcharakteristik verlangt. **Kein Halt, keine Räum- oder
//! Fahrstraßenbildezeit.** `docs/infrastruktur.md` 1 zählt sechs Anteile der
//! Sperrzeit auf; dieses Modul liefert genau einen — die Fahrzeit. Die anderen
//! fünf gehören zum Sperrzeitenmodell (M3.1). Und **kein Fahrweg durch den
//! Graphen** — welche Gleise ein Zug in welcher Reihenfolge befährt, entscheidet
//! der Planner (M3.4); dieses Modul rechnet nur die Zeit über einen bereits
//! gegebenen Fahrweg.

#![allow(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "M1.10: die Fahrdynamik ist der in docs/monorepo.md 3 vorgesehene, \
              einzige Ort mit Gleitkommarechnung in diesem Crate — sie liest und \
              schreibt ausschließlich die ganzzahligen Einheiten aus units.rs"
)]

use core::fmt;
use std::collections::BTreeSet;

use crate::edge::TravelDirection;
use crate::error::InfraError;
use crate::track::Track;
use crate::train::TrainCharacteristics;
use crate::units::{Gradient, Length, Speed};

/// Erdbeschleunigung in m/s² — Grundlage der Neigungswirkung auf Anfahr- und
/// Bremsvermögen.
const GRAVITY_MPS2: f64 = 9.806_65;

/// Ein Abschnitt konstanter Geschwindigkeitsbeschränkung und Neigung entlang
/// eines Fahrwegs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunSegment {
    length: Length,
    speed_limit: Speed,
    gradient: Gradient,
}

impl RunSegment {
    /// Ein Segment mit Länge, zulässiger Geschwindigkeit und Neigung in
    /// Fahrtrichtung.
    ///
    /// # Errors
    ///
    /// - [`InfraError::NonPositiveLength`], wenn die Länge nicht positiv ist.
    /// - [`InfraError::NonPositiveSpeed`], wenn die Geschwindigkeit nicht
    ///   positiv ist.
    pub fn new(length: Length, speed_limit: Speed, gradient: Gradient) -> Result<Self, InfraError> {
        if !length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Fahrwegsegment",
                value: length,
            });
        }
        if !speed_limit.is_positive() {
            return Err(InfraError::NonPositiveSpeed {
                what: "Segment-Vmax",
                value: speed_limit,
            });
        }
        Ok(Self {
            length,
            speed_limit,
            gradient,
        })
    }

    /// Die Länge des Segments.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die zulässige Geschwindigkeit — bereits das Minimum aus Zug- und
    /// Streckengeschwindigkeit.
    pub const fn speed_limit(&self) -> Speed {
        self.speed_limit
    }

    /// Die Neigung in Fahrtrichtung.
    pub const fn gradient(&self) -> Gradient {
        self.gradient
    }
}

/// Ein Fahrweg als lückenlose Folge von [`RunSegment`]s.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunPath {
    segments: Vec<RunSegment>,
}

impl RunPath {
    /// Ein leerer Fahrweg.
    pub fn new() -> Self {
        Self::default()
    }

    /// Die Segmente in Fahrtrichtung.
    pub fn segments(&self) -> &[RunSegment] {
        &self.segments
    }

    /// Die Gesamtlänge.
    pub fn length(&self) -> Length {
        self.segments
            .iter()
            .fold(Length::ZERO, |summe, segment| summe + segment.length())
    }

    /// Ob der Fahrweg kein einziges Segment hat.
    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// Hängt ein einzelnes, bereits fertiges Segment an.
    ///
    /// Für den Regelfall — den befahrenen Bereich eines Gleises —
    /// [`RunPath::push_track_range`] verwenden; diese Methode ist für
    /// synthetische oder aus mehreren Quellen zusammengesetzte Fahrwege da.
    pub fn push_segment(&mut self, segment: RunSegment) {
        self.segments.push(segment);
    }

    /// Hängt den befahrenen Bereich eines Gleises an — geschnitten an jeder
    /// Bandgrenze von Vmax- oder Neigungsprofil, damit jedes Segment konstante
    /// Werte trägt.
    ///
    /// `start` und `end` sind Positionen entlang der Kilometrierung des
    /// Gleises, `start` kleiner als `end`, unabhängig von der Fahrtrichtung.
    /// Bei [`TravelDirection::AgainstChainage`] entstehen die Segmente in
    /// absteigender Kilometrierung — der tatsächlichen Fahrtrichtung.
    ///
    /// # Errors
    ///
    /// - [`InfraError::InvalidRunRange`], wenn `start` negativ ist, `end` das
    ///   Gleis überragt oder `start` nicht kleiner als `end` ist.
    /// - [`InfraError::TrackProfileGap`], wenn ein Bandprofil eine Position
    ///   innerhalb des Bereichs nicht abdeckt — bei einem gültig gebauten
    ///   [`Track`] ausgeschlossen.
    /// - [`InfraError::TrainProtectionIncompatible`], wenn die streckenseitige
    ///   Zugsicherung an einer Stelle kein System mit dem Zug teilt.
    /// - [`InfraError::TrainTractionIncompatible`], wenn die Antriebsart des
    ///   Zuges an einer Stelle nicht zur Elektrifizierung passt.
    pub fn push_track_range(
        &mut self,
        train: &TrainCharacteristics,
        track: &Track,
        direction: TravelDirection,
        start: Length,
        end: Length,
    ) -> Result<(), InfraError> {
        if start.is_negative() || end > track.length() || start >= end {
            return Err(InfraError::InvalidRunRange {
                track: track.id(),
                start,
                end,
            });
        }

        let mut boundaries: BTreeSet<Length> = BTreeSet::new();
        boundaries.insert(start);
        boundaries.insert(end);
        for band in track.speed().bands() {
            if band.start() > start && band.start() < end {
                boundaries.insert(band.start());
            }
        }
        for band in track.gradient().bands() {
            if band.start() > start && band.start() < end {
                boundaries.insert(band.start());
            }
        }

        let points: Vec<Length> = boundaries.into_iter().collect();
        let mut segments = Vec::with_capacity(points.len().saturating_sub(1));
        for fenster in points.windows(2) {
            let [lo, hi] = fenster else { continue };
            let (lo, hi) = (*lo, *hi);
            segments.push(einzelnes_segment(train, track, direction, lo, hi)?);
        }

        if matches!(direction, TravelDirection::AgainstChainage) {
            segments.reverse();
        }

        self.segments.extend(segments);
        Ok(())
    }
}

/// Baut ein einzelnes Segment aus einer Position, an der Vmax-, Neigungs-,
/// Elektrifizierungs- und Zugsicherungsband des Gleises konstant sind.
fn einzelnes_segment(
    train: &TrainCharacteristics,
    track: &Track,
    direction: TravelDirection,
    lo: Length,
    hi: Length,
) -> Result<RunSegment, InfraError> {
    fn luecke(track: &Track, position: Length) -> InfraError {
        InfraError::TrackProfileGap {
            track: track.id(),
            position,
        }
    }

    let vmax_infra = *track.speed_at(lo).ok_or_else(|| luecke(track, lo))?;
    let protection_infra = track.protection_at(lo).ok_or_else(|| luecke(track, lo))?;
    let electrification_infra = track
        .electrification_at(lo)
        .ok_or_else(|| luecke(track, lo))?;
    let gradient_infra = track
        .gradient_for(lo, direction)
        .ok_or_else(|| luecke(track, lo))?;

    if !train.is_compatible_with_protection(protection_infra) {
        return Err(InfraError::TrainProtectionIncompatible {
            track: track.id(),
            position: lo,
        });
    }
    if !train.is_compatible_with_electrification(electrification_infra) {
        return Err(InfraError::TrainTractionIncompatible {
            track: track.id(),
            position: lo,
        });
    }

    let speed_limit = train.effective_speed_limit(vmax_infra);
    RunSegment::new(hi - lo, speed_limit, gradient_infra)
}

/// Eine ganzzahlige Fahrzeit in Sekunden.
///
/// Sie ist **aufgerundet**: Wie die Umrechnung von km/h in Millimeter je
/// Sekunde (`units.rs`) darf eine vorberechnete Fahrzeittabelle nie eine
/// schnellere Fahrt versprechen, als physikalisch möglich ist.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RunningTime(i64);

impl RunningTime {
    /// Keine verstrichene Zeit — der Beginn eines Fahrwegs.
    pub const ZERO: Self = Self(0);

    /// Fahrzeit aus vollen Sekunden.
    pub const fn from_seconds(seconds: i64) -> Self {
        Self(seconds)
    }

    /// Die Fahrzeit in Sekunden.
    pub const fn seconds(self) -> i64 {
        self.0
    }
}

impl fmt::Display for RunningTime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} s", self.0)
    }
}

/// Ein Eintrag der Fahrzeittabelle: Position, kumulierte Fahrzeit und
/// erreichte Geschwindigkeit an einer Segmentgrenze.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunningTimeCheckpoint {
    position: Length,
    elapsed: RunningTime,
    speed: Speed,
}

impl RunningTimeCheckpoint {
    /// Die Position ab dem Anfang des Fahrwegs.
    pub const fn position(&self) -> Length {
        self.position
    }

    /// Die seit Fahrwegbeginn verstrichene Fahrzeit.
    pub const fn elapsed(&self) -> RunningTime {
        self.elapsed
    }

    /// Die an dieser Stelle erreichte Geschwindigkeit.
    pub const fn speed(&self) -> Speed {
        self.speed
    }
}

/// Eine vorberechnete, ganzzahlige Fahrzeittabelle für eine Zugcharakteristik
/// über einen Fahrweg — das Ergebnis von M1.10.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunningTimeTable {
    checkpoints: Vec<RunningTimeCheckpoint>,
}

impl RunningTimeTable {
    /// Die Einträge in Fahrtrichtung, beginnend mit dem Fahrwegbeginn bei
    /// Fahrzeit null.
    pub fn checkpoints(&self) -> &[RunningTimeCheckpoint] {
        &self.checkpoints
    }

    /// Die gesamte Fahrzeit über den Fahrweg.
    pub fn total(&self) -> RunningTime {
        self.checkpoints
            .last()
            .map_or(RunningTime::ZERO, |checkpoint| checkpoint.elapsed)
    }
}

/// Rechnet die Fahrzeittabelle einer Zugcharakteristik über einen Fahrweg.
///
/// `entry_speed` ist die Geschwindigkeit, mit der der Zug den Fahrweg
/// erreicht — für eine Abfahrt aus dem Stand [`Speed::ZERO`]. Das letzte
/// Segment erzwingt keinen Halt: Diese Funktion liefert die reine Fahrzeit
/// (`docs/infrastruktur.md` 1), keine Räum- oder Haltezeit.
///
/// # Errors
///
/// - [`InfraError::EmptyRunPath`], wenn der Fahrweg kein einziges Segment hat.
/// - [`InfraError::InsufficientTraction`], wenn eine Steigung das
///   Anfahrvermögen des Zuges übersteigt.
/// - [`InfraError::InsufficientBraking`], wenn ein Gefälle das Bremsvermögen
///   des Zuges übersteigt.
pub fn derive_running_time_table(
    path: &RunPath,
    train: &TrainCharacteristics,
    entry_speed: Speed,
) -> Result<RunningTimeTable, InfraError> {
    let segments = path.segments();
    if segments.is_empty() {
        return Err(InfraError::EmptyRunPath);
    }
    let n = segments.len();

    let accel_nominal = train.acceleration().millimetres_per_second_squared() as f64 / 1_000.0;
    let decel_nominal = train.deceleration().millimetres_per_second_squared() as f64 / 1_000.0;

    let mut limit = Vec::with_capacity(n);
    let mut length_m = Vec::with_capacity(n);
    let mut accel_eff = Vec::with_capacity(n);
    let mut decel_eff = Vec::with_capacity(n);
    let mut cumulative_position = Vec::with_capacity(n.saturating_add(1));
    cumulative_position.push(Length::ZERO);

    let mut laufende_position = Length::ZERO;
    for segment in segments {
        laufende_position = laufende_position + segment.length();
        cumulative_position.push(laufende_position);

        limit.push(segment.speed_limit().millimetres_per_second() as f64 / 1_000.0);
        length_m.push(segment.length().millimetres() as f64 / 1_000.0);

        // Kleinwinkelnäherung sin θ ≈ Gefälle ‰ / 1000, im Bahnbau üblich.
        let sin_theta = f64::from(segment.gradient().per_mille_tenths()) / 10_000.0;
        let a = accel_nominal - GRAVITY_MPS2 * sin_theta;
        let d = decel_nominal + GRAVITY_MPS2 * sin_theta;
        if a <= 0.0 {
            return Err(InfraError::InsufficientTraction {
                position: laufende_position,
            });
        }
        if d <= 0.0 {
            return Err(InfraError::InsufficientBraking {
                position: laufende_position,
            });
        }
        accel_eff.push(a);
        decel_eff.push(d);
    }

    // Rückwärtspass: die höchste an jeder Segmentgrenze zulässige
    // Geschwindigkeit, damit jede nachfolgende Beschränkung noch rechtzeitig
    // erreicht werden kann.
    let mut v_brake = vec![0.0_f64; n.saturating_add(1)];
    v_brake[n] = limit[n - 1];
    for i in (0..n).rev() {
        let erreichbar = v_brake[i.saturating_add(1)].powi(2) + 2.0 * decel_eff[i] * length_m[i];
        v_brake[i] = limit[i].min(erreichbar.sqrt());
    }

    // Vorwärtspass: die tatsächlich erreichte Geschwindigkeit, begrenzt durch
    // Einstiegsgeschwindigkeit, Anfahrvermögen und die Bremskurve.
    let entry = entry_speed.millimetres_per_second() as f64 / 1_000.0;
    let mut v = vec![0.0_f64; n.saturating_add(1)];
    v[0] = entry.min(limit[0]).min(v_brake[0]);
    for i in 0..n {
        let erreichbar = v[i].powi(2) + 2.0 * accel_eff[i] * length_m[i];
        v[i.saturating_add(1)] = erreichbar
            .sqrt()
            .min(v_brake[i.saturating_add(1)])
            .min(limit[i]);
    }

    let mut checkpoints = Vec::with_capacity(n.saturating_add(1));
    checkpoints.push(RunningTimeCheckpoint {
        position: cumulative_position[0],
        elapsed: RunningTime::ZERO,
        speed: geschwindigkeit_aus(v[0]),
    });

    let mut elapsed_s = 0.0_f64;
    for i in 0..n {
        elapsed_s += segmentzeit(
            v[i],
            v[i.saturating_add(1)],
            limit[i],
            accel_eff[i],
            decel_eff[i],
            length_m[i],
        )
        .max(0.0);
        checkpoints.push(RunningTimeCheckpoint {
            position: cumulative_position[i.saturating_add(1)],
            elapsed: RunningTime::from_seconds(elapsed_s.ceil() as i64),
            speed: geschwindigkeit_aus(v[i.saturating_add(1)]),
        });
    }

    Ok(RunningTimeTable { checkpoints })
}

/// Die Fahrzeit über ein einzelnes Segment aus einem Trapez- oder
/// Dreiecksgeschwindigkeitsprofil: Beschleunigung von `v_in`, Beharrung bei
/// `c` (falls erreichbar), Bremsung auf `v_out`.
fn segmentzeit(v_in: f64, v_out: f64, c: f64, a: f64, d: f64, length: f64) -> f64 {
    let beschleunigungsweg_bis_c = (c.powi(2) - v_in.powi(2)) / (2.0 * a);
    let bremsweg_bis_c = (c.powi(2) - v_out.powi(2)) / (2.0 * d);

    if beschleunigungsweg_bis_c + bremsweg_bis_c <= length {
        let beharrungsweg = (length - beschleunigungsweg_bis_c - bremsweg_bis_c).max(0.0);
        let beharrungszeit = if c > 0.0 { beharrungsweg / c } else { 0.0 };
        (c - v_in) / a + beharrungszeit + (c - v_out) / d
    } else {
        // Dreiecksprofil: die Spitzengeschwindigkeit bleibt unter `c`, geschlossen
        // lösbar aus der Bedingung, dass Beschleunigungs- und Bremsweg zusammen
        // genau die Segmentlänge ergeben.
        let nenner = 1.0 / (2.0 * a) + 1.0 / (2.0 * d);
        let zaehler = length + v_in.powi(2) / (2.0 * a) + v_out.powi(2) / (2.0 * d);
        let spitze = (zaehler / nenner)
            .max(v_in.powi(2))
            .max(v_out.powi(2))
            .sqrt();
        (spitze - v_in) / a + (spitze - v_out) / d
    }
}

/// Rundet eine Geschwindigkeit in m/s auf die nächste ganzzahlige
/// Geschwindigkeit in Millimetern je Sekunde.
fn geschwindigkeit_aus(metres_per_second: f64) -> Speed {
    Speed::from_millimetres_per_second((metres_per_second * 1_000.0).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::{RunPath, RunSegment, RunningTime, derive_running_time_table};
    use crate::bands::BandProfile;
    use crate::edge::TravelDirection;
    use crate::electrification::{Electrification, PowerSystem};
    use crate::error::InfraError;
    use crate::example::reference_network;
    use crate::identity::{TrackEdgeId, TrackId, TrainCharacteristicsId};
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::speed::{SpeedCategory, SpeedLimit};
    use crate::track::{Track, TrackKind, TrackOwner};
    use crate::train::{ElectricSystems, TractionType, TrainCharacteristics};
    use crate::units::{Acceleration, Gradient, Length, Mass, Speed};

    fn quelle() -> SourceId {
        SourceId::new("beispielnetz").expect("gültige Quellenkennung")
    }

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(quelle(), confidence)
    }

    fn regionaltriebwagen(
        acceleration_mm_s2: i64,
        deceleration_mm_s2: i64,
    ) -> TrainCharacteristics {
        TrainCharacteristics::new(
            TrainCharacteristicsId::new(1),
            "Testzug",
            Mass::from_tonnes(120),
            Length::from_metres(80),
            Speed::from_km_h(160),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(acceleration_mm_s2),
            Acceleration::from_millimetres_per_second_squared(deceleration_mm_s2),
            TractionType::Diesel,
            TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
        )
        .expect("gültige Zugcharakteristik")
    }

    /// Ein Gleis mit einer einzigen, wählbaren Neigung.
    fn gleis_mit_neigung(length: Length, gradient: Gradient) -> Track {
        Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Streckengleis",
            length,
        )
        .kind(TrackKind::ThroughMainTrack)
        .speed(
            BandProfile::uniform(
                "vmax",
                length,
                SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::uniform("neigung", length, gradient, herkunft(Confidence::Derived))
                .expect("Profil deckt das Gleis"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                length,
                Electrification::Unelectrified,
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(
            BandProfile::uniform(
                "zugsicherung",
                length,
                TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis")
    }

    #[test]
    fn zwei_segmente_ergeben_ein_handgerechnetes_profil() {
        // 1 m/s² Anfahr- und Bremsvermögen, zwei ebene Segmente mit 10 m/s und
        // 5 m/s Vmax — von Hand nachgerechnet (siehe Kommentare unten).
        let zug = regionaltriebwagen(1_000, 1_000);
        let mut fahrweg = RunPath::new();
        fahrweg.push_segment(
            RunSegment::new(
                Length::from_metres(1_000),
                Speed::from_km_h(36),
                Gradient::LEVEL,
            )
            .expect("gültig"),
        );
        fahrweg.push_segment(
            RunSegment::new(
                Length::from_metres(500),
                Speed::from_km_h(18),
                Gradient::LEVEL,
            )
            .expect("gültig"),
        );

        let tabelle =
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO).expect("gültige Fahrzeit");
        let checkpoints = tabelle.checkpoints();
        assert_eq!(checkpoints.len(), 3);
        assert_eq!(checkpoints[0].elapsed(), RunningTime::ZERO);
        // Segment A: 0 → 5 m/s Ausstieg, Spitze bei 10 m/s, 1000 m → 106,25 s,
        // aufgerundet 107 s.
        assert_eq!(checkpoints[1].elapsed(), RunningTime::from_seconds(107));
        // Segment B: konstant bei 5 m/s über 500 m → 100 s, kumuliert 206,25 s,
        // aufgerundet 207 s.
        assert_eq!(checkpoints[2].elapsed(), RunningTime::from_seconds(207));
        assert_eq!(tabelle.total(), RunningTime::from_seconds(207));
        assert_eq!(checkpoints[2].speed(), Speed::from_km_h(18));
    }

    #[test]
    fn die_fahrzeit_ist_wiederholbar() {
        let zug = regionaltriebwagen(800, 900);
        let mut fahrweg = RunPath::new();
        fahrweg.push_segment(
            RunSegment::new(
                Length::from_metres(2_000),
                Speed::from_km_h(120),
                Gradient::from_per_mille(5),
            )
            .expect("gültig"),
        );

        let erste =
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO).expect("gültige Fahrzeit");
        let zweite =
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO).expect("gültige Fahrzeit");
        assert_eq!(erste, zweite);
    }

    #[test]
    fn steigung_verlaengert_und_gefaelle_verkuerzt_die_fahrzeit() {
        let zug = regionaltriebwagen(800, 900);
        let laenge = Length::from_metres(3_000);

        let eben = {
            let mut fahrweg = RunPath::new();
            fahrweg.push_segment(
                RunSegment::new(laenge, Speed::from_km_h(120), Gradient::LEVEL).expect("gültig"),
            );
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
                .expect("gültig")
                .total()
        };
        let bergauf = {
            let mut fahrweg = RunPath::new();
            fahrweg.push_segment(
                RunSegment::new(laenge, Speed::from_km_h(120), Gradient::from_per_mille(15))
                    .expect("gültig"),
            );
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
                .expect("gültig")
                .total()
        };
        let bergab = {
            let mut fahrweg = RunPath::new();
            fahrweg.push_segment(
                RunSegment::new(laenge, Speed::from_km_h(120), Gradient::from_per_mille(-15))
                    .expect("gültig"),
            );
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
                .expect("gültig")
                .total()
        };

        assert!(bergauf.seconds() > eben.seconds(), "{bergauf} > {eben}");
        assert!(bergab.seconds() < eben.seconds(), "{bergab} < {eben}");
    }

    #[test]
    fn eine_zu_steile_steigung_uebersteigt_das_anfahrvermoegen() {
        // 0,5 m/s² Anfahrvermögen gegen 200 ‰ Steigung: g·sin θ ≈ 1,96 m/s² —
        // weit über dem, was der Zug leisten kann.
        let zug = regionaltriebwagen(500, 900);
        let gleis = gleis_mit_neigung(Length::from_metres(1_000), Gradient::from_per_mille(200));
        let mut fahrweg = RunPath::new();
        fahrweg
            .push_track_range(
                &zug,
                &gleis,
                TravelDirection::WithChainage,
                Length::ZERO,
                gleis.length(),
            )
            .expect("das Segment selbst ist gültig");

        let fehler = derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
            .expect_err("die Steigung übersteigt das Anfahrvermögen");
        assert!(matches!(fehler, InfraError::InsufficientTraction { .. }));
    }

    #[test]
    fn ein_zu_starkes_gefaelle_uebersteigt_das_bremsvermoegen() {
        let zug = regionaltriebwagen(900, 500);
        let gleis = gleis_mit_neigung(Length::from_metres(1_000), Gradient::from_per_mille(-200));
        let mut fahrweg = RunPath::new();
        fahrweg
            .push_track_range(
                &zug,
                &gleis,
                TravelDirection::WithChainage,
                Length::ZERO,
                gleis.length(),
            )
            .expect("das Segment selbst ist gültig");

        let fehler = derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
            .expect_err("das Gefälle übersteigt das Bremsvermögen");
        assert!(matches!(fehler, InfraError::InsufficientBraking { .. }));
    }

    #[test]
    fn ein_leerer_fahrweg_hat_keine_fahrzeit() {
        let zug = regionaltriebwagen(800, 900);
        let fahrweg = RunPath::new();
        let fehler = derive_running_time_table(&fahrweg, &zug, Speed::ZERO)
            .expect_err("ein Fahrweg ohne Segmente hat keine Fahrzeit");
        assert!(matches!(fehler, InfraError::EmptyRunPath));
    }

    #[test]
    fn der_fahrweg_aus_dem_beispielnetz_schneidet_an_bandgrenzen() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        // Der Ast hat ein dreibändiges Neigungsprofil (M1.1, Abschnitt 6) und
        // nur PZB — ein Dieselzug mit PZB darf ihn befahren.
        let zug = regionaltriebwagen(700, 800);

        let mut fahrweg = RunPath::new();
        fahrweg
            .push_track_range(
                &zug,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect("Diesel mit PZB passt zum Ast");

        // Drei Neigungsbänder im Gleis ergeben mindestens drei Segmente.
        assert!(
            fahrweg.segments().len() >= 3,
            "{}",
            fahrweg.segments().len()
        );
        assert_eq!(fahrweg.length(), ast.length());

        let tabelle =
            derive_running_time_table(&fahrweg, &zug, Speed::ZERO).expect("gültige Fahrzeit");
        // Monoton steigende Position und Fahrzeit über die ganze Tabelle.
        for fenster in tabelle.checkpoints().windows(2) {
            let [voriger, naechster] = fenster else {
                continue;
            };
            assert!(naechster.position() > voriger.position());
            assert!(naechster.elapsed().seconds() >= voriger.elapsed().seconds());
        }
    }

    #[test]
    fn gegen_die_kilometrierung_kehrt_sich_die_reihenfolge_um() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        let zug = regionaltriebwagen(700, 800);

        let mut vorwaerts = RunPath::new();
        vorwaerts
            .push_track_range(
                &zug,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect("gültig");
        let mut rueckwaerts = RunPath::new();
        rueckwaerts
            .push_track_range(
                &zug,
                ast,
                TravelDirection::AgainstChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect("gültig");

        let vorwaerts_gradienten: Vec<_> = vorwaerts
            .segments()
            .iter()
            .map(RunSegment::gradient)
            .collect();
        let mut rueckwaerts_gradienten: Vec<_> = rueckwaerts
            .segments()
            .iter()
            .map(RunSegment::gradient)
            .collect();
        rueckwaerts_gradienten.reverse();

        // Dieselben Abschnitte in umgekehrter Reihenfolge, aber mit
        // umgekehrtem Vorzeichen — wer bergauf gefahren ist, fährt zurück
        // bergab (dieselbe Regel wie in `track.rs`).
        for (hin, zurueck) in vorwaerts_gradienten
            .iter()
            .zip(rueckwaerts_gradienten.iter())
        {
            assert_eq!(*hin, zurueck.reversed());
        }
    }

    #[test]
    fn eine_unpassende_zugsicherung_faellt_auf() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        let nur_etcs = TrainCharacteristics::new(
            TrainCharacteristicsId::new(2),
            "ETCS-Zug",
            Mass::from_tonnes(80),
            Length::from_metres(60),
            Speed::from_km_h(120),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(700),
            Acceleration::from_millimetres_per_second_squared(800),
            TractionType::Diesel,
            TrainProtection::single(ProtectionSystem::EtcsLevel2),
        )
        .expect("gültige Zugcharakteristik");

        let mut fahrweg = RunPath::new();
        let fehler = fahrweg
            .push_track_range(
                &nur_etcs,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect_err("der Ast trägt nur PZB, der Zug nur ETCS");
        assert!(matches!(
            fehler,
            InfraError::TrainProtectionIncompatible { .. }
        ));
    }

    #[test]
    fn eine_unpassende_antriebsart_faellt_auf() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis — ohne Fahrdraht");
        let nur_strom = TrainCharacteristics::new(
            TrainCharacteristicsId::new(3),
            "Elektrozug",
            Mass::from_tonnes(80),
            Length::from_metres(60),
            Speed::from_km_h(120),
            SpeedCategory::Standard,
            Acceleration::from_millimetres_per_second_squared(700),
            Acceleration::from_millimetres_per_second_squared(800),
            TractionType::Electric(ElectricSystems::single(PowerSystem::Ac15kV)),
            TrainProtection::single(ProtectionSystem::Pzb),
        )
        .expect("gültige Zugcharakteristik");

        let mut fahrweg = RunPath::new();
        let fehler = fahrweg
            .push_track_range(
                &nur_strom,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length(),
            )
            .expect_err("der Ast hat keinen Fahrdraht");
        assert!(matches!(
            fehler,
            InfraError::TrainTractionIncompatible { .. }
        ));
    }

    #[test]
    fn ein_ungueltiger_bereich_faellt_auf() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        let zug = regionaltriebwagen(700, 800);
        let mut fahrweg = RunPath::new();

        let fehler = fahrweg
            .push_track_range(
                &zug,
                ast,
                TravelDirection::WithChainage,
                ast.length(),
                Length::ZERO,
            )
            .expect_err("Anfang liegt nicht vor dem Ende");
        assert!(matches!(fehler, InfraError::InvalidRunRange { .. }));

        let fehler = fahrweg
            .push_track_range(
                &zug,
                ast,
                TravelDirection::WithChainage,
                Length::ZERO,
                ast.length() + Length::from_metres(1),
            )
            .expect_err("das Ende liegt hinter dem Gleisende");
        assert!(matches!(fehler, InfraError::InvalidRunRange { .. }));
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(RunningTime::from_seconds(90).to_string(), "90 s");
    }
}
