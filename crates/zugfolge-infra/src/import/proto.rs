//! Der Protokollpuffer-Ausschnitt, den das PBF-Format braucht.
//!
//! Kein vollständiger Protobuf-Codec — nur Varint, Zickzack-Kodierung und ein
//! Feldleser, der unbekannte Felder überspringt. Das genügt, weil das
//! PBF-Format selbst nur diese Bausteine kennt (`fileformat.proto`,
//! `osmformat.proto`). Ein generierter Client für ein fremdes Protokoll wäre
//! hier eine Abhängigkeit mehr, ohne dass irgendetwas anderes im Projekt
//! Protobuf spricht.

use crate::import::error::ImportError;

/// Der Drahttyp eines Protobuf-Felds — bestimmt, wie viele Bytes folgen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WireType {
    /// Varint — Ganzzahlen aller Art, auch Zickzack-kodierte.
    Varint,
    /// 64-Bit-Festbreite — im hier gebrauchten Ausschnitt ungenutzt.
    Fixed64,
    /// Längenbegrenzt — eingebettete Nachrichten, Zeichenketten, gepackte Felder.
    LengthDelimited,
    /// 32-Bit-Festbreite — im hier gebrauchten Ausschnitt ungenutzt.
    Fixed32,
}

impl WireType {
    fn from_tag(tag: u64) -> Result<Self, ImportError> {
        match tag & 0x7 {
            0 => Ok(Self::Varint),
            1 => Ok(Self::Fixed64),
            2 => Ok(Self::LengthDelimited),
            5 => Ok(Self::Fixed32),
            other => Err(ImportError::UnsupportedWireType(other)),
        }
    }
}

/// Liest eine Protobuf-Nachricht aus einem Byte-Ausschnitt.
///
/// Die Nachricht ist immer schon vollständig im Speicher — Blöcke werden vor
/// dem Zerlegen entpackt (`blob.rs`). Ein `ProtoReader` hält deshalb nur eine
/// Position in einem geliehenen Ausschnitt, keinen eigenen Puffer.
pub(crate) struct ProtoReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> ProtoReader<'a> {
    pub(crate) const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    pub(crate) const fn has_remaining(&self) -> bool {
        self.position < self.bytes.len()
    }

    /// Liest ein Varint — die Grundeinheit jedes Protobuf-Felds.
    pub(crate) fn read_varint(&mut self) -> Result<u64, ImportError> {
        let mut result: u64 = 0;
        let mut shift: u32 = 0;
        loop {
            let byte = *self
                .bytes
                .get(self.position)
                .ok_or(ImportError::Truncated)?;
            self.position += 1;
            // Nach neun Bytes bleibt nur Bit 63. Weitere Nutzbits würden
            // beim Schieben still verschwinden und eine andere Kennung ergeben.
            if shift == 63 && byte > 1 {
                return Err(ImportError::MalformedVarint);
            }
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
            if shift >= 64 {
                return Err(ImportError::MalformedVarint);
            }
        }
    }

    /// Liest die Feldkennung — Feldnummer und Drahttyp.
    pub(crate) fn read_tag(&mut self) -> Result<(u32, WireType), ImportError> {
        let tag = self.read_varint()?;
        let wire_type = WireType::from_tag(tag)?;
        let field = u32::try_from(tag >> 3).map_err(|_wert| ImportError::MalformedProtobuf {
            context: "Feldnummer überschreitet u32",
        })?;
        if field == 0 || field > 0x1fff_ffff {
            return Err(ImportError::MalformedProtobuf {
                context: "Feldnummer liegt außerhalb 1 bis 2^29-1",
            });
        }
        Ok((field, wire_type))
    }

    /// Liest ein längenbegrenztes Feld und gibt den inneren Ausschnitt zurück.
    pub(crate) fn read_length_delimited(&mut self) -> Result<&'a [u8], ImportError> {
        let length = usize::try_from(self.read_varint()?).map_err(|_wert| {
            ImportError::MalformedProtobuf {
                context: "Länge eines Felds überschreitet die Adressbreite",
            }
        })?;
        let start = self.position;
        let end = start.checked_add(length).ok_or(ImportError::Truncated)?;
        let slice = self.bytes.get(start..end).ok_or(ImportError::Truncated)?;
        self.position = end;
        Ok(slice)
    }

    /// Überspringt ein Feld, dessen Inhalt hier nicht gebraucht wird.
    pub(crate) fn skip(&mut self, wire_type: WireType) -> Result<(), ImportError> {
        match wire_type {
            WireType::Varint => {
                self.read_varint()?;
            }
            WireType::LengthDelimited => {
                self.read_length_delimited()?;
            }
            WireType::Fixed32 => {
                self.position = self
                    .position
                    .checked_add(4)
                    .filter(|ende| *ende <= self.bytes.len())
                    .ok_or(ImportError::Truncated)?;
            }
            WireType::Fixed64 => {
                self.position = self
                    .position
                    .checked_add(8)
                    .filter(|ende| *ende <= self.bytes.len())
                    .ok_or(ImportError::Truncated)?;
            }
        }
        Ok(())
    }
}

/// Zickzack-Dekodierung eines `sintN`-Felds in seinen ursprünglichen Wert.
///
/// Zickzack bildet negative Zahlen auf ungerade, positive auf gerade Varints
/// ab — so bleiben kleine Beträge in beide Richtungen kurz kodiert. Das
/// PBF-Format nutzt das für IDs und Koordinaten-Deltas, die in beide
/// Richtungen wachsen.
pub(crate) const fn zigzag_decode(value: u64) -> i64 {
    #[expect(
        clippy::cast_possible_wrap,
        reason = "Zickzack-Dekodierung ist per Definition eine Bitmuster-Umdeutung, kein Wertverlust"
    )]
    let vorzeichenlos = (value >> 1) as i64;
    #[expect(
        clippy::cast_possible_wrap,
        reason = "das niedrigste Bit ist 0 oder 1 — die Umdeutung als i64 verliert keinen Wert"
    )]
    let vorzeichen = (value & 1) as i64;
    vorzeichenlos ^ (-vorzeichen)
}

/// Liest ein gepacktes Feld — eine Aneinanderreihung von Varints ohne eigene
/// Feldkennungen je Wert, typisch für `repeated ... [packed = true]`.
pub(crate) fn read_packed_varints(bytes: &[u8]) -> Result<Vec<u64>, ImportError> {
    let mut reader = ProtoReader::new(bytes);
    let mut values = Vec::new();
    while reader.has_remaining() {
        values.push(reader.read_varint()?);
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::{ProtoReader, WireType, read_packed_varints, zigzag_decode};

    #[test]
    fn varint_liest_mehrbyte_werte() {
        // 300 kodiert als [0xAC, 0x02].
        let mut reader = ProtoReader::new(&[0xAC, 0x02]);
        assert_eq!(reader.read_varint().expect("gültiges Varint"), 300);
        assert!(!reader.has_remaining());
    }

    #[test]
    fn varint_verwirft_nutzbits_oberhalb_der_64_bit_grenze() {
        let mut bytes = [0xff; 10];
        bytes[9] = 1;
        assert_eq!(ProtoReader::new(&bytes).read_varint().unwrap(), u64::MAX);
        for last in [2, 0x7f, 0x80, 0xff] {
            bytes[9] = last;
            assert!(matches!(
                ProtoReader::new(&bytes).read_varint(),
                Err(crate::import::error::ImportError::MalformedVarint)
            ));
        }
    }

    #[test]
    fn feldnummern_muessen_in_den_protobuf_tag_passen() {
        for bytes in [&[0x00][..], &[0x80, 0x80, 0x80, 0x80, 0x10][..]] {
            assert!(ProtoReader::new(bytes).read_tag().is_err());
        }
        assert_eq!(
            ProtoReader::new(&[0xf8, 0xff, 0xff, 0xff, 0x0f])
                .read_tag()
                .unwrap(),
            (0x1fff_ffff, WireType::Varint)
        );
    }

    #[test]
    fn feldkennung_trennt_nummer_und_drahttyp() {
        // Feld 1, längenbegrenzt: (1 << 3) | 2 = 0x0A.
        let mut reader = ProtoReader::new(&[0x0A]);
        let (feld, drahttyp) = reader.read_tag().expect("gültige Feldkennung");
        assert_eq!(feld, 1);
        assert_eq!(drahttyp, WireType::LengthDelimited);
    }

    #[test]
    fn laengenbegrenztes_feld_liefert_den_inneren_ausschnitt() {
        let mut reader = ProtoReader::new(&[0x03, b'a', b'b', b'c']);
        let ausschnitt = reader
            .read_length_delimited()
            .expect("gültiges längenbegrenztes Feld");
        assert_eq!(ausschnitt, b"abc");
    }

    #[test]
    fn zickzack_dekodiert_symmetrisch() {
        assert_eq!(zigzag_decode(0), 0);
        assert_eq!(zigzag_decode(1), -1);
        assert_eq!(zigzag_decode(2), 1);
        assert_eq!(zigzag_decode(3), -2);
        assert_eq!(zigzag_decode(4_294_967_294), 2_147_483_647);
    }

    #[test]
    fn gepackte_varints_werden_bis_zum_ende_gelesen() {
        // Drei Ein-Byte-Varints hintereinander: 1, 2, 3.
        let werte = read_packed_varints(&[0x01, 0x02, 0x03]).expect("gültige Varints");
        assert_eq!(werte, vec![1, 2, 3]);
    }

    #[test]
    fn abgeschnittenes_varint_meldet_sich() {
        // 0x80 kündigt ein Folgebyte an, das nicht kommt.
        let mut reader = ProtoReader::new(&[0x80]);
        assert!(reader.read_varint().is_err());
    }
}
