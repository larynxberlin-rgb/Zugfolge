//! Versionierter Fahrzeugkatalog — **M5.1**.
//!
//! Der Katalog trennt die faktische Baureihenbezeichnung vom erfundenen
//! Handelsnamen (E6), führt den belegten Bauzeitraum und beschreibt die drei
//! Beschaffungswege getrennt. Reale Marktfenster und spielerisch geschätzte
//! Leasing-/Gebrauchtfenster bleiben unterscheidbar.
//!
//! Zugsicherung wird nicht als pauschales Häkchen modelliert: Serienausrüstung
//! ist immer vorhanden. Eine nur teilweise belegte Ausrüstung wird dagegen
//! als zeitgebundene Werksoption oder als zeitgebundener Werkstattumbau am
//! **genauen Fahrzeugtyp** freigegeben. Die Entscheidung, ob sie tatsächlich
//! eingebaut wird, fällt damit beim Kauf beziehungsweise in der Werkstatt.

use core::convert::Infallible;
use core::fmt;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;

use zugfolge_determinism::{DeterministicModel, SimTime, StateHash, StateHasher};
use zugfolge_infra::{FleetClass, ProtectionSystem};

/// Stabile Kennung eines Fahrzeugtyps im Katalog.
pub type VehicleTypeId = u64;

/// Letztes Jahr, das für eine offene spielerische Fortschreibung verwendet wird.
pub const OPEN_ENDED_YEAR: u16 = 9_999;

/// Beidseitig eingeschlossener Jahresbereich.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct YearRange {
    from: u16,
    to: u16,
}

impl YearRange {
    /// Vollständiger, vom Modell darstellbarer Zeitraum.
    pub const ALL: Self = Self {
        from: 1,
        to: OPEN_ENDED_YEAR,
    };

    /// Baut einen nichtleeren, beidseitig eingeschlossenen Bereich.
    pub const fn new(from: u16, to: u16) -> Result<Self, CatalogError> {
        if from == 0 || from > to || to > OPEN_ENDED_YEAR {
            return Err(CatalogError::InvalidYearRange);
        }
        Ok(Self { from, to })
    }

    /// Erstes eingeschlossenes Jahr.
    pub const fn from(self) -> u16 {
        self.from
    }

    /// Letztes eingeschlossenes Jahr.
    pub const fn to(self) -> u16 {
        self.to
    }

    /// Ob das Jahr im Bereich liegt.
    pub const fn contains(self, year: u16) -> bool {
        self.from <= year && year <= self.to
    }

    /// Ob sich zwei Bereiche in mindestens einem Jahr schneiden.
    pub const fn overlaps(self, other: Self) -> bool {
        self.from <= other.to && other.from <= self.to
    }

    /// Ob dieser Bereich einen anderen vollständig enthält.
    pub const fn contains_range(self, other: Self) -> bool {
        self.from <= other.from && other.to <= self.to
    }
}

/// Vordefinierte oder frei zugeschnittene Fahrzeugepoche einer Welt.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum VehicleEra {
    /// Alle darstellbaren Bau- beziehungsweise Beschaffungsjahre.
    All,
    /// Fahrzeuge bis einschließlich 1948.
    Until1948,
    /// Deutsche Teilungszeit von 1949 bis einschließlich 1993.
    Division1949To1993,
    /// Bahnreformzeit von 1994 bis einschließlich 2010.
    RailReform1994To2010,
    /// Gegenwart ab 2011.
    ContemporaryFrom2011,
    /// Benutzerdefinierter, beidseitig eingeschlossener Bereich.
    Years(YearRange),
}

impl VehicleEra {
    /// Der von der Epoche abgedeckte Jahresbereich.
    pub const fn years(self) -> YearRange {
        match self {
            Self::All => YearRange::ALL,
            Self::Until1948 => YearRange { from: 1, to: 1948 },
            Self::Division1949To1993 => YearRange {
                from: 1949,
                to: 1993,
            },
            Self::RailReform1994To2010 => YearRange {
                from: 1994,
                to: 2010,
            },
            Self::ContemporaryFrom2011 => YearRange {
                from: 2011,
                to: OPEN_ENDED_YEAR,
            },
            Self::Years(years) => years,
        }
    }

    /// Ob die Epoche ein bestimmtes Jahr einschließt.
    pub const fn contains(self, year: u16) -> bool {
        self.years().contains(year)
    }
}

/// Weltregeln für Baujahr und Beschaffungsjahr.
///
/// Die beiden Epochen sind absichtlich unabhängig: Eine Gegenwartswelt kann
/// historische Baujahre zulassen, während das aktuelle Beschaffungsjahr dafür
/// nur Leasing und Gebrauchtmarkt öffnet.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleWorldSettings {
    construction_era: VehicleEra,
    procurement_era: VehicleEra,
}

impl VehicleWorldSettings {
    /// Weltregeln mit getrennten Epochen.
    pub const fn new(construction_era: VehicleEra, procurement_era: VehicleEra) -> Self {
        Self {
            construction_era,
            procurement_era,
        }
    }

    /// Welt ohne Epochenfilter.
    pub const fn all_eras() -> Self {
        Self::new(VehicleEra::All, VehicleEra::All)
    }

    /// Zugelassene Baujahre.
    pub const fn construction_era(self) -> VehicleEra {
        self.construction_era
    }

    /// Zugelassene Beschaffungsjahre.
    pub const fn procurement_era(self) -> VehicleEra {
        self.procurement_era
    }

    /// Ob ein konkretes Baujahr zulässig ist.
    pub const fn allows_construction_year(self, year: u16) -> bool {
        self.construction_era.contains(year)
    }

    /// Ob ein konkretes Beschaffungsjahr zulässig ist.
    pub const fn allows_procurement_year(self, year: u16) -> bool {
        self.procurement_era.contains(year)
    }
}

/// Beschaffungsweg eines Fahrzeugs.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ProcurementChannel {
    /// Neubestellung beim Hersteller.
    NewBuild,
    /// Leasing eines bereits konfigurierten Fahrzeugs.
    Leasing,
    /// Kauf eines bereits konfigurierten Gebrauchtfahrzeugs.
    Used,
}

impl ProcurementChannel {
    pub(crate) const fn tag(self) -> &'static str {
        match self {
            Self::NewBuild => "new-build",
            Self::Leasing => "leasing",
            Self::Used => "used",
        }
    }
}

/// Stabile Quellenkennung innerhalb eines Katalog-Releases.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CatalogSourceId(String);

impl CatalogSourceId {
    /// Prüft und übernimmt eine Quellenkennung.
    pub fn new(id: impl Into<String>) -> Result<Self, CatalogError> {
        let id = id.into();
        let valid = !id.is_empty()
            && id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-');
        if !valid {
            return Err(CatalogError::InvalidSourceId);
        }
        Ok(Self(id))
    }

    /// Die Kennung als Text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Eine Katalogquelle mit den Baureihen, für die sie tatsächlich herangezogen wird.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogSource {
    id: CatalogSourceId,
    title: String,
    url: String,
    exact_classes: BTreeSet<FleetClass>,
}

impl CatalogSource {
    /// Baut eine Quelle und bindet sie an genau bezeichnete Baureihen.
    pub fn new(
        id: CatalogSourceId,
        title: impl Into<String>,
        url: impl Into<String>,
        exact_classes: impl IntoIterator<Item = FleetClass>,
    ) -> Result<Self, CatalogError> {
        let title = title.into();
        let url = url.into();
        let exact_classes: BTreeSet<FleetClass> = exact_classes.into_iter().collect();
        if title.trim().is_empty() {
            return Err(CatalogError::EmptySourceTitle);
        }
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(CatalogError::InvalidSourceUrl);
        }
        if exact_classes.is_empty() {
            return Err(CatalogError::SourceWithoutExactClass);
        }
        Ok(Self {
            id,
            title,
            url,
            exact_classes,
        })
    }

    /// Quellenkennung.
    pub const fn id(&self) -> &CatalogSourceId {
        &self.id
    }

    /// Quellentitel.
    pub fn title(&self) -> &str {
        &self.title
    }

    /// Fundstelle.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Ob die Quelle die genaue Baureihe abdeckt.
    pub fn covers(&self, class: &FleetClass) -> bool {
        self.exact_classes.contains(class)
    }
}

/// Beleglage eines Marktfensters.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarketEvidence {
    /// Durch eine oder mehrere Quellen belegtes Marktfenster.
    Documented(BTreeSet<CatalogSourceId>),
    /// Ausdrücklich spielerisch geschätztes Fenster.
    Estimated(String),
}

impl MarketEvidence {
    /// Belegtes Marktfenster aus mindestens einer Quelle.
    pub fn documented(
        source_ids: impl IntoIterator<Item = CatalogSourceId>,
    ) -> Result<Self, CatalogError> {
        let source_ids: BTreeSet<CatalogSourceId> = source_ids.into_iter().collect();
        if source_ids.is_empty() {
            return Err(CatalogError::MissingEvidence);
        }
        Ok(Self::Documented(source_ids))
    }

    /// Spielerisch geschätztes Marktfenster mit nachvollziehbarer Begründung.
    pub fn estimated(rationale: impl Into<String>) -> Result<Self, CatalogError> {
        let rationale = rationale.into();
        if rationale.trim().is_empty() {
            return Err(CatalogError::MissingEstimateRationale);
        }
        Ok(Self::Estimated(rationale))
    }

    /// Ob die Angabe eine Spielannahme und kein behaupteter Fakt ist.
    pub const fn is_estimated(&self) -> bool {
        matches!(self, Self::Estimated(_))
    }
}

/// Zeitgebundene Verfügbarkeit eines Beschaffungswegs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketAvailability {
    channel: ProcurementChannel,
    years: YearRange,
    evidence: MarketEvidence,
}

impl MarketAvailability {
    /// Verfügbarkeit eines Beschaffungswegs.
    pub const fn new(
        channel: ProcurementChannel,
        years: YearRange,
        evidence: MarketEvidence,
    ) -> Self {
        Self {
            channel,
            years,
            evidence,
        }
    }

    /// Beschaffungsweg.
    pub const fn channel(&self) -> ProcurementChannel {
        self.channel
    }

    /// Gültigkeitszeitraum.
    pub const fn years(&self) -> YearRange {
        self.years
    }

    /// Beleglage.
    pub const fn evidence(&self) -> &MarketEvidence {
        &self.evidence
    }

    /// Ob der Weg im genannten Jahr angeboten wird.
    pub const fn is_available(&self, year: u16) -> bool {
        self.years.contains(year)
    }
}

/// Art einer nicht serienmäßigen Zugsicherung.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ProtectionFitment {
    /// Bei der Neubestellung wählbare Werksoption.
    FactoryOption,
    /// Späterer Einbau als ausdrücklicher Werkstattumbau.
    Retrofit,
}

impl ProtectionFitment {
    pub(crate) const fn tag(self) -> &'static str {
        match self {
            Self::FactoryOption => "factory-option",
            Self::Retrofit => "retrofit",
        }
    }
}

/// Belegte, nicht serienmäßige Zugsicherungsoption einer genauen Baureihe.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectionOption {
    system: ProtectionSystem,
    fitment: ProtectionFitment,
    years: YearRange,
    source_ids: BTreeSet<CatalogSourceId>,
}

impl ProtectionOption {
    /// Baut eine belegte Option. Ohne Quelle wird sie nicht freigeschaltet.
    pub fn new(
        system: ProtectionSystem,
        fitment: ProtectionFitment,
        years: YearRange,
        source_ids: impl IntoIterator<Item = CatalogSourceId>,
    ) -> Result<Self, CatalogError> {
        let source_ids: BTreeSet<CatalogSourceId> = source_ids.into_iter().collect();
        if source_ids.is_empty() {
            return Err(CatalogError::MissingEvidence);
        }
        Ok(Self {
            system,
            fitment,
            years,
            source_ids,
        })
    }

    /// Zugsicherungssystem.
    pub const fn system(&self) -> ProtectionSystem {
        self.system
    }

    /// Einbauart.
    pub const fn fitment(&self) -> ProtectionFitment {
        self.fitment
    }

    /// Freigabezeitraum.
    pub const fn years(&self) -> YearRange {
        self.years
    }

    /// Ob der Einbau in diesem Jahr freigegeben ist.
    pub const fn is_available(&self, year: u16) -> bool {
        self.years.contains(year)
    }
}

/// Serienausrüstung und belegte, optionale Zugsicherung eines Fahrzeugtyps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectionEquipment {
    standard: BTreeSet<ProtectionSystem>,
    standard_source_ids: BTreeSet<CatalogSourceId>,
    options: Vec<ProtectionOption>,
}

impl ProtectionEquipment {
    /// Baut eine genaue, belegte Ausrüstungsbeschreibung.
    pub fn new(
        standard: impl IntoIterator<Item = ProtectionSystem>,
        standard_source_ids: impl IntoIterator<Item = CatalogSourceId>,
        mut options: Vec<ProtectionOption>,
    ) -> Result<Self, CatalogError> {
        let standard: BTreeSet<_> = standard.into_iter().collect();
        let standard_source_ids: BTreeSet<CatalogSourceId> =
            standard_source_ids.into_iter().collect();
        if standard.is_empty() || standard_source_ids.is_empty() {
            return Err(CatalogError::MissingStandardProtectionEvidence);
        }
        options.sort_by_key(|option| (option.system, option.fitment, option.years));
        let mut keys = BTreeSet::new();
        for option in &options {
            if standard.contains(&option.system) {
                return Err(CatalogError::OptionDuplicatesStandard);
            }
            if !keys.insert((option.system, option.fitment)) {
                return Err(CatalogError::DuplicateProtectionOption);
            }
        }
        Ok(Self {
            standard,
            standard_source_ids,
            options,
        })
    }

    /// Serienmäßig immer eingebaute Systeme.
    pub fn standard_systems(&self) -> impl Iterator<Item = ProtectionSystem> + '_ {
        self.standard.iter().copied()
    }

    /// Nicht serienmäßige, belegte Optionen.
    pub fn options(&self) -> impl Iterator<Item = &ProtectionOption> {
        self.options.iter()
    }

    /// Ob ein System in irgendeiner belegten Ausführung dieses Typs vorkam.
    pub fn supports_system(&self, system: ProtectionSystem) -> bool {
        self.standard.contains(&system) || self.options.iter().any(|option| option.system == system)
    }

    /// Ob ein System im genannten Jahr als Werksoption bestellbar ist.
    pub fn is_factory_option(&self, system: ProtectionSystem, year: u16) -> bool {
        self.options.iter().any(|option| {
            option.system == system
                && option.fitment == ProtectionFitment::FactoryOption
                && option.is_available(year)
        })
    }

    /// Ob ein System im genannten Jahr als Werkstattumbau freigegeben ist.
    pub fn is_retrofit(&self, system: ProtectionSystem, year: u16) -> bool {
        self.options.iter().any(|option| {
            option.system == system
                && option.fitment == ProtectionFitment::Retrofit
                && option.is_available(year)
        })
    }

    pub(crate) fn historical_installation_is_plausible(
        &self,
        system: ProtectionSystem,
        build_year: u16,
        acquisition_year: u16,
    ) -> bool {
        self.standard.contains(&system)
            || self.options.iter().any(|option| {
                option.system == system
                    && match option.fitment {
                        ProtectionFitment::FactoryOption => option.years.contains(build_year),
                        ProtectionFitment::Retrofit => {
                            option.years.from() <= acquisition_year
                                && build_year <= option.years.to()
                        }
                    }
            })
    }
}

/// Ein Fahrzeugtyp im Release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleCatalogEntry {
    id: VehicleTypeId,
    class_designation: FleetClass,
    trade_name: String,
    construction: YearRange,
    construction_source_ids: BTreeSet<CatalogSourceId>,
    markets: BTreeMap<ProcurementChannel, MarketAvailability>,
    protection: ProtectionEquipment,
}

impl VehicleCatalogEntry {
    /// Baut einen Fahrzeugtyp; releaseweite Eindeutigkeit folgt beim Einfrieren.
    #[allow(
        clippy::too_many_arguments,
        reason = "Katalogkennung, faktische Klasse, fiktiver Name, Bauzeit, Herkunft, Märkte und Zugsicherung sind getrennte Fachwerte"
    )]
    pub fn new(
        id: VehicleTypeId,
        class_designation: FleetClass,
        trade_name: impl Into<String>,
        construction: YearRange,
        construction_source_ids: impl IntoIterator<Item = CatalogSourceId>,
        markets: impl IntoIterator<Item = MarketAvailability>,
        protection: ProtectionEquipment,
    ) -> Result<Self, CatalogError> {
        if id == 0 {
            return Err(CatalogError::InvalidVehicleTypeId);
        }
        let trade_name = trade_name.into();
        if trade_name.trim().is_empty() {
            return Err(CatalogError::EmptyTradeName);
        }
        let construction_source_ids: BTreeSet<CatalogSourceId> =
            construction_source_ids.into_iter().collect();
        if construction_source_ids.is_empty() {
            return Err(CatalogError::MissingEvidence);
        }
        let mut market_map = BTreeMap::new();
        for market in markets {
            if market_map.insert(market.channel, market).is_some() {
                return Err(CatalogError::DuplicateMarketChannel);
            }
        }
        if market_map.is_empty() {
            return Err(CatalogError::MissingMarket);
        }
        if let Some(new_build) = market_map.get(&ProcurementChannel::NewBuild)
            && !construction.contains_range(new_build.years)
        {
            return Err(CatalogError::NewBuildOutsideConstruction);
        }
        for option in protection.options() {
            if option.fitment == ProtectionFitment::FactoryOption
                && !construction.contains_range(option.years)
            {
                return Err(CatalogError::FactoryOptionOutsideConstruction);
            }
        }
        Ok(Self {
            id,
            class_designation,
            trade_name,
            construction,
            construction_source_ids,
            markets: market_map,
            protection,
        })
    }

    /// Stabile Typkennung.
    pub const fn id(&self) -> VehicleTypeId {
        self.id
    }

    /// Faktische Baureihenbezeichnung.
    pub const fn class_designation(&self) -> &FleetClass {
        &self.class_designation
    }

    /// Fiktiver Handelsname nach E6.
    pub fn trade_name(&self) -> &str {
        &self.trade_name
    }

    /// Dokumentierter Bauzeitraum.
    pub const fn construction(&self) -> YearRange {
        self.construction
    }

    /// Marktfenster eines Beschaffungswegs.
    pub fn market(&self, channel: ProcurementChannel) -> Option<&MarketAvailability> {
        self.markets.get(&channel)
    }

    /// Serienausrüstung und belegte Optionen.
    pub const fn protection(&self) -> &ProtectionEquipment {
        &self.protection
    }

    /// Ob dieser Typ unter den Weltregeln in einem Kanal sichtbar ist.
    pub fn is_available(
        &self,
        settings: VehicleWorldSettings,
        channel: ProcurementChannel,
        procurement_year: u16,
    ) -> bool {
        settings.allows_procurement_year(procurement_year)
            && self
                .construction
                .overlaps(settings.construction_era().years())
            && self
                .market(channel)
                .is_some_and(|market| market.is_available(procurement_year))
    }
}

/// Unveränderlicher, versionierter Fahrzeugkatalog.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VehicleCatalogRelease {
    version: String,
    sources: BTreeMap<CatalogSourceId, CatalogSource>,
    vehicles: BTreeMap<VehicleTypeId, VehicleCatalogEntry>,
}

impl VehicleCatalogRelease {
    /// Beginnt einen Release-Erbauer.
    pub fn builder(version: impl Into<String>) -> VehicleCatalogBuilder {
        VehicleCatalogBuilder {
            version: version.into(),
            sources: Vec::new(),
            vehicles: Vec::new(),
        }
    }

    /// Releaseversion.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Fahrzeugtyp nach Kennung.
    pub fn vehicle(&self, id: VehicleTypeId) -> Option<&VehicleCatalogEntry> {
        self.vehicles.get(&id)
    }

    /// Fahrzeugtyp nach faktischer Baureihenbezeichnung.
    pub fn vehicle_by_class(&self, class: &FleetClass) -> Option<&VehicleCatalogEntry> {
        self.vehicles
            .values()
            .find(|vehicle| vehicle.class_designation() == class)
    }

    /// Fahrzeugtypen in stabiler Kennungsreihenfolge.
    pub fn vehicles(&self) -> impl Iterator<Item = &VehicleCatalogEntry> {
        self.vehicles.values()
    }

    /// Zahl der Fahrzeugtypen.
    pub fn vehicle_count(&self) -> usize {
        self.vehicles.len()
    }

    /// Unter den Weltregeln sichtbare Fahrzeugtypen.
    pub fn available_vehicles(
        &self,
        settings: VehicleWorldSettings,
        channel: ProcurementChannel,
        procurement_year: u16,
    ) -> impl Iterator<Item = &VehicleCatalogEntry> {
        self.vehicles
            .values()
            .filter(move |vehicle| vehicle.is_available(settings, channel, procurement_year))
    }

    /// Kanonische Prüfsumme, die eine Welt und jeder Flottensnapshot pinnen.
    pub fn checksum(&self) -> StateHash {
        self.state_hash()
    }
}

impl DeterministicModel for VehicleCatalogRelease {
    type Command = Infallible;

    const SCHEMA: &'static str = "vehicle-catalog/v2";

    fn apply(&mut self, _at: SimTime, command: &Infallible) {
        match *command {}
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        hasher.text("version", &self.version);
        hasher.seq("sources", self.sources.len());
        for source in self.sources.values() {
            hasher
                .text("source-id", source.id.as_str())
                .text("source-title", &source.title)
                .text("source-url", &source.url)
                .seq("source-classes", source.exact_classes.len());
            for class in &source.exact_classes {
                hasher.text("source-class", class.as_str());
            }
        }
        hasher.seq("vehicles", self.vehicles.len());
        for vehicle in self.vehicles.values() {
            hasher
                .uint("vehicle-id", vehicle.id)
                .text("class", vehicle.class_designation.as_str())
                .text("trade-name", &vehicle.trade_name)
                .uint("construction-from", u64::from(vehicle.construction.from))
                .uint("construction-to", u64::from(vehicle.construction.to));
            write_source_ids(
                hasher,
                "construction-sources",
                &vehicle.construction_source_ids,
            );
            hasher.seq("markets", vehicle.markets.len());
            for market in vehicle.markets.values() {
                hasher
                    .text("market-channel", market.channel.tag())
                    .uint("market-from", u64::from(market.years.from))
                    .uint("market-to", u64::from(market.years.to));
                match &market.evidence {
                    MarketEvidence::Documented(source_ids) => {
                        hasher.text("market-evidence", "documented");
                        write_source_ids(hasher, "market-sources", source_ids);
                    }
                    MarketEvidence::Estimated(rationale) => {
                        hasher
                            .text("market-evidence", "estimated")
                            .text("market-rationale", rationale);
                    }
                }
            }
            hasher.seq("standard-protection", vehicle.protection.standard.len());
            for system in &vehicle.protection.standard {
                hasher.text("standard-system", system.tag());
            }
            write_source_ids(
                hasher,
                "standard-protection-sources",
                &vehicle.protection.standard_source_ids,
            );
            hasher.seq("protection-options", vehicle.protection.options.len());
            for option in &vehicle.protection.options {
                hasher
                    .text("option-system", option.system.tag())
                    .text("option-fitment", option.fitment.tag())
                    .uint("option-from", u64::from(option.years.from))
                    .uint("option-to", u64::from(option.years.to));
                write_source_ids(hasher, "option-sources", &option.source_ids);
            }
        }
    }
}

fn write_source_ids(hasher: &mut StateHasher, name: &str, source_ids: &BTreeSet<CatalogSourceId>) {
    hasher.seq(name, source_ids.len());
    for source_id in source_ids {
        hasher.text("source-ref", source_id.as_str());
    }
}

/// Erbauer eines [`VehicleCatalogRelease`].
#[derive(Clone, Debug)]
pub struct VehicleCatalogBuilder {
    version: String,
    sources: Vec<CatalogSource>,
    vehicles: Vec<VehicleCatalogEntry>,
}

impl VehicleCatalogBuilder {
    /// Fügt eine Quelle hinzu; die Aufrufreihenfolge beeinflusst den Release nicht.
    #[must_use]
    pub fn source(mut self, source: CatalogSource) -> Self {
        self.sources.push(source);
        self
    }

    /// Fügt einen Fahrzeugtyp hinzu; die Aufrufreihenfolge beeinflusst den Release nicht.
    #[must_use]
    pub fn vehicle(mut self, vehicle: VehicleCatalogEntry) -> Self {
        self.vehicles.push(vehicle);
        self
    }

    /// Prüft Eindeutigkeit, Quellenbezug und Markt-/Ausrüstungsnachweise.
    pub fn build(self) -> Result<VehicleCatalogRelease, CatalogError> {
        if self.version.trim().is_empty() {
            return Err(CatalogError::EmptyVersion);
        }
        let mut sources = BTreeMap::new();
        for source in self.sources {
            if sources.insert(source.id.clone(), source).is_some() {
                return Err(CatalogError::DuplicateSource);
            }
        }
        let mut vehicles = BTreeMap::new();
        let mut classes = BTreeSet::new();
        let mut trade_names = BTreeSet::new();
        let mut used_sources = BTreeSet::new();
        for vehicle in self.vehicles {
            if !classes.insert(vehicle.class_designation.clone()) {
                return Err(CatalogError::DuplicateClassDesignation);
            }
            if !trade_names.insert(vehicle.trade_name.clone()) {
                return Err(CatalogError::DuplicateTradeName);
            }
            validate_source_refs(
                &sources,
                &vehicle.class_designation,
                &vehicle.construction_source_ids,
                &mut used_sources,
            )?;
            validate_source_refs(
                &sources,
                &vehicle.class_designation,
                &vehicle.protection.standard_source_ids,
                &mut used_sources,
            )?;
            for market in vehicle.markets.values() {
                if let MarketEvidence::Documented(source_ids) = &market.evidence {
                    validate_source_refs(
                        &sources,
                        &vehicle.class_designation,
                        source_ids,
                        &mut used_sources,
                    )?;
                }
            }
            for option in &vehicle.protection.options {
                validate_source_refs(
                    &sources,
                    &vehicle.class_designation,
                    &option.source_ids,
                    &mut used_sources,
                )?;
            }
            let id = vehicle.id;
            if vehicles.insert(id, vehicle).is_some() {
                return Err(CatalogError::DuplicateVehicleTypeId);
            }
        }
        if vehicles.is_empty() {
            return Err(CatalogError::EmptyCatalog);
        }
        if used_sources.len() != sources.len() {
            return Err(CatalogError::UnusedSource);
        }
        Ok(VehicleCatalogRelease {
            version: self.version,
            sources,
            vehicles,
        })
    }
}

fn validate_source_refs(
    sources: &BTreeMap<CatalogSourceId, CatalogSource>,
    class: &FleetClass,
    source_ids: &BTreeSet<CatalogSourceId>,
    used_sources: &mut BTreeSet<CatalogSourceId>,
) -> Result<(), CatalogError> {
    for source_id in source_ids {
        let source = sources.get(source_id).ok_or(CatalogError::UnknownSource)?;
        if !source.covers(class) {
            return Err(CatalogError::SourceDoesNotCoverExactClass);
        }
        used_sources.insert(source_id.clone());
    }
    Ok(())
}

/// Fehler beim Aufbau eines Fahrzeugkatalogs.
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    missing_docs,
    reason = "die selbsterklärenden Varianten sind stabile, maschinenlesbare Diagnosen"
)]
pub enum CatalogError {
    InvalidYearRange,
    InvalidSourceId,
    EmptySourceTitle,
    InvalidSourceUrl,
    SourceWithoutExactClass,
    MissingEvidence,
    MissingEstimateRationale,
    MissingStandardProtectionEvidence,
    OptionDuplicatesStandard,
    DuplicateProtectionOption,
    InvalidVehicleTypeId,
    EmptyTradeName,
    DuplicateMarketChannel,
    MissingMarket,
    NewBuildOutsideConstruction,
    FactoryOptionOutsideConstruction,
    EmptyVersion,
    DuplicateSource,
    DuplicateClassDesignation,
    DuplicateTradeName,
    DuplicateVehicleTypeId,
    UnknownSource,
    SourceDoesNotCoverExactClass,
    UnusedSource,
    EmptyCatalog,
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl Error for CatalogError {}
