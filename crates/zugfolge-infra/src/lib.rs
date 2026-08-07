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
//! geglättetes Neigungsprofil um, wie es [`Track::builder`] erwartet. Was
//! daraus ein spielbares Netz macht, ist Aufgabe der folgenden Schritte:
//!
//! ## Was hier bewusst noch nicht steht
//!
//! | Fehlt | Gehört nach |
//! |-------|-------------|
//! | Blockabschnitte, virtuelle Blöcke, Qualitätsklassifizierung A/B/C je Block | M1.6 |
//! | Weichen, Fahrstraßen, Durchrutschwege, Ausschlussmengen | M1.7 |
//! | Anlagenkataster | M1.11 |
//! | `InfraRelease` als versioniertes Artefakt | M1.12 |
//!
//! Das Modell ist auf alle vier vorbereitet, nimmt aber keines vorweg. Ein
//! Blockabschnitt ist **kein** Gleis, und eine Fahrstraße ist keine Kante — wer
//! sie hier unterbrächte, müsste sie in M1.6 und M1.7 wieder herausoperieren.
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
mod canonical;
mod coverage;
mod edge;
mod electrification;
mod elevation;
mod error;
mod example;
mod graph;
mod identity;
mod import;
mod network_filter;
mod operating_point;
mod platform;
mod protection;
mod provenance;
mod speed;
mod track;
mod units;

pub use bands::{Band, BandProfile};
pub use coverage::{
    AchievableSection, AttributeCoverage, CoverageReport, QualityClass, TrackCoverage,
};
pub use edge::{TrackEdge, TravelDirection};
pub use electrification::{Electrification, PowerSystem};
pub use elevation::{DEFAULT_MIN_BAND_LENGTH, ElevationSample, derive_gradient_profile};
pub use error::InfraError;
pub use example::reference_network;
pub use graph::{OperatingGraph, OperatingGraphBuilder};
pub use identity::{OperatingPointCode, OperatingPointId, PlatformId, TrackEdgeId, TrackId};
pub use import::{
    ImportError, OsmNodeId, OsmWayId, RawEdge, RawEdgeId, RawGraph, RawNode, import_pbf,
};
pub use network_filter::{
    EXCLUDED_RAILWAY_VALUES, ExclusionReason, NetworkFilterOutcome, classify, filter_network,
};
pub use operating_point::{Coordinate, OperatingPoint, OperatingPointKind};
pub use platform::Platform;
pub use protection::{ProtectionSystem, TrainProtection};
pub use provenance::{Attributed, Confidence, Provenance, SourceId};
pub use speed::{SpeedCategory, SpeedLimit};
pub use track::{Track, TrackBuilder, TrackDirection, TrackGauge, TrackKind, TrackOwner};
pub use units::{Gradient, Length, Speed};
