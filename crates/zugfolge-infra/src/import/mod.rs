//! Import-Pipeline OSM-PBF → Rohgraph — **M1.2**.
//!
//! Liest einen genehmigten OSM-PBF-Extract (`docs/rechte.md`, Quelle
//! `osm-pbf-lhe`) und baut daraus einen [`RawGraph`]: Topologie, Geometrie
//! und Tags, roh und ungefiltert. Was daraus ein spielbares Netz macht —
//! Spurweitenfilter, Netzausschlussliste, Blockableitung, Fahrstraßen — ist
//! bewusst **nicht** hier: Das sind M1.3 und danach, und jede dieser Stufen
//! braucht den vollen Rohgraphen als Eingabe, nicht schon eine Vorauswahl.
//!
//! ## Aufbau
//!
//! | Datei | Zuständigkeit |
//! |-------|----------------|
//! | `proto` | der Protobuf-Ausschnitt: Varint, Zickzack, Feldleser |
//! | `blob` | der Blob-Rahmen der Datei: `BlobHeader`, `Blob`, zlib-Entpacken |
//! | `block` | Blockinhalt: `HeaderBlock`-Prüfung, `PrimitiveBlock`-Zerlegung |
//! | `element` | ein einzelner OSM-Knoten oder -Weg aus seinen Bytes |
//! | `topology` | der [`RawGraph`] selbst: welcher Knoten bedeutsam wird |
//! | `pipeline` | [`import_pbf`] — verbindet alles zu einem Aufruf |
//!
//! Jede Stufe liest nur, was die vorherige bereits geprüft hat — ein
//! defekter Extract fällt so an der frühestmöglichen Stelle auf, mit einer
//! Meldung, die sagt, welche Erwartung er verletzt hat.

mod blob;
mod block;
mod element;
mod error;
mod pipeline;
mod proto;
mod topology;

pub use element::{OsmNode, OsmNodeId, OsmWay, OsmWayId};
pub use error::ImportError;
pub use pipeline::{PbfDocument, import_pbf, import_pbf_document};
pub use topology::{RawEdge, RawEdgeId, RawGraph, RawNode};
