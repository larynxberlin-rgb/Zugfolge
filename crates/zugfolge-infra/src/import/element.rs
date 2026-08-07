//! OSM-Elemente — Knoten und Wege, so wie ein `PrimitiveBlock` sie kodiert.
//!
//! Hier steht nur die Übersetzung der PBF-Bytes in fachlich lesbare Werte:
//! Kennung, Koordinate, Tags. Was daraus ein Netz macht — welcher Knoten ein
//! Kreuzungspunkt ist, wie ein Weg in Kanten zerfällt — entscheidet
//! `topology.rs`. Diese Trennung hält den Protobuf-Teil frei von
//! Netzwissen und das Netzwissen frei von Bit-Fummelei.

use core::fmt;
use std::collections::BTreeMap;

use crate::import::error::ImportError;
use crate::import::proto::{ProtoReader, WireType, zigzag_decode};
use crate::operating_point::Coordinate;

/// Die OSM-Kennung eines Knotens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OsmNodeId(i64);

impl OsmNodeId {
    /// Kennung aus ihrem OSM-Zahlwert.
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// Der OSM-Zahlwert.
    pub const fn value(self) -> i64 {
        self.0
    }
}

impl fmt::Display for OsmNodeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "n{}", self.0)
    }
}

/// Die OSM-Kennung eines Wegs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OsmWayId(i64);

impl OsmWayId {
    /// Kennung aus ihrem OSM-Zahlwert.
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// Der OSM-Zahlwert.
    pub const fn value(self) -> i64 {
        self.0
    }
}

impl fmt::Display for OsmWayId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "w{}", self.0)
    }
}

/// Ein OSM-Knoten mit seinen Tags — noch ohne Aussage darüber, ob er im
/// Rohgraph ein eigener Knotenpunkt wird oder nur ein Geometriepunkt bleibt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OsmNode {
    pub(crate) id: OsmNodeId,
    pub(crate) coordinate: Coordinate,
    pub(crate) tags: BTreeMap<String, String>,
}

/// Ein OSM-Weg mit seiner Knotenfolge und seinen Tags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OsmWay {
    pub(crate) id: OsmWayId,
    pub(crate) nodes: Vec<OsmNodeId>,
    pub(crate) tags: BTreeMap<String, String>,
}

/// Löst eine Zeichenkettentabelle auf: `s = 1`, wiederholt, unkodiert.
pub(crate) fn decode_string_table(bytes: &[u8]) -> Result<Vec<String>, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut strings = Vec::new();
    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        if field == 1 && wire_type == WireType::LengthDelimited {
            let bytes = reader.read_length_delimited()?;
            strings.push(
                String::from_utf8(bytes.to_vec()).map_err(|_fehler| ImportError::InvalidText)?,
            );
        } else {
            reader.skip(wire_type)?;
        }
    }
    Ok(strings)
}

fn resolve(table: &[String], index: u64) -> Result<&str, ImportError> {
    let index = usize::try_from(index).map_err(|_wert| ImportError::MalformedProtobuf {
        context: "Zeichenkettenindex überschreitet die Adressbreite",
    })?;
    table
        .get(index)
        .map(String::as_str)
        .ok_or(ImportError::MalformedProtobuf {
            context: "Zeichenkettenindex außerhalb der Tabelle",
        })
}

/// Rechnet ein PBF-Koordinatenfeld (Zehnmillionstel Grad nach Anwendung von
/// `granularity`/Offset, aber hier noch in Nanograd) in Zehnmillionstel Grad
/// um — ganzzahlig, mit kaufmännischer Rundung.
///
/// `granularity` ist bei realen Extracts praktisch immer 100, und dann ist
/// die Umrechnung exakt: 100 Nanograd sind genau ein Zehnmillionstel Grad.
/// Die Rundung greift nur bei einer abweichenden Granularität.
fn nanodegrees_to_e7(offset: i64, granularity: i64, delta: i64) -> Result<i32, ImportError> {
    let scaled = granularity
        .checked_mul(delta)
        .ok_or(ImportError::NumericOverflow {
            context: "Koordinate: granularity * delta",
        })?;
    let nanodegrees = offset
        .checked_add(scaled)
        .ok_or(ImportError::NumericOverflow {
            context: "Koordinate: offset + granularity * delta",
        })?;
    let quotient = nanodegrees / 100;
    let remainder = nanodegrees % 100;
    let rounded = if remainder.abs() * 2 >= 100 {
        quotient
            .checked_add(remainder.signum())
            .ok_or(ImportError::NumericOverflow {
                context: "Koordinate: Rundung",
            })?
    } else {
        quotient
    };
    i32::try_from(rounded).map_err(|_wert| ImportError::NumericOverflow {
        context: "Koordinate überschreitet i32",
    })
}

/// Dekodiert eine `DenseNodes`-Gruppe in einzelne [`OsmNode`]-Werte.
///
/// `id`, `lat` und `lon` sind Delta-kodiert: Jeder Wert ist die Differenz zum
/// vorherigen, nicht der absolute Wert — das hält die Kodierung kurz, weil
/// benachbart importierte Knoten meist benachbarte Kennungen und Lagen haben.
/// `keys_vals` ist eine flache Folge von Schlüssel-/Wert-Indexpaaren je
/// Knoten, durch eine `0` (der Leerstring) je Knoten abgeschlossen.
pub(crate) fn decode_dense_nodes(
    bytes: &[u8],
    string_table: &[String],
    granularity: i64,
    lat_offset: i64,
    lon_offset: i64,
) -> Result<Vec<OsmNode>, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut ids = Vec::new();
    let mut lats = Vec::new();
    let mut lons = Vec::new();
    let mut keys_vals = Vec::new();

    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::LengthDelimited => {
                ids = decode_packed_sint64(reader.read_length_delimited()?)?;
            }
            8 if wire_type == WireType::LengthDelimited => {
                lats = decode_packed_sint64(reader.read_length_delimited()?)?;
            }
            9 if wire_type == WireType::LengthDelimited => {
                lons = decode_packed_sint64(reader.read_length_delimited()?)?;
            }
            10 if wire_type == WireType::LengthDelimited => {
                keys_vals =
                    crate::import::proto::read_packed_varints(reader.read_length_delimited()?)?;
            }
            _ => reader.skip(wire_type)?,
        }
    }

    if ids.len() != lats.len() || ids.len() != lons.len() {
        return Err(ImportError::MalformedProtobuf {
            context: "DenseNodes: id/lat/lon unterschiedlich lang",
        });
    }

    let mut nodes = Vec::with_capacity(ids.len());
    let mut kv_iterator = keys_vals.into_iter();
    let mut id_accumulator: i64 = 0;
    let mut lat_accumulator: i64 = 0;
    let mut lon_accumulator: i64 = 0;

    for index in 0..ids.len() {
        id_accumulator =
            id_accumulator
                .checked_add(ids[index])
                .ok_or(ImportError::NumericOverflow {
                    context: "DenseNodes: id-Delta",
                })?;
        lat_accumulator =
            lat_accumulator
                .checked_add(lats[index])
                .ok_or(ImportError::NumericOverflow {
                    context: "DenseNodes: lat-Delta",
                })?;
        lon_accumulator =
            lon_accumulator
                .checked_add(lons[index])
                .ok_or(ImportError::NumericOverflow {
                    context: "DenseNodes: lon-Delta",
                })?;

        let latitude_e7 = nanodegrees_to_e7(lat_offset, granularity, lat_accumulator)?;
        let longitude_e7 = nanodegrees_to_e7(lon_offset, granularity, lon_accumulator)?;
        let coordinate = Coordinate::new(latitude_e7, longitude_e7)?;

        let mut tags = BTreeMap::new();
        loop {
            let key_index = kv_iterator.next().ok_or(ImportError::MalformedProtobuf {
                context: "DenseNodes: keys_vals endet mitten in einem Knoten",
            })?;
            if key_index == 0 {
                break;
            }
            let value_index = kv_iterator.next().ok_or(ImportError::MalformedProtobuf {
                context: "DenseNodes: keys_vals ohne passenden Wert",
            })?;
            tags.insert(
                resolve(string_table, key_index)?.to_owned(),
                resolve(string_table, value_index)?.to_owned(),
            );
        }

        nodes.push(OsmNode {
            id: OsmNodeId::new(id_accumulator),
            coordinate,
            tags,
        });
    }

    Ok(nodes)
}

fn decode_packed_sint64(bytes: &[u8]) -> Result<Vec<i64>, ImportError> {
    crate::import::proto::read_packed_varints(bytes)
        .map(|werte| werte.into_iter().map(zigzag_decode).collect())
}

/// Dekodiert einen `Way`.
///
/// `refs` ist wie `id`/`lat`/`lon` bei `DenseNodes` Delta-kodiert.
pub(crate) fn decode_way(bytes: &[u8], string_table: &[String]) -> Result<OsmWay, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut id = None;
    let mut keys = Vec::new();
    let mut vals = Vec::new();
    let mut deltas = Vec::new();

    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::Varint => {
                let wert = reader.read_varint()?;
                #[expect(
                    clippy::cast_possible_wrap,
                    reason = "OSM-Wegkennungen sind nicht Zickzack-kodiert, sondern ein Bitmuster gleicher Breite"
                )]
                let wert = wert as i64;
                id = Some(OsmWayId::new(wert));
            }
            2 if wire_type == WireType::LengthDelimited => {
                keys = crate::import::proto::read_packed_varints(reader.read_length_delimited()?)?;
            }
            3 if wire_type == WireType::LengthDelimited => {
                vals = crate::import::proto::read_packed_varints(reader.read_length_delimited()?)?;
            }
            8 if wire_type == WireType::LengthDelimited => {
                deltas = decode_packed_sint64(reader.read_length_delimited()?)?;
            }
            _ => reader.skip(wire_type)?,
        }
    }

    let id = id.ok_or(ImportError::MalformedProtobuf {
        context: "Way ohne 'id'",
    })?;

    if keys.len() != vals.len() {
        return Err(ImportError::MalformedProtobuf {
            context: "Way: keys/vals unterschiedlich lang",
        });
    }
    let mut tags = BTreeMap::new();
    for (key_index, value_index) in keys.into_iter().zip(vals) {
        tags.insert(
            resolve(string_table, key_index)?.to_owned(),
            resolve(string_table, value_index)?.to_owned(),
        );
    }

    let mut nodes = Vec::with_capacity(deltas.len());
    let mut accumulator: i64 = 0;
    for delta in deltas {
        accumulator = accumulator
            .checked_add(delta)
            .ok_or(ImportError::NumericOverflow {
                context: "Way: refs-Delta",
            })?;
        nodes.push(OsmNodeId::new(accumulator));
    }

    Ok(OsmWay { id, nodes, tags })
}

#[cfg(test)]
mod tests {
    use super::{OsmNodeId, OsmWayId, decode_string_table};

    #[test]
    fn kennungen_zeigen_ihren_ursprung() {
        assert_eq!(OsmNodeId::new(42).to_string(), "n42");
        assert_eq!(OsmWayId::new(7).to_string(), "w7");
        assert_eq!(OsmNodeId::new(42).value(), 42);
    }

    #[test]
    fn zeichenkettentabelle_liest_wiederholte_bytes_felder() {
        // s="" (Index 0), s="railway", je Feld 1, längenbegrenzt.
        let mut bytes = vec![0x0A, 0x00];
        bytes.push(0x0A);
        bytes.push(7);
        bytes.extend_from_slice(b"railway");
        let tabelle = decode_string_table(&bytes).expect("gültige Tabelle");
        assert_eq!(tabelle, vec![String::new(), "railway".to_owned()]);
    }
}
