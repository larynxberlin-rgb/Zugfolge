//! Versionierte, ganzzahlige Kalibrierwerte für simulierte Störungen.
//!
//! Die Primärursachenverteilung ist aus den klassifizierten
//! Verspätungsminuten 2024 der Marktuntersuchung Eisenbahnen 2025 abgeleitet.
//! Die sekundäre Gruppe Zugfolge bleibt ausdrücklich außen vor: Sie entsteht
//! im Simulationskern als Fortpflanzung und darf nie als Primärereignis gezogen
//! werden. Die Tages-Einschränkungen sind eine aggregierte Momentaufnahme der
//! für den 9. August 2026 bereitgestellten Deutschlandausgabe.

/// Version der Primärursachen-Kalibrierung.
pub const PRIMARY_CAUSE_CALIBRATION_VERSION: &str = "primary-cause-minutes/de-2024-v1";

/// Version der nach Bezugsgrößen getrennten Spontanstörungs-Kalibrierung.
///
/// Infrastruktur: gemeldete Fälle je 100 Netztage in der Pilotregion,
/// Fahrzeuge: Fälle je 10.000 Zugfahrten, Fahrgastwechsel: aus beobachteten
/// Zusatzsekunden je 10.000 Halten abgeleitete Ereignisrate.
pub const SPONTANEOUS_INCIDENT_CALIBRATION_VERSION: &str =
    "spontaneous-incidents/de-spnv-2022-2024-v1";

/// 558 LST-/Weichenfälle in 184 Tagen, ganzzahlig auf 100 Tage gerundet.
pub const INFRASTRUCTURE_INCIDENTS_PER_100_DAYS: u32 = 303;

/// Gemeldete technische Fahrzeugstörungen je 10.000 SPNV-Zugfahrten.
pub const VEHICLE_INCIDENTS_PER_10_000_TRAIN_RUNS: u32 = 22;

/// Modellierte Fahrgastwechsel-Ereignisse je 10.000 Halte.
///
/// Die amtliche Statistik veröffentlicht nur 156.000 Zusatzminuten bei
/// 9,7 Millionen Halten, nicht die Fallzahl. Vierzig Fälle mit im Mittel rund
/// 241 Sekunden reproduzieren diesen Zeitverlust ohne eine erfundene amtliche
/// Fallzahl vorzutäuschen.
pub const DWELL_INCIDENTS_PER_10_000_STOPS: u32 = 40;

/// Beobachtetes Kalibrierziel für Zusatzhaltezeit je 10.000 Halte.
pub const DWELL_DELAY_SECONDS_PER_10_000_STOPS: u32 = 9_649;

/// Spontane, unmittelbar spielwirksame Ereignisklasse.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SpontaneousIncidentClass {
    /// Stellwerk oder übergeordnete Leit- und Sicherungstechnik.
    Interlocking,
    /// Signalstörung.
    Signal,
    /// Gleisfreimeldung oder Belegtmeldung gestört.
    TrackOccupation,
    /// Weiche oder Weichenantrieb gestört.
    Switch,
    /// Bremstechnische Fahrzeugstörung.
    VehicleBrake,
    /// Fahrzeugseitige Zugbeeinflussung gestört.
    VehicleTrainProtection,
    /// Sonstige unmittelbar betriebswirksame Fahrzeugtechnik.
    VehicleOtherTechnical,
    /// Tür oder Türüberwachung am Fahrzeug gestört.
    VehicleDoor,
    /// Verlängerter Fahrgastwechsel wegen hohem Aufkommen.
    DwellPassengerVolume,
    /// Verlängerter Halt wegen barrierefreiem Ein-/Ausstieg.
    DwellAccessibility,
    /// Verlängerter Halt durch Verhalten oder Hilfeleistung im Zug.
    DwellPassengerBehaviour,
    /// Verzögerte Abfertigung am Bahnsteig.
    DwellDispatch,
}

/// Ganzzahliges Gewicht innerhalb genau einer Bezugsgröße.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpontaneousIncidentWeight {
    /// Ereignisklasse.
    pub class: SpontaneousIncidentClass,
    /// Gewicht innerhalb der jeweiligen Tabelle.
    pub weight: u32,
}

/// 436 Fälle Leit-/Sicherungstechnik und 122 Weichenfälle in der Pilotregion.
/// Die amtliche Quelle trennt die 436 Fälle nicht weiter; die gleichmäßige
/// Aufteilung der drei beobachteten LST-Unterklassen ist eine Modellannahme.
pub const INFRASTRUCTURE_INCIDENT_WEIGHTS: &[SpontaneousIncidentWeight] = &[
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::Interlocking,
        weight: 146,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::Signal,
        weight: 145,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::TrackOccupation,
        weight: 145,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::Switch,
        weight: 122,
    },
];

/// Unterteilung der veröffentlichten Gesamtquote von 22 je 10.000 Fahrten.
/// Bremsen (7), Zugbeeinflussung (9) und sonstige Bordeinrichtung (1) sind
/// veröffentlicht. Die sechs nicht getrennt als Bremse oder Zugbeeinflussung
/// ausgewiesenen Fälle werden als markenfreie Modellannahme auf sonstige
/// betriebswirksame Fahrzeugtechnik (4) und Türen (2) verteilt.
pub const VEHICLE_INCIDENT_WEIGHTS: &[SpontaneousIncidentWeight] = &[
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::VehicleBrake,
        weight: 7,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::VehicleTrainProtection,
        weight: 9,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::VehicleOtherTechnical,
        weight: 4,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::VehicleDoor,
        weight: 2,
    },
];

/// Wirkungsmix des Fahrgastwechselmodells. Die Gesamtzeit ist amtlich
/// kalibriert; diese interne Aufteilung ist eine offen ausgewiesene Annahme.
pub const DWELL_INCIDENT_WEIGHTS: &[SpontaneousIncidentWeight] = &[
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::DwellPassengerVolume,
        weight: 50,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::DwellAccessibility,
        weight: 15,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::DwellPassengerBehaviour,
        weight: 20,
    },
    SpontaneousIncidentWeight {
        class: SpontaneousIncidentClass::DwellDispatch,
        weight: 15,
    },
];

/// Version der Tages-Einschränkungs-Kalibrierung.
pub const DAILY_RESTRICTION_CALIBRATION_VERSION: &str = "daily-restrictions/de-2026-08-09-v1";

/// Statistische Primärursachengruppe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrimaryCauseGroup {
    /// Bauarbeiten und Bauablauf.
    Construction,
    /// Betriebliche Vorbereitung und Durchführung.
    Operation,
    /// Wetter, Behörden und sonstige externe Einflüsse.
    External,
    /// Fehler in Fahrplanung und Fahrplandaten.
    TimetablePlanning,
    /// Fahrzeugtechnik.
    Vehicle,
    /// Technische Infrastruktur.
    Infrastructure,
    /// Personalverfügbarkeit und -handlung.
    Personnel,
}

/// Ganzzahliges Gewicht einer Primärursachengruppe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PrimaryCauseWeight {
    /// Ursachengruppe.
    pub group: PrimaryCauseGroup,
    /// Auf exakt 10.000 normierter Anteil.
    pub weight_basis_points: u32,
}

/// Primärursachen ohne die nur abgeleitete Gruppe Zugfolge.
pub const PRIMARY_CAUSE_WEIGHTS: &[PrimaryCauseWeight] = &[
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::Construction,
        weight_basis_points: 761,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::Operation,
        weight_basis_points: 6_861,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::External,
        weight_basis_points: 891,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::TimetablePlanning,
        weight_basis_points: 57,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::Vehicle,
        weight_basis_points: 309,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::Infrastructure,
        weight_basis_points: 690,
    },
    PrimaryCauseWeight {
        group: PrimaryCauseGroup::Personnel,
        weight_basis_points: 431,
    },
];

/// Anteil der sekundären Zugfolge an allen klassifizierten
/// Verspätungsminuten. Nur Kalibrierziel für Fortpflanzung, kein
/// Generatorgewicht.
pub const SEQUENCE_DELAY_SHARE_BASIS_POINTS: u32 = 3_449;

/// Klasse einer tagesaktuell veröffentlichten Einschränkung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DailyRestrictionClass {
    /// Symbolisch oder grafisch beschriebene betriebliche Bedingung.
    OperationalCondition,
    /// Numerische Langsamfahrstelle.
    NumericSpeed,
    /// Sonstige textlich beschriebene Bedingung.
    TextualCondition,
    /// Betriebsfunk nicht verfügbar.
    RadioUnavailable,
    /// Streckenseitige Zugbeeinflussung eingeschränkt.
    TrainProtection,
    /// Einschränkung an einem Bahnübergang.
    LevelCrossing,
}

/// Ganzzahliges Stichprobengewicht einer Tages-Einschränkungsklasse.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DailyRestrictionWeight {
    /// Einschränkungsklasse.
    pub class: DailyRestrictionClass,
    /// Anzahl konservativ strukturierter Zeilen im Referenztag.
    pub sample_count: u32,
}

/// 367 konservativ aus den fünf Regionalausgaben extrahierte Zeilen.
pub const DAILY_RESTRICTION_WEIGHTS: &[DailyRestrictionWeight] = &[
    DailyRestrictionWeight {
        class: DailyRestrictionClass::OperationalCondition,
        sample_count: 142,
    },
    DailyRestrictionWeight {
        class: DailyRestrictionClass::NumericSpeed,
        sample_count: 114,
    },
    DailyRestrictionWeight {
        class: DailyRestrictionClass::TextualCondition,
        sample_count: 79,
    },
    DailyRestrictionWeight {
        class: DailyRestrictionClass::RadioUnavailable,
        sample_count: 18,
    },
    DailyRestrictionWeight {
        class: DailyRestrictionClass::TrainProtection,
        sample_count: 8,
    },
    DailyRestrictionWeight {
        class: DailyRestrictionClass::LevelCrossing,
        sample_count: 6,
    },
];

/// Numerische Langsamfahrgeschwindigkeit und Häufigkeit im Referenztag.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SpeedWeight {
    /// Geschwindigkeit in Kilometern je Stunde.
    pub kilometres_per_hour: u32,
    /// Beobachtete strukturierte Zeilen.
    pub sample_count: u32,
}

/// Alle 114 extrahierten numerischen Geschwindigkeiten.
pub const DAILY_SPEED_WEIGHTS: &[SpeedWeight] = &[
    SpeedWeight {
        kilometres_per_hour: 70,
        sample_count: 22,
    },
    SpeedWeight {
        kilometres_per_hour: 20,
        sample_count: 20,
    },
    SpeedWeight {
        kilometres_per_hour: 40,
        sample_count: 15,
    },
    SpeedWeight {
        kilometres_per_hour: 30,
        sample_count: 15,
    },
    SpeedWeight {
        kilometres_per_hour: 60,
        sample_count: 11,
    },
    SpeedWeight {
        kilometres_per_hour: 120,
        sample_count: 10,
    },
    SpeedWeight {
        kilometres_per_hour: 50,
        sample_count: 9,
    },
    SpeedWeight {
        kilometres_per_hour: 80,
        sample_count: 4,
    },
    SpeedWeight {
        kilometres_per_hour: 10,
        sample_count: 3,
    },
    SpeedWeight {
        kilometres_per_hour: 110,
        sample_count: 1,
    },
    SpeedWeight {
        kilometres_per_hour: 140,
        sample_count: 1,
    },
    SpeedWeight {
        kilometres_per_hour: 100,
        sample_count: 1,
    },
    SpeedWeight {
        kilometres_per_hour: 5,
        sample_count: 1,
    },
    SpeedWeight {
        kilometres_per_hour: 90,
        sample_count: 1,
    },
];
