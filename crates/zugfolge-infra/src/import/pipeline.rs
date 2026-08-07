//! Der Einstiegspunkt der Import-Pipeline: OSM-PBF → [`RawGraph`].
//!
//! zugfolge:quelle=osm-pbf-lhe
//!
//! Der Marker oben ist das Rechte-Gate aus M0.4 (`docs/rechte.md`): Der
//! Wächter `rights-gate` prüft, dass jede so genannte Quelle im
//! Quellenregister steht und dort `freigegeben` ist. `import_pbf` selbst ist
//! quellenunabhängig — welche registrierte Quelle ein Aufruf tatsächlich
//! zieht, entscheidet die [`SourceId`], die der Aufrufer übergibt. Für die
//! Pilotregion ist das `osm-pbf-lhe`, deshalb steht sie hier als Beleg, nicht
//! als Zwang.

use std::collections::BTreeMap;
use std::io::Read;

use crate::import::blob::{read_blob, read_blob_header};
use crate::import::block::{decode_header_block, decode_primitive_block};
use crate::import::element::{OsmNode, OsmNodeId, OsmWay, OsmWayId};
use crate::import::error::ImportError;
use crate::import::topology::{RawGraph, build_raw_graph};
use crate::provenance::SourceId;

/// Erwarteter Blocktyp der ersten Blob in jeder PBF-Datei.
const HEADER_BLOCK_TYPE: &str = "OSMHeader";

/// Blocktyp, der die eigentlichen Knoten und Wege trägt.
const DATA_BLOCK_TYPE: &str = "OSMData";

/// Importiert einen OSM-PBF-Extract in einen [`RawGraph`].
///
/// Liest blockweise von `reader` — nie mehr als ein entpackter Block steht
/// gleichzeitig im Speicher — und meldet als Erstes jeden Block, dessen
/// Pflichtmerkmale oder Kodierung dieser Leser nicht versteht, statt ihn
/// still falsch zu lesen.
///
/// `source` benennt die Quelle, aus der `reader` stammt — sie geht
/// unverändert in den zurückgegebenen [`RawGraph`] ein. Ob diese Quelle
/// nach dem Rechte-Gate (`docs/rechte.md`) überhaupt importiert werden darf,
/// prüft dieser Aufruf nicht: Das ist eine Prüfung gegen das
/// Quellenregister, keine Eigenschaft der Bytes.
///
/// # Errors
///
/// Ein [`ImportError`] für jede Abweichung vom erwarteten Dateiaufbau — eine
/// abgeschnittene Datei, ein unbekanntes Pflichtmerkmal, ein Weg, der auf
/// einen im Extract fehlenden Knoten verweist, und Ähnliches.
pub fn import_pbf<R: Read>(reader: &mut R, source: SourceId) -> Result<RawGraph, ImportError> {
    let header = read_blob_header(reader)?.ok_or(ImportError::Truncated)?;
    if header.block_type != HEADER_BLOCK_TYPE {
        return Err(ImportError::UnexpectedBlockType {
            expected: HEADER_BLOCK_TYPE,
            found: header.block_type,
        });
    }
    let header_bytes = read_blob(reader, &header)?;
    decode_header_block(&header_bytes)?;

    let mut nodes: BTreeMap<OsmNodeId, OsmNode> = BTreeMap::new();
    let mut ways: BTreeMap<OsmWayId, OsmWay> = BTreeMap::new();

    while let Some(header) = read_blob_header(reader)? {
        if header.block_type != DATA_BLOCK_TYPE {
            return Err(ImportError::UnexpectedBlockType {
                expected: DATA_BLOCK_TYPE,
                found: header.block_type,
            });
        }
        let block_bytes = read_blob(reader, &header)?;
        let elements = decode_primitive_block(&block_bytes)?;
        for node in elements.nodes {
            nodes.insert(node.id, node);
        }
        for way in elements.ways {
            ways.insert(way.id, way);
        }
    }

    build_raw_graph(source, &nodes, &ways)
}
