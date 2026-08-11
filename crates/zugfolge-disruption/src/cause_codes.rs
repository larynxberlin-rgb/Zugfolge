//! Versionierte Referenzkataloge für betriebliche Verspätungsursachen und
//! davon getrennte Fahrgastinformations-Abweichungen.
//!
//! Markenfreie Hauptkennungen und eine daraus abgeleitete, markenneutrale
//! Feinkodierung mit eigenen Einordnungstexten. Verantwortungsgruppen sind eine
//! eigene, spielmechanische Einordnung von Zugfolge; Herkunft und
//! Rechteprüfung stehen außerhalb des Laufzeitcodes im Quellenregister.

/// Stand der betrieblichen Kurzcode-Referenz.
pub const DELAY_CAUSE_CATALOG_VERSION: &str = "delay-cause-main-codes/2025-12-14";

/// Fachliche Rolle eines Verspätungsursachencodes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CauseType {
    /// Technische Kennung aus dem Erfassungsprozess, keine Ursache.
    ProcessMarker,
    /// Unmittelbar wirkender Primärgrund.
    Primary,
    /// Sicherheitsereignis, dessen endgültige Ursache später folgen kann.
    DangerousEvent,
    /// Folge einer bereits bestehenden Verspätung.
    Secondary,
    /// Befristeter Prüfstatus, keine abschließende Ursache.
    Investigation,
}

/// Für Spielauswertung und Kostenrechnung normalisierte Verantwortungsgruppe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CauseResponsibility {
    /// Kein Verursacher: technische Kennung.
    None,
    /// Infrastrukturbetreiber der Welt.
    InfrastructureManager,
    /// Energie-, Stations- oder sonstiger Infrastrukturpartner.
    InfrastructurePartner,
    /// Eisenbahnverkehrsunternehmen.
    RailwayUndertaking,
    /// Benachbarter Infrastrukturbetreiber.
    NeighborInfrastructureManager,
    /// Benachbartes Eisenbahnverkehrsunternehmen.
    NeighborRailwayUndertaking,
    /// Außerhalb des Einflusses von EIU und EVU.
    External,
    /// Sekundärgrund; Verantwortung wird vom auslösenden Vorgang abgeleitet.
    Derived,
    /// Zuständigkeit ist noch nicht abschließend geklärt.
    UnderInvestigation,
}

/// Ein betrieblicher Verspätungsursachencode mit knappem Einordnungstext.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DelayCauseCode {
    /// Zweistellige offizielle Kennung.
    pub code: u8,
    /// Kurze öffentlich dokumentierte Bezeichnung.
    pub label: &'static str,
    /// Primär-, Sekundär- oder Prozessrolle.
    pub cause_type: CauseType,
    /// Normalisierte Verantwortung für das Spiel.
    pub responsibility: CauseResponsibility,
}

const fn code(
    code: u8,
    label: &'static str,
    cause_type: CauseType,
    responsibility: CauseResponsibility,
) -> DelayCauseCode {
    DelayCauseCode {
        code,
        label,
        cause_type,
        responsibility,
    }
}

/// Vollständige Liste der in der Referenz sichtbaren Hauptkennungen.
///
/// Feinkodierungen sind im getrennt versionierten Katalog weiter unten
/// enthalten, damit Haupt- und Feincodes unabhängig migriert werden können.
pub const DELAY_CAUSE_CATALOG: &[DelayCauseCode] = &[
    code(
        0,
        "Automatisch erzeugter Verspätungsdatensatz",
        CauseType::ProcessMarker,
        CauseResponsibility::None,
    ),
    code(
        2,
        "Nicht plausibler Verspätungsdatensatz",
        CauseType::ProcessMarker,
        CauseResponsibility::None,
    ),
    code(
        6,
        "Einbruchsverspätung am Grenz- oder Übernahmepunkt",
        CauseType::ProcessMarker,
        CauseResponsibility::None,
    ),
    code(
        10,
        "Fahrplanerstellung",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        12,
        "Fehldisposition",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        13,
        "Vorbereitung",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        14,
        "Anfangsverspätung bei Zügen des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        18,
        "Betriebliches Personal des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        19,
        "Sonstige Betriebsdurchführung des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        20,
        "Stromversorgungsanlagen (Fahrstrom)",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        21,
        "Telekommunikationsanlagen",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        22,
        "Bauwerke",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        23,
        "Fahrbahn",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        24,
        "Bahnübergangssicherungsanlagen",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        25,
        "Anlagen Leit- und Sicherungstechnik",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        26,
        "Weichen",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        27,
        "Fahrzeuge des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        28,
        "Technisches Personal des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        29,
        "Sonstige Technik des Infrastrukturbetreibers",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        30,
        "Mängellangsamfahrstelle",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        31,
        "Bauarbeiten/Arbeiten",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        32,
        "Unregelmäßigkeiten bei Bauarbeiten/Arbeiten",
        CauseType::Primary,
        CauseResponsibility::InfrastructureManager,
    ),
    code(
        40,
        "Nächster Eisenbahn-Infrastruktur-Unternehmer",
        CauseType::Primary,
        CauseResponsibility::NeighborInfrastructureManager,
    ),
    code(
        41,
        "Vorheriger Eisenbahn-Infrastruktur-Unternehmer",
        CauseType::Primary,
        CauseResponsibility::NeighborInfrastructureManager,
    ),
    code(
        46,
        "Anlagen des Energieversorgungspartners",
        CauseType::Primary,
        CauseResponsibility::InfrastructurePartner,
    ),
    code(
        47,
        "Anlagen der Personenbahnhöfe",
        CauseType::Primary,
        CauseResponsibility::InfrastructurePartner,
    ),
    code(
        48,
        "Personal der Personenbahnhöfe und Energieversorgung",
        CauseType::Primary,
        CauseResponsibility::InfrastructurePartner,
    ),
    code(
        49,
        "Sonstiges bei Personenbahnhöfen und Energieversorgung",
        CauseType::Primary,
        CauseResponsibility::InfrastructurePartner,
    ),
    code(
        50,
        "Haltezeitüberschreitung",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        51,
        "Antrag EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        52,
        "Ladearbeiten",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        53,
        "Unregelmäßigkeiten an der Ladung",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        54,
        "Verkehrliche Zugvorbereitung",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        57,
        "Keine Meldung durch EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        58,
        "Verkehrliches Personal EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        59,
        "Sonstige verkehrliche Gründe EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        60,
        "Umlauf-, Einsatzplanung",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        61,
        "Zugbildung durch EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        62,
        "Reisezugwagen",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        63,
        "Güterwagen",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        64,
        "Triebfahrzeuge",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        68,
        "Technisches Personal EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        69,
        "Sonstiges Fahrzeuge EVU",
        CauseType::Primary,
        CauseResponsibility::RailwayUndertaking,
    ),
    code(
        70,
        "Nächstes EVU",
        CauseType::Primary,
        CauseResponsibility::NeighborRailwayUndertaking,
    ),
    code(
        71,
        "Vorheriges EVU",
        CauseType::Primary,
        CauseResponsibility::NeighborRailwayUndertaking,
    ),
    code(
        80,
        "Externe Einflüsse bei externen EIU",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        81,
        "Anordnung der Netzleitstelle - Streik",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        82,
        "Anordnung der Netzleitstelle - Witterung",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        83,
        "Schmierfilm",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        84,
        "Behörden",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        85,
        "Fremdeinwirkung",
        CauseType::Primary,
        CauseResponsibility::External,
    ),
    code(
        90,
        "Gefährliche Ereignisse",
        CauseType::DangerousEvent,
        CauseResponsibility::UnderInvestigation,
    ),
    code(
        91,
        "Zugfolge - wegen Vorrang anderer Züge",
        CauseType::Secondary,
        CauseResponsibility::Derived,
    ),
    code(
        92,
        "Zugfolge - betroffener Zug war verspätet",
        CauseType::Secondary,
        CauseResponsibility::Derived,
    ),
    code(
        93,
        "Umlauf",
        CauseType::Secondary,
        CauseResponsibility::Derived,
    ),
    code(
        94,
        "Anschluss",
        CauseType::Secondary,
        CauseResponsibility::Derived,
    ),
    code(
        95,
        "Flügeln",
        CauseType::Secondary,
        CauseResponsibility::Derived,
    ),
    code(
        96,
        "Anordnung der Netzleitstelle - Weitere Untersuchung erforderlich",
        CauseType::Investigation,
        CauseResponsibility::UnderInvestigation,
    ),
];

/// Schlägt eine Hauptkennung im gepinnten betrieblichen Katalog nach.
#[must_use]
pub fn delay_cause_code(code: u8) -> Option<&'static DelayCauseCode> {
    DELAY_CAUSE_CATALOG.iter().find(|entry| entry.code == code)
}

/// Stand der markenfreien Zugfolge-Feintaxonomie auf Basis des Katalogs 2023.
pub const FINE_CAUSE_CATALOG_VERSION: &str = "fine-cause-taxonomy/2023-12-10";

/// Stabiler, markenfreier Feingrund unter einer zweistelligen Hauptkennung.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FineCauseCode {
    /// Dauerhafte maschinenlesbare Kennung von Zugfolge.
    pub id: &'static str,
    /// Zugehörige Hauptkennung.
    pub main_code: u8,
    /// Eigenständig formulierter Kurztext ohne Unternehmensnamen.
    pub label: &'static str,
}

/// Fachlicher Entstehungskanal eines Feingrunds in der Simulation.
///
/// Nicht jeder Eintrag des Referenzkatalogs ist ein eigenstaendiges
/// Zufallsereignis. Fahrplan- und Dispositionsfehler entstehen beispielsweise
/// aus dem Spielzustand, waehrend Pruefkennungen und wirkungslose Hinweise gar
/// nicht materialisiert werden.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FineCauseGeneration {
    /// Geplante, vorab veroeffentlichte Einschraenkung.
    PlannedModel,
    /// Spontanes Ereignis der Infrastruktur oder ihrer Umgebung.
    SpontaneousInfrastructure,
    /// Nicht im oeffentlichen Infrastrukturfeed enthaltenes internes Ereignis.
    SpontaneousInternal,
    /// Entsteht aus einer konkreten Spieler- oder Systementscheidung.
    Endogenous,
    /// Seltenes Sicherheitsereignis; nur als explizites Szenario oder Feedfund.
    ScenarioOrProvider,
    /// Keine derzeit abgebildete betriebliche Wirkung.
    ExcludedEffectless,
    /// Vorlaeufiger Status, keine dauerhaft simulierbare Ursache.
    TemporaryStatus,
}

/// Abdeckung im Modus `REALISTIC` ohne Doppelzaehlung des Infrastrukturfeeds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RealisticFineCauseCoverage {
    /// Wird aus dem freigegebenen Infrastrukturfeed oder Tagesmodell bezogen.
    InfrastructureSource,
    /// Muss zusaetzlich intern simuliert werden, weil es im Feed nicht vorkommt.
    InternalGapSimulation,
    /// Entsteht ohnehin aus dem autoritativen Spielzustand.
    EndogenousGameState,
    /// Wird wegen fehlender Wirkung oder bloss vorlaeufigem Status nicht erzeugt.
    NotMaterialized,
}

/// Primaere, bereits im Spiel vorhandene Wirkung eines Feingrunds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FineCauseEffectFamily {
    /// Sperrung, Restkapazitaet oder nicht nutzbare Ressource.
    Capacity,
    /// Zusaetzliche Fahrzeit, Halt vor Ressource oder Laufwegabweichung.
    RunningTime,
    /// Konkrete Verlaengerung eines Fahrgasthalts.
    Dwell,
    /// Fahrzeug darf nicht oder nur eingeschraenkt eingesetzt werden.
    VehicleEligibility,
    /// Bahnsteig oder dessen Nutzlaenge ist nicht geeignet.
    PlatformEligibility,
}

/// Vollstaendige Einordnung eines Feingrunds fuer beide Spielmodi.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FineCauseSimulationDisposition {
    /// Entstehung im vollstaendig simulierten Modus.
    pub generation: FineCauseGeneration,
    /// Herkunft im realistischen Modus.
    pub realistic_coverage: RealisticFineCauseCoverage,
    /// Konkrete Spielwirkung; `None` bedeutet vollstaendigen Ausschluss.
    pub effect: Option<FineCauseEffectFamily>,
}

const fn fine(id: &'static str, main_code: u8, label: &'static str) -> FineCauseCode {
    FineCauseCode {
        id,
        main_code,
        label,
    }
}

/// Markenfreie Feintaxonomie mit der fachlichen Granularität des Katalogs 2023.
///
/// Die Texte sind eigene Zugfolge-Bezeichnungen. Technische Abkürzungen werden
/// nur verwendet, wenn sie ein interoperables Bahnsystem und kein Unternehmen
/// bezeichnen.
pub const FINE_CAUSE_CATALOG_2023: &[FineCauseCode] = &[
    fine(
        "timetable.departure-time",
        10,
        "Abfahrtszeit im Fahrplan unzutreffend",
    ),
    fine("timetable.route-missing", 10, "Alternativer Laufweg fehlt"),
    fine("timetable.destination", 10, "Zugziel unzutreffend"),
    fine(
        "timetable.platform-length",
        10,
        "Bahnsteiglänge nicht ausreichend",
    ),
    fine(
        "timetable.vehicle-parameters",
        10,
        "Fahrzeugparameter unzutreffend",
    ),
    fine(
        "timetable.track-occupation",
        10,
        "Gleisbelegung nicht berücksichtigt",
    ),
    fine("timetable.running-time", 10, "Fahrzeit nicht ausreichend"),
    fine(
        "timetable.control-system-data",
        10,
        "Fahrplandaten im Leitsystem fehlen oder sind unzutreffend",
    ),
    fine(
        "dispatch.agreement",
        12,
        "Dispositionsvereinbarung nicht eingehalten",
    ),
    fine(
        "dispatch.wrong-direction",
        12,
        "Gegengleisfahrt nicht abgestimmt",
    ),
    fine(
        "dispatch.control-center",
        12,
        "Fehler in der regionalen Disposition",
    ),
    fine(
        "dispatch.local-execution",
        12,
        "Dispositionsentscheidung örtlich fehlerhaft umgesetzt",
    ),
    fine(
        "dispatch.handover",
        12,
        "Abstimmung zur Zugübergabe mangelhaft",
    ),
    fine(
        "preparation.train-number",
        13,
        "Zugnummer fehlerhaft vergeben",
    ),
    fine(
        "preparation.local-rules",
        13,
        "Örtliche betriebliche Unterlage fehlerhaft",
    ),
    fine(
        "preparation.speed-restriction-register",
        13,
        "Verzeichnis der Langsamfahrstellen fehlerhaft",
    ),
    fine(
        "preparation.route-register",
        13,
        "Streckenverzeichnis fehlerhaft",
    ),
    fine(
        "preparation.stabling",
        13,
        "Abstellkonzept in Unterlagen fehlerhaft",
    ),
    fine(
        "infrastructure-train.late-start",
        14,
        "Infrastrukturzug verspätet bereit",
    ),
    fine(
        "infrastructure-train.fuel",
        14,
        "Betriebsstoffaufnahme vor Abfahrt",
    ),
    fine(
        "infrastructure-train.vehicle",
        14,
        "Fahrzeugstörung am Infrastrukturzug",
    ),
    fine(
        "infrastructure-train.staff",
        14,
        "Personal für Infrastrukturzug nicht rechtzeitig verfügbar",
    ),
    fine(
        "operations-staff.unfit",
        18,
        "Betriebspersonal während der Schicht nicht dienstfähig",
    ),
    fine(
        "operations-staff.action",
        18,
        "Fehlhandlung des Betriebspersonals",
    ),
    fine(
        "operations-staff.unavailable",
        18,
        "Betriebspersonal nicht verfügbar",
    ),
    fine(
        "operations-staff.late-start",
        18,
        "Betriebspersonal nimmt Arbeit verspätet auf",
    ),
    fine(
        "traction-power.current-limit",
        20,
        "Fahrstrombegrenzung angeordnet",
    ),
    fine(
        "traction-power.overhead-line",
        20,
        "Oberleitungsanlage gestört",
    ),
    fine(
        "traction-power.conductor-rail",
        20,
        "Stromschienenanlage gestört",
    ),
    fine(
        "traction-power.auxiliary-supply",
        20,
        "Versorgung technischer Nebenanlagen gestört",
    ),
    fine(
        "traction-power.maintenance",
        20,
        "Unangekündigte Arbeit an Stromversorgungsanlage",
    ),
    fine("telecom.radio", 21, "Bahnfunk gestört"),
    fine("telecom.network", 21, "Funknetz gestört"),
    fine("telecom.telephone", 21, "Betriebstelefonie gestört"),
    fine(
        "telecom.data-link",
        21,
        "Datenverbindung zur Betriebszentrale gestört",
    ),
    fine("telecom.cable", 21, "Telekommunikationskabel beschädigt"),
    fine("telecom.video", 21, "Videoüberwachungsanlage gestört"),
    fine("structure.bridge", 22, "Brückenbauwerk schadhaft"),
    fine(
        "structure.tunnel",
        22,
        "Tunnel oder Tunnelausrüstung schadhaft",
    ),
    fine(
        "structure.noise-barrier",
        22,
        "Schallschutzbauwerk schadhaft",
    ),
    fine(
        "structure.inspection",
        22,
        "Ungeplante Bauwerksprüfung erforderlich",
    ),
    fine("track.geometry", 23, "Gleislagefehler"),
    fine("track.settlement", 23, "Gleisabsenkung"),
    fine("track.rail-break", 23, "Schienenbruch"),
    fine("track.superstructure", 23, "Oberbaumangel"),
    fine("track.slope", 23, "Hang- oder Dammrutsch"),
    fine("track.flooding", 23, "Gleis unter- oder überspült"),
    fine("track.vegetation", 23, "Vegetation im Fahrwegprofil"),
    fine("track.monitoring", 23, "Fahrbahnüberwachung meldet Störung"),
    fine(
        "level-crossing.axle-counter",
        24,
        "Achszähleinrichtung am Bahnübergang gestört",
    ),
    fine("level-crossing.drive", 24, "Schrankenantrieb gestört"),
    fine(
        "level-crossing.clearance",
        24,
        "Gefahrraumüberwachung gestört",
    ),
    fine(
        "level-crossing.power",
        24,
        "Stromversorgung des Bahnübergangs gestört",
    ),
    fine(
        "level-crossing.road-surface",
        24,
        "Straßen- oder Fußwegbelag am Bahnübergang schadhaft",
    ),
    fine(
        "signalling.control-interface",
        25,
        "Bedieneinrichtung der Sicherungstechnik gestört",
    ),
    fine("signalling.remote-control", 25, "Fernsteuerung gestört"),
    fine(
        "signalling.track-occupation",
        25,
        "Gleisfreimeldung gestört",
    ),
    fine("signalling.signal", 25, "Signal gestört"),
    fine(
        "signalling.interlocking",
        25,
        "Stellwerks- oder Leitsystem gestört",
    ),
    fine(
        "signalling.cable",
        25,
        "Kabel der Sicherungstechnik beschädigt",
    ),
    fine(
        "signalling.train-protection",
        25,
        "Zugbeeinflussung streckenseitig gestört",
    ),
    fine(
        "signalling.train-number",
        25,
        "Zugnummernmeldeanlage gestört",
    ),
    fine("switch.heating", 26, "Weichenheizung gestört"),
    fine("switch.drive", 26, "Weichenantrieb oder Verschluss gestört"),
    fine("switch.track", 26, "Fahrbahnteil der Weiche gestört"),
    fine("switch.tongue", 26, "Weichenzunge beschädigt"),
    fine("switch.intermittent", 26, "Einmalige Weichenstörung"),
    fine(
        "infrastructure-vehicle.vehicle",
        27,
        "Infrastrukturfahrzeug gestört",
    ),
    fine(
        "infrastructure-vehicle.measurement",
        27,
        "Messeinrichtung am Infrastrukturfahrzeug gestört",
    ),
    fine(
        "technical-staff.execution",
        28,
        "Technische Arbeit fehlerhaft ausgeführt",
    ),
    fine(
        "technical-staff.signal-placement",
        28,
        "Signal fehlerhaft aufgestellt",
    ),
    fine(
        "technical-staff.unavailable",
        28,
        "Technisches Personal nicht verfügbar",
    ),
    fine(
        "technical-staff.late-start",
        28,
        "Technisches Personal nimmt Arbeit verspätet auf",
    ),
    fine(
        "speed-restriction.asset-condition",
        30,
        "Langsamfahrstelle wegen mangelhaftem Anlagenzustand",
    ),
    fine(
        "speed-restriction.bridge",
        30,
        "Langsamfahrstelle an Brücke oder Hilfsbrücke",
    ),
    fine(
        "speed-restriction.level-crossing",
        30,
        "Langsamfahrstelle am Bahnübergang",
    ),
    fine(
        "speed-restriction.train-control",
        30,
        "Langsamfahrt in der Zugbeeinflussung hinterlegt",
    ),
    fine(
        "construction.work-zone",
        31,
        "Fahrzeitverlust im Bauabschnitt",
    ),
    fine(
        "construction.temporary-speed",
        31,
        "Baubedingte Langsamfahrstelle",
    ),
    fine("construction.diversion", 31, "Baubedingte Umleitung"),
    fine(
        "construction.protective-speed",
        31,
        "Schutzlangsamfahrt wegen Arbeiten in Gleisnähe",
    ),
    fine(
        "construction.replacement-service-wait",
        31,
        "Warten auf veröffentlichten Ersatzverkehr",
    ),
    fine(
        "construction.overrun",
        32,
        "Geplante Sperrzeit überschritten",
    ),
    fine(
        "construction.asset-damage",
        32,
        "Infrastruktur bei Bauarbeit beschädigt",
    ),
    fine(
        "construction.resources",
        32,
        "Personal oder Material für Bauablauf fehlt",
    ),
    fine("construction.machinery", 32, "Baumaschine ausgefallen"),
    fine(
        "construction.target-state",
        32,
        "Geplanter Bauzustand nicht erreicht",
    ),
    fine(
        "construction.communication",
        32,
        "Kommunikation zur Arbeitsstelle gestört",
    ),
    fine(
        "previous-infrastructure.diversion",
        41,
        "Umleitung wegen Störung auf vorheriger Infrastruktur",
    ),
    fine(
        "previous-infrastructure.handover",
        41,
        "Verspätete Übergabe von vorheriger Infrastruktur",
    ),
    fine(
        "energy-supply.traction",
        46,
        "Fahrstromversorgung unzureichend",
    ),
    fine(
        "energy-supply.interlocking",
        46,
        "Stromversorgung einer Betriebsanlage ausgefallen",
    ),
    fine(
        "energy-supply.substation",
        46,
        "Umform- oder Unterwerk gestört",
    ),
    fine(
        "energy-supply.external-feed",
        46,
        "Externe Einspeisung gestört",
    ),
    fine("station.lift", 47, "Aufzug gestört"),
    fine(
        "station.passenger-information",
        47,
        "Reisendeninformationsanlage gestört",
    ),
    fine("station.platform", 47, "Bahnsteig schadhaft"),
    fine(
        "station.accessibility",
        47,
        "Barrierefreier Zugang eingeschränkt",
    ),
    fine(
        "station.public-address",
        47,
        "Lautsprecher oder Beleuchtung gestört",
    ),
    fine(
        "station-staff.dispatch",
        48,
        "Stationspersonal nicht verfügbar",
    ),
    fine(
        "station-staff.passenger-guidance",
        48,
        "Reisendenlenkung fehlerhaft oder verspätet",
    ),
    fine(
        "station-staff.train-dispatch",
        48,
        "Zugabfertigung durch Stationspersonal verspätet",
    ),
    fine(
        "station-staff.snow-clearance",
        48,
        "Schneeräumung verspätet freigemeldet",
    ),
    fine("dwell.passenger-volume", 50, "Erhöhtes Reisendenaufkommen"),
    fine(
        "dwell.accessibility",
        50,
        "Einstiegshilfe oder Mobilitätshilfe verzögert Halt",
    ),
    fine(
        "dwell.passenger-behavior",
        50,
        "Reisendenverhalten verzögert Halt",
    ),
    fine("dwell.dispatch", 50, "Zugabfertigung verzögert"),
    fine(
        "operator-request.extra-stop",
        51,
        "Außerplanmäßiger Halt beantragt",
    ),
    fine(
        "operator-request.staff-change",
        51,
        "Außerplanmäßiger Personalwechsel beantragt",
    ),
    fine(
        "operator-request.short-turn",
        51,
        "Vorzeitige Wende beantragt",
    ),
    fine(
        "operator-request.running-time",
        51,
        "Abweichende Fahrzeit beantragt",
    ),
    fine(
        "operator-request.wait",
        51,
        "Warten über die Regelwartezeit beantragt",
    ),
    fine(
        "loading.catering",
        52,
        "Versorgung oder Dienstleistung am Zug verzögert",
    ),
    fine(
        "loading.cleaning",
        52,
        "Wasseraufnahme oder Reinigung verzögert",
    ),
    fine(
        "loading.animals",
        52,
        "Versorgung eines Tiertransports verzögert",
    ),
    fine("load.shifted", 53, "Ladung verschoben"),
    fine(
        "load.unsecured",
        53,
        "Ladung oder Abdeckung unzureichend gesichert",
    ),
    fine("load.documents", 53, "Frachtpapiere fehlen"),
    fine("load.opening", 53, "Tür oder Luke nicht geschlossen"),
    fine("load.lost", 53, "Ladungsteil verloren"),
    fine(
        "train-preparation.notification",
        54,
        "Zugvorbereitung verspätet gemeldet",
    ),
    fine(
        "train-preparation.handover",
        54,
        "Zug verspätet betriebsbereit übergeben",
    ),
    fine(
        "operator-no-report.running-time",
        57,
        "Fahrzeitüberschreitung ohne Begründung",
    ),
    fine(
        "operator-no-report.dwell",
        57,
        "Haltezeitüberschreitung ohne Begründung",
    ),
    fine(
        "commercial-staff.unavailable",
        58,
        "Verkehrliches Personal fehlt",
    ),
    fine(
        "commercial-staff.duty-limit",
        58,
        "Dienstzeit des verkehrlichen Personals überschritten",
    ),
    fine(
        "commercial-staff.late-start",
        58,
        "Verkehrliches Personal beginnt verspätet",
    ),
    fine(
        "commercial-staff.planning",
        58,
        "Einsatzplanung des verkehrlichen Personals fehlerhaft",
    ),
    fine(
        "commercial-staff.action",
        58,
        "Fehlhandlung des verkehrlichen Personals",
    ),
    fine(
        "rotation.vehicle-properties",
        60,
        "Fahrzeugeigenschaften weichen von Planung ab",
    ),
    fine(
        "rotation.replacement-set",
        60,
        "Ersatzfahrzeug außerplanmäßig eingesetzt",
    ),
    fine(
        "rotation.vehicle-change",
        60,
        "Fahrzeugwechsel außerplanmäßig",
    ),
    fine(
        "rotation.capacity-change",
        60,
        "Zug außerplanmäßig gestärkt oder geschwächt",
    ),
    fine(
        "rotation.braking",
        60,
        "Erforderliches Bremsvermögen vor Fahrtbeginn fehlt",
    ),
    fine(
        "formation.correction",
        61,
        "Fehler der Zugbildung wird behoben",
    ),
    fine(
        "formation.locomotive-change",
        61,
        "Planmäßiger Triebfahrzeugwechsel verzögert",
    ),
    fine(
        "formation.capacity-change",
        61,
        "Planmäßiges Stärken oder Schwächen verzögert",
    ),
    fine(
        "formation.assistance",
        61,
        "Warten auf Unterstützungsfahrzeug",
    ),
    fine("coach.door", 62, "Tür an Reisezugwagen gestört"),
    fine("coach.brake", 62, "Bremse an Reisezugwagen gestört"),
    fine("coach.climate", 62, "Heizung oder Klimatisierung gestört"),
    fine("coach.power", 62, "Bordstromversorgung gestört"),
    fine("coach.control-car", 62, "Steuerwagen gestört"),
    fine(
        "freight-wagon.hotbox",
        63,
        "Achs- oder Lagerstörung am Güterwagen",
    ),
    fine("freight-wagon.brake", 63, "Bremse am Güterwagen gestört"),
    fine(
        "freight-wagon.air",
        63,
        "Luftversorgung am Güterwagen gestört",
    ),
    fine(
        "freight-wagon.loading-system",
        63,
        "Ladungssicherungstechnik am Güterwagen gestört",
    ),
    fine(
        "traction-unit.drive",
        64,
        "Antrieb des Triebfahrzeugs gestört",
    ),
    fine(
        "traction-unit.running-gear",
        64,
        "Fahrwerk oder Radsatz gestört",
    ),
    fine("traction-unit.pantograph", 64, "Stromabnehmer gestört"),
    fine(
        "traction-unit.brake",
        64,
        "Bremse des Triebfahrzeugs gestört",
    ),
    fine(
        "traction-unit.train-radio",
        64,
        "Zugfunk am Fahrzeug gestört",
    ),
    fine(
        "traction-unit.train-protection",
        64,
        "Zugbeeinflussung am Fahrzeug gestört",
    ),
    fine(
        "traction-unit.door-control",
        64,
        "Türüberwachung am Fahrzeug gestört",
    ),
    fine(
        "traction-unit.control-system",
        64,
        "Fahrzeugsteuerung gestört",
    ),
    fine(
        "technical-operator-staff.unavailable",
        68,
        "Technisches Fahrpersonal fehlt",
    ),
    fine(
        "technical-operator-staff.duty-limit",
        68,
        "Arbeitszeitgrenze des technischen Fahrpersonals erreicht",
    ),
    fine(
        "technical-operator-staff.vehicle-operation",
        68,
        "Fahrzeug oder Sicherheitseinrichtung fehlerhaft bedient",
    ),
    fine(
        "technical-operator-staff.driving",
        68,
        "Fehler beim Führen des Zuges",
    ),
    fine(
        "technical-operator-staff.shunting",
        68,
        "Rangierarbeit oder Kommunikation fehlerhaft",
    ),
    fine(
        "technical-operator-staff.signals",
        68,
        "Spitzen- oder Zugschlusssignal fehlt",
    ),
    fine(
        "strike.operations",
        81,
        "Arbeitskampf beim Betriebspersonal",
    ),
    fine(
        "strike.operator",
        81,
        "Arbeitskampf beim Eisenbahnverkehrsunternehmen",
    ),
    fine("strike.contractor", 81, "Arbeitskampf bei Auftragnehmer"),
    fine(
        "weather.snow-platform",
        82,
        "Bahnsteig nicht von Schnee oder Eis geräumt",
    ),
    fine("weather.storm", 82, "Sturm beeinträchtigt Infrastruktur"),
    fine(
        "weather.lightning",
        82,
        "Blitzschlag beeinträchtigt Infrastruktur",
    ),
    fine("weather.flooding", 82, "Gleis durch Wasser beeinträchtigt"),
    fine("weather.overhead-line-ice", 82, "Oberleitung vereist"),
    fine(
        "weather.switch-snow",
        82,
        "Weiche erreicht wegen Schnee keine Endlage",
    ),
    fine(
        "weather.vehicle",
        82,
        "Fahrzeugtechnik witterungsbedingt gestört",
    ),
    fine(
        "weather.service-suspension",
        82,
        "Betrieb wegen Unwetter teilweise oder vollständig eingestellt",
    ),
    fine(
        "low-adhesion.starting",
        83,
        "Anfahr- oder Bremsschwierigkeit durch geringe Haftung",
    ),
    fine(
        "low-adhesion.speed",
        83,
        "Geschwindigkeit wegen geringer Haftung herabgesetzt",
    ),
    fine(
        "low-adhesion.stall",
        83,
        "Zug bleibt wegen geringer Haftung liegen",
    ),
    fine("authority.police", 84, "Polizeilicher Einsatz"),
    fine("authority.rescue", 84, "Rettungseinsatz"),
    fine(
        "authority.explosive-ordnance",
        84,
        "Kampfmitteluntersuchung oder Entschärfung",
    ),
    fine(
        "authority.border-control",
        84,
        "Behördliche Kontrolle verzögert Zug",
    ),
    fine(
        "authority.large-event",
        84,
        "Großveranstaltung führt zu behördlicher Einschränkung",
    ),
    fine("third-party.person-track", 85, "Person im oder am Gleis"),
    fine("third-party.object-track", 85, "Gegenstand im Gleis"),
    fine(
        "third-party.object-overhead-line",
        85,
        "Gegenstand in der Oberleitung",
    ),
    fine(
        "third-party.vandalism",
        85,
        "Anlage durch Vandalismus beschädigt",
    ),
    fine(
        "third-party.theft",
        85,
        "Teil einer Infrastrukturanlage entwendet",
    ),
    fine(
        "third-party.level-crossing",
        85,
        "Bahnübergang durch Verkehrsteilnehmer beschädigt",
    ),
    fine(
        "third-party.bridge-strike",
        85,
        "Brücke durch Straßenfahrzeug angefahren",
    ),
    fine("third-party.fire", 85, "Brand in Gleisnähe"),
    fine(
        "third-party.animal",
        85,
        "Tier beeinträchtigt Infrastruktur",
    ),
    fine("dangerous-event.derailment", 90, "Entgleisung"),
    fine("dangerous-event.collision", 90, "Kollision"),
    fine(
        "dangerous-event.level-crossing",
        90,
        "Unfall am Bahnübergang",
    ),
    fine("dangerous-event.vehicle-fire", 90, "Fahrzeugbrand"),
    fine(
        "dangerous-event.hazardous-goods",
        90,
        "Gefahrgut oder gefährlicher Betriebsstoff tritt aus",
    ),
    fine(
        "dangerous-event.person",
        90,
        "Personenunfall im Zusammenhang mit Eisenbahnfahrzeug",
    ),
    fine(
        "dangerous-event.signal-passed",
        90,
        "Halt zeigendes Signal unzulässig passiert",
    ),
    fine(
        "dangerous-event.infrastructure-safety",
        90,
        "Sicherheitsrelevante Infrastrukturstörung",
    ),
    fine(
        "investigation.infrastructure",
        96,
        "Ursache auf Antrag des Infrastrukturbetreibers in Untersuchung",
    ),
    fine(
        "investigation.operator",
        96,
        "Ursache auf Antrag des Eisenbahnverkehrsunternehmens in Untersuchung",
    ),
];

/// Schlägt einen stabilen Feingrund nach und validiert zugleich seine Hauptkennung.
#[must_use]
pub fn fine_cause_code(id: &str, main_code: u8) -> Option<&'static FineCauseCode> {
    FINE_CAUSE_CATALOG_2023
        .iter()
        .find(|entry| entry.id == id && entry.main_code == main_code)
}

/// Ordnet jeden Feincode des Katalogs einem belastbaren Simulationskanal zu.
///
/// Die wenigen wirkungslosen Ausnahmen werden absichtlich ueber ihre stabile
/// Kennung erkannt. Alle uebrigen Gruppen folgen der fachlichen Hauptkennung.
#[must_use]
pub fn fine_cause_simulation_disposition(cause: &FineCauseCode) -> FineCauseSimulationDisposition {
    use FineCauseGeneration as Generation;
    use RealisticFineCauseCoverage as Realistic;

    let effectless = cause.id.starts_with("telecom.")
        || matches!(
            cause.id,
            "traction-power.current-limit"
                | "structure.noise-barrier"
                | "station.passenger-information"
                | "station.public-address"
                | "traction-unit.train-radio"
        );
    if effectless {
        return FineCauseSimulationDisposition {
            generation: Generation::ExcludedEffectless,
            realistic_coverage: Realistic::NotMaterialized,
            effect: None,
        };
    }
    if cause.main_code == 96 {
        return FineCauseSimulationDisposition {
            generation: Generation::TemporaryStatus,
            realistic_coverage: Realistic::NotMaterialized,
            effect: None,
        };
    }

    let internal = cause.main_code == 50
        || matches!(cause.main_code, 62..=64) && cause.id != "traction-unit.train-radio";
    if internal {
        return FineCauseSimulationDisposition {
            generation: Generation::SpontaneousInternal,
            realistic_coverage: Realistic::InternalGapSimulation,
            effect: Some(effect_family(cause)),
        };
    }

    if matches!(
        cause.main_code,
        10 | 12 | 13 | 47 | 48 | 51..=54 | 57 | 58 | 60 | 61 | 68
    ) || matches!(cause.id, "strike.operator" | "weather.vehicle")
    {
        return FineCauseSimulationDisposition {
            generation: Generation::Endogenous,
            realistic_coverage: Realistic::EndogenousGameState,
            effect: Some(effect_family(cause)),
        };
    }
    if matches!(cause.main_code, 30 | 31) {
        return FineCauseSimulationDisposition {
            generation: Generation::PlannedModel,
            realistic_coverage: Realistic::InfrastructureSource,
            effect: Some(effect_family(cause)),
        };
    }
    if cause.main_code == 90 {
        return FineCauseSimulationDisposition {
            generation: Generation::ScenarioOrProvider,
            realistic_coverage: Realistic::InfrastructureSource,
            effect: Some(FineCauseEffectFamily::Capacity),
        };
    }

    FineCauseSimulationDisposition {
        generation: Generation::SpontaneousInfrastructure,
        realistic_coverage: Realistic::InfrastructureSource,
        effect: Some(effect_family(cause)),
    }
}

fn effect_family(cause: &FineCauseCode) -> FineCauseEffectFamily {
    match cause.id {
        "timetable.platform-length" | "station.platform" => {
            FineCauseEffectFamily::PlatformEligibility
        }
        "timetable.vehicle-parameters"
        | "load.shifted"
        | "load.unsecured"
        | "load.documents"
        | "load.opening"
        | "load.lost"
        | "weather.vehicle" => FineCauseEffectFamily::VehicleEligibility,
        "dwell.passenger-volume"
        | "dwell.accessibility"
        | "dwell.passenger-behavior"
        | "dwell.dispatch"
        | "loading.catering"
        | "loading.cleaning"
        | "loading.animals"
        | "operator-no-report.dwell" => FineCauseEffectFamily::Dwell,
        "station.lift" | "station.accessibility" => FineCauseEffectFamily::Dwell,
        _ if matches!(cause.main_code, 60..=64) => FineCauseEffectFamily::VehicleEligibility,
        _ if matches!(
            cause.main_code,
            20 | 22 | 23 | 31 | 32 | 46 | 81 | 82 | 84 | 85 | 90
        ) =>
        {
            FineCauseEffectFamily::Capacity
        }
        _ => FineCauseEffectFamily::RunningTime,
    }
}

/// Öffentlich kommunizierter Abweichungscode aus der Reisendeninformation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PassengerInformationCode {
    /// Kennung im Reisendeninformations-Kontext.
    pub code: u8,
    /// Zugehöriger Kurztext.
    pub label: &'static str,
}

/// Separater Reisendeninformations-Katalog. Diese Codes dürfen nicht als
/// betriebliche Verspätungsursachen verbucht werden.
pub const PASSENGER_INFORMATION_CATALOG: &[PassengerInformationCode] =
    &[PassengerInformationCode {
        code: 78,
        label: "Ersatzverkehr mit Bus ist eingerichtet",
    }];
