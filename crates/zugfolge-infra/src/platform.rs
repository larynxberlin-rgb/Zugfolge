//! Bahnsteige — die Fahrgastanlage an einem Gleis.
//!
//! Ein Bahnsteig ist keine Verzierung des Bahnhofs, sondern eine harte
//! Randbedingung: Seine **Nutzlänge** begrenzt die Formation, die dort halten
//! darf, seine **Höhe** entscheidet über den stufenfreien Einstieg. Beides
//! wirkt später auf die Fahrzeugkonfiguration (M5.1a) und auf die
//! Ausschreibungsprüfung (M6.6a) — und beides ist eine Eigenschaft der
//! Infrastruktur, die ein Spieler hinnehmen muss.
//!
//! Der Bahnsteig hängt am **Gleis**, nicht an der Betriebsstelle. Nur so ist
//! die Frage beantwortbar, die im Betrieb wirklich gestellt wird: Passt dieser
//! Zug an dieses Gleis?

use core::fmt;

use zugfolge_determinism::StateHasher;

use crate::canonical::Canonical;
use crate::error::InfraError;
use crate::identity::{PlatformId, TrackId};
use crate::provenance::Provenance;
use crate::units::Length;

/// Ein Bahnsteig an einem Gleis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Platform {
    id: PlatformId,
    track: TrackId,
    designation: String,
    start: Length,
    usable_length: Length,
    height: Length,
    provenance: Provenance,
}

impl Platform {
    /// Ein Bahnsteig, der bei `start` am Gleis beginnt.
    ///
    /// `height` ist die Höhe der Bahnsteigkante über Schienenoberkante — im
    /// deutschen Netz üblicherweise 380, 550 oder 760 mm.
    ///
    /// # Errors
    ///
    /// - [`InfraError::EmptyName`], wenn die Bezeichnung leer ist.
    /// - [`InfraError::NonPositiveLength`], wenn Nutzlänge oder Höhe nicht
    ///   positiv sind oder der Anfang negativ ist.
    pub fn new(
        id: PlatformId,
        track: TrackId,
        designation: impl Into<String>,
        start: Length,
        usable_length: Length,
        height: Length,
        provenance: Provenance,
    ) -> Result<Self, InfraError> {
        let designation = designation.into();
        if designation.trim().is_empty() {
            return Err(InfraError::EmptyName { what: "Bahnsteig" });
        }
        if start.is_negative() {
            return Err(InfraError::NonPositiveLength {
                what: "Bahnsteiganfang",
                value: start,
            });
        }
        if !usable_length.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Bahnsteignutzlänge",
                value: usable_length,
            });
        }
        if !height.is_positive() {
            return Err(InfraError::NonPositiveLength {
                what: "Bahnsteighöhe",
                value: height,
            });
        }
        Ok(Self {
            id,
            track,
            designation,
            start,
            usable_length,
            height,
            provenance,
        })
    }

    /// Die Kennung.
    pub const fn id(&self) -> PlatformId {
        self.id
    }

    /// Das Gleis, an dem der Bahnsteig liegt.
    pub const fn track(&self) -> TrackId {
        self.track
    }

    /// Die Bezeichnung, etwa `Bahnsteig 2` oder `Gleis 3a`.
    pub fn designation(&self) -> &str {
        &self.designation
    }

    /// Der Anfang entlang des Gleises.
    pub const fn start(&self) -> Length {
        self.start
    }

    /// Das Ende entlang des Gleises.
    pub fn end(&self) -> Length {
        self.start + self.usable_length
    }

    /// Die Nutzlänge.
    pub const fn usable_length(&self) -> Length {
        self.usable_length
    }

    /// Die Höhe der Bahnsteigkante über Schienenoberkante.
    pub const fn height(&self) -> Length {
        self.height
    }

    /// Die Herkunft der Angaben.
    pub const fn provenance(&self) -> &Provenance {
        &self.provenance
    }

    /// Ob eine Formation dieser Länge hier halten kann.
    pub fn accommodates(&self, train_length: Length) -> bool {
        train_length.is_positive() && train_length <= self.usable_length
    }

    /// Ob der Bahnsteig stufenfreien Einstieg für eine Einstiegshöhe bietet.
    ///
    /// Stufenfrei heißt hier: gleich hoch. Wie viel Abweichung noch als
    /// stufenfrei gilt, ist eine Frage der Fahrzeugkonfiguration (M5.1a) und
    /// der Ausschreibungsvorgaben (M6.6a) — nicht der Infrastruktur.
    pub fn is_level_with(&self, entrance_height: Length) -> bool {
        self.height == entrance_height
    }
}

impl fmt::Display for Platform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{} ({} m nutzbar, {} mm hoch)",
            self.designation,
            self.usable_length.millimetres() / 1_000,
            self.height.millimetres()
        )
    }
}

impl Canonical for Platform {
    fn write_canonical(&self, name: &str, hasher: &mut StateHasher) {
        self.id.write_canonical(name, hasher);
        self.track.write_canonical(name, hasher);
        hasher.text(name, &self.designation);
        self.start.write_canonical(name, hasher);
        self.usable_length.write_canonical(name, hasher);
        self.height.write_canonical(name, hasher);
        self.provenance.write_canonical(name, hasher);
    }
}

#[cfg(test)]
mod tests {
    use super::Platform;
    use crate::error::InfraError;
    use crate::identity::{PlatformId, TrackId};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::units::Length;

    fn herkunft() -> Provenance {
        Provenance::new(
            SourceId::new("osm-pbf-lhe").expect("gültige Quellenkennung"),
            Confidence::Surveyed,
        )
    }

    fn bahnsteig() -> Platform {
        Platform::new(
            PlatformId::new(1),
            TrackId::new(5),
            "Bahnsteig 2",
            Length::from_metres(50),
            Length::from_metres(210),
            Length::from_millimetres(760),
            herkunft(),
        )
        .expect("gültiger Bahnsteig")
    }

    #[test]
    fn ein_bahnsteig_liegt_an_seinem_gleis() {
        let bahnsteig = bahnsteig();
        assert_eq!(bahnsteig.track(), TrackId::new(5));
        assert_eq!(bahnsteig.start(), Length::from_metres(50));
        assert_eq!(bahnsteig.end(), Length::from_metres(260));
    }

    #[test]
    fn die_nutzlaenge_begrenzt_die_formation() {
        let bahnsteig = bahnsteig();
        assert!(bahnsteig.accommodates(Length::from_metres(140)));
        assert!(bahnsteig.accommodates(Length::from_metres(210)));
        // Ein Doppeltraktions-Zug von 280 m passt nicht mehr — genau diese
        // Prüfung entscheidet später über die Formation (M5.2).
        assert!(!bahnsteig.accommodates(Length::from_metres(280)));
        assert!(!bahnsteig.accommodates(Length::ZERO));
    }

    #[test]
    fn die_hoehe_entscheidet_ueber_den_stufenfreien_einstieg() {
        let bahnsteig = bahnsteig();
        assert!(bahnsteig.is_level_with(Length::from_millimetres(760)));
        assert!(!bahnsteig.is_level_with(Length::from_millimetres(550)));
    }

    #[test]
    fn ein_bahnsteig_ohne_masse_faellt_auf() {
        for (nutzlaenge, hoehe) in [
            (Length::ZERO, Length::from_millimetres(760)),
            (Length::from_metres(200), Length::ZERO),
        ] {
            let fehler = Platform::new(
                PlatformId::new(1),
                TrackId::new(5),
                "Bahnsteig 2",
                Length::ZERO,
                nutzlaenge,
                hoehe,
                herkunft(),
            )
            .expect_err("ein Bahnsteig ohne Länge oder Höhe ist keiner");
            assert!(matches!(fehler, InfraError::NonPositiveLength { .. }));
        }
    }

    #[test]
    fn anzeige_bleibt_lesbar() {
        assert_eq!(
            bahnsteig().to_string(),
            "Bahnsteig 2 (210 m nutzbar, 760 mm hoch)"
        );
    }
}
