//! Integrationstest der Import-Pipeline (M1.2): OSM-PBF → [`RawGraph`].
//!
//! Der Testfall baut sich seine `.osm.pbf`-Bytes selbst — von Hand, mit den
//! immer gleichen Protobuf-Bausteinen (Varint, Zickzack, längenbegrenzte
//! Felder). Das ist kein Umweg um eine echte Bibliothek herum: Es ist die
//! Kehrseite von `import_pbf` selbst, geschrieben, ohne dessen Code
//! wiederzuverwenden, damit ein Fehler auf der einen Seite nicht spiegelbild-
//! lich auf der anderen verschwindet. Ein binäres Testfixture im
//! Repositorium hätte denselben Zweck nur unlesbar erfüllt.
//!
//! Das Beispielnetz ist frei erfunden — wie `reference_network()` aus M1.1,
//! aus demselben Grund: Ein Import ist noch keiner, wenn seine Testdaten
//! echte Namen tragen.

use std::io::Write as _;

use flate2::Compression;
use flate2::write::ZlibEncoder;
use zugfolge_infra::{OsmNodeId, SourceId, import_pbf};

// ---------------------------------------------------------------------
// Der minimale Protobuf-Schreiber — das Gegenstück zu `src/import/proto.rs`,
// absichtlich unabhängig davon aufgeschrieben.
// ---------------------------------------------------------------------

fn write_varint(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte =
            u8::try_from(value & 0x7f).expect("die unteren sieben Bit passen immer in ein Byte");
        value >>= 7;
        if value == 0 {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

fn write_tag(buf: &mut Vec<u8>, field: u32, wire_type: u8) {
    write_varint(buf, (u64::from(field) << 3) | u64::from(wire_type));
}

fn write_zigzag(buf: &mut Vec<u8>, value: i64) {
    let magnitude = value.unsigned_abs();
    let doubled = magnitude
        .checked_mul(2)
        .expect("Testwerte sind klein genug, um verdoppelt zu werden");
    let encoded = if value < 0 { doubled - 1 } else { doubled };
    write_varint(buf, encoded);
}

fn write_bytes_field(buf: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    write_tag(buf, field, 2);
    write_varint(buf, bytes.len() as u64);
    buf.extend_from_slice(bytes);
}

fn write_string_field(buf: &mut Vec<u8>, field: u32, value: &str) {
    write_bytes_field(buf, field, value.as_bytes());
}

fn write_varint_field(buf: &mut Vec<u8>, field: u32, value: u64) {
    write_tag(buf, field, 0);
    write_varint(buf, value);
}

fn write_packed_varints(buf: &mut Vec<u8>, field: u32, values: &[u64]) {
    let mut inner = Vec::new();
    for &value in values {
        write_varint(&mut inner, value);
    }
    write_bytes_field(buf, field, &inner);
}

fn write_packed_zigzag(buf: &mut Vec<u8>, field: u32, values: &[i64]) {
    let mut inner = Vec::new();
    for &value in values {
        write_zigzag(&mut inner, value);
    }
    write_bytes_field(buf, field, &inner);
}

// ---------------------------------------------------------------------
// Der Blob-Rahmen — das Gegenstück zu `src/import/blob.rs`.
// ---------------------------------------------------------------------

fn append_block(file: &mut Vec<u8>, block_type: &str, payload: &[u8]) {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(payload)
        .expect("zlib-Kompression der Testdaten");
    let compressed = encoder.finish().expect("zlib-Abschluss der Testdaten");

    let mut blob = Vec::new();
    write_varint_field(&mut blob, 2, payload.len() as u64);
    write_bytes_field(&mut blob, 3, &compressed);

    let mut header = Vec::new();
    write_string_field(&mut header, 1, block_type);
    write_varint_field(&mut header, 3, blob.len() as u64);

    file.extend_from_slice(
        &u32::try_from(header.len())
            .expect("Kopfzeile passt in u32")
            .to_be_bytes(),
    );
    file.extend_from_slice(&header);
    file.extend_from_slice(&blob);
}

// ---------------------------------------------------------------------
// HeaderBlock — das Gegenstück zu `decode_header_block`.
// ---------------------------------------------------------------------

fn build_header_block() -> Vec<u8> {
    let mut block = Vec::new();
    write_string_field(&mut block, 4, "OsmSchema-V0.6");
    write_string_field(&mut block, 4, "DenseNodes");
    block
}

// ---------------------------------------------------------------------
// Eine kleine Tag-Tabelle, die Schlüssel/Werte in Zeichenkettenindizes
// übersetzt — je Block neu, wie es der Extract auch tut.
// ---------------------------------------------------------------------

struct StringTable {
    strings: Vec<String>,
}

impl StringTable {
    fn new() -> Self {
        // Index 0 ist per Konvention der Leerstring.
        Self {
            strings: vec![String::new()],
        }
    }

    fn index_of(&mut self, value: &str) -> u64 {
        if let Some(position) = self.strings.iter().position(|s| s == value) {
            return position as u64;
        }
        self.strings.push(value.to_owned());
        (self.strings.len() - 1) as u64
    }

    fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        for s in &self.strings {
            write_bytes_field(&mut buf, 1, s.as_bytes());
        }
        buf
    }
}

// ---------------------------------------------------------------------
// PrimitiveBlock mit DenseNodes — das Gegenstück zu `decode_dense_nodes`.
// ---------------------------------------------------------------------

/// Ein Testknoten: Kennung, Breite/Länge in Zehnmillionstel Grad, Tags.
struct TestNode {
    id: i64,
    latitude_e7: i32,
    longitude_e7: i32,
    tags: Vec<(&'static str, &'static str)>,
}

fn build_dense_nodes_block(nodes: &[TestNode]) -> Vec<u8> {
    let mut table = StringTable::new();
    let mut ids = Vec::new();
    let mut lats = Vec::new();
    let mut lons = Vec::new();
    let mut keys_vals = Vec::new();

    let mut previous_id: i64 = 0;
    let mut previous_lat: i64 = 0;
    let mut previous_lon: i64 = 0;

    for node in nodes {
        ids.push(node.id - previous_id);
        previous_id = node.id;
        // Granularity 100, Offset 0: Der akkumulierte Rohwert entspricht
        // damit exakt dem gewünschten Zehnmillionstel-Grad-Wert.
        let lat = i64::from(node.latitude_e7);
        let lon = i64::from(node.longitude_e7);
        lats.push(lat - previous_lat);
        previous_lat = lat;
        lons.push(lon - previous_lon);
        previous_lon = lon;

        for (key, value) in &node.tags {
            keys_vals.push(table.index_of(key));
            keys_vals.push(table.index_of(value));
        }
        keys_vals.push(0);
    }

    let mut dense = Vec::new();
    write_packed_zigzag(&mut dense, 1, &ids);
    write_packed_zigzag(&mut dense, 8, &lats);
    write_packed_zigzag(&mut dense, 9, &lons);
    write_packed_varints(&mut dense, 10, &keys_vals);

    let mut group = Vec::new();
    write_bytes_field(&mut group, 2, &dense);

    let mut block = Vec::new();
    write_bytes_field(&mut block, 1, &table.encode());
    write_bytes_field(&mut block, 2, &group);
    block
}

// ---------------------------------------------------------------------
// PrimitiveBlock mit Ways — das Gegenstück zu `decode_way`.
// ---------------------------------------------------------------------

struct TestWay {
    id: i64,
    nodes: Vec<i64>,
    tags: Vec<(&'static str, &'static str)>,
}

fn encode_way(way: &TestWay, table: &mut StringTable) -> Vec<u8> {
    let mut keys = Vec::new();
    let mut vals = Vec::new();
    for (key, value) in &way.tags {
        keys.push(table.index_of(key));
        vals.push(table.index_of(value));
    }

    let mut deltas = Vec::new();
    let mut previous = 0_i64;
    for &node_id in &way.nodes {
        deltas.push(node_id - previous);
        previous = node_id;
    }

    let mut encoded = Vec::new();
    write_varint_field(
        &mut encoded,
        1,
        u64::try_from(way.id).expect("Testwegkennungen sind positiv"),
    );
    write_packed_varints(&mut encoded, 2, &keys);
    write_packed_varints(&mut encoded, 3, &vals);
    write_packed_zigzag(&mut encoded, 8, &deltas);
    encoded
}

fn build_ways_block(ways: &[TestWay]) -> Vec<u8> {
    let mut table = StringTable::new();
    let encoded_ways: Vec<Vec<u8>> = ways.iter().map(|way| encode_way(way, &mut table)).collect();

    let mut group = Vec::new();
    for way_bytes in &encoded_ways {
        write_bytes_field(&mut group, 3, way_bytes);
    }

    let mut block = Vec::new();
    write_bytes_field(&mut block, 1, &table.encode());
    write_bytes_field(&mut block, 2, &group);
    block
}

// ---------------------------------------------------------------------
// Das Beispiel: eine Verzweigung, zwei Prellböcke, ein Formpunkt ohne
// eigene Bedeutung und ein Straßenweg, der herausfallen muss.
// ---------------------------------------------------------------------

fn beispiel_pbf() -> Vec<u8> {
    let nodes = [
        TestNode {
            id: 1,
            latitude_e7: 512_300_000,
            longitude_e7: 123_000_000,
            tags: vec![],
        },
        TestNode {
            id: 5,
            latitude_e7: 512_300_000,
            longitude_e7: 123_050_000,
            tags: vec![],
        },
        TestNode {
            id: 2,
            latitude_e7: 512_300_000,
            longitude_e7: 123_100_000,
            tags: vec![("railway", "switch")],
        },
        TestNode {
            id: 3,
            latitude_e7: 512_300_000,
            longitude_e7: 123_200_000,
            tags: vec![("railway", "buffer_stop")],
        },
        TestNode {
            id: 4,
            latitude_e7: 512_350_000,
            longitude_e7: 123_150_000,
            tags: vec![("railway", "buffer_stop")],
        },
        TestNode {
            id: 6,
            latitude_e7: 512_400_000,
            longitude_e7: 123_000_000,
            tags: vec![],
        },
        TestNode {
            id: 7,
            latitude_e7: 512_400_000,
            longitude_e7: 123_100_000,
            tags: vec![],
        },
    ];

    let ways = [
        TestWay {
            id: 100,
            nodes: vec![1, 5, 2, 3],
            tags: vec![
                ("railway", "rail"),
                ("name", "Beispielstrecke A"),
                ("maxspeed", "100"),
                ("electrified", "contact_line"),
                ("gauge", "1435"),
            ],
        },
        TestWay {
            id: 101,
            nodes: vec![2, 4],
            tags: vec![
                ("railway", "rail"),
                ("name", "Abzweig B"),
                ("maxspeed", "60"),
            ],
        },
        TestWay {
            id: 200,
            nodes: vec![6, 7],
            tags: vec![("highway", "residential")],
        },
    ];

    let mut file = Vec::new();
    append_block(&mut file, "OSMHeader", &build_header_block());
    // Zwei Datenblöcke statt einem: Knoten und Wege verteilen sich auf
    // getrennte Blöcke, wie es reale Extracts auch tun — und jeder Block
    // trägt seine eigene, lokale Zeichenkettentabelle.
    append_block(&mut file, "OSMData", &build_dense_nodes_block(&nodes));
    append_block(&mut file, "OSMData", &build_ways_block(&ways));
    file
}

fn quelle() -> SourceId {
    SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung")
}

#[test]
fn ein_osm_pbf_extract_wird_zum_rohgraph() {
    let bytes = beispiel_pbf();
    let mut reader = std::io::Cursor::new(bytes);
    let graph = import_pbf(&mut reader, quelle()).expect("gültiger Testextract");

    assert_eq!(graph.source().as_str(), "osm-pbf-lhe");
    assert_eq!(
        graph.node_count(),
        4,
        "N1, N2, N3, N4 — N5 bleibt Formpunkt, N6/N7 sind keine Eisenbahn"
    );
    assert_eq!(graph.edge_count(), 3);

    assert!(graph.node(OsmNodeId::new(1)).is_some());
    assert!(
        graph.node(OsmNodeId::new(5)).is_none(),
        "N5 ist nur ein Geometriepunkt"
    );
    assert!(
        graph.node(OsmNodeId::new(6)).is_none(),
        "N6 gehört zum verworfenen Straßenweg"
    );

    let verzweigung = graph
        .node(OsmNodeId::new(2))
        .expect("die Verzweigung wird ein Knoten");
    assert_eq!(
        verzweigung.tags().get("railway").map(String::as_str),
        Some("switch")
    );

    let hauptast = graph
        .edges()
        .iter()
        .find(|edge| edge.from() == OsmNodeId::new(1))
        .expect("der erste Abschnitt beginnt bei N1");
    assert_eq!(hauptast.to(), OsmNodeId::new(2));
    assert_eq!(
        hauptast.geometry().len(),
        3,
        "N1, N5, N2 — der Formpunkt bleibt in der Geometrie"
    );
    assert_eq!(
        hauptast.tags().get("name").map(String::as_str),
        Some("Beispielstrecke A")
    );
    assert_eq!(
        hauptast.tags().get("maxspeed").map(String::as_str),
        Some("100")
    );

    let zweigast = graph
        .edges()
        .iter()
        .find(|edge| edge.way().value() == 101)
        .expect("der Abzweig bleibt eine eigene Kante");
    assert_eq!(zweigast.from(), OsmNodeId::new(2));
    assert_eq!(zweigast.to(), OsmNodeId::new(4));
    assert_eq!(zweigast.geometry().len(), 2);

    assert!(
        graph.edges().iter().all(|edge| edge.way().value() != 200),
        "der Straßenweg trägt kein railway-Tag und darf nicht auftauchen"
    );
}

#[test]
fn zweimaliges_parsen_ergibt_dasselbe_ergebnis() {
    let bytes = beispiel_pbf();

    let mut erster_lauf = std::io::Cursor::new(bytes.clone());
    let graph_a = import_pbf(&mut erster_lauf, quelle()).expect("gültiger Testextract");

    let mut zweiter_lauf = std::io::Cursor::new(bytes);
    let graph_b = import_pbf(&mut zweiter_lauf, quelle()).expect("gültiger Testextract");

    assert_eq!(
        graph_a, graph_b,
        "derselbe Extract muss zweimal denselben Rohgraphen ergeben"
    );
}

#[test]
fn ein_unbekanntes_pflichtmerkmal_bricht_den_import() {
    let mut header_block = Vec::new();
    write_string_field(&mut header_block, 4, "ExoticFeature");

    let mut file = Vec::new();
    append_block(&mut file, "OSMHeader", &header_block);

    let mut reader = std::io::Cursor::new(file);
    let fehler = import_pbf(&mut reader, quelle()).expect_err("unbekanntes Pflichtmerkmal");
    let meldung = fehler.to_string();
    assert!(meldung.contains("ExoticFeature"), "{meldung}");
}

#[test]
fn ein_fehlender_referenzierter_knoten_wird_gemeldet() {
    let ways = [TestWay {
        id: 300,
        nodes: vec![42, 43],
        tags: vec![("railway", "rail")],
    }];

    let mut file = Vec::new();
    append_block(&mut file, "OSMHeader", &build_header_block());
    append_block(&mut file, "OSMData", &build_ways_block(&ways));

    let mut reader = std::io::Cursor::new(file);
    let fehler = import_pbf(&mut reader, quelle()).expect_err("Weg ohne seine Knoten");
    let meldung = fehler.to_string();
    assert!(
        meldung.contains("n42") || meldung.contains("n43"),
        "{meldung}"
    );
}
