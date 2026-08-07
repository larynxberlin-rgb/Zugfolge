//! Die Fehler der Import-Pipeline.
//!
//! Anders als [`crate::InfraError`] sind das nicht nur Aussagen über
//! fachlich falsche Daten, sondern auch über ein beschädigtes oder
//! unvollständig verstandenes Eingabeformat — ein PBF-Extract kann
//! abgeschnitten sein, eine Blockart nutzen, die dieser Leser nicht kennt,
//! oder auf einen Knoten verweisen, den der Extract nicht enthält. Jede
//! Variante bleibt so genau, dass sie den Fund einer defekten oder
//! unvollständigen Quelle von einem echten Programmfehler unterscheidbar
//! macht.

use core::fmt;
use std::io;

use crate::error::InfraError;
use crate::import::element::{OsmNodeId, OsmWayId};

/// Was beim Import eines OSM-PBF-Extracts schiefgehen kann.
#[derive(Debug)]
#[non_exhaustive]
pub enum ImportError {
    /// Lesefehler auf dem zugrundeliegenden Datenstrom.
    Io(io::Error),
    /// Die Eingabe endet, wo noch Daten erwartet wurden.
    Truncated,
    /// Ein Varint ist länger als 64 Bit — kein gültiges Protobuf-Feld.
    MalformedVarint,
    /// Ein Drahttyp, den das PBF-Format nicht kennt.
    UnsupportedWireType(u64),
    /// Eine Protobuf-Struktur verletzt eine Annahme, die über den reinen
    /// Drahttyp hinausgeht — etwa eine Feldnummer, die nicht in `u32` passt.
    MalformedProtobuf {
        /// Wo im Ablauf der Fund auftrat.
        context: &'static str,
    },
    /// Ein Textfeld ist kein gültiges UTF-8.
    InvalidText,
    /// Ein Block trägt eine andere Art, als an dieser Stelle der Datei
    /// erwartet wurde.
    UnexpectedBlockType {
        /// Die erwartete Art.
        expected: &'static str,
        /// Die tatsächlich gefundene Art.
        found: String,
    },
    /// Ein Block ist auf eine Weise komprimiert, die dieser Leser nicht
    /// entpackt — nur `zlib` und unkomprimiert (`raw`) sind eingelöst.
    UnsupportedCompression,
    /// Das Entpacken eines `zlib`-komprimierten Blocks ist fehlgeschlagen.
    Decompression,
    /// Die Kopfzeile verlangt ein Merkmal, das dieser Leser nicht versteht.
    ///
    /// `required_features` ist die Stelle, an der ein PBF-Schreiber neue,
    /// mit alten Lesern unverträgliche Kodierungen ankündigt. Ein Leser, der
    /// ein unbekanntes Pflichtmerkmal ignoriert, würde still falsch lesen —
    /// deshalb ist das ein Fehler und keine Warnung.
    UnsupportedFeature(String),
    /// Elemente außerhalb von `DenseNodes` — reale Extracts der
    /// Pilotregion nutzen ausnahmslos `DenseNodes`; ein Extract mit
    /// einzeln kodierten Knoten bräuchte einen eigenen, hier bewusst noch
    /// nicht eingelösten Zweig.
    UnsupportedElementEncoding(&'static str),
    /// Eine Koordinate liegt außerhalb des gültigen Bereichs.
    Coordinate(InfraError),
    /// Ein Weg referenziert einen Knoten, den der Extract nicht enthält.
    ///
    /// Das ist der erwartbare Fund an einer unvollständig geschnittenen
    /// Extract-Grenze — der genehmigte Extract der Pilotregion schneidet
    /// vollständige Wege (`docs/rechte.md` 3), ein Fund hier ist deshalb ein
    /// Hinweis auf einen falschen oder beschädigten Extract, kein Normalfall.
    DanglingNodeReference {
        /// Der Weg, der den Verweis trägt.
        way: OsmWayId,
        /// Der fehlende Knoten.
        node: OsmNodeId,
    },
    /// Ein railway-getaggter Weg hat weniger als zwei Knoten und beschreibt
    /// damit keine Geometrie.
    DegenerateWay(OsmWayId),
    /// Eine ganzzahlige Rechnung wäre über- oder unterlaufen.
    NumericOverflow {
        /// Wo im Ablauf die Rechnung stand.
        context: &'static str,
    },
}

impl fmt::Display for ImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(fehler) => write!(formatter, "Lesefehler: {fehler}"),
            Self::Truncated => formatter.write_str(
                "Eingabe endet, wo noch Daten erwartet wurden — abgeschnittener Extract",
            ),
            Self::MalformedVarint => {
                formatter.write_str("Varint länger als 64 Bit — kein gültiges Protobuf")
            }
            Self::UnsupportedWireType(wert) => {
                write!(formatter, "unbekannter Drahttyp {wert} — kein PBF-Feld")
            }
            Self::MalformedProtobuf { context } => {
                write!(formatter, "ungültige Protobuf-Struktur bei {context}")
            }
            Self::InvalidText => formatter.write_str("Textfeld ist kein gültiges UTF-8"),
            Self::UnexpectedBlockType { expected, found } => write!(
                formatter,
                "Block vom Typ '{found}' an einer Stelle, an der '{expected}' erwartet wurde"
            ),
            Self::UnsupportedCompression => {
                formatter.write_str("Block ist weder unkomprimiert noch zlib-komprimiert")
            }
            Self::Decompression => formatter.write_str("zlib-Block ließ sich nicht entpacken"),
            Self::UnsupportedFeature(merkmal) => write!(
                formatter,
                "Extract verlangt das Pflichtmerkmal '{merkmal}', das dieser Leser nicht kennt"
            ),
            Self::UnsupportedElementEncoding(art) => {
                write!(
                    formatter,
                    "'{art}' wird von diesem Leser nicht gelesen — nur DenseNodes"
                )
            }
            Self::Coordinate(fehler) => write!(formatter, "{fehler}"),
            Self::DanglingNodeReference { way, node } => write!(
                formatter,
                "Weg {way} verweist auf Knoten {node}, den der Extract nicht enthält"
            ),
            Self::DegenerateWay(way) => {
                write!(
                    formatter,
                    "Weg {way} hat weniger als zwei Knoten und beschreibt keine Geometrie"
                )
            }
            Self::NumericOverflow { context } => write!(formatter, "Zahlenüberlauf bei {context}"),
        }
    }
}

impl core::error::Error for ImportError {}

impl From<io::Error> for ImportError {
    fn from(fehler: io::Error) -> Self {
        Self::Io(fehler)
    }
}

impl From<InfraError> for ImportError {
    fn from(fehler: InfraError) -> Self {
        Self::Coordinate(fehler)
    }
}
