//! Blockinhalt des PBF-Formats (`osmformat.proto`).
//!
//! Ein entpackter Blob ist entweder ein `HeaderBlock` — genau einer, ganz am
//! Anfang der Datei — oder ein `PrimitiveBlock` mit den eigentlichen
//! Knoten und Wegen. Diese Datei entscheidet, was in einem solchen Block
//! steht; wie ein einzelner Knoten oder Weg aus seinen Bytes wird, steht in
//! `element.rs`.

use crate::import::element::{
    OsmNode, OsmWay, decode_dense_nodes, decode_string_table, decode_way,
};
use crate::import::error::ImportError;
use crate::import::proto::{ProtoReader, WireType, zigzag_decode};

/// Merkmale, die dieser Leser versteht. `OsmSchema-V0.6` ist das
/// grundlegende OSM-Datenmodell, `DenseNodes` die dichte Knotenkodierung, die
/// jeder reale Extract der Pilotregion nutzt.
const SUPPORTED_FEATURES: [&str; 2] = ["OsmSchema-V0.6", "DenseNodes"];

/// Prüft die Kopfzeile der Datei gegen die Merkmale, die dieser Leser kennt.
///
/// Ein Pflichtmerkmal, das hier nicht in [`SUPPORTED_FEATURES`] steht, würde
/// bei stillem Ignorieren zu einer falsch gelesenen Datei führen — deshalb
/// bricht die Prüfung statt einer Warnung.
pub(crate) fn decode_header_block(bytes: &[u8]) -> Result<(), ImportError> {
    let mut reader = ProtoReader::new(bytes);
    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        if field == 4 && wire_type == WireType::LengthDelimited {
            let merkmal_bytes = reader.read_length_delimited()?;
            let merkmal = String::from_utf8(merkmal_bytes.to_vec())
                .map_err(|_fehler| ImportError::InvalidText)?;
            if !SUPPORTED_FEATURES.contains(&merkmal.as_str()) {
                return Err(ImportError::UnsupportedFeature(merkmal));
            }
        } else {
            reader.skip(wire_type)?;
        }
    }
    Ok(())
}

/// Die aus einem `PrimitiveBlock` gelesenen Elemente.
pub(crate) struct PrimitiveBlockElements {
    pub(crate) nodes: Vec<OsmNode>,
    pub(crate) ways: Vec<OsmWay>,
}

/// Dekodiert einen `PrimitiveBlock`.
///
/// Die Zeichenkettentabelle wird vollständig gelesen, bevor eine
/// `PrimitiveGroup` dekodiert wird — jede Gruppe verweist über Indizes auf
/// sie, unabhängig davon, in welcher Reihenfolge die Felder in der Datei
/// stehen.
pub(crate) fn decode_primitive_block(bytes: &[u8]) -> Result<PrimitiveBlockElements, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut string_table_bytes = None;
    let mut group_slices = Vec::new();
    let mut granularity: i64 = 100;
    let mut lat_offset: i64 = 0;
    let mut lon_offset: i64 = 0;

    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::LengthDelimited => {
                string_table_bytes = Some(reader.read_length_delimited()?);
            }
            2 if wire_type == WireType::LengthDelimited => {
                group_slices.push(reader.read_length_delimited()?);
            }
            17 if wire_type == WireType::Varint => {
                let wert = reader.read_varint()?;
                granularity =
                    i64::try_from(wert).map_err(|_wert| ImportError::MalformedProtobuf {
                        context: "PrimitiveBlock.granularity überschreitet i64",
                    })?;
            }
            19 if wire_type == WireType::Varint => {
                lat_offset = zigzag_decode(reader.read_varint()?);
            }
            20 if wire_type == WireType::Varint => {
                lon_offset = zigzag_decode(reader.read_varint()?);
            }
            _ => reader.skip(wire_type)?,
        }
    }

    let string_table_bytes = string_table_bytes.ok_or(ImportError::MalformedProtobuf {
        context: "PrimitiveBlock ohne 'stringtable'",
    })?;
    let string_table = decode_string_table(string_table_bytes)?;

    let mut nodes = Vec::new();
    let mut ways = Vec::new();
    for group_bytes in group_slices {
        decode_primitive_group(
            group_bytes,
            &string_table,
            granularity,
            lat_offset,
            lon_offset,
            &mut nodes,
            &mut ways,
        )?;
    }

    Ok(PrimitiveBlockElements { nodes, ways })
}

fn decode_primitive_group(
    bytes: &[u8],
    string_table: &[String],
    granularity: i64,
    lat_offset: i64,
    lon_offset: i64,
    nodes: &mut Vec<OsmNode>,
    ways: &mut Vec<OsmWay>,
) -> Result<(), ImportError> {
    let mut reader = ProtoReader::new(bytes);
    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::LengthDelimited => {
                reader.read_length_delimited()?;
                return Err(ImportError::UnsupportedElementEncoding("Node"));
            }
            2 if wire_type == WireType::LengthDelimited => {
                let dense_bytes = reader.read_length_delimited()?;
                nodes.extend(decode_dense_nodes(
                    dense_bytes,
                    string_table,
                    granularity,
                    lat_offset,
                    lon_offset,
                )?);
            }
            3 if wire_type == WireType::LengthDelimited => {
                let way_bytes = reader.read_length_delimited()?;
                ways.push(decode_way(way_bytes, string_table)?);
            }
            _ => reader.skip(wire_type)?,
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::decode_header_block;
    use crate::import::error::ImportError;

    fn write_varint(buf: &mut Vec<u8>, mut value: u64) {
        loop {
            let byte = u8::try_from(value & 0x7f).expect("sieben Bit passen in ein Byte");
            value >>= 7;
            if value == 0 {
                buf.push(byte);
                break;
            }
            buf.push(byte | 0x80);
        }
    }

    fn write_required_feature(buf: &mut Vec<u8>, feature: &str) {
        write_varint(buf, (4_u64 << 3) | 2);
        write_varint(buf, feature.len() as u64);
        buf.extend_from_slice(feature.as_bytes());
    }

    #[test]
    fn bekannte_pflichtmerkmale_werden_angenommen() {
        let mut bytes = Vec::new();
        write_required_feature(&mut bytes, "OsmSchema-V0.6");
        write_required_feature(&mut bytes, "DenseNodes");
        assert!(decode_header_block(&bytes).is_ok());
    }

    #[test]
    fn ein_unbekanntes_pflichtmerkmal_bricht_die_prüfung() {
        let mut bytes = Vec::new();
        write_required_feature(&mut bytes, "HistoricalInformation");
        let fehler = decode_header_block(&bytes).expect_err("unbekanntes Merkmal");
        assert!(
            matches!(fehler, ImportError::UnsupportedFeature(merkmal) if merkmal == "HistoricalInformation")
        );
    }
}
