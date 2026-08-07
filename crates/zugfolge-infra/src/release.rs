//! Der `InfraRelease` — **M1.12**.
//!
//! `docs/architektur.md` 3 führt den `InfraRelease` unter den **irreversiblen**
//! Entscheidungen: „versioniert und je Welt gepinnt — ohne Pinning keine
//! reproduzierbare Welt, kein durchsetzbarer Stichtag." M1.12 macht aus dem
//! geprüften [`OperatingGraph`] genau dieses Artefakt: **unveränderlich,
//! versioniert, mit Herkunft, Lizenz, Prüfsumme und Confidence je Attribut**
//! (`docs/milestones.md` M1.12).
//!
//! ## Woraus ein Release besteht
//!
//! | Angabe | Träger | Herkunft im Modell |
//! |--------|--------|--------------------|
//! | Version | [`ReleaseVersion`] | neu in M1.12 |
//! | Herkunft **und** Lizenz je Quelle | [`ReleaseSource`] | Quellenregister (M0.4), `docs/rechte.md` |
//! | Prüfsumme | [`InfraRelease::checksum`] | der kanonische Fingerabdruck des Graphen (M1.1) |
//! | Confidence je Attribut und Abschnitt | [`CoverageReport`] | die Abdeckungsmessung (M1.4) |
//! | das Netz selbst | [`OperatingGraph`] | M1.1 |
//!
//! `docs/daten.md` 2 verlangt es wörtlich: **Jedes importierte Attribut trägt
//! Quelle, Lizenz, Gültigkeit, Checksumme und Confidence.** Quelle und
//! Confidence hängen seit M1.1 am einzelnen Band ([`Provenance`]); Lizenz und
//! Prüfsumme kommen hier dazu. Der Release ist die Stelle, an der sie
//! **zusammengeführt und eingefroren** werden: [`InfraReleaseBuilder::build`]
//! prüft, dass jede vom Netz genutzte Quelle mit einer Lizenz deklariert ist —
//! und dass keine Lizenz ohne Gegenstand deklariert wurde.
//!
//! ## Die Prüfsumme
//!
//! Der Release implementiert [`DeterministicModel`] mit dem Kommandotyp
//! [`Infallible`] — dieselbe Aussage wie beim [`OperatingGraph`]: Er nimmt keine
//! Kommandos entgegen, er ist ein Artefakt und kein Zustand. Seine
//! [`InfraRelease::checksum`] ist der kanonische Zustands-Hash über Version,
//! Region, die deklarierten Quellen **und** den Fingerabdruck des Graphen.
//! Zwei Releases mit demselben Netz, aber verschiedener Version oder Lizenz
//! bekommen dadurch verschiedene Prüfsummen — was richtig ist, denn sie sind
//! verschiedene Releases. Die Abdeckung geht **nicht** eigens in die Prüfsumme
//! ein: Sie ist eine reine Funktion des Graphen und damit schon durch dessen
//! Fingerabdruck festgelegt.

use core::convert::Infallible;
use core::fmt;
use std::collections::{BTreeMap, BTreeSet};

use zugfolge_determinism::{DeterministicModel, SimTime, StateHash, StateHasher};

use crate::canonical::Canonical;
use crate::coverage::CoverageReport;
use crate::error::InfraError;
use crate::graph::OperatingGraph;
use crate::provenance::{Confidence, SourceId};

/// Die Version eines `InfraRelease`, als `major.minor.patch`.
///
/// Eine Version ist unveränderlich: Ein Release wird einmal erzeugt und danach
/// von Welten über Jahre gepinnt zitiert (`docs/daten.md` 5: „Updates erfolgen
/// ausschließlich zu angekündigten Fahrplanstichtagen"). Drei Zahlen genügen —
/// eine Datumsangabe verböte sich ohnehin (`CLAUDE.md`: „Keine Kalenderdaten").
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReleaseVersion {
    major: u32,
    minor: u32,
    patch: u32,
}

impl ReleaseVersion {
    /// Eine Version aus Haupt-, Neben- und Patchnummer.
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Die Hauptnummer.
    pub const fn major(self) -> u32 {
        self.major
    }

    /// Die Nebennummer.
    pub const fn minor(self) -> u32 {
        self.minor
    }

    /// Die Patchnummer.
    pub const fn patch(self) -> u32 {
        self.patch
    }
}

impl fmt::Display for ReleaseVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Canonical for ReleaseVersion {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.uint(name, u64::from(self.major));
        hasher.uint(name, u64::from(self.minor));
        hasher.uint(name, u64::from(self.patch));
    }
}

/// Eine Datenquelle des Release mit ihrer Lizenz.
///
/// Die Quelle selbst ist die Kennung aus dem Quellenregister ([`SourceId`],
/// M0.4). Der Release nennt dazu die **Lizenz** und die **Attribution**, die
/// mit dem Artefakt ausgeliefert werden müssen — bei OSM etwa die ODbL und die
/// Namensnennung der Mitwirkenden (`docs/rechte.md`, Quellenregister-Eintrag
/// `osm-pbf-lhe`). Ob die Quelle **freigegeben** ist, prüft nicht dieses Crate,
/// sondern der Wächter `rights-gate` gegen das Register (Invariante 8); hier
/// steht, unter welcher Lizenz ihre Daten im Release stehen.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReleaseSource {
    id: SourceId,
    license: String,
    attribution: String,
}

impl ReleaseSource {
    /// Eine Quelle mit Kennung, Lizenz und Attribution.
    ///
    /// # Errors
    ///
    /// [`InfraError::ReleaseSourceWithoutLicense`], wenn die Lizenz leer ist —
    /// eine Datenebene ohne benannte Lizenz dürfte gar nicht ausgeliefert
    /// werden (`docs/daten.md` 2).
    pub fn new(
        id: SourceId,
        license: impl Into<String>,
        attribution: impl Into<String>,
    ) -> Result<Self, InfraError> {
        let license = license.into();
        if license.trim().is_empty() {
            return Err(InfraError::ReleaseSourceWithoutLicense(id));
        }
        Ok(Self {
            id,
            license,
            attribution: attribution.into(),
        })
    }

    /// Die Kennung der Quelle.
    pub const fn id(&self) -> &SourceId {
        &self.id
    }

    /// Die Lizenz, unter der die Daten dieser Quelle im Release stehen.
    pub fn license(&self) -> &str {
        &self.license
    }

    /// Die Attribution, die mit dem Release auszuweisen ist.
    pub fn attribution(&self) -> &str {
        &self.attribution
    }
}

impl fmt::Display for ReleaseSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.id, self.license)
    }
}

impl Canonical for ReleaseSource {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.id.write_canonical(name, hasher);
        hasher.text("lizenz", &self.license);
        hasher.text("attribution", &self.attribution);
    }
}

/// Ein unveränderliches, versioniertes Infrastruktur-Release.
///
/// Erzeugt über [`InfraRelease::builder`] und danach nur noch lesbar. Alle
/// Felder sind privat: Ein Release, das sich nachträglich ändern ließe, wäre
/// keine Prüfsumme wert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InfraRelease {
    version: ReleaseVersion,
    region: String,
    graph: OperatingGraph,
    coverage: CoverageReport,
    sources: BTreeMap<SourceId, ReleaseSource>,
}

impl InfraRelease {
    /// Beginnt den Bau eines Release aus Version, Region und geprüftem Netz.
    pub fn builder(
        version: ReleaseVersion,
        region: impl Into<String>,
        graph: OperatingGraph,
    ) -> InfraReleaseBuilder {
        InfraReleaseBuilder {
            version,
            region: region.into(),
            graph,
            sources: Vec::new(),
        }
    }

    /// Die Version.
    pub const fn version(&self) -> ReleaseVersion {
        self.version
    }

    /// Die gepinnte Region, etwa `Leipzig–Halle–Erfurt`.
    pub fn region(&self) -> &str {
        &self.region
    }

    /// Das geprüfte Netz.
    pub const fn graph(&self) -> &OperatingGraph {
        &self.graph
    }

    /// Die Abdeckungsmessung — Confidence je Attribut und Streckenabschnitt
    /// (M1.4).
    pub const fn coverage(&self) -> &CoverageReport {
        &self.coverage
    }

    /// Die Quellen des Release, nach Kennung geordnet.
    pub fn sources(&self) -> impl Iterator<Item = &ReleaseSource> {
        self.sources.values()
    }

    /// Eine Quelle zu ihrer Kennung.
    pub fn source(&self, id: &SourceId) -> Option<&ReleaseSource> {
        self.sources.get(id)
    }

    /// Anzahl der deklarierten Quellen.
    pub fn source_count(&self) -> usize {
        self.sources.len()
    }

    /// Die Prüfsumme des Release — sein kanonischer Fingerabdruck.
    ///
    /// Das ist die Zahl, mit der eine Welt ihren Infrastrukturstand pinnt und
    /// ein Replay ihn wiedererkennt (`docs/architektur.md` 4). Sie deckt
    /// Version, Region, die deklarierten Quellen und den Fingerabdruck des
    /// Graphen ab.
    pub fn checksum(&self) -> StateHash {
        self.state_hash()
    }

    /// Der schwächste Vertrauensgrad über alle Gleisattribute — die eine Zahl
    /// über die Confidence hinweg. Die ortsaufgelöste Sicht liefert
    /// [`InfraRelease::coverage`].
    pub fn confidence(&self) -> Confidence {
        self.graph.confidence()
    }
}

impl DeterministicModel for InfraRelease {
    /// Ein Release nimmt keine Kommandos entgegen — es ist ein unveränderliches
    /// Artefakt, genau wie der [`OperatingGraph`], den es einfriert.
    type Command = Infallible;

    const SCHEMA: &'static str = "infra-release/v1";

    fn apply(&mut self, _at: SimTime, command: &Infallible) {
        match *command {}
    }

    fn write_state(&self, hasher: &mut StateHasher) {
        self.version.write_canonical("version", hasher);
        hasher.text("region", &self.region);

        hasher.seq("quellen", self.sources.len());
        for source in self.sources.values() {
            source.write_canonical("quelle", hasher);
        }

        // Der Fingerabdruck des Graphen ist der Kern der Release-Prüfsumme
        // (M1.1, `betriebsgraph.md` 4). Die Abdeckung geht bewusst nicht eigens
        // ein: Sie ist eine reine Funktion des Graphen und damit schon hier
        // festgelegt.
        hasher.hash("betriebsgraph", self.graph.state_hash());
    }
}

impl fmt::Display for InfraRelease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "InfraRelease {} {} ({})",
            self.region,
            self.version,
            self.checksum()
        )
    }
}

/// Der Erbauer eines [`InfraRelease`].
///
/// Die Reihenfolge der [`InfraReleaseBuilder::source`]-Aufrufe spielt keine
/// Rolle: Geprüft und geordnet wird erst in [`InfraReleaseBuilder::build`].
#[derive(Clone, Debug)]
pub struct InfraReleaseBuilder {
    version: ReleaseVersion,
    region: String,
    graph: OperatingGraph,
    sources: Vec<ReleaseSource>,
}

impl InfraReleaseBuilder {
    /// Deklariert eine Datenquelle mit ihrer Lizenz.
    #[must_use]
    pub fn source(mut self, source: ReleaseSource) -> Self {
        self.sources.push(source);
        self
    }

    /// Prüft Herkunft und Lizenz und friert das Release ein.
    ///
    /// Geprüft wird, dass **jede vom Netz genutzte Quelle** mit einer Lizenz
    /// deklariert ist und dass **keine Quelle ohne Gegenstand** deklariert
    /// wurde — eine Lizenz für eine Quelle, die kein Attribut nennt, wäre eine
    /// Freigabe ins Leere (dieselbe Haltung wie beim Beispielnetz, das gerade
    /// **nicht** im Quellenregister steht).
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn die Region leer ist.
    /// - [`InfraError::DuplicateReleaseSource`], wenn eine Quelle doppelt
    ///   deklariert ist.
    /// - [`InfraError::UndeclaredReleaseSource`], wenn ein Attribut des Netzes
    ///   eine Quelle nennt, die der Release nicht deklariert — dann fehlte ihre
    ///   Lizenz.
    /// - [`InfraError::UnusedReleaseSource`], wenn eine deklarierte Quelle von
    ///   keinem Attribut genutzt wird.
    pub fn build(self) -> Result<InfraRelease, InfraError> {
        if self.region.trim().is_empty() {
            return Err(InfraError::EmptyName {
                what: "Region des InfraRelease",
            });
        }

        let mut sources: BTreeMap<SourceId, ReleaseSource> = BTreeMap::new();
        for source in self.sources {
            let id = source.id().clone();
            if sources.insert(id.clone(), source).is_some() {
                return Err(InfraError::DuplicateReleaseSource(id));
            }
        }

        let used = used_sources(&self.graph);
        for id in &used {
            if !sources.contains_key(id) {
                return Err(InfraError::UndeclaredReleaseSource(id.clone()));
            }
        }
        for id in sources.keys() {
            if !used.contains(id) {
                return Err(InfraError::UnusedReleaseSource(id.clone()));
            }
        }

        let coverage = CoverageReport::measure(&self.graph);

        Ok(InfraRelease {
            version: self.version,
            region: self.region,
            graph: self.graph,
            coverage,
            sources,
        })
    }
}

/// Sammelt jede Quellenkennung, die irgendein Attribut des Netzes nennt —
/// Betriebsstellen, Kanten, alle vier Bandprofile jedes Gleises und Bahnsteige.
fn used_sources(graph: &OperatingGraph) -> BTreeSet<SourceId> {
    let mut sources = BTreeSet::new();
    for point in graph.operating_points() {
        sources.insert(point.provenance().source().clone());
    }
    for edge in graph.edges() {
        sources.insert(edge.provenance().source().clone());
    }
    for track in graph.tracks() {
        for band in track.speed().bands() {
            sources.insert(band.provenance().source().clone());
        }
        for band in track.gradient().bands() {
            sources.insert(band.provenance().source().clone());
        }
        for band in track.electrification().bands() {
            sources.insert(band.provenance().source().clone());
        }
        for band in track.protection().bands() {
            sources.insert(band.provenance().source().clone());
        }
    }
    for platform in graph.platforms() {
        sources.insert(platform.provenance().source().clone());
    }
    sources
}

#[cfg(test)]
mod tests {
    use zugfolge_determinism::DeterministicModel;

    use super::{InfraRelease, ReleaseSource, ReleaseVersion};
    use crate::coverage::QualityClass;
    use crate::error::InfraError;
    use crate::example::reference_network;
    use crate::provenance::{Confidence, SourceId};

    fn beispiel_quelle() -> ReleaseSource {
        ReleaseSource::new(
            SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
            "erfunden — kein Import (docs/betriebsgraph.md 6)",
            "Zugfolge-Beispielnetz",
        )
        .expect("gültige Quelle")
    }

    /// Ein Release aus dem Beispielnetz — dessen einzige Quelle `beispielnetz`
    /// ist, wie `example.rs` festhält.
    fn beispiel_release() -> InfraRelease {
        InfraRelease::builder(
            ReleaseVersion::new(1, 0, 0),
            "Beispielnetz",
            reference_network(),
        )
        .source(beispiel_quelle())
        .build()
        .expect("das Beispielnetz nennt nur die Quelle 'beispielnetz'")
    }

    #[test]
    fn eine_version_zeigt_sich_lesbar() {
        assert_eq!(ReleaseVersion::new(1, 4, 2).to_string(), "1.4.2");
        assert!(ReleaseVersion::new(1, 0, 0) < ReleaseVersion::new(1, 0, 1));
        assert!(ReleaseVersion::new(1, 0, 0) < ReleaseVersion::new(2, 0, 0));
    }

    #[test]
    fn eine_quelle_ohne_lizenz_faellt_auf() {
        let fehler = ReleaseSource::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            "   ",
            "© OpenStreetMap-Mitwirkende",
        )
        .expect_err("eine Datenebene ohne Lizenz darf nicht ausgeliefert werden");
        assert!(matches!(fehler, InfraError::ReleaseSourceWithoutLicense(_)));
    }

    #[test]
    fn ein_release_traegt_version_herkunft_lizenz_und_confidence() {
        let release = beispiel_release();

        assert_eq!(release.version(), ReleaseVersion::new(1, 0, 0));
        assert_eq!(release.region(), "Beispielnetz");
        assert_eq!(release.source_count(), 1);

        let quelle = SourceId::new("beispielnetz").expect("gültige Quellenkennung");
        let quelleneintrag = release.source(&quelle).expect("die Quelle ist deklariert");
        assert!(quelleneintrag.license().contains("kein Import"));

        // Confidence je Attribut — die Abdeckung ist mitgeführt (M1.4). Das
        // Beispielnetz ist überall abgeleitet, weil seine Neigung aus einem
        // Höhenmodell stammt.
        assert_eq!(release.confidence(), Confidence::Derived);
        assert!(
            !release
                .coverage()
                .class_totals()
                .contains_key(&QualityClass::A),
            "abgeleitete Neigung lässt kein Gleis Klasse A erreichen"
        );
    }

    #[test]
    fn die_pruefsumme_haengt_am_netz_und_an_der_version() {
        let release = beispiel_release();
        // Die Prüfsumme ist der Fingerabdruck des Release, nicht der des reinen
        // Graphen: Version und Quellen gehen mit ein.
        assert_ne!(release.checksum(), reference_network().state_hash());
        assert_eq!(release.checksum().to_hex().len(), 64);

        // Dieselben Eingaben ergeben dieselbe Prüfsumme.
        let noch_eins = InfraRelease::builder(
            ReleaseVersion::new(1, 0, 0),
            "Beispielnetz",
            reference_network(),
        )
        .source(beispiel_quelle())
        .build()
        .expect("gültig");
        assert_eq!(release.checksum(), noch_eins.checksum());

        // Eine andere Version ergibt eine andere Prüfsumme.
        let andere_version = InfraRelease::builder(
            ReleaseVersion::new(1, 0, 1),
            "Beispielnetz",
            reference_network(),
        )
        .source(beispiel_quelle())
        .build()
        .expect("gültig");
        assert_ne!(release.checksum(), andere_version.checksum());
    }

    #[test]
    fn eine_genutzte_quelle_ohne_deklaration_faellt_auf() {
        // Das Beispielnetz nutzt 'beispielnetz', der Release deklariert nur
        // 'osm-pbf-lhe' — die genutzte Quelle bliebe ohne Lizenz.
        let fehler = InfraRelease::builder(
            ReleaseVersion::new(1, 0, 0),
            "Beispielnetz",
            reference_network(),
        )
        .source(
            ReleaseSource::new(
                SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
                "ODbL-1.0",
                "© OpenStreetMap-Mitwirkende",
            )
            .expect("gültige Quelle"),
        )
        .build()
        .expect_err("die genutzte Quelle 'beispielnetz' ist nicht deklariert");
        assert!(matches!(fehler, InfraError::UndeclaredReleaseSource(_)));
    }

    #[test]
    fn eine_deklarierte_quelle_ohne_gegenstand_faellt_auf() {
        let fehler = InfraRelease::builder(
            ReleaseVersion::new(1, 0, 0),
            "Beispielnetz",
            reference_network(),
        )
        .source(beispiel_quelle())
        .source(
            ReleaseSource::new(
                SourceId::new("dem-hoehenmodell").expect("gültige Quellenkennung"),
                "Copernicus",
                "",
            )
            .expect("gültige Quelle"),
        )
        .build()
        .expect_err("eine Quelle, die kein Attribut nennt, ist eine Lizenz ins Leere");
        assert!(matches!(fehler, InfraError::UnusedReleaseSource(_)));
    }

    #[test]
    fn eine_doppelte_quelle_faellt_auf() {
        let fehler = InfraRelease::builder(
            ReleaseVersion::new(1, 0, 0),
            "Beispielnetz",
            reference_network(),
        )
        .source(beispiel_quelle())
        .source(beispiel_quelle())
        .build()
        .expect_err("dieselbe Quelle zweimal");
        assert!(matches!(fehler, InfraError::DuplicateReleaseSource(_)));
    }

    #[test]
    fn ein_release_ohne_region_faellt_auf() {
        let fehler = InfraRelease::builder(ReleaseVersion::new(1, 0, 0), "  ", reference_network())
            .source(beispiel_quelle())
            .build()
            .expect_err("ein Release ohne Region ist keiner");
        assert!(matches!(fehler, InfraError::EmptyName { .. }));
    }
}
