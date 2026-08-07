//! Neigungsprofil aus einem Höhenmodell — **M1.5**.
//!
//! `docs/daten.md` 1 nennt die Längsneigung ausdrücklich als eine der drei
//! Angaben, die OSM nicht liefert (`incline` ist kaum gepflegt) und die
//! deshalb abgeleitet werden müssen: aus einem digitalen Höhenmodell (DEM)
//! entlang der Gleisgeometrie. Diese Datei liefert genau dieses Verfahren —
//! [`derive_gradient_profile`] rechnet Höhenstichproben in ein
//! [`BandProfile<Gradient>`](crate::BandProfile) um, wie es [`Track::builder`]
//! erwartet.
//!
//! **Was diese Datei nicht ist: ein Import.** Das Quellenregister
//! (`tools/guards/quellenregister.json`, `docs/rechte.md` 3) führt das
//! Höhenmodell der Pilotregion mit dem Status `pruefung` — Version,
//! Bereitstellungsweg und Lizenz sind noch nicht geklärt. Invariante 8
//! verbietet jeden Import ohne dokumentierte Freigabe, und der Wächter
//! `rights-gate` setzt das durch. Deshalb liefert diese Datei nur das
//! Verfahren: [`ElevationSample`] ist eine Position-Höhe-Stichprobe, gleich
//! woher sie stammt. Sobald das Höhenmodell freigegeben ist, liest ein
//! eigener Import (nach dem Vorbild von M1.2) reale Stichproben und übergibt
//! sie hierher — an dieser Funktion ändert sich dadurch nichts.
//!
//! **Geglättet, wie der Milestone verlangt.** Ein Höhenmodell rauscht: Zwei
//! benachbarte Stichproben können eine Neigung ergeben, die kein Zug je zu
//! spüren bekäme, weil ihr Abstand unter der Auflösungsgrenze des Modells
//! liegt. [`derive_gradient_profile`] rechnet deshalb nicht Stichprobe gegen
//! Stichprobe, sondern setzt Stützpunkte im Abstand von mindestens
//! `min_band_length`, interpoliert die Höhe an jedem Stützpunkt linear aus
//! den umliegenden Stichproben und bildet erst zwischen den Stützpunkten ein
//! Band. Ein Reststück kürzer als `min_band_length` bekommt kein eigenes
//! Band, sondern verlängert das letzte — kein Band ist je kürzer als die
//! angegebene Mindestlänge.
//!
//! Jedes abgeleitete Band trägt [`Confidence::Derived`] — es stammt aus einem
//! Modell, nicht aus einer erfassten Messung (`docs/betriebsgraph.md` 1).

use crate::bands::{Band, BandProfile};
use crate::error::InfraError;
use crate::provenance::{Confidence, Provenance, SourceId};
use crate::units::{Gradient, Length};

/// Eine geeignete Standard-Mindestbandlänge für die Glättung.
///
/// 200 m sind kürzer als jeder betrieblich relevante Neigungswechsel der
/// Pilotregion und lang genug, um das Rauschen üblicher Höhenmodelle
/// (Rasterweite meist 1–25 m) nicht in einzelne Bänder zu übersetzen.
pub const DEFAULT_MIN_BAND_LENGTH: Length = Length::from_metres(200);

/// Eine Höhenstichprobe entlang eines Gleises.
///
/// `position` zählt wie jede Position in diesem Modell ab dem Gleisanfang in
/// Richtung wachsender Kilometrierung (Invariante 3); `elevation` ist die
/// Höhe über einem beliebigen, aber für alle Stichproben eines Aufrufs
/// gleichen Bezugsniveau — nur die **Differenz** zwischen Stichproben geht in
/// die Neigung ein, das absolute Niveau nicht.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ElevationSample {
    position: Length,
    elevation: Length,
}

impl ElevationSample {
    /// Eine Stichprobe an einer Position mit einer Höhe.
    pub const fn new(position: Length, elevation: Length) -> Self {
        Self {
            position,
            elevation,
        }
    }

    /// Die Position entlang des Gleises.
    pub const fn position(&self) -> Length {
        self.position
    }

    /// Die Höhe an dieser Position.
    pub const fn elevation(&self) -> Length {
        self.elevation
    }
}

/// `numerator / denominator`, kaufmännisch gerundet — ganzzahlig, wie jede
/// Rechnung in diesem Modell (Invariante 3). `denominator` muss positiv sein.
fn round_div(numerator: i64, denominator: i64) -> i64 {
    let half = denominator / 2;
    if numerator >= 0 {
        numerator.saturating_add(half) / denominator
    } else {
        -((-numerator).saturating_add(half) / denominator)
    }
}

/// Lineare Interpolation der Höhe zwischen zwei Stichproben.
///
/// Setzt voraus, dass `samples` mindestens zwei aufsteigend sortierte
/// Stichproben enthält und `position` zwischen der ersten und letzten liegt —
/// genau das prüft [`derive_gradient_profile`], bevor sie diese Funktion
/// aufruft.
fn interpolate(samples: &[ElevationSample], position: Length) -> Length {
    for fenster in samples.windows(2) {
        let [a, b] = fenster else { continue };
        if position < a.position || position > b.position {
            continue;
        }
        if position == a.position {
            return a.elevation;
        }
        if position == b.position {
            return b.elevation;
        }
        let run = (b.position - a.position).millimetres();
        let delta = (b.elevation - a.elevation).millimetres();
        let offset = (position - a.position).millimetres();
        let angehoben = round_div(delta.saturating_mul(offset), run);
        return a.elevation + Length::from_millimetres(angehoben);
    }
    samples
        .last()
        .map_or(Length::ZERO, ElevationSample::elevation)
}

/// Die Neigung aus einem Höhenunterschied über eine Länge, in Zehntel
/// Promille — die Umkehrung von [`Gradient::rise_over`].
fn gradient_from_rise(rise: Length, run: Length) -> Gradient {
    let run_mm = run.millimetres();
    if run_mm <= 0 {
        return Gradient::LEVEL;
    }
    let zehntel_promille = round_div(rise.millimetres().saturating_mul(10_000), run_mm);
    let tenths = i32::try_from(zehntel_promille).unwrap_or(if zehntel_promille > 0 {
        i32::MAX
    } else {
        i32::MIN
    });
    Gradient::from_per_mille_tenths(tenths)
}

/// Stützpunkte im Abstand von mindestens `min_band_length`, beginnend bei
/// null und endend bei `track_length`. Ein Reststück kürzer als
/// `min_band_length` bekommt kein eigenes Element, sondern verlängert das
/// letzte reguläre Band.
fn resample_boundaries(track_length: Length, min_band_length: Length) -> Vec<Length> {
    let min_mm = min_band_length.millimetres();
    let total_mm = track_length.millimetres();
    let full_bands = total_mm / min_mm;

    let mut boundaries = vec![Length::ZERO];
    for index in 1..full_bands {
        boundaries.push(Length::from_millimetres(min_mm.saturating_mul(index)));
    }
    boundaries.push(track_length);
    boundaries
}

/// Leitet ein geglättetes Neigungsprofil aus Höhenstichproben entlang eines
/// Gleises ab.
///
/// `samples` muss aufsteigend sortiert sein und das ganze Gleis abdecken —
/// die erste Stichprobe bei [`Length::ZERO`], die letzte bei `track_length`.
/// `min_band_length` ist der Mindestabstand der Stützpunkte, an denen die
/// Glättung neu abtastet (siehe Moduldokumentation); [`DEFAULT_MIN_BAND_LENGTH`]
/// ist ein brauchbarer Standardwert. `source` benennt die Herkunft der
/// Stichproben im Quellenregister — jedes Band trägt [`Confidence::Derived`],
/// weil es aus einem Modell und nicht aus einer Messung stammt.
///
/// # Errors
///
/// - [`InfraError::EmptyElevationSamples`], wenn `samples` leer ist.
/// - [`InfraError::UnorderedElevationSamples`], wenn zwei Stichproben nicht
///   aufsteigend sortiert sind.
/// - [`InfraError::ElevationSamplesDoNotCoverTrack`], wenn die erste
///   Stichprobe nicht bei null liegt oder die letzte nicht bei
///   `track_length`.
/// - [`InfraError::NonPositiveLength`], wenn `track_length` oder
///   `min_band_length` nicht positiv sind.
pub fn derive_gradient_profile(
    samples: &[ElevationSample],
    track_length: Length,
    min_band_length: Length,
    source: SourceId,
) -> Result<BandProfile<Gradient>, InfraError> {
    if !track_length.is_positive() {
        return Err(InfraError::NonPositiveLength {
            what: "Gleislänge",
            value: track_length,
        });
    }
    if !min_band_length.is_positive() {
        return Err(InfraError::NonPositiveLength {
            what: "Mindestbandlänge",
            value: min_band_length,
        });
    }

    let Some(erste) = samples.first() else {
        return Err(InfraError::EmptyElevationSamples);
    };
    for fenster in samples.windows(2) {
        let [a, b] = fenster else { continue };
        if b.position <= a.position {
            return Err(InfraError::UnorderedElevationSamples { at: b.position });
        }
    }
    let letzte = samples.last().unwrap_or(erste);
    if erste.position != Length::ZERO || letzte.position != track_length {
        return Err(InfraError::ElevationSamplesDoNotCoverTrack {
            first: erste.position,
            last: letzte.position,
            track_length,
        });
    }

    let provenance = Provenance::new(source, Confidence::Derived);
    let boundaries = resample_boundaries(track_length, min_band_length);

    let mut sections: Vec<(Length, Length, Gradient)> =
        Vec::with_capacity(boundaries.len().saturating_sub(1));
    for fenster in boundaries.windows(2) {
        let [start, end] = fenster else { continue };
        let hoehe_start = interpolate(samples, *start);
        let hoehe_end = interpolate(samples, *end);
        let gradient = gradient_from_rise(hoehe_end - hoehe_start, *end - *start);
        // Zwei benachbarte Stützpunkte mit derselben Neigung sind kein
        // eigener Wechsel, sondern derselbe Abschnitt fortgesetzt — eine
        // gleichmäßige Rampe soll ein Band ergeben, nicht eines je Stützpunkt.
        match sections.last_mut() {
            Some((_, letztes_ende, letzte_neigung)) if *letzte_neigung == gradient => {
                *letztes_ende = *end;
            }
            _ => sections.push((*start, *end, gradient)),
        }
    }

    let bands = sections
        .into_iter()
        .map(|(start, end, gradient)| Band::new(start, end, gradient, provenance.clone()))
        .collect();

    BandProfile::new("neigung", track_length, bands)
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_MIN_BAND_LENGTH, ElevationSample, derive_gradient_profile};
    use crate::error::InfraError;
    use crate::provenance::{Confidence, SourceId};
    use crate::units::{Gradient, Length};

    fn quelle() -> SourceId {
        SourceId::new("dem-hoehenmodell").expect("gültige Quellenkennung")
    }

    #[test]
    fn eine_gleichmaessige_steigung_ergibt_ein_einziges_band() {
        let laenge = Length::from_metres(1_000);
        // 10 m Höhe auf 1000 m sind genau 10 ‰ — eine glatte Rampe ohne
        // Rauschen, an der die Glättung nichts verändern sollte.
        let samples = [
            ElevationSample::new(Length::ZERO, Length::from_metres(100)),
            ElevationSample::new(laenge, Length::from_metres(110)),
        ];

        let profil = derive_gradient_profile(&samples, laenge, DEFAULT_MIN_BAND_LENGTH, quelle())
            .expect("gültiges Profil");

        assert_eq!(profil.band_count(), 1);
        assert_eq!(
            profil.value_at(Length::from_metres(500)),
            Some(&Gradient::from_per_mille(10))
        );
        assert_eq!(profil.bands()[0].confidence(), Confidence::Derived);
    }

    #[test]
    fn ein_gefaelle_traegt_ein_negatives_vorzeichen() {
        let laenge = Length::from_metres(1_000);
        let samples = [
            ElevationSample::new(Length::ZERO, Length::from_metres(110)),
            ElevationSample::new(laenge, Length::from_metres(100)),
        ];
        let profil = derive_gradient_profile(&samples, laenge, DEFAULT_MIN_BAND_LENGTH, quelle())
            .expect("gültiges Profil");
        assert!(
            profil
                .value_at(Length::from_metres(500))
                .is_some_and(|neigung| neigung.is_falling())
        );
    }

    #[test]
    fn rauschen_zwischen_stuetzpunkten_verschwindet_in_der_glaettung() {
        let laenge = Length::from_metres(1_000);
        // Insgesamt eine Rampe von 0 auf 10 m, aber mit einer Stichprobe
        // mittendrin, die kurz nach oben und wieder zurück ausschlägt — ein
        // typisches DEM-Rauschmuster zwischen zwei Stützpunkten.
        let samples = [
            ElevationSample::new(Length::ZERO, Length::ZERO),
            ElevationSample::new(Length::from_metres(400), Length::from_metres(4)),
            ElevationSample::new(Length::from_metres(450), Length::from_metres(6)),
            ElevationSample::new(Length::from_metres(500), Length::from_metres(4)),
            ElevationSample::new(laenge, Length::from_metres(10)),
        ];

        // Ein einziger Stützpunktabstand über die volle Länge glättet das
        // Rauschen bei 450 m vollständig weg: Es bleibt ein Band.
        let profil =
            derive_gradient_profile(&samples, laenge, laenge, quelle()).expect("gültiges Profil");
        assert_eq!(profil.band_count(), 1);
        assert_eq!(
            profil.value_at(Length::from_metres(10)),
            Some(&Gradient::from_per_mille(10))
        );
    }

    #[test]
    fn ein_kurzer_rest_bekommt_kein_eigenes_band() {
        let laenge = Length::from_metres(1_050);
        // Zwei unterschiedliche Neigungen, damit die Stützpunktbänder nicht
        // wegen gleicher Werte zusammenfallen — hier soll allein die
        // Reststück-Regel greifen.
        let samples = [
            ElevationSample::new(Length::ZERO, Length::ZERO),
            ElevationSample::new(Length::from_metres(500), Length::from_metres(3)),
            ElevationSample::new(laenge, Length::from_metres(10)),
        ];
        let profil = derive_gradient_profile(&samples, laenge, Length::from_metres(500), quelle())
            .expect("gültiges Profil");

        // 1050 m bei 500 m Mindestbandlänge: zwei Bänder, keine drei — das
        // letzte reicht von 500 bis 1050 m statt ein 50-m-Restband zu bilden.
        assert_eq!(profil.band_count(), 2);
        assert_eq!(profil.bands()[0].end(), Length::from_metres(500));
        assert_eq!(profil.bands()[1].start(), Length::from_metres(500));
        assert_eq!(profil.bands()[1].end(), laenge);
    }

    #[test]
    fn ein_gleis_kuerzer_als_die_mindestbandlaenge_bekommt_ein_band() {
        let laenge = Length::from_metres(80);
        let samples = [
            ElevationSample::new(Length::ZERO, Length::ZERO),
            ElevationSample::new(laenge, Length::from_metres(1)),
        ];
        let profil = derive_gradient_profile(&samples, laenge, DEFAULT_MIN_BAND_LENGTH, quelle())
            .expect("gültiges Profil");
        assert_eq!(profil.band_count(), 1);
    }

    #[test]
    fn leere_stichproben_fallen_auf() {
        let fehler = derive_gradient_profile(
            &[],
            Length::from_metres(1_000),
            DEFAULT_MIN_BAND_LENGTH,
            quelle(),
        )
        .expect_err("ohne Stichproben gibt es kein Profil");
        assert_eq!(fehler, InfraError::EmptyElevationSamples);
    }

    #[test]
    fn unsortierte_stichproben_fallen_auf() {
        let samples = [
            ElevationSample::new(Length::from_metres(500), Length::ZERO),
            ElevationSample::new(Length::from_metres(200), Length::from_metres(1)),
        ];
        let fehler = derive_gradient_profile(
            &samples,
            Length::from_metres(500),
            DEFAULT_MIN_BAND_LENGTH,
            quelle(),
        )
        .expect_err("die Reihenfolge muss aufsteigend sein");
        assert!(matches!(
            fehler,
            InfraError::UnorderedElevationSamples { .. }
        ));
    }

    #[test]
    fn luecken_am_rand_fallen_auf() {
        let laenge = Length::from_metres(1_000);
        let samples = [
            ElevationSample::new(Length::from_metres(100), Length::ZERO),
            ElevationSample::new(laenge, Length::from_metres(5)),
        ];
        let fehler = derive_gradient_profile(&samples, laenge, DEFAULT_MIN_BAND_LENGTH, quelle())
            .expect_err("die erste Stichprobe muss bei null liegen");
        assert!(matches!(
            fehler,
            InfraError::ElevationSamplesDoNotCoverTrack { .. }
        ));
    }

    #[test]
    fn eine_nicht_positive_mindestbandlaenge_faellt_auf() {
        let laenge = Length::from_metres(1_000);
        let samples = [
            ElevationSample::new(Length::ZERO, Length::ZERO),
            ElevationSample::new(laenge, Length::from_metres(5)),
        ];
        let fehler = derive_gradient_profile(&samples, laenge, Length::ZERO, quelle())
            .expect_err("eine Mindestbandlänge von null ist keine");
        assert!(matches!(fehler, InfraError::NonPositiveLength { .. }));
    }
}
