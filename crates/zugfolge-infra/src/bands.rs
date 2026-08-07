//! Bandprofile: ein Attribut, das sich entlang eines Gleises ändert.
//!
//! Vmax, Neigung, Elektrifizierung und Zugsicherung sind keine Eigenschaften
//! eines Gleises, sondern Eigenschaften **von Abschnitten** eines Gleises. Eine
//! Strecke ist bis Kilometer 4 auf 160 km/h ausgelegt und danach auf 120; ein
//! Systemwechsel liegt mitten auf der freien Strecke; ein Streckenblock endet
//! dort, wo die Zugbeeinflussung wechselt.
//!
//! Alle vier Attribute haben dieselbe Form, deshalb gibt es sie hier **einmal**
//! statt viermal. Das ist nicht nur weniger Code, es ist auch nur eine Stelle,
//! an der die Lückenlosigkeit geprüft wird — und genau daran hängt später jede
//! Fahrzeitrechnung: Ein Gleis mit einer Lücke im Vmax-Profil hat einen
//! Abschnitt ohne zulässige Geschwindigkeit, und das darf gar nicht erst
//! entstehen können.
//!
//! **Ein Profil deckt sein Gleis lückenlos und überschneidungsfrei ab.** Das
//! ist die Invariante dieses Moduls, und [`BandProfile::new`] ist der einzige
//! Weg, ein Profil zu bekommen.

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;
use crate::provenance::{Confidence, Provenance};
use crate::units::Length;

/// Ein Abschnitt konstanten Attributwerts entlang eines Gleises.
///
/// Der Abschnitt reicht von [`Band::start`] (einschließlich) bis
/// [`Band::end`] (ausschließlich), gemessen ab dem Anfang des Gleises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Band<T> {
    start: Length,
    end: Length,
    value: T,
    provenance: Provenance,
}

impl<T> Band<T> {
    /// Ein Band von `start` bis `end` mit Wert und Herkunft.
    ///
    /// Ob das Band in ein Profil passt, entscheidet erst
    /// [`BandProfile::new`] — ein einzelnes Band kennt seine Nachbarn nicht.
    pub const fn new(start: Length, end: Length, value: T, provenance: Provenance) -> Self {
        Self {
            start,
            end,
            value,
            provenance,
        }
    }

    /// Anfang des Bandes.
    pub const fn start(&self) -> Length {
        self.start
    }

    /// Ende des Bandes.
    pub const fn end(&self) -> Length {
        self.end
    }

    /// Ausdehnung des Bandes.
    pub fn length(&self) -> Length {
        self.end - self.start
    }

    /// Der Attributwert.
    pub const fn value(&self) -> &T {
        &self.value
    }

    /// Die Herkunft dieses Wertes.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Der Vertrauensgrad dieses Wertes.
    pub const fn confidence(&self) -> Confidence {
        self.provenance.confidence()
    }

    /// Ob eine Position in dieses Band fällt — Anfang einschließlich, Ende
    /// ausschließlich.
    pub fn contains(&self, position: Length) -> bool {
        self.start <= position && position < self.end
    }
}

/// Ein lückenloses, überschneidungsfreies Bandprofil über die volle Länge
/// eines Gleises.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BandProfile<T> {
    attribute: &'static str,
    length: Length,
    bands: Vec<Band<T>>,
}

impl<T> BandProfile<T> {
    /// Baut ein Profil und prüft es gegen die Gleislänge.
    ///
    /// `attribute` benennt das Attribut — es steht in jeder Fehlermeldung und
    /// beantwortet die Frage, die man sonst raten müsste: *welches* Profil ist
    /// kaputt.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyProfile`], wenn keine Bänder angegeben sind.
    /// - [`InfraError::ProfileBand`], wenn ein Band keine Ausdehnung hat oder
    ///   rückwärts läuft.
    /// - [`InfraError::ProfileStart`] und [`InfraError::ProfileEnd`], wenn das
    ///   Profil nicht bei null beginnt oder nicht am Gleisende endet.
    /// - [`InfraError::ProfileGap`], wenn zwischen zwei Bändern eine Lücke
    ///   klafft oder sie sich überschneiden.
    pub fn new(
        attribute: &'static str,
        length: Length,
        bands: Vec<Band<T>>,
    ) -> Result<Self, InfraError> {
        if !length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: attribute,
                value: length,
            });
        }
        let Some(erstes) = bands.first() else {
            return Err(InfraError::EmptyProfile { attribute });
        };
        if erstes.start != Length::ZERO {
            return Err(InfraError::ProfileStart {
                attribute,
                first: erstes.start,
            });
        }

        for (index, band) in bands.iter().enumerate() {
            if !(band.end - band.start).is_positive() {
                return Err(InfraError::ProfileBand { attribute, index });
            }
        }

        for (vorheriger_index, paar) in bands.windows(2).enumerate() {
            let [vorheriges, folgendes] = paar else {
                continue;
            };
            if vorheriges.end != folgendes.start {
                return Err(InfraError::ProfileGap {
                    attribute,
                    index: vorheriger_index.saturating_add(1),
                    ends: vorheriges.end,
                    starts: folgendes.start,
                });
            }
        }

        let letztes = bands.last().unwrap_or(erstes);
        if letztes.end != length {
            return Err(InfraError::ProfileEnd {
                attribute,
                last: letztes.end,
                length,
            });
        }

        Ok(Self {
            attribute,
            length,
            bands,
        })
    }

    /// Ein Profil aus einem einzigen Band über die volle Länge.
    ///
    /// # Errors
    ///
    /// Wie [`BandProfile::new`] — hier praktisch nur, wenn `length` nicht
    /// positiv ist.
    pub fn uniform(
        attribute: &'static str,
        length: Length,
        value: T,
        provenance: Provenance,
    ) -> Result<Self, InfraError> {
        Self::new(
            attribute,
            length,
            vec![Band::new(Length::ZERO, length, value, provenance)],
        )
    }

    /// Das Attribut, das dieses Profil beschreibt.
    pub const fn attribute(&self) -> &'static str {
        self.attribute
    }

    /// Die abgedeckte Länge.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Alle Bänder in Reihenfolge wachsender Kilometrierung.
    pub fn bands(&self) -> &[Band<T>] {
        &self.bands
    }

    /// Anzahl der Bänder; immer mindestens eins.
    pub fn band_count(&self) -> usize {
        self.bands.len()
    }

    /// Das Band an einer Position.
    ///
    /// Am Gleisende selbst gilt das letzte Band: Eine Position darf gleich der
    /// Gleislänge sein — ein Zug, der genau am Ende steht, hat eine zulässige
    /// Geschwindigkeit und keine Lücke.
    pub fn band_at(&self, position: Length) -> Option<&Band<T>> {
        if position.is_negative() || position > self.length {
            return None;
        }
        if position == self.length {
            return self.bands.last();
        }
        self.bands.iter().find(|band| band.contains(position))
    }

    /// Der Attributwert an einer Position.
    pub fn value_at(&self, position: Length) -> Option<&T> {
        self.band_at(position).map(Band::value)
    }

    /// Der schwächste Vertrauensgrad des Profils.
    ///
    /// Ein Profil ist so belastbar wie sein schwächstes Band — ein einziger
    /// angenommener Abschnitt macht das ganze Gleis zu einem angenommenen.
    pub fn confidence(&self) -> Confidence {
        self.bands
            .iter()
            .map(Band::confidence)
            .fold(Confidence::Surveyed, Confidence::weakest)
    }
}

impl<T: Canonical> Canonical for BandProfile<T> {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        hasher.text(name, self.attribute);
        hasher.seq(name, self.bands.len());
        for band in &self.bands {
            band.start.write_canonical(name, hasher);
            band.end.write_canonical(name, hasher);
            band.value.write_canonical(name, hasher);
            band.provenance.write_canonical(name, hasher);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Band, BandProfile};
    use crate::error::InfraError;
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::units::Length;

    const ATTRIBUT: &str = "vmax";

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            confidence,
        )
    }

    fn band(von_m: i64, bis_m: i64, wert: i64) -> Band<i64> {
        Band::new(
            Length::from_metres(von_m),
            Length::from_metres(bis_m),
            wert,
            herkunft(Confidence::Surveyed),
        )
    }

    #[test]
    fn ein_lueckenloses_profil_wird_angenommen() {
        let profil = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 1_000, 160), band(1_000, 3_000, 120)],
        )
        .expect("Profil ist lückenlos");

        assert_eq!(profil.band_count(), 2);
        assert_eq!(profil.length(), Length::from_metres(3_000));
        assert_eq!(profil.attribute(), ATTRIBUT);
    }

    #[test]
    fn der_wert_wird_an_jeder_position_gefunden() {
        let profil = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 1_000, 160), band(1_000, 3_000, 120)],
        )
        .expect("Profil ist lückenlos");

        assert_eq!(profil.value_at(Length::ZERO), Some(&160));
        assert_eq!(profil.value_at(Length::from_metres(999)), Some(&160));
        // Die Bandgrenze gehört zum folgenden Band, nicht zum vorherigen.
        assert_eq!(profil.value_at(Length::from_metres(1_000)), Some(&120));
        // Das Gleisende selbst gehört zum letzten Band.
        assert_eq!(profil.value_at(Length::from_metres(3_000)), Some(&120));
        assert_eq!(profil.value_at(Length::from_metres(3_001)), None);
        assert_eq!(profil.value_at(Length::from_millimetres(-1)), None);
    }

    #[test]
    fn eine_luecke_faellt_auf() {
        let fehler = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 1_000, 160), band(1_500, 3_000, 120)],
        )
        .expect_err("die Lücke zwischen 1000 und 1500 muss auffallen");
        assert!(matches!(fehler, InfraError::ProfileGap { index: 1, .. }));
    }

    #[test]
    fn eine_ueberschneidung_faellt_auf() {
        let fehler = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 1_500, 160), band(1_000, 3_000, 120)],
        )
        .expect_err("die Überschneidung muss auffallen");
        assert!(matches!(fehler, InfraError::ProfileGap { index: 1, .. }));
    }

    #[test]
    fn ein_profil_muss_das_ganze_gleis_abdecken() {
        let zu_kurz = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 2_000, 160)],
        )
        .expect_err("ein zu kurzes Profil lässt einen Abschnitt ohne Wert");
        assert!(matches!(zu_kurz, InfraError::ProfileEnd { .. }));

        let falscher_anfang = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(100, 3_000, 160)],
        )
        .expect_err("ein Profil, das erst später beginnt, lässt den Anfang offen");
        assert!(matches!(falscher_anfang, InfraError::ProfileStart { .. }));
    }

    #[test]
    fn ein_leeres_profil_beschreibt_nichts() {
        let fehler = BandProfile::<i64>::new(ATTRIBUT, Length::from_metres(3_000), Vec::new())
            .expect_err("ein Profil ohne Bänder ist kein Profil");
        assert!(matches!(fehler, InfraError::EmptyProfile { .. }));
    }

    #[test]
    fn ein_band_ohne_ausdehnung_faellt_auf() {
        let fehler = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(3_000),
            vec![band(0, 0, 160), band(0, 3_000, 120)],
        )
        .expect_err("ein Band der Länge null beschreibt keinen Abschnitt");
        assert!(matches!(fehler, InfraError::ProfileBand { index: 0, .. }));
    }

    #[test]
    fn der_schwaechste_vertrauensgrad_faerbt_das_profil() {
        let profil = BandProfile::new(
            ATTRIBUT,
            Length::from_metres(2_000),
            vec![
                band(0, 1_000, 160),
                Band::new(
                    Length::from_metres(1_000),
                    Length::from_metres(2_000),
                    120,
                    herkunft(Confidence::Assumed),
                ),
            ],
        )
        .expect("Profil ist lückenlos");

        assert_eq!(profil.confidence(), Confidence::Assumed);
    }

    #[test]
    fn ein_gleichmaessiges_profil_deckt_alles_ab() {
        let profil = BandProfile::uniform(
            ATTRIBUT,
            Length::from_metres(500),
            60,
            herkunft(Confidence::Derived),
        )
        .expect("Profil ist gültig");
        assert_eq!(profil.band_count(), 1);
        assert_eq!(profil.value_at(Length::from_metres(250)), Some(&60));
        assert_eq!(profil.confidence(), Confidence::Derived);
    }
}
