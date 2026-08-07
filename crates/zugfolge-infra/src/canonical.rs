//! Kanonische Serialisierung in den Zustands-Hash.
//!
//! Der Betriebsgraph ist ein **unveränderliches Artefakt** (M1.12). Sein Wert
//! hängt daran, dass zwei Läufe, zwei Betriebssysteme und zwei Jahre denselben
//! Hash ergeben. Deshalb schreibt jeder Typ sich selbst — mit einem stabilen
//! Feldnamen und, bei Aufzählungen, einer stabilen Textkennung statt einer
//! Variantennummer. Wird eine Variante umsortiert, bleibt der Hash dadurch
//! gleich; wird eine Kennung geändert, ändert sich die Welt, und das soll
//! auffallen.
//!
//! Die Schnittstelle ist bewusst `pub(crate)`: Sie ist ein Bauteil des
//! Fingerabdrucks, keine öffentliche Zusicherung.

use zugfolge_determinism::StateHasher;

/// Schreibt den vollständigen Inhalt eines Wertes unter `name` in den Hasher.
pub(crate) trait Canonical {
    /// Schreibt den Wert. Die Reihenfolge der Schreibvorgänge ist Teil des
    /// Hashes und darf sich nicht zufällig ändern.
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher);
}

impl Canonical for str {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self);
    }
}

impl Canonical for String {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self);
    }
}

impl<T: Canonical> Canonical for Option<T> {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        match self {
            Some(wert) => {
                hasher.flag(name, true);
                wert.write_canonical(name, hasher);
            }
            None => {
                hasher.flag(name, false);
            }
        }
    }
}
