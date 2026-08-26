//! Stationsdaten-Anreicherung — **M1.8**.
//!
//! `docs/daten.md` 2 führt OpenStation und StaDa als freigegebene
//! Stationsdatenquellen: Bahnhofskategorie und Ausstattung — Barrierefreiheit,
//! Wetterschutz, Fahrgastinformation und mehr — liegen dort vor. Invariante 8
//! verlangt trotzdem für jeden Import einen konkret gepinnten und
//! rechtegeprüften Snapshot. **M1.8 liefert das Modell und das Verfahren, mit
//! dem eine Betriebsstelle angereichert wird — keinen stillen Import.** Der
//! Deutschlandlauf verwendet OpenStation; StaDa bleibt eine optionale
//! Alternative oder Ergänzung. Der Adapter füllt [`StationEnrichment`]-Werte;
//! an diesem Modul ändert sich dann nichts, genau wie bei der Neigung aus dem
//! Höhenmodell (M1.5).
//!
//! ## Warum je Feld eine eigene Herkunft
//!
//! Eine **Anreicherung** ist keine Ersterfassung: Die Bahnhofskategorie kann
//! aus einer Quelle stammen, die Ausstattung erst später aus einer anderen
//! nachgetragen werden, mit eigenem Vertrauensgrad. [`StationEnrichment`]
//! trägt seine beiden Angaben deshalb als [`Attributed`] statt mit einer
//! einzigen [`Provenance`] für den ganzen Datensatz, wie es
//! [`OperatingPoint`](crate::OperatingPoint) und [`Platform`](crate::Platform)
//! für ihre Ersterfassung tun.
//!
//! ## Was angereichert werden kann
//!
//! Nur eine Betriebsstelle mit planmäßigem Fahrgastwechsel
//! (`OperatingPointKind::allows_passenger_stop`) hat Stationsdaten — an einer
//! Abzweig- oder Blockstelle gibt es keine Station anzureichern. Das prüft
//! [`StationEnrichmentCatalogBuilder::build`] gegen einen fertigen
//! [`OperatingGraph`](crate::OperatingGraph).

use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use crate::error::InfraError;
use crate::graph::OperatingGraph;
use crate::identity::OperatingPointId;
use crate::provenance::Attributed;

/// Die Bahnhofskategorie einer Betriebsstelle mit Fahrgastwechsel.
///
/// Die Einstufung nach Größe und Ausstattungsniveau ist im deutschen SPNV
/// gebräuchlich (Kategorie 1 die größten Fernbahnhöfe, Kategorie 7 die
/// kleinsten Haltepunkte) und wird später zur Bemessungsgrundlage des
/// Stationsentgelts (`docs/daten.md` 4). Die Größenordnung selbst ist
/// Branchenwissen, keine importierte Angabe einer bestimmten Quelle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StationCategory {
    /// Kategorie 1 — die größten Fernverkehrsknoten.
    Category1,
    /// Kategorie 2.
    Category2,
    /// Kategorie 3.
    Category3,
    /// Kategorie 4.
    Category4,
    /// Kategorie 5.
    Category5,
    /// Kategorie 6.
    Category6,
    /// Kategorie 7 — die kleinsten Haltepunkte.
    Category7,
}

impl StationCategory {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Category1 => "category-1",
            Self::Category2 => "category-2",
            Self::Category3 => "category-3",
            Self::Category4 => "category-4",
            Self::Category5 => "category-5",
            Self::Category6 => "category-6",
            Self::Category7 => "category-7",
        }
    }

    /// Die Kategorienummer, 1 bis 7.
    pub const fn rank(self) -> u8 {
        match self {
            Self::Category1 => 1,
            Self::Category2 => 2,
            Self::Category3 => 3,
            Self::Category4 => 4,
            Self::Category5 => 5,
            Self::Category6 => 6,
            Self::Category7 => 7,
        }
    }
}

impl fmt::Display for StationCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Kategorie {}", self.rank())
    }
}

/// Ein einzelnes Ausstattungsmerkmal einer Station.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StationAmenity {
    /// Stufenfreier Zugang zu allen Bahnsteigen.
    StepFreeAccess,
    /// Aufzug.
    Elevator,
    /// Rolltreppe.
    Escalator,
    /// Taktiles Leitsystem für blinde und sehbehinderte Fahrgäste.
    TactileGuidanceSystem,
    /// Wetterschutz auf dem Bahnsteig.
    WeatherProtection,
    /// Sitzgelegenheiten auf dem Bahnsteig.
    Seating,
    /// Beleuchtung des Bahnsteigs und der Zugänge.
    Lighting,
    /// Dynamische Fahrgastinformation (Anzeiger in Echtzeit).
    DynamicPassengerInformation,
    /// Lautsprecheranlage für Ansagen.
    PublicAddressSystem,
    /// Öffentliche Toilette.
    Restroom,
    /// Reisezentrum oder Fahrkartenautomat.
    TicketSales,
    /// Fahrradabstellplatz.
    BicycleParking,
}

impl StationAmenity {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::StepFreeAccess => "step-free-access",
            Self::Elevator => "elevator",
            Self::Escalator => "escalator",
            Self::TactileGuidanceSystem => "tactile-guidance-system",
            Self::WeatherProtection => "weather-protection",
            Self::Seating => "seating",
            Self::Lighting => "lighting",
            Self::DynamicPassengerInformation => "dynamic-passenger-information",
            Self::PublicAddressSystem => "public-address-system",
            Self::Restroom => "restroom",
            Self::TicketSales => "ticket-sales",
            Self::BicycleParking => "bicycle-parking",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::StepFreeAccess => "stufenfreier Zugang",
            Self::Elevator => "Aufzug",
            Self::Escalator => "Rolltreppe",
            Self::TactileGuidanceSystem => "taktiles Leitsystem",
            Self::WeatherProtection => "Wetterschutz",
            Self::Seating => "Sitzgelegenheit",
            Self::Lighting => "Beleuchtung",
            Self::DynamicPassengerInformation => "dynamische Fahrgastinformation",
            Self::PublicAddressSystem => "Lautsprecheranlage",
            Self::Restroom => "WC",
            Self::TicketSales => "Reisezentrum",
            Self::BicycleParking => "Fahrradabstellplatz",
        }
    }
}

impl fmt::Display for StationAmenity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.label())
    }
}

/// Die Ausstattung einer Station.
///
/// Eine Menge unabhängiger Merkmale, keine Rangfolge — genau wie
/// [`TrainProtection`](crate::TrainProtection) auf der Strecke. Die
/// Reihenfolge ist geordnet (`BTreeSet`), damit ein späterer Fingerabdruck
/// nicht an der Einfügereihenfolge hängt.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StationAmenities {
    features: BTreeSet<StationAmenity>,
}

impl StationAmenities {
    /// Eine Station ohne ein einziges erfasstes Ausstattungsmerkmal.
    ///
    /// Kein Fehlerfall: Ein kleiner Haltepunkt hat regelmäßig keine
    /// gesonderte Ausstattung.
    pub fn none() -> Self {
        Self::default()
    }

    /// Ausstattung aus einer Aufzählung von Merkmalen.
    pub fn from_features(features: impl IntoIterator<Item = StationAmenity>) -> Self {
        Self {
            features: features.into_iter().collect(),
        }
    }

    /// Die Merkmale in fester Reihenfolge.
    pub fn features(&self) -> impl Iterator<Item = StationAmenity> + '_ {
        self.features.iter().copied()
    }

    /// Anzahl der Merkmale.
    pub fn count(&self) -> usize {
        self.features.len()
    }

    /// Ob ein bestimmtes Merkmal vorhanden ist.
    pub fn has(&self, feature: StationAmenity) -> bool {
        self.features.contains(&feature)
    }
}

impl fmt::Display for StationAmenities {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.features.is_empty() {
            return formatter.write_str("ohne erfasste Ausstattung");
        }
        let mut erstes = true;
        for feature in &self.features {
            if !erstes {
                formatter.write_str(", ")?;
            }
            formatter.write_str(feature.label())?;
            erstes = false;
        }
        Ok(())
    }
}

/// Die Stationsdaten einer einzelnen Betriebsstelle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StationEnrichment {
    operating_point: OperatingPointId,
    category: Attributed<StationCategory>,
    amenities: Attributed<StationAmenities>,
}

impl StationEnrichment {
    /// Stationsdaten für eine Betriebsstelle.
    pub const fn new(
        operating_point: OperatingPointId,
        category: Attributed<StationCategory>,
        amenities: Attributed<StationAmenities>,
    ) -> Self {
        Self {
            operating_point,
            category,
            amenities,
        }
    }

    /// Die angereicherte Betriebsstelle.
    pub const fn operating_point(&self) -> OperatingPointId {
        self.operating_point
    }

    /// Die Bahnhofskategorie mit ihrer Herkunft.
    pub const fn category(&self) -> &Attributed<StationCategory> {
        &self.category
    }

    /// Die Ausstattung mit ihrer Herkunft.
    pub const fn amenities(&self) -> &Attributed<StationAmenities> {
        &self.amenities
    }
}

/// Der geprüfte Bestand an Stationsdaten einer Welt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StationEnrichmentCatalog {
    entries: BTreeMap<OperatingPointId, StationEnrichment>,
}

impl StationEnrichmentCatalog {
    /// Beginnt den Bau eines Stationsdatenbestands.
    pub fn builder() -> StationEnrichmentCatalogBuilder {
        StationEnrichmentCatalogBuilder::default()
    }

    /// Die Stationsdaten einer Betriebsstelle, falls vorhanden.
    pub fn get(&self, operating_point: OperatingPointId) -> Option<&StationEnrichment> {
        self.entries.get(&operating_point)
    }

    /// Alle Einträge, nach Betriebsstelle geordnet.
    pub fn entries(&self) -> impl Iterator<Item = &StationEnrichment> {
        self.entries.values()
    }

    /// Anzahl der angereicherten Betriebsstellen.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Ob kein einziger Eintrag vorliegt.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Der Erbauer eines [`StationEnrichmentCatalog`].
#[derive(Clone, Debug, Default)]
pub struct StationEnrichmentCatalogBuilder {
    entries: Vec<StationEnrichment>,
}

impl StationEnrichmentCatalogBuilder {
    /// Ein leerer Erbauer.
    pub fn new() -> Self {
        Self::default()
    }

    /// Nimmt Stationsdaten auf.
    #[must_use]
    pub fn entry(mut self, enrichment: StationEnrichment) -> Self {
        self.entries.push(enrichment);
        self
    }

    /// Prüft alle Einträge gegen einen fertigen Betriebsgraphen und baut den
    /// Bestand.
    ///
    /// # Errors
    ///
    /// - [`InfraError::DuplicateStationEnrichment`], wenn eine Betriebsstelle
    ///   zweimal angereichert wird.
    /// - [`InfraError::UnknownEnrichmentPoint`], wenn die Betriebsstelle im
    ///   Graphen nicht existiert.
    /// - [`InfraError::EnrichmentWithoutPassengerStop`], wenn die
    ///   Betriebsstelle keinen planmäßigen Fahrgastwechsel hat.
    pub fn build(self, graph: &OperatingGraph) -> Result<StationEnrichmentCatalog, InfraError> {
        let mut entries: BTreeMap<OperatingPointId, StationEnrichment> = BTreeMap::new();
        for enrichment in self.entries {
            let operating_point = enrichment.operating_point();
            let Some(punkt) = graph.operating_point(operating_point) else {
                return Err(InfraError::UnknownEnrichmentPoint(operating_point));
            };
            if !punkt.kind().allows_passenger_stop() {
                return Err(InfraError::EnrichmentWithoutPassengerStop(operating_point));
            }
            if entries.insert(operating_point, enrichment).is_some() {
                return Err(InfraError::DuplicateStationEnrichment(operating_point));
            }
        }
        Ok(StationEnrichmentCatalog { entries })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        StationAmenities, StationAmenity, StationCategory, StationEnrichment,
        StationEnrichmentCatalog,
    };
    use crate::bands::BandProfile;
    use crate::edge::TrackEdge;
    use crate::electrification::Electrification;
    use crate::error::InfraError;
    use crate::example::reference_network;
    use crate::graph::OperatingGraph;
    use crate::identity::{OperatingPointCode, OperatingPointId, TrackEdgeId, TrackId};
    use crate::operating_point::{Coordinate, OperatingPoint, OperatingPointKind};
    use crate::protection::TrainProtection;
    use crate::provenance::{Attributed, Confidence, Provenance, SourceId};
    use crate::speed::SpeedLimit;
    use crate::track::{Track, TrackOwner};
    use crate::units::{Gradient, Length, Speed};

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            confidence,
        )
    }

    /// Ein Gleis mit gleichmäßigen, vollständigen Profilen.
    fn gleis(id: u32, owner: TrackOwner, length: Length) -> Track {
        Track::builder(TrackId::new(id), owner, "Gleis 1", length)
            .speed(
                BandProfile::uniform(
                    "vmax",
                    length,
                    SpeedLimit::uniform(Speed::from_km_h(80)).expect("positiv"),
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .gradient(
                BandProfile::uniform(
                    "neigung",
                    length,
                    Gradient::LEVEL,
                    herkunft(Confidence::Derived),
                )
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
                    TrainProtection::unprotected(),
                    herkunft(Confidence::Surveyed),
                )
                .expect("Profil deckt das Gleis"),
            )
            .build()
            .expect("gültiges Gleis")
    }

    /// Ein Minimalnetz aus einer Station und einer Abzweigstelle ohne
    /// Fahrgastwechsel — für den Fehlerfall, den das Beispielnetz nicht zeigen
    /// kann, weil dort jede Betriebsstelle Fahrgastwechsel hat.
    fn minimalnetz() -> OperatingGraph {
        let laenge = Length::from_metres(1_000);
        OperatingGraph::builder()
            .operating_point(
                OperatingPoint::new(
                    OperatingPointId::new(1),
                    OperatingPointCode::new("ST").expect("gültiges Kürzel"),
                    "Station",
                    OperatingPointKind::Station,
                    Coordinate::new(513_000_000, 123_000_000).expect("Punkt liegt auf der Erde"),
                    herkunft(Confidence::Surveyed),
                )
                .expect("gültige Betriebsstelle"),
            )
            .operating_point(
                OperatingPoint::new(
                    OperatingPointId::new(2),
                    OperatingPointCode::new("AB").expect("gültiges Kürzel"),
                    "Abzweig",
                    OperatingPointKind::Junction,
                    Coordinate::new(513_100_000, 123_100_000).expect("Punkt liegt auf der Erde"),
                    herkunft(Confidence::Surveyed),
                )
                .expect("gültige Betriebsstelle"),
            )
            .edge(
                TrackEdge::new(
                    TrackEdgeId::new(1),
                    OperatingPointId::new(1),
                    OperatingPointId::new(2),
                    "Station – Abzweig",
                    laenge,
                    herkunft(Confidence::Surveyed),
                )
                .expect("gültige Kante"),
            )
            .track(gleis(1, TrackOwner::Edge(TrackEdgeId::new(1)), laenge))
            .track(gleis(
                2,
                TrackOwner::OperatingPoint(OperatingPointId::new(1)),
                Length::from_metres(200),
            ))
            .track(gleis(
                3,
                TrackOwner::OperatingPoint(OperatingPointId::new(2)),
                Length::from_metres(200),
            ))
            .build()
            .expect("gültiges Minimalnetz")
    }

    fn nordstadt() -> StationEnrichment {
        StationEnrichment::new(
            OperatingPointId::new(1),
            Attributed::new(StationCategory::Category3, herkunft(Confidence::Surveyed)),
            Attributed::new(
                StationAmenities::from_features([
                    StationAmenity::StepFreeAccess,
                    StationAmenity::TicketSales,
                ]),
                herkunft(Confidence::Derived),
            ),
        )
    }

    #[test]
    fn die_kategorierangfolge_bleibt_lesbar() {
        assert_eq!(StationCategory::Category1.rank(), 1);
        assert_eq!(StationCategory::Category7.rank(), 7);
        assert_eq!(StationCategory::Category3.to_string(), "Kategorie 3");
    }

    #[test]
    fn die_ausstattung_ist_eine_menge() {
        let ausstattung = StationAmenities::from_features([
            StationAmenity::Elevator,
            StationAmenity::StepFreeAccess,
        ]);
        assert_eq!(ausstattung.count(), 2);
        assert!(ausstattung.has(StationAmenity::Elevator));
        assert!(!ausstattung.has(StationAmenity::Escalator));
        assert!(StationAmenities::none().features().next().is_none());
    }

    #[test]
    fn ein_eintrag_traegt_zwei_getrennte_herkuenfte() {
        let eintrag = nordstadt();
        assert_eq!(eintrag.category().value(), &StationCategory::Category3);
        assert_eq!(eintrag.category().confidence(), Confidence::Surveyed);
        // Die Ausstattung ist unabhängig nachgetragen — eigene Herkunft, eigener
        // Vertrauensgrad.
        assert_eq!(eintrag.amenities().confidence(), Confidence::Derived);
    }

    #[test]
    fn der_bestand_haengt_an_stationen_von_nordstadt() {
        let netz = reference_network();
        let bestand = StationEnrichmentCatalog::builder()
            .entry(nordstadt())
            .build(&netz)
            .expect("Nordstadt hat Fahrgastwechsel");

        assert_eq!(bestand.len(), 1);
        let eintrag = bestand
            .get(OperatingPointId::new(1))
            .expect("Nordstadt ist angereichert");
        assert_eq!(eintrag.category().value(), &StationCategory::Category3);
        assert!(bestand.get(OperatingPointId::new(2)).is_none());
    }

    #[test]
    fn eine_unbekannte_betriebsstelle_faellt_auf() {
        let netz = reference_network();
        let eintrag = StationEnrichment::new(
            OperatingPointId::new(99_999),
            Attributed::new(StationCategory::Category7, herkunft(Confidence::Assumed)),
            Attributed::new(StationAmenities::none(), herkunft(Confidence::Assumed)),
        );

        let fehler = StationEnrichmentCatalog::builder()
            .entry(eintrag)
            .build(&netz)
            .expect_err("die Betriebsstelle existiert nicht");
        assert!(matches!(fehler, InfraError::UnknownEnrichmentPoint(_)));
    }

    #[test]
    fn alle_betriebsstellen_des_beispielnetzes_erlauben_fahrgastwechsel() {
        // Station und Halt erlauben beide Fahrgastwechsel — deshalb zeigt das
        // Beispielnetz allein den Fehlerfall nicht; der folgende Test prüft
        // ihn gegen ein Minimalnetz mit einer Abzweigstelle.
        let netz = reference_network();
        for id in [1_u32, 2, 3, 4] {
            let eintrag = StationEnrichment::new(
                OperatingPointId::new(id),
                Attributed::new(StationCategory::Category5, herkunft(Confidence::Assumed)),
                Attributed::new(StationAmenities::none(), herkunft(Confidence::Assumed)),
            );
            StationEnrichmentCatalog::builder()
                .entry(eintrag)
                .build(&netz)
                .unwrap_or_else(|_| panic!("Betriebsstelle {id} hat Fahrgastwechsel"));
        }
    }

    #[test]
    fn eine_abzweigstelle_ohne_fahrgastwechsel_faellt_auf() {
        let netz = minimalnetz();
        let eintrag = StationEnrichment::new(
            OperatingPointId::new(2),
            Attributed::new(StationCategory::Category7, herkunft(Confidence::Assumed)),
            Attributed::new(StationAmenities::none(), herkunft(Confidence::Assumed)),
        );

        let fehler = StationEnrichmentCatalog::builder()
            .entry(eintrag)
            .build(&netz)
            .expect_err("eine Abzweigstelle hat keinen Fahrgastwechsel");
        assert!(matches!(
            fehler,
            InfraError::EnrichmentWithoutPassengerStop(_)
        ));
    }

    #[test]
    fn doppelt_angereicherte_betriebsstellen_fallen_auf() {
        let netz = reference_network();
        let fehler = StationEnrichmentCatalog::builder()
            .entry(nordstadt())
            .entry(nordstadt())
            .build(&netz)
            .expect_err("Nordstadt ist zweimal angereichert");
        assert!(matches!(fehler, InfraError::DuplicateStationEnrichment(_)));
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(
            StationAmenities::from_features([StationAmenity::Elevator]).to_string(),
            "Aufzug"
        );
        assert_eq!(
            StationAmenities::none().to_string(),
            "ohne erfasste Ausstattung"
        );
    }
}
