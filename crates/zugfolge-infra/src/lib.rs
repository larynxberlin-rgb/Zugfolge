//! Das Domänenmodell des Betriebsgraphen — **M1.1**.
//!
//! Betriebsstellen, Kanten, Gleise, Bahnsteige, Elektrifizierung,
//! Zugsicherung, Vmax-Bänder und Neigung. Es ist die Grundlage, auf der der
//! Rest von M1 aufsetzt: Der Import (M1.2) füllt dieses Modell, der Netzfilter
//! (M1.3) wirft aus ihm heraus, was nicht zur EBO gehört, die Abdeckungsmessung
//! (M1.4) liest seine Vertrauensgrade, und der `InfraRelease` (M1.12) friert es
//! ein.
//!
//! ## Die drei Gedanken, die das Modell tragen
//!
//! **Erstens: Gefahren wird auf Gleisen, nicht auf Kanten.** Eine Kante ist die
//! Verbindung zweier Betriebsstellen, ein Gleis ist das, was ein Zug befährt.
//! Ob zwei Züge auf einem Abschnitt in den Zugfolgefall oder in eine Gegenfahrt
//! geraten, entscheidet dadurch die Infrastruktur allein — über die
//! Richtungsbindung des Gleises. Das ist der Befund des Spikes aus M0.3, und er
//! steht hier als Datenmodell statt als Regel.
//!
//! **Zweitens: Attribute sind Bänder.** Vmax, Neigung, Elektrifizierung und
//! Zugsicherung ändern sich entlang eines Gleises. Sie stehen deshalb als
//! [`BandProfile`] da, das sein Gleis lückenlos abdeckt — geprüft beim Bau, ein
//! für alle Mal. Ein Abschnitt ohne zulässige Geschwindigkeit kann so gar nicht
//! erst entstehen.
//!
//! **Drittens: Jeder Wert trägt seine Herkunft.** `docs/daten.md` verlangt
//! Quelle und Confidence je Attribut, und zwar nicht als Schmuck: Der
//! Vertrauensgrad entscheidet in M1.4, welche Strecke Qualitätsklasse A
//! erreichen kann. Deshalb hängt die [`Provenance`] am einzelnen Band, nicht am
//! Gleis — eine erfasste Geschwindigkeit und eine abgeleitete Neigung sind
//! nicht gleich viel wert.
//!
//! Der Import aus OSM-PBF steht seit M1.2 in [`import_pbf`] — er füllt einen
//! eigenen [`RawGraph`], noch keinen [`OperatingGraph`]. Der Netzfilter aus
//! M1.3 ([`filter_network`]) wählt daraus das EBO-Netz aus, wieder als
//! [`RawGraph`]. Die Abdeckungsmessung aus M1.4 ([`CoverageReport`]) liest die
//! Vertrauensgrade eines fertigen [`OperatingGraph`] und sagt je Attribut und
//! Streckenabschnitt, welche Qualitätsklasse er datenseitig erreichen kann.
//! Und [`derive_gradient_profile`] aus M1.5 rechnet Höhenstichproben in ein
//! geglättetes Neigungsprofil um, wie es [`Track::builder`] erwartet.
//! [`derive_block_sections`] aus M1.6 leitet die Blockabschnitte eines Gleises
//! aus Signalpositionen, Zugbeeinflussung und Topologie ab — einschließlich der
//! reinen LZB- und ETCS-Blöcke ohne ortsfestes Signal — und
//! [`derive_interlocking_routes`] aus M1.7 erzeugt aus einem [`StationHead`] die
//! Fahrstraßen, Durchrutschwege und Ausschlussmengen eines Bahnhofskopfs.
//! [`StationEnrichmentCatalog`] aus M1.8 bindet Bahnhofskategorie und
//! Ausstattung an eine Betriebsstelle mit Fahrgastwechsel — mit einer eigenen
//! Herkunft je Feld, weil eine Anreicherung keine Ersterfassung ist.
//! [`TrainCharacteristics`] aus M1.9 ist die Zugcharakteristik — Masse, Länge,
//! Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung —, die
//! Fahrzeitrechnung und Trassenplanung vom Fahrzeugkatalog entkoppelt.
//! [`derive_running_time_table`] aus M1.10 rechnet darüber die Fahrdynamik: aus
//! einem [`RunPath`] und einer Zugcharakteristik eine ganzzahlige
//! Fahrzeittabelle — der einzige Ort in diesem Crate, der dafür einmalig mit
//! Gleitkomma rechnet. Und [`FacilityCatalog`] aus M1.11 führt Werkstätten,
//! Behandlungs- und Waschanlagen, Tankstellen, Entsorgungsanlagen und als
//! Anlage geführte Abstellgleise mit Kapazität, Öffnungszeit, Nutzlänge und
//! Baureihenkompetenz.
//!
//! [`InfraRelease`] aus M1.12 friert schließlich einen geprüften
//! [`OperatingGraph`] zu einem **unveränderlichen, versionierten Artefakt** ein
//! — mit Herkunft und Lizenz je Quelle ([`ReleaseSource`]), einer Prüfsumme
//! über das Ganze und der Abdeckung je Attribut ([`CoverageReport`]). Und der
//! [`ReferenceCorpus`] aus M1.13 hält reale Fahrzeiten der Pilotregion, gegen
//! die ein [`DeviationReport`] die aus dem Release berechneten Fahrzeiten
//! innerhalb einer definierten [`Tolerance`] prüft — der Beweis von M1.
//!
//! ## Wie die abgeleiteten Artefakte zum Modell stehen
//!
//! Ein Blockabschnitt ist **kein** Gleis, eine Fahrstraße ist keine Kante, eine
//! Stationsanreicherung ist keine Betriebsstelle und eine Anlage ist kein
//! Gleis — deshalb entstehen sie ab M1.6 als eigene, abgeleitete Artefakte
//! neben dem Modell, nicht als neue Bausteine darin.
//!
//! ## Beispiel
//!
//! ```
//! use zugfolge_infra::{Length, OperatingPointId, TrackId, TravelDirection, reference_network};
//!
//! let netz = reference_network();
//!
//! // Der eingleisige Ast ist in beiden Richtungen befahrbar — genau daraus
//! // entsteht später die Gegenfahrt.
//! let ast = netz.track(TrackId::new(3001)).expect("das eingleisige Gleis");
//! assert!(ast.direction().permits_opposing_moves());
//!
//! // Wer bergauf gefahren ist, fährt zurück bergab.
//! let bei_km_5 = Length::from_metres(5_000);
//! let hinauf = ast.gradient_for(bei_km_5, TravelDirection::WithChainage);
//! let hinab = ast.gradient_for(bei_km_5, TravelDirection::AgainstChainage);
//! assert!(hinauf.is_some_and(|neigung| neigung.is_rising()));
//! assert!(hinab.is_some_and(|neigung| neigung.is_falling()));
//!
//! // Und der Fahrdraht endet mit der Hauptstrecke.
//! assert!(!ast.is_fully_electrified());
//! assert_eq!(netz.neighbours(OperatingPointId::new(1)).count(), 1);
//! ```

mod bands;
mod blocks;
mod canonical;
mod coverage;
mod dynamics;
mod edge;
mod electrification;
mod elevation;
mod error;
mod example;
mod facility;
mod germany_operational_v2;
mod graph;
mod identity;
mod import;
mod interlocking;
mod network_filter;
mod operating_point;
mod operational_streaming;
mod platform;
mod protection;
mod provenance;
mod reference;
mod release;
mod release_manifest;
mod semantic_export;
mod speed;
mod station;
mod track;
mod train;
mod units;

pub use bands::{Band, BandProfile};
pub use blocks::{
    BlockKind, BlockSection, DEFAULT_MAX_BLOCK_LENGTH, Signal, SignalKind, derive_block_sections,
};
pub use coverage::{
    AchievableSection, AttributeCoverage, CoverageReport, QualityClass, TrackCoverage,
};
pub use dynamics::{
    RunPath, RunSegment, RunningTime, RunningTimeCheckpoint, RunningTimeTable,
    derive_running_time_table, derive_running_time_table_with_exit,
};
pub use edge::{TrackEdge, TravelDirection};
pub use electrification::{Electrification, PowerSystem};
pub use elevation::{DEFAULT_MIN_BAND_LENGTH, ElevationSample, derive_gradient_profile};
pub use error::InfraError;
pub use example::reference_network;
pub use facility::{
    Facility, FacilityCatalog, FacilityCatalogBuilder, FacilityKind, FleetClass, FleetCompetence,
    OpeningHours, TimeOfDay,
};
pub use germany_operational_v2::{GermanyOperationalV2Error, derive_germany_operational_v2};
pub use graph::{OperatingGraph, OperatingGraphBuilder};
pub use identity::{
    FacilityId, HeadElementId, HeadNodeId, HeadSignalId, InterlockingRouteId, OperatingPointCode,
    OperatingPointId, PlatformId, SwitchId, TrackEdgeId, TrackId, TrainCharacteristicsId,
};
pub use import::{
    ImportError, OsmNode, OsmNodeId, OsmWay, OsmWayId, PbfDocument, RawEdge, RawEdgeId, RawGraph,
    RawNode, import_pbf, import_pbf_document,
};
pub use interlocking::{
    HeadElement, HeadNode, HeadNodeKind, HeadSignal, InterlockingPlan, InterlockingRoute,
    OverlapPath, RouteDestination, StationHead, StationHeadBuilder, Switch, SwitchPosition,
    derive_interlocking_routes,
};
pub use network_filter::{
    EXCLUDED_RAILWAY_VALUES, ExclusionReason, NetworkFilterOutcome, classify, filter_network,
};
pub use operating_point::{Coordinate, OperatingPoint, OperatingPointKind};
pub use operational_streaming::{
    OperationalInfrastructureV2Store, OperationalStreamingError,
    open_operational_infrastructure_v2_store, validate_operational_infrastructure_v2_file,
};
pub use platform::Platform;
pub use protection::{ProtectionSystem, TrainProtection};
pub use provenance::{Attributed, Confidence, Provenance, SourceId};
pub use reference::{DeviationReport, ReferenceCorpus, ReferenceRun, RunDeviation, Tolerance};
pub use release::{InfraRelease, InfraReleaseBuilder, ReleaseSource, ReleaseVersion};
pub use release_manifest::{
    ReleaseManifestError, build_annual_infra_plan, build_mitteldeutschland_infra_release,
    build_public_infra_release, build_public_infra_release_with_operational_quality,
    build_qualified_reference_release, build_reference_report,
    validate_operational_infrastructure_v2, verify_reference_artifact_chain,
};
pub use semantic_export::{SemanticExportError, SemanticExportSummary, export_semantic_geojsonseq};
pub use speed::{SpeedCategory, SpeedLimit};
pub use station::{
    StationAmenities, StationAmenity, StationCategory, StationEnrichment, StationEnrichmentCatalog,
    StationEnrichmentCatalogBuilder,
};
pub use track::{Track, TrackBuilder, TrackDirection, TrackGauge, TrackKind, TrackOwner};
pub use train::{ElectricSystems, TractionType, TrainCharacteristics};
pub use units::{Acceleration, Force, Gradient, Length, Mass, Power, Speed};
