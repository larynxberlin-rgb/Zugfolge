//! Die Fehler des Sperrzeiten- und Konfliktmodells.
//!
//! Wie in `zugfolge-infra` ist ein Fehler hier eine Aussage über die
//! **Eingabe**, nie über die Programmierung: ein Laufweg, der nicht
//! zusammenhängt, ein Gleis, das die Fahrtrichtung nicht zulässt, ein Halt auf
//! freier Strecke. Jede Variante nennt das betroffene Objekt und den
//! betroffenen Wert, damit die Meldung jemandem hilft, der sie beheben soll.

use core::fmt;

use zugfolge_infra::{InfraError, Length, OperatingPointId, TrackId, TravelDirection};

use crate::framework::FrameworkAgreementId;
use crate::resource::ConflictResource;

/// Was an einem Laufweg, einem Belegungsprofil oder einer Parametrierung nicht
/// stimmt.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConflictError {
    /// Ein Laufweg ohne einen einzigen Abschnitt.
    EmptyItinerary,
    /// Ein Laufweg nennt ein Gleis, das der Betriebsgraph nicht kennt.
    UnknownTrack(TrackId),
    /// Ein Laufweg nennt eine Betriebsstelle, die der Betriebsgraph nicht
    /// kennt.
    UnknownOperatingPoint(OperatingPointId),
    /// Auf diesem Gleis finden keine Zugfahrten statt — ein Abstell- oder
    /// Anschlussgleis wird rangiert, nicht befahren (E12).
    NotForTrainRuns(TrackId),
    /// Das Gleis ist in dieser Richtung nicht befahrbar.
    DirectionNotAllowed {
        /// Das Gleis.
        track: TrackId,
        /// Die verlangte Fahrtrichtung.
        direction: TravelDirection,
    },
    /// Zwei aufeinanderfolgende Abschnitte des Laufwegs treffen sich nicht.
    Disconnected {
        /// Das Gleis, von dem aus weitergefahren werden soll.
        from: TrackId,
        /// Das Gleis, auf das gewechselt werden soll.
        to: TrackId,
    },
    /// Ein Laufweg muss in einer Betriebsstelle beginnen und enden, und
    /// Streckengleis und Bahnhofsgleis müssen sich abwechseln.
    MisplacedLeg {
        /// Das Gleis an der beanstandeten Stelle.
        track: TrackId,
        /// Die Stelle im Laufweg, ab null gezählt.
        index: usize,
    },
    /// Für ein Bahnhofsgleis ist eine Blockteilung hinterlegt.
    ///
    /// Ein Bahnhofsgleis ist als Ganzes eine Konfliktressource — auf ihm steht
    /// ein Zug, und zwei stehen dort nie gleichzeitig. Eine Blockteilung wäre
    /// wirkungslos, und wirkungslose Daten sind schlimmer als fehlende: Sie
    /// sehen aus, als täten sie etwas.
    BlocksOnStationTrack(TrackId),
    /// Auf freier Strecke wird nicht gehalten — ein Halt gehört in eine
    /// Betriebsstelle.
    DwellOnLine {
        /// Das Streckengleis, an dem der Halt hängt.
        track: TrackId,
    },
    /// Eine Haltezeit darf nicht negativ sein.
    NegativeDwell {
        /// Der angegebene Wert in Sekunden.
        seconds: i64,
    },
    /// Eine Länge muss positiv sein, ist es aber nicht.
    NonPositiveLength {
        /// Welche Länge gemeint ist.
        what: &'static str,
        /// Der angegebene Wert.
        value: Length,
    },
    /// Eine Dauer darf nicht negativ sein.
    NegativeDuration {
        /// Welche Dauer gemeint ist.
        what: &'static str,
        /// Der angegebene Wert in Sekunden.
        seconds: i64,
    },
    /// Eine Zugnummer liegt außerhalb des Bereichs ihrer Zuggattung.
    TrainNumberOutOfRange {
        /// Die Zuggattung.
        category: &'static str,
        /// Die angegebene Nummer.
        number: u32,
    },
    /// Ein Verkehrsangebot ohne einen einzigen Verkehrstag fährt nie.
    NoOperatingDays,
    /// Die Fahrzeitrechnung oder der Betriebsgraph hat die Eingabe
    /// zurückgewiesen.
    Infra(InfraError),
    /// Ein Rahmenvertrag ohne eine einzige Ressource im Korridor (M3.8).
    EmptyCorridor(FrameworkAgreementId),
    /// Ein Kapazitätsanteil muss zwischen 1 und 10 000 Basispunkten liegen
    /// (M3.8).
    InvalidCapacityShare(u32),
    /// Zwei Rahmenverträge desselben Kapazitätsbuchs tragen dieselbe Kennung
    /// (M3.8).
    DuplicateFrameworkAgreement(FrameworkAgreementId),
    /// Ein Kapazitätsbuch kennt diesen Rahmenvertrag nicht (M3.8).
    UnknownFrameworkAgreement(FrameworkAgreementId),
    /// Der Kapazitätsdeckel eines Rahmenvertrags ist auf dieser Ressource
    /// bereits ausgeschöpft (M3.8).
    FrameworkCapacityExceeded {
        /// Der betroffene Rahmenvertrag.
        agreement: FrameworkAgreementId,
        /// Die betroffene Konfliktressource.
        resource: ConflictResource,
    },
}

impl From<InfraError> for ConflictError {
    fn from(error: InfraError) -> Self {
        Self::Infra(error)
    }
}

impl fmt::Display for ConflictError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyItinerary => write!(formatter, "der Laufweg hat keinen einzigen Abschnitt"),
            Self::UnknownTrack(track) => {
                write!(formatter, "Gleis {track} steht nicht im Betriebsgraphen")
            }
            Self::UnknownOperatingPoint(point) => write!(
                formatter,
                "Betriebsstelle {point} steht nicht im Betriebsgraphen"
            ),
            Self::NotForTrainRuns(track) => write!(
                formatter,
                "auf Gleis {track} finden keine Zugfahrten statt — dort wird rangiert"
            ),
            Self::DirectionNotAllowed { track, direction } => write!(
                formatter,
                "Gleis {track} ist in Richtung '{}' nicht befahrbar",
                direction.tag()
            ),
            Self::Disconnected { from, to } => write!(
                formatter,
                "Gleis {from} und Gleis {to} treffen sich in keiner Betriebsstelle"
            ),
            Self::MisplacedLeg { track, index } => write!(
                formatter,
                "Gleis {track} steht an Stelle {index} des Laufwegs falsch — \
                 ein Laufweg beginnt und endet in einer Betriebsstelle und \
                 wechselt zwischen Bahnhofs- und Streckengleis"
            ),
            Self::BlocksOnStationTrack(track) => write!(
                formatter,
                "für das Bahnhofsgleis {track} ist eine Blockteilung hinterlegt — \
                 ein Bahnhofsgleis ist als Ganzes eine Konfliktressource"
            ),
            Self::DwellOnLine { track } => write!(
                formatter,
                "auf dem Streckengleis {track} ist eine Haltezeit angegeben — \
                 gehalten wird in einer Betriebsstelle"
            ),
            Self::NegativeDwell { seconds } => {
                write!(formatter, "die Haltezeit {seconds} s ist negativ")
            }
            Self::NonPositiveLength { what, value } => {
                write!(formatter, "{what} muss positiv sein, ist aber {value}")
            }
            Self::NegativeDuration { what, seconds } => {
                write!(
                    formatter,
                    "{what} darf nicht negativ sein, ist aber {seconds} s"
                )
            }
            Self::TrainNumberOutOfRange { category, number } => write!(
                formatter,
                "die Zugnummer {number} liegt außerhalb des Bereichs der Zuggattung {category}"
            ),
            Self::NoOperatingDays => {
                write!(formatter, "ein Verkehrsangebot ohne Verkehrstag fährt nie")
            }
            Self::Infra(error) => write!(formatter, "{error}"),
            Self::EmptyCorridor(agreement) => write!(
                formatter,
                "Rahmenvertrag {agreement} hat keine einzige Ressource im Korridor"
            ),
            Self::InvalidCapacityShare(basis_points) => write!(
                formatter,
                "der Kapazitätsanteil {basis_points} Basispunkte liegt außerhalb von 1 bis 10 000"
            ),
            Self::DuplicateFrameworkAgreement(agreement) => write!(
                formatter,
                "der Rahmenvertrag {agreement} ist im Kapazitätsbuch bereits registriert"
            ),
            Self::UnknownFrameworkAgreement(agreement) => write!(
                formatter,
                "das Kapazitätsbuch kennt keinen Rahmenvertrag {agreement}"
            ),
            Self::FrameworkCapacityExceeded {
                agreement,
                resource,
            } => write!(
                formatter,
                "der Kapazitätsdeckel des Rahmenvertrags {agreement} ist auf {resource} ausgeschöpft"
            ),
        }
    }
}

impl core::error::Error for ConflictError {
    fn source(&self) -> Option<&(dyn core::error::Error + 'static)> {
        match self {
            Self::Infra(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ConflictError;
    use zugfolge_infra::{InfraError, TrackId, TravelDirection};

    #[test]
    fn jede_meldung_nennt_das_betroffene_objekt() {
        let meldungen = [
            ConflictError::UnknownTrack(TrackId::new(7)).to_string(),
            ConflictError::DirectionNotAllowed {
                track: TrackId::new(7),
                direction: TravelDirection::AgainstChainage,
            }
            .to_string(),
            ConflictError::DwellOnLine {
                track: TrackId::new(7),
            }
            .to_string(),
        ];
        for meldung in meldungen {
            assert!(meldung.contains("G7"), "{meldung}");
        }
    }

    #[test]
    fn ein_infra_fehler_bleibt_die_ursache() {
        let fehler = ConflictError::from(InfraError::EmptyRunPath);
        assert!(core::error::Error::source(&fehler).is_some());
        assert_eq!(fehler, ConflictError::Infra(InfraError::EmptyRunPath));
    }
}
