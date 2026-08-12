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

/// Vollstaendig gelesene Knoten und Wege eines gepinnten OSM-PBF-Dokuments.
///
/// Der Typ bewahrt neben dem Eisenbahn-Rohgraphen auch Kartenelemente wie
/// separate Bahnsteige und Betriebsstellenpunkte. Relationen werden vom
/// gegenwaertigen PBF-Leser nicht ausgewertet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PbfDocument {
    source: SourceId,
    nodes: BTreeMap<OsmNodeId, OsmNode>,
    ways: BTreeMap<OsmWayId, OsmWay>,
}

impl PbfDocument {
    /// Die fuer diesen Import deklarierte, releasegebundene Quelle.
    pub const fn source(&self) -> &SourceId {
        &self.source
    }

    /// Alle OSM-Knoten, auch wenn sie nicht Teil einer `railway=rail`-Kante sind.
    pub fn nodes(&self) -> impl Iterator<Item = &OsmNode> {
        self.nodes.values()
    }

    /// Ein OSM-Knoten ueber seine stabile Kennung.
    pub fn node(&self, id: OsmNodeId) -> Option<&OsmNode> {
        self.nodes.get(&id)
    }

    /// Alle OSM-Wege in aufsteigender OSM-Kennung.
    pub fn ways(&self) -> impl Iterator<Item = &OsmWay> {
        self.ways.values()
    }

    /// Baut den unveraenderten Eisenbahn-Rohgraphen aus diesem PBF-Dokument.
    ///
    /// # Errors
    ///
    /// Gibt einen [`ImportError`] zurueck, wenn ein Eisenbahnweg entartet ist
    /// oder auf einen im Extract fehlenden Knoten verweist.
    pub fn raw_graph(&self) -> Result<RawGraph, ImportError> {
        build_raw_graph(self.source.clone(), &self.nodes, &self.ways)
    }
}

/// Liest ein PBF-Dokument einschliesslich der Elemente, die nur fuer Karte
/// und Kontext gebraucht werden, etwa Bahnsteige und Betriebsstellenpunkte.
///
/// Anders als [`import_pbf`] reduziert dieser Aufruf die Eingabe noch nicht
/// auf den Rohgraphen. Dadurch kann ein nachgelagerter, deterministischer
/// Semantikexport echte Geometrien nicht am Gleis liegender Objekte bewahren.
///
/// # Errors
///
/// Ein [`ImportError`] fuer jede Abweichung vom erwarteten Dateiaufbau.
pub fn import_pbf_document<R: Read>(
    reader: &mut R,
    source: SourceId,
) -> Result<PbfDocument, ImportError> {
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

    Ok(PbfDocument {
        source,
        nodes,
        ways,
    })
}

/// Importiert einen OSM-PBF-Extract in einen [`RawGraph`].
///
/// Liest blockweise und meldet unbekannte Pflichtmerkmale, abgeschnittene
/// Dateien und fehlende Knotenreferenzen, statt sie still zu ignorieren.
///
/// # Errors
///
/// Ein [`ImportError`] fuer jede Abweichung vom erwarteten Dateiaufbau.
pub fn import_pbf<R: Read>(reader: &mut R, source: SourceId) -> Result<RawGraph, ImportError> {
    import_pbf_document(reader, source)?.raw_graph()
}
