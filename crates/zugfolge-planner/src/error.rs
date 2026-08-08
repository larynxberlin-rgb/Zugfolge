//! Die Fehler des Trassen-Planners.
//!
//! Ein Fehler ist hier eine Aussage über den **Antrag** oder das **Netz**, nie
//! über die Programmierung. „Kein Laufweg gefunden" ist deshalb ein Fehler mit
//! genannten Enden — und keine leere Ergebnisliste, die der Aufrufer selbst
//! deuten müsste.

use core::fmt;

use zugfolge_conflict::ConflictError;
use zugfolge_infra::OperatingPointId;

/// Was an einem Trassenantrag oder seiner Bearbeitung nicht stimmt.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PlannerError {
    /// Anfang und Ziel sind dieselbe Betriebsstelle.
    TrivialRequest(OperatingPointId),
    /// Eine Betriebsstelle ist zweimal als Halt genannt.
    DuplicateStop(OperatingPointId),
    /// Eine Toleranz oder Haltezeit hat einen unzulässigen Wert.
    InvalidTolerance {
        /// Welcher Wert gemeint ist.
        what: &'static str,
        /// Der angegebene Wert.
        value: i64,
    },
    /// Zwischen den beiden Betriebsstellen führt kein Laufweg, der alle
    /// beantragten Halte bedient.
    NoRoute {
        /// Anfangsbetriebsstelle.
        origin: OperatingPointId,
        /// Zielbetriebsstelle.
        destination: OperatingPointId,
    },
    /// Ein beantragter Halt liegt auf keinem Laufweg zwischen Anfang und Ziel,
    /// oder es gibt dort keinen Bahnsteig für diese Zuglänge.
    UnservableStop(OperatingPointId),
    /// Der Betriebsgraph, die Fahrdynamik oder das Sperrzeitenmodell hat die
    /// Eingabe zurückgewiesen.
    Conflict(ConflictError),
}

impl From<ConflictError> for PlannerError {
    fn from(error: ConflictError) -> Self {
        Self::Conflict(error)
    }
}

impl fmt::Display for PlannerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TrivialRequest(point) => write!(
                formatter,
                "Anfang und Ziel sind dieselbe Betriebsstelle {point}"
            ),
            Self::DuplicateStop(point) => {
                write!(
                    formatter,
                    "Betriebsstelle {point} ist zweimal als Halt genannt"
                )
            }
            Self::InvalidTolerance { what, value } => {
                write!(formatter, "{what} hat den unzulässigen Wert {value}")
            }
            Self::NoRoute {
                origin,
                destination,
            } => write!(
                formatter,
                "zwischen {origin} und {destination} führt kein Laufweg, der alle \
                 beantragten Halte bedient"
            ),
            Self::UnservableStop(point) => write!(
                formatter,
                "der Halt in {point} ist nicht bedienbar — kein Laufweg dorthin oder kein \
                 Bahnsteig für diese Zuglänge"
            ),
            Self::Conflict(error) => write!(formatter, "{error}"),
        }
    }
}

impl core::error::Error for PlannerError {
    fn source(&self) -> Option<&(dyn core::error::Error + 'static)> {
        match self {
            Self::Conflict(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PlannerError;
    use zugfolge_conflict::ConflictError;
    use zugfolge_infra::OperatingPointId;

    #[test]
    fn jede_meldung_nennt_das_betroffene_objekt() {
        let meldung = PlannerError::NoRoute {
            origin: OperatingPointId::new(1),
            destination: OperatingPointId::new(4),
        }
        .to_string();
        assert!(
            meldung.contains("Bst1") && meldung.contains("Bst4"),
            "{meldung}"
        );
        assert!(
            PlannerError::UnservableStop(OperatingPointId::new(2))
                .to_string()
                .contains("Bst2")
        );
    }

    #[test]
    fn ein_konfliktfehler_bleibt_die_ursache() {
        let fehler = PlannerError::from(ConflictError::EmptyItinerary);
        assert!(core::error::Error::source(&fehler).is_some());
    }
}
