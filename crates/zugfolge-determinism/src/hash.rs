//! Kanonischer Zustands-Hash.

use core::fmt;

use sha2::{Digest, Sha256};

/// Trennt Zustandshashes von jeder anderen Hashverwendung.
const STATE_DOMAIN: &[u8] = b"zugfolge/state/v1";

const TAG_SCHEMA: u8 = 1;
const TAG_INT: u8 = 2;
const TAG_UINT: u8 = 3;
const TAG_FLAG: u8 = 4;
const TAG_TEXT: u8 = 5;
const TAG_BYTES: u8 = 6;
const TAG_SEQ: u8 = 7;
const TAG_HASH: u8 = 8;
const TAG_END: u8 = 255;

/// Der Hash eines vollständigen Simulationszustands.
///
/// Vergleichbar über Betriebssysteme und Prozessorarchitekturen hinweg: Alle
/// Zahlen gehen in Big-Endian-Darstellung fester Breite ein, alle Namen mit
/// Längenpräfix.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StateHash([u8; 32]);

impl StateHash {
    /// Die 32 Rohbytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Kleinbuchstaben-Hexdarstellung, 64 Zeichen.
    pub fn to_hex(&self) -> String {
        const ZIFFERN: &[u8; 16] = b"0123456789abcdef";
        let mut text = String::with_capacity(64);
        for byte in self.0 {
            text.push(char::from(ZIFFERN[usize::from(byte >> 4)]));
            text.push(char::from(ZIFFERN[usize::from(byte & 0x0F)]));
        }
        text
    }

    /// Liest eine Hexdarstellung ein, etwa aus einer Golden-Master-Datei.
    ///
    /// # Errors
    ///
    /// Wenn `text` nicht aus genau 64 Hexziffern besteht.
    pub fn parse_hex(text: &str) -> Result<Self, StateHashError> {
        let text = text.trim();
        if text.len() != 64 {
            return Err(StateHashError::Length(text.len()));
        }
        let mut bytes = [0_u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            let start = index * 2;
            let paar = text
                .get(start..start + 2)
                .ok_or(StateHashError::Length(text.len()))?;
            *byte = u8::from_str_radix(paar, 16).map_err(|_| StateHashError::Digit(paar.into()))?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for StateHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_hex())
    }
}

impl fmt::Debug for StateHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "StateHash({})", self.to_hex())
    }
}

/// Fehler beim Einlesen einer Hexdarstellung.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum StateHashError {
    /// Die Zeichenkette hat nicht die erwarteten 64 Zeichen.
    Length(usize),
    /// Ein Zeichenpaar ist keine Hexzahl.
    Digit(String),
}

impl fmt::Display for StateHashError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Length(laenge) => {
                write!(
                    formatter,
                    "Zustands-Hash braucht 64 Hexziffern, hat aber {laenge}"
                )
            }
            Self::Digit(paar) => write!(formatter, "'{paar}' ist keine Hexzahl"),
        }
    }
}

impl core::error::Error for StateHashError {}

/// Baut einen kanonischen Zustands-Hash.
///
/// Jeder Eintrag wird als `Kennung + Namenslänge + Name + Wertlänge + Wert`
/// geschrieben. Dadurch lässt sich kein Zustand als ein anderer ausgeben:
/// `int("ab", 1)` und `int("a", …)` erzeugen verschiedene Eingaben, auch wenn
/// die Bytefolgen sich sonst überlappten.
///
/// Die Reihenfolge der Einträge ist Teil des Hashes. Wer über eine Menge
/// hasht, sortiert sie vorher — deshalb `BTreeMap` und nicht `HashMap`
/// (siehe `clippy.toml`).
pub struct StateHasher {
    inner: Sha256,
    fields: u64,
}

impl StateHasher {
    /// Beginnt einen Hash für ein benanntes Zustandsschema.
    ///
    /// `schema` trennt Modelle voneinander: Zwei Modelle mit zufällig gleichen
    /// Feldern bekommen trotzdem verschiedene Hashes. Die Zeichenkette gehört
    /// versioniert, etwa `"occupation-board/v1"`.
    pub fn new(schema: &str) -> Self {
        let mut inner = Sha256::new();
        inner.update(STATE_DOMAIN);
        let mut hasher = Self { inner, fields: 0 };
        hasher.write_entry(TAG_SCHEMA, "schema", schema.as_bytes());
        hasher
    }

    /// Ganzzahliger Zustandswert — Geld in Cent, Zeiten in Sekunden,
    /// Positionen in Millimetern.
    pub fn int(&mut self, name: &str, value: i64) -> &mut Self {
        self.write_entry(TAG_INT, name, &value.to_be_bytes());
        self
    }

    /// Vorzeichenloser ganzzahliger Zustandswert.
    pub fn uint(&mut self, name: &str, value: u64) -> &mut Self {
        self.write_entry(TAG_UINT, name, &value.to_be_bytes());
        self
    }

    /// Wahrheitswert.
    pub fn flag(&mut self, name: &str, value: bool) -> &mut Self {
        self.write_entry(TAG_FLAG, name, &[u8::from(value)]);
        self
    }

    /// Zeichenkette — Bezeichner, nie freier Text von Spielern.
    pub fn text(&mut self, name: &str, value: &str) -> &mut Self {
        self.write_entry(TAG_TEXT, name, value.as_bytes());
        self
    }

    /// Rohbytes.
    pub fn bytes(&mut self, name: &str, value: &[u8]) -> &mut Self {
        self.write_entry(TAG_BYTES, name, value);
        self
    }

    /// Beginnt eine Folge und schreibt ihre Länge.
    ///
    /// Ohne diesen Aufruf wären zwei Folgen ununterscheidbar, deren Elemente
    /// hintereinander dieselbe Bytefolge ergeben. Die Elemente folgen als
    /// gewöhnliche Einträge.
    pub fn seq(&mut self, name: &str, len: usize) -> &mut Self {
        let len = u64::try_from(len).expect("Folgenlänge passt in 64 Bit");
        self.write_entry(TAG_SEQ, name, &len.to_be_bytes());
        self
    }

    /// Ein bereits berechneter Teilhash, etwa der einer Region.
    pub fn hash(&mut self, name: &str, value: StateHash) -> &mut Self {
        self.write_entry(TAG_HASH, name, value.as_bytes());
        self
    }

    /// Anzahl der bisher geschriebenen Einträge, das Schema eingeschlossen.
    pub const fn field_count(&self) -> u64 {
        self.fields
    }

    /// Schließt den Hash ab.
    pub fn finish(mut self) -> StateHash {
        let anzahl = self.fields;
        self.write_entry(TAG_END, "", &anzahl.to_be_bytes());
        StateHash(self.inner.finalize().into())
    }

    fn write_entry(&mut self, tag: u8, name: &str, value: &[u8]) {
        let name_len = u32::try_from(name.len()).expect("Feldname passt in 32 Bit");
        let value_len = u32::try_from(value.len()).expect("Feldwert passt in 32 Bit");
        self.inner.update([tag]);
        self.inner.update(name_len.to_be_bytes());
        self.inner.update(name.as_bytes());
        self.inner.update(value_len.to_be_bytes());
        self.inner.update(value);
        self.fields = self.fields.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{StateHash, StateHashError, StateHasher};

    fn hash_von(bau: impl FnOnce(&mut StateHasher)) -> StateHash {
        let mut hasher = StateHasher::new("test/v1");
        bau(&mut hasher);
        hasher.finish()
    }

    #[test]
    fn gleicher_inhalt_gleicher_hash() {
        let erster = hash_von(|h| {
            h.int("geld_cent", -1250).text("evu", "nordwest");
        });
        let zweiter = hash_von(|h| {
            h.int("geld_cent", -1250).text("evu", "nordwest");
        });
        assert_eq!(erster, zweiter);
    }

    #[test]
    fn feldnamen_sind_nicht_verschiebbar() {
        // Ohne Längenpräfix wären "ab"/"c" und "a"/"bc" derselbe Hasheingang.
        let erster = hash_von(|h| {
            h.text("ab", "c");
        });
        let zweiter = hash_von(|h| {
            h.text("a", "bc");
        });
        assert_ne!(erster, zweiter);
    }

    #[test]
    fn reihenfolge_zaehlt() {
        let erster = hash_von(|h| {
            h.int("a", 1).int("b", 2);
        });
        let zweiter = hash_von(|h| {
            h.int("b", 2).int("a", 1);
        });
        assert_ne!(erster, zweiter);
    }

    #[test]
    fn schema_trennt_modelle() {
        let mut erster = StateHasher::new("a/v1");
        erster.int("x", 1);
        let mut zweiter = StateHasher::new("b/v1");
        zweiter.int("x", 1);
        assert_ne!(erster.finish(), zweiter.finish());
    }

    #[test]
    fn typ_trennt_gleiche_bytes() {
        // 1_i64 und 1_u64 haben dieselbe Bytefolge — die Kennung trennt sie.
        let erster = hash_von(|h| {
            h.int("x", 1);
        });
        let zweiter = hash_von(|h| {
            h.uint("x", 1);
        });
        assert_ne!(erster, zweiter);
    }

    #[test]
    fn leere_folge_unterscheidet_sich_von_fehlender_folge() {
        let mit = hash_von(|h| {
            h.seq("halte", 0);
        });
        let ohne = hash_von(|_| {});
        assert_ne!(mit, ohne);
    }

    #[test]
    fn feldzahl_wird_mitgezaehlt() {
        let mut hasher = StateHasher::new("test/v1");
        assert_eq!(hasher.field_count(), 1, "das Schema zählt mit");
        hasher.int("a", 1).flag("b", true);
        assert_eq!(hasher.field_count(), 3);
    }

    #[test]
    fn hex_ist_umkehrbar() {
        let hash = hash_von(|h| {
            h.int("x", 7);
        });
        let text = hash.to_hex();
        assert_eq!(text.len(), 64);
        assert_eq!(StateHash::parse_hex(&text), Ok(hash));
        assert_eq!(StateHash::parse_hex(&format!("  {text}\n")), Ok(hash));
    }

    #[test]
    fn hex_meldet_fehler() {
        assert_eq!(StateHash::parse_hex("abc"), Err(StateHashError::Length(3)));
        let falsch = "z".repeat(64);
        assert!(matches!(
            StateHash::parse_hex(&falsch),
            Err(StateHashError::Digit(_))
        ));
    }

    #[test]
    fn teilhashes_lassen_sich_zusammensetzen() {
        let region = hash_von(|h| {
            h.int("belegt_bis", 900);
        });
        let welt = hash_von(|h| {
            h.hash("region_leipzig", region);
        });
        assert_ne!(welt, region);
    }
}
