//! Blob-Rahmen des PBF-Dateiformats (`fileformat.proto`).
//!
//! Eine `.osm.pbf`-Datei ist eine Folge unabhängig komprimierter Blöcke —
//! das erlaubt parallele Verarbeitung und begrenzt den Speicherbedarf beim
//! Lesen, weil nie mehr als ein Block im Speicher steht. Jeder Block besteht
//! aus einer kurzen `BlobHeader`-Nachricht (Art und Größe) gefolgt von einer
//! `Blob`-Nachricht (die eigentlichen, meist zlib-komprimierten Nutzdaten).

use std::io::Read;

use flate2::read::ZlibDecoder;

use crate::import::error::ImportError;
use crate::import::proto::{ProtoReader, WireType};

/// Größte zulässige Länge einer `BlobHeader`-Nachricht.
///
/// Der offizielle Referenzleser begrenzt sie auf 64 KiB — eine größere
/// Kopfzeile ist entweder eine andere Datei oder ein beschädigter Extract,
/// nie ein gültiger, nur ungewöhnlich großer Block.
const MAX_BLOB_HEADER_LENGTH: u32 = 64 * 1024;

/// Größte zulässige entpackte Größe eines Blobs — der Referenzwert des
/// PBF-Formats (32 MiB). Ohne diese Grenze könnte ein manipulierter Extract
/// eine unbegrenzte Entpackung erzwingen.
const MAX_UNCOMPRESSED_BLOB_SIZE: usize = 32 * 1024 * 1024;

/// Die Art eines Blocks, gelesen aus seiner `BlobHeader`.
pub(crate) struct BlobHeader {
    pub(crate) block_type: String,
    datasize: u32,
}

/// Liest die nächste `BlobHeader` von einem Datenstrom, sofern noch einer
/// folgt.
///
/// Gibt `Ok(None)` zurück, wenn der Strom sauber am Dateiende endet — das ist
/// der reguläre Abschluss, kein Fehler.
pub(crate) fn read_blob_header<R: Read>(reader: &mut R) -> Result<Option<BlobHeader>, ImportError> {
    let mut length_bytes = [0_u8; 4];
    match read_exact_or_eof(reader, &mut length_bytes)? {
        FillResult::Eof => return Ok(None),
        FillResult::Filled => {}
    }
    let header_length = u32::from_be_bytes(length_bytes);
    if header_length > MAX_BLOB_HEADER_LENGTH {
        return Err(ImportError::MalformedProtobuf {
            context: "BlobHeader-Länge überschreitet die zulässige Höchstgröße",
        });
    }
    let mut header_bytes = vec![
        0_u8;
        usize::try_from(header_length).map_err(|_wert| {
            ImportError::MalformedProtobuf {
                context: "BlobHeader-Länge überschreitet die Adressbreite",
            }
        })?
    ];
    reader.read_exact(&mut header_bytes)?;
    decode_blob_header(&header_bytes)
}

fn decode_blob_header(bytes: &[u8]) -> Result<Option<BlobHeader>, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut block_type = None;
    let mut datasize = None;
    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::LengthDelimited => {
                let text = reader.read_length_delimited()?;
                block_type = Some(
                    String::from_utf8(text.to_vec()).map_err(|_fehler| ImportError::InvalidText)?,
                );
            }
            3 if wire_type == WireType::Varint => {
                let wert = reader.read_varint()?;
                datasize =
                    Some(
                        u32::try_from(wert).map_err(|_wert| ImportError::MalformedProtobuf {
                            context: "BlobHeader.datasize überschreitet u32",
                        })?,
                    );
            }
            _ => reader.skip(wire_type)?,
        }
    }
    let block_type = block_type.ok_or(ImportError::MalformedProtobuf {
        context: "BlobHeader ohne 'type'",
    })?;
    let datasize = datasize.ok_or(ImportError::MalformedProtobuf {
        context: "BlobHeader ohne 'datasize'",
    })?;
    Ok(Some(BlobHeader {
        block_type,
        datasize,
    }))
}

/// Liest und entpackt den zu einer `BlobHeader` gehörenden `Blob`.
pub(crate) fn read_blob<R: Read>(
    reader: &mut R,
    header: &BlobHeader,
) -> Result<Vec<u8>, ImportError> {
    let length =
        usize::try_from(header.datasize).map_err(|_wert| ImportError::MalformedProtobuf {
            context: "Blob-Länge überschreitet die Adressbreite",
        })?;
    // Auch der serialisierte Block ist im OSM-Referenzleser auf 32 MiB
    // begrenzt. Die Prüfung muss vor der Speicherreservierung stattfinden.
    if length > MAX_UNCOMPRESSED_BLOB_SIZE {
        return Err(ImportError::MalformedProtobuf {
            context: "Blob-Länge überschreitet die zulässige Höchstgröße",
        });
    }
    let mut blob_bytes = vec![0_u8; length];
    reader.read_exact(&mut blob_bytes)?;
    decode_blob(&blob_bytes)
}

fn decode_blob(bytes: &[u8]) -> Result<Vec<u8>, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut raw: Option<&[u8]> = None;
    let mut zlib_data: Option<&[u8]> = None;
    let mut raw_size: Option<u64> = None;
    while reader.has_remaining() {
        let (field, wire_type) = reader.read_tag()?;
        match field {
            1 if wire_type == WireType::LengthDelimited => {
                raw = Some(reader.read_length_delimited()?);
            }
            2 if wire_type == WireType::Varint => {
                raw_size = Some(reader.read_varint()?);
            }
            3 if wire_type == WireType::LengthDelimited => {
                zlib_data = Some(reader.read_length_delimited()?);
            }
            _ => reader.skip(wire_type)?,
        }
    }

    if let Some(raw) = raw {
        if raw.len() > MAX_UNCOMPRESSED_BLOB_SIZE {
            return Err(ImportError::MalformedProtobuf {
                context: "Unkomprimierter Blob überschreitet die zulässige Höchstgröße",
            });
        }
        return Ok(raw.to_vec());
    }
    if let Some(zlib_data) = zlib_data {
        let capacity = raw_size
            .and_then(|wert| usize::try_from(wert).ok())
            .unwrap_or(zlib_data.len());
        if capacity > MAX_UNCOMPRESSED_BLOB_SIZE {
            return Err(ImportError::MalformedProtobuf {
                context: "Blob.raw_size überschreitet die zulässige Höchstgröße",
            });
        }
        let mut decoder = ZlibDecoder::new(zlib_data);
        let mut entpackt = Vec::with_capacity(capacity);
        let mut begrenzt =
            decoder
                .by_ref()
                .take(
                    u64::try_from(MAX_UNCOMPRESSED_BLOB_SIZE + 1).map_err(|_wert| {
                        ImportError::NumericOverflow {
                            context: "Höchstgröße für entpackte Blobs",
                        }
                    })?,
                );
        begrenzt
            .read_to_end(&mut entpackt)
            .map_err(|_fehler| ImportError::Decompression)?;
        if entpackt.len() > MAX_UNCOMPRESSED_BLOB_SIZE {
            return Err(ImportError::MalformedProtobuf {
                context: "Entpackter Blob überschreitet die zulässige Höchstgröße",
            });
        }
        if raw_size.is_some_and(|expected| expected != entpackt.len() as u64) {
            return Err(ImportError::MalformedProtobuf {
                context: "Entpackte Blob-Länge weicht von raw_size ab",
            });
        }
        return Ok(entpackt);
    }
    Err(ImportError::UnsupportedCompression)
}

enum FillResult {
    Filled,
    Eof,
}

/// Wie `Read::read_exact`, meldet ein leeres erstes Lesen aber als sauberes
/// Dateiende statt als Fehler — das ist der reguläre Abschluss zwischen zwei
/// Blöcken.
fn read_exact_or_eof<R: Read>(
    reader: &mut R,
    buffer: &mut [u8],
) -> Result<FillResult, ImportError> {
    let mut gelesen = 0;
    while gelesen < buffer.len() {
        let anzahl = reader.read(&mut buffer[gelesen..])?;
        if anzahl == 0 {
            return if gelesen == 0 {
                Ok(FillResult::Eof)
            } else {
                Err(ImportError::Truncated)
            };
        }
        gelesen += anzahl;
    }
    Ok(FillResult::Filled)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use flate2::Compression;
    use flate2::write::ZlibEncoder;

    use super::{read_blob, read_blob_header};

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

    fn write_tag(buf: &mut Vec<u8>, field: u32, wire_type: u8) {
        write_varint(buf, (u64::from(field) << 3) | u64::from(wire_type));
    }

    fn encode_blob_header(block_type: &str, datasize: u32) -> Vec<u8> {
        let mut buf = Vec::new();
        write_tag(&mut buf, 1, 2);
        write_varint(&mut buf, block_type.len() as u64);
        buf.extend_from_slice(block_type.as_bytes());
        write_tag(&mut buf, 3, 0);
        write_varint(&mut buf, u64::from(datasize));
        buf
    }

    fn encode_zlib_blob(payload: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(payload).expect("zlib-Kompression");
        let komprimiert = encoder.finish().expect("zlib-Abschluss");

        let mut buf = Vec::new();
        write_tag(&mut buf, 2, 0);
        write_varint(&mut buf, payload.len() as u64);
        write_tag(&mut buf, 3, 2);
        write_varint(&mut buf, komprimiert.len() as u64);
        buf.extend_from_slice(&komprimiert);
        buf
    }

    #[test]
    fn ein_zlib_block_wird_entpackt() {
        let payload = b"Testinhalt eines Blocks".to_vec();
        let blob = encode_zlib_blob(&payload);
        let header_bytes = encode_blob_header("OSMData", u32::try_from(blob.len()).expect("passt"));

        let mut strom = Vec::new();
        strom.extend_from_slice(
            &u32::try_from(header_bytes.len())
                .expect("passt")
                .to_be_bytes(),
        );
        strom.extend_from_slice(&header_bytes);
        strom.extend_from_slice(&blob);

        let mut cursor = std::io::Cursor::new(strom);
        let header = read_blob_header(&mut cursor)
            .expect("lesbare Kopfzeile")
            .expect("kein Dateiende");
        assert_eq!(header.block_type, "OSMData");
        let entpackt = read_blob(&mut cursor, &header).expect("lesbarer Blob");
        assert_eq!(entpackt, payload);
    }

    #[test]
    fn ein_sauberes_dateiende_ist_kein_fehler() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        assert!(
            read_blob_header(&mut cursor)
                .expect("kein Fehler")
                .is_none()
        );
    }

    #[test]
    fn ein_abgeschnittener_block_meldet_sich() {
        let mut cursor = std::io::Cursor::new(vec![0, 0, 0, 10]);
        assert!(read_blob_header(&mut cursor).is_err());
    }

    #[test]
    fn ein_uebergrosser_dateiblock_wird_vor_dem_lesen_abgewiesen() {
        let header = super::BlobHeader {
            block_type: "OSMData".into(),
            datasize: u32::MAX,
        };
        let error = read_blob(&mut std::io::empty(), &header).unwrap_err();
        assert!(matches!(
            error,
            super::ImportError::MalformedProtobuf { .. }
        ));
    }

    #[test]
    fn raw_size_muss_der_tatsaechlichen_laenge_entsprechen() {
        let mut blob = encode_zlib_blob(b"test");
        blob[1] = 3;
        assert!(super::decode_blob(&blob).is_err());
    }

    #[test]
    fn die_entpackgrenze_darf_keinen_erfolgreichen_teilblock_liefern() {
        let mut blob = encode_zlib_blob(&vec![0; super::MAX_UNCOMPRESSED_BLOB_SIZE + 1]);
        // Der manipulierte Block verkleinert raw_size, um die Vorprüfung
        // zu umgehen. Auch dann muss die Entpackung vollständig scheitern.
        write_tag(&mut blob, 2, 0);
        write_varint(&mut blob, 0);
        assert!(matches!(
            super::decode_blob(&blob),
            Err(super::ImportError::MalformedProtobuf {
                context: "Entpackter Blob überschreitet die zulässige Höchstgröße",
            })
        ));
    }
}
