//! Golden-Master-Ablage für Zustands-Hashes.

use std::fs;
use std::path::Path;

use crate::hash::StateHash;

/// Ist diese Umgebungsvariable auf `1` gesetzt, werden Golden-Master
/// geschrieben statt geprüft.
const UPDATE_ENV: &str = "ZUGFOLGE_GOLDEN_UPDATE";

/// Vergleicht einen Zustands-Hash mit dem hinterlegten Golden-Master.
///
/// Der Golden-Master ist eine einzeilige Textdatei mit der Hexdarstellung. Sie
/// gehört in die Versionsverwaltung: Sie ist der eigentliche Beweis, dass zwei
/// Betriebssysteme, zwei Prozessorarchitekturen und zwei Zeitpunkte denselben
/// Zustand erzeugen.
///
/// Fehlt die Datei oder weicht sie ab, schlägt der Test fehl. Ein neuer Stand
/// wird bewusst gesetzt — mit `ZUGFOLGE_GOLDEN_UPDATE=1` — und **muss** im
/// Commit begründet werden: Ein geänderter Golden-Master heißt entweder, dass
/// eine Regel absichtlich anders rechnet, oder dass gerade eine Welt
/// unbemerkt kaputtgegangen ist.
///
/// # Panics
///
/// Wenn die Datei fehlt, nicht lesbar ist oder einen anderen Hash enthält.
pub fn assert_golden(path: impl AsRef<Path>, actual: StateHash) {
    let aktualisieren = std::env::var(UPDATE_ENV).is_ok_and(|wert| wert == "1");
    vergleiche_oder_schreibe(path.as_ref(), actual, aktualisieren);
}

/// Der prüfbare Kern von [`assert_golden`], ohne Umgebungsvariable.
///
/// Getrennt, damit der Test des Harnischs nicht selbst prozessweiten Zustand
/// setzen muss — parallel laufende Tests würden sich sonst gegenseitig
/// umschalten.
fn vergleiche_oder_schreibe(path: &Path, actual: StateHash, aktualisieren: bool) {
    if aktualisieren {
        if let Some(ordner) = path.parent() {
            fs::create_dir_all(ordner)
                .unwrap_or_else(|fehler| panic!("{} nicht anlegbar: {fehler}", ordner.display()));
        }
        fs::write(path, format!("{actual}\n"))
            .unwrap_or_else(|fehler| panic!("{} nicht schreibbar: {fehler}", path.display()));
        return;
    }

    let inhalt = fs::read_to_string(path).unwrap_or_else(|fehler| {
        panic!(
            "Golden-Master {} nicht lesbar: {fehler}\n\
             Neu erzeugen mit {UPDATE_ENV}=1 cargo test — und die Änderung im Commit begründen.",
            path.display()
        )
    });

    let erwartet = inhalt.trim();
    assert_eq!(
        erwartet,
        actual.to_hex(),
        "Golden-Master {} weicht ab.\n\
         Entweder rechnet eine Regel absichtlich anders — dann mit {UPDATE_ENV}=1 neu setzen \
         und begründen — oder der Determinismus ist verletzt.",
        path.display()
    );
}

/// Pfad zu einer Golden-Master-Datei im **aufrufenden** Crate:
/// `tests/golden/<name>.hash`.
///
/// ```
/// let pfad = zugfolge_determinism::golden_path!("beispiel");
/// assert!(pfad.ends_with("beispiel.hash"));
/// ```
#[macro_export]
macro_rules! golden_path {
    ($name:literal) => {
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden/", $name, ".hash")
    };
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::vergleiche_oder_schreibe;
    use crate::hash::{StateHash, StateHasher};

    fn beispielhash(wert: i64) -> StateHash {
        let mut hasher = StateHasher::new("golden/v1");
        hasher.int("x", wert);
        hasher.finish()
    }

    fn temppfad(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("zugfolge-golden-{name}")).join("wert.hash")
    }

    #[test]
    fn schreibt_und_prueft_denselben_wert() {
        let pfad = temppfad("schreiben");
        let _ = fs::remove_file(&pfad);

        vergleiche_oder_schreibe(&pfad, beispielhash(4711), true);

        let inhalt = fs::read_to_string(&pfad).expect("Golden-Master wurde geschrieben");
        assert_eq!(inhalt.trim(), beispielhash(4711).to_hex());

        vergleiche_oder_schreibe(&pfad, beispielhash(4711), false);
        let _ = fs::remove_file(&pfad);
    }

    #[test]
    #[should_panic(expected = "weicht ab")]
    fn abweichender_wert_schlaegt_fehl() {
        let pfad = temppfad("abweichung");
        let _ = fs::remove_file(&pfad);
        vergleiche_oder_schreibe(&pfad, beispielhash(1), true);
        vergleiche_oder_schreibe(&pfad, beispielhash(2), false);
    }

    #[test]
    #[should_panic(expected = "nicht lesbar")]
    fn fehlender_golden_master_schlaegt_fehl() {
        vergleiche_oder_schreibe(&temppfad("fehlt-mit-absicht"), beispielhash(0), false);
    }

    #[test]
    fn pfadmakro_zeigt_ins_aufrufende_crate() {
        let pfad = crate::golden_path!("beispiel");
        assert!(pfad.contains("zugfolge-determinism"), "{pfad}");
        assert!(pfad.ends_with("tests/golden/beispiel.hash"), "{pfad}");
    }
}
