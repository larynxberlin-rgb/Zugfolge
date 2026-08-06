//! **Wegwerf-Spike M0.3 — Sperrzeitentreppe und Konfliktprüfung.**
//!
//! > Dieser Code ist zum Wegwerfen gebaut. Er **verfällt mit M3.1**, sobald das
//! > echte Sperrzeitenmodell steht. Nichts außerhalb von `spikes/` darf ihn
//! > verwenden; er trägt weder Weltisolation noch Persistenz noch Fahrdynamik.
//!
//! Der Spike beantwortet genau eine Frage, und zwar zum billigsten möglichen
//! Zeitpunkt:
//!
//! > **Trägt die Konfliktprüfung über Sperrzeiten?**
//!
//! Dafür baut er den kleinsten Aufbau, in dem die Frage überhaupt entscheidbar
//! ist — drei Betriebsstellen, eine zweigleisige Strecke, ein eingleisiger Ast,
//! zwei Züge — rechnet die Sperrzeitentreppe beider Züge aus, prüft sie
//! gegeneinander und zeichnet das Ergebnis als Bildfahrplan.
//!
//! ## Aufbau
//!
//! | Modul | Inhalt |
//! |-------|--------|
//! | [`network`] | die Beispielinfrastruktur und ihre Konfliktressourcen |
//! | [`train`] | Zugcharakteristik und Zugfahrt |
//! | [`blocking`] | das Sperrzeitenmodell — die sechs Anteile einer Sperrzeit |
//! | [`conflict`] | die Konfliktprüfung mit erklärbarem Befund |
//! | [`board`] | dasselbe als Zustandsmodell, für Determinismus- und Golden-Master-Test |
//! | [`diagram`] | der Bildfahrplan als SVG |
//! | [`case`] | die vier Betriebsfälle, die der Spike vorführt |
//!
//! ## Was der Spike bewusst nicht tut
//!
//! Keine Fahrdynamik (M1.10), keine Fahrstraßen im Bahnhofskopf (M1.7), keine
//! Weichen, keine Verkehrstage, keine Zugsicherung, keine Datenhaltung. Die
//! vollständige Liste mit Begründung steht in der README des Spikes.

pub mod blocking;
pub mod board;
pub mod case;
pub mod conflict;
pub mod diagram;
pub mod images;
pub mod network;
pub mod train;

use zugfolge_determinism::SimTime;

/// Uhrzeit eines Simulationszeitpunkts als `hh:mm:ss`.
///
/// Die Simulationszeit zählt Sekunden seit der Weltepoche; für die Anzeige
/// zählt nur die Tageszeit. Ohne `rem_euclid` liefe die Darstellung für
/// negative Zeiten falsch — die gibt es hier nicht, aber die Formel soll auch
/// dann nicht lügen.
pub fn clock(time: SimTime) -> String {
    let sekunden = time.seconds().rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}",
        sekunden / 3600,
        (sekunden / 60) % 60,
        sekunden % 60
    )
}

/// Eine Dauer in Sekunden als `m:ss`.
pub fn duration(seconds: i64) -> String {
    let vorzeichen = if seconds < 0 { "−" } else { "" };
    let betrag = seconds.abs();
    format!("{vorzeichen}{}:{:02}", betrag / 60, betrag % 60)
}

#[cfg(test)]
mod tests {
    use zugfolge_determinism::SimTime;

    use super::{clock, duration};

    #[test]
    fn uhrzeit_und_dauer_werden_lesbar_dargestellt() {
        assert_eq!(clock(SimTime::from_seconds(28_800)), "08:00:00");
        assert_eq!(clock(SimTime::from_seconds(29_637)), "08:13:57");
        assert_eq!(clock(SimTime::from_seconds(86_400)), "00:00:00");
        assert_eq!(duration(234), "3:54");
        assert_eq!(duration(60), "1:00");
        assert_eq!(duration(-90), "−1:30");
    }
}
