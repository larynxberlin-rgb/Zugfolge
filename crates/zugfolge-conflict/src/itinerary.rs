//! Der Laufweg — die Folge von Gleisen, die eine Zugfahrt befährt.
//!
//! `docs/glossar.md` trennt zwei Begriffe, die leicht zusammenfallen: Der
//! **Laufweg** ([`Itinerary`]) ist die betriebliche Folge von Betriebsstellen
//! und Kanten; der **Fahrweg** (`RunPath`, M1.10) ist derselbe Weg, bereits auf
//! Abschnitte konstanter Geschwindigkeit und Neigung geschnitten. Der Laufweg
//! ist das, was ein Trassenantrag beschreibt, der Fahrweg das, woraus die
//! Fahrdynamik eine Zeit rechnet.
//!
//! ## Die Form eines Laufwegs
//!
//! Ein Laufweg **beginnt und endet in einer Betriebsstelle** und wechselt
//! dazwischen zwischen Bahnhofs- und Streckengleis. Das ist keine technische
//! Bequemlichkeit, sondern die betriebliche Wahrheit: Ein Zug entsteht und
//! endet nicht auf freier Strecke, und gehalten wird in einer Betriebsstelle.
//! Der Bau prüft es, damit spätere Schritte sich darauf verlassen können.
//!
//! ## Warum die Richtung am Gleis hängt
//!
//! Jeder Abschnitt nennt seine [`TravelDirection`] entlang der Kilometrierung
//! seines Gleises. Ob zwei Züge in den Zugfolgefall oder in eine Gegenfahrt
//! geraten, folgt allein daraus und aus der Richtungsbindung des Gleises — der
//! Befund des Spikes aus M0.3, hier als Datenmodell statt als Regel.

use core::fmt;

use zugfolge_infra::{
    InterlockingRouteId, Length, OperatingGraph, OperatingPointId, TrackId, TrackOwner,
    TravelDirection,
};

use crate::error::ConflictError;

/// Ein Abschnitt eines Laufwegs: ein Gleis, in einer Richtung, mit der
/// Haltezeit an seinem Ende.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ItineraryLeg {
    track: TrackId,
    direction: TravelDirection,
    dwell_s: i64,
    route: Option<InterlockingRouteId>,
}

impl ItineraryLeg {
    /// Ein Abschnitt ohne Halt und ohne benannte Fahrstraße.
    pub const fn new(track: TrackId, direction: TravelDirection) -> Self {
        Self {
            track,
            direction,
            dwell_s: 0,
            route: None,
        }
    }

    /// Setzt die Haltezeit am Ende dieses Abschnitts.
    ///
    /// Sie zählt zur Sperrzeit des Gleises, auf dem der Zug steht — deshalb ist
    /// sie eine Eigenschaft des Abschnitts und nicht der Betriebsstelle.
    #[must_use]
    pub const fn with_dwell(mut self, seconds: i64) -> Self {
        self.dwell_s = seconds;
        self
    }

    /// Bindet den Abschnitt an eine Fahrstraße des Bahnhofskopfs (M1.7).
    ///
    /// Ist sie gesetzt, belegt der Zug zusätzlich die Fahrstraße als eigene
    /// Konfliktressource — und damit alles, was ihre Ausschlussmenge nennt.
    #[must_use]
    pub const fn with_route(mut self, route: InterlockingRouteId) -> Self {
        self.route = Some(route);
        self
    }

    /// Das befahrene Gleis.
    pub const fn track(&self) -> TrackId {
        self.track
    }

    /// Die Fahrtrichtung entlang der Kilometrierung des Gleises.
    pub const fn direction(&self) -> TravelDirection {
        self.direction
    }

    /// Die Haltezeit am Ende des Abschnitts, in Sekunden.
    pub const fn dwell_s(&self) -> i64 {
        self.dwell_s
    }

    /// Ob der Zug am Ende dieses Abschnitts steht.
    pub const fn is_stop(&self) -> bool {
        self.dwell_s > 0
    }

    /// Die belegte Fahrstraße, sofern bekannt.
    pub const fn route(&self) -> Option<InterlockingRouteId> {
        self.route
    }
}

/// Ein Abschnitt, dessen Bezüge gegen den Betriebsgraphen geprüft sind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheckedLeg {
    leg: ItineraryLeg,
    length: Length,
    from: OperatingPointId,
    to: OperatingPointId,
    in_station: bool,
}

impl CheckedLeg {
    /// Der ungeprüfte Abschnitt.
    pub const fn leg(&self) -> ItineraryLeg {
        self.leg
    }

    /// Das befahrene Gleis.
    pub const fn track(&self) -> TrackId {
        self.leg.track()
    }

    /// Die Fahrtrichtung.
    pub const fn direction(&self) -> TravelDirection {
        self.leg.direction()
    }

    /// Die Haltezeit am Ende des Abschnitts.
    pub const fn dwell_s(&self) -> i64 {
        self.leg.dwell_s()
    }

    /// Die belegte Fahrstraße, sofern bekannt.
    pub const fn route(&self) -> Option<InterlockingRouteId> {
        self.leg.route()
    }

    /// Die Länge des Gleises.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die Betriebsstelle, an der der Abschnitt beginnt.
    pub const fn from(&self) -> OperatingPointId {
        self.from
    }

    /// Die Betriebsstelle, an der der Abschnitt endet.
    pub const fn to(&self) -> OperatingPointId {
        self.to
    }

    /// Ob der Abschnitt in einer Betriebsstelle liegt — sonst auf freier
    /// Strecke.
    pub const fn is_in_station(&self) -> bool {
        self.in_station
    }

    /// Die Betriebsstelle, deren Stellwerk diesen Abschnitt bedient.
    ///
    /// Für ein Bahnhofsgleis ist das die eigene Betriebsstelle; für ein
    /// Streckengleis die, aus der die Fahrt kommt — von dort wird der Fahrweg
    /// gestellt.
    pub const fn governing_point(&self) -> OperatingPointId {
        self.from
    }
}

/// Der geprüfte Laufweg einer Zugfahrt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Itinerary {
    legs: Vec<CheckedLeg>,
}

impl Itinerary {
    /// Prüft eine Folge von Abschnitten gegen den Betriebsgraphen.
    ///
    /// # Errors
    ///
    /// - [`ConflictError::EmptyItinerary`], wenn die Folge leer ist.
    /// - [`ConflictError::UnknownTrack`], wenn ein Gleis nicht im Graphen
    ///   steht.
    /// - [`ConflictError::NotForTrainRuns`], wenn auf einem Gleis keine
    ///   Zugfahrten stattfinden (E12: dort wird ausschließlich rangiert).
    /// - [`ConflictError::DirectionNotAllowed`], wenn die Richtungsbindung des
    ///   Gleises die Fahrtrichtung ausschließt.
    /// - [`ConflictError::MisplacedLeg`], wenn Bahnhofs- und Streckengleis
    ///   sich nicht abwechseln oder der Laufweg nicht in einer Betriebsstelle
    ///   beginnt und endet.
    /// - [`ConflictError::Disconnected`], wenn zwei aufeinanderfolgende
    ///   Abschnitte sich nicht in derselben Betriebsstelle treffen.
    /// - [`ConflictError::DwellOnLine`], wenn auf freier Strecke gehalten
    ///   werden soll.
    /// - [`ConflictError::NegativeDwell`], wenn eine Haltezeit negativ ist.
    pub fn new(graph: &OperatingGraph, legs: Vec<ItineraryLeg>) -> Result<Self, ConflictError> {
        if legs.is_empty() {
            return Err(ConflictError::EmptyItinerary);
        }

        let mut geprueft: Vec<CheckedLeg> = Vec::with_capacity(legs.len());
        for (index, leg) in legs.into_iter().enumerate() {
            let track = graph
                .track(leg.track())
                .ok_or(ConflictError::UnknownTrack(leg.track()))?;
            if !track.kind().carries_train_runs() {
                return Err(ConflictError::NotForTrainRuns(leg.track()));
            }
            if !track.direction().allows(leg.direction()) {
                return Err(ConflictError::DirectionNotAllowed {
                    track: leg.track(),
                    direction: leg.direction(),
                });
            }
            if leg.dwell_s() < 0 {
                return Err(ConflictError::NegativeDwell {
                    seconds: leg.dwell_s(),
                });
            }

            // Gerade Stellen sind Bahnhofsgleise, ungerade Streckengleise.
            let soll_bahnhof = index % 2 == 0;
            let (from, to, in_station) = match track.owner() {
                TrackOwner::OperatingPoint(point) => {
                    if !soll_bahnhof {
                        return Err(ConflictError::MisplacedLeg {
                            track: leg.track(),
                            index,
                        });
                    }
                    (point, point, true)
                }
                TrackOwner::Edge(edge_id) => {
                    if soll_bahnhof {
                        return Err(ConflictError::MisplacedLeg {
                            track: leg.track(),
                            index,
                        });
                    }
                    if leg.dwell_s() > 0 {
                        return Err(ConflictError::DwellOnLine { track: leg.track() });
                    }
                    let edge = graph
                        .edge(edge_id)
                        .ok_or(ConflictError::UnknownTrack(leg.track()))?;
                    (
                        edge.end_of(leg.direction().opposite()),
                        edge.end_of(leg.direction()),
                        false,
                    )
                }
            };

            if let Some(vorher) = geprueft.last()
                && vorher.to() != from
            {
                return Err(ConflictError::Disconnected {
                    from: vorher.track(),
                    to: leg.track(),
                });
            }

            geprueft.push(CheckedLeg {
                leg,
                length: track.length(),
                from,
                to,
                in_station,
            });
        }

        // Ein Laufweg endet in einer Betriebsstelle — also auf einem
        // Bahnhofsgleis, und damit an einer geraden Stelle.
        let letzter = geprueft.last().expect("mindestens ein Abschnitt");
        if !letzter.is_in_station() {
            return Err(ConflictError::MisplacedLeg {
                track: letzter.track(),
                index: geprueft.len().saturating_sub(1),
            });
        }

        Ok(Self { legs: geprueft })
    }

    /// Die Abschnitte in Fahrtreihenfolge.
    pub fn legs(&self) -> &[CheckedLeg] {
        &self.legs
    }

    /// Die Betriebsstelle, in der der Laufweg beginnt.
    ///
    /// # Panics
    ///
    /// Nie — ein geprüfter Laufweg hat mindestens einen Abschnitt.
    pub fn origin(&self) -> OperatingPointId {
        self.legs.first().expect("mindestens ein Abschnitt").from()
    }

    /// Die Betriebsstelle, in der der Laufweg endet.
    ///
    /// # Panics
    ///
    /// Nie — ein geprüfter Laufweg hat mindestens einen Abschnitt.
    pub fn destination(&self) -> OperatingPointId {
        self.legs.last().expect("mindestens ein Abschnitt").to()
    }

    /// Die Gesamtlänge des Laufwegs.
    pub fn length(&self) -> Length {
        self.legs
            .iter()
            .fold(Length::ZERO, |summe, leg| summe + leg.length())
    }

    /// Die Betriebsstellen mit planmäßigem Halt, in Fahrtreihenfolge.
    ///
    /// Der Endpunkt zählt nicht dazu: Dort endet die Fahrt, statt zu halten.
    pub fn stops(&self) -> impl Iterator<Item = OperatingPointId> + '_ {
        self.legs
            .iter()
            .filter(|leg| leg.leg().is_stop())
            .map(CheckedLeg::to)
    }

    /// Die Summe aller Haltezeiten in Sekunden.
    pub fn total_dwell_s(&self) -> i64 {
        self.legs
            .iter()
            .map(CheckedLeg::dwell_s)
            .fold(0_i64, i64::saturating_add)
    }

    /// Ob der Laufweg diese Betriebsstelle berührt.
    pub fn touches(&self, point: OperatingPointId) -> bool {
        self.legs
            .iter()
            .any(|leg| leg.from() == point || leg.to() == point)
    }
}

impl fmt::Display for Itinerary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} → {}", self.origin(), self.destination())
    }
}

#[cfg(test)]
mod tests {
    use super::{Itinerary, ItineraryLeg};
    use crate::error::ConflictError;
    use zugfolge_infra::{OperatingPointId, TrackId, TravelDirection, reference_network};

    fn hin(track: u32) -> ItineraryLeg {
        ItineraryLeg::new(TrackId::new(track), TravelDirection::WithChainage)
    }

    #[test]
    fn ein_laufweg_haelt_zusammen_und_kennt_seine_enden() {
        let netz = reference_network();
        let laufweg = Itinerary::new(
            &netz,
            vec![
                hin(101),
                hin(1001),
                hin(201).with_dwell(30),
                hin(2001),
                hin(301),
            ],
        )
        .expect("gültiger Laufweg");

        assert_eq!(laufweg.origin(), OperatingPointId::new(1));
        assert_eq!(laufweg.destination(), OperatingPointId::new(3));
        assert_eq!(laufweg.legs().len(), 5);
        assert_eq!(laufweg.total_dwell_s(), 30);
        assert_eq!(
            laufweg.stops().collect::<Vec<_>>(),
            vec![OperatingPointId::new(2)]
        );
        assert!(laufweg.touches(OperatingPointId::new(2)));
        assert!(!laufweg.touches(OperatingPointId::new(4)));
    }

    #[test]
    fn ein_laufweg_beginnt_und_endet_in_einer_betriebsstelle() {
        let netz = reference_network();
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(1001)]),
            Err(ConflictError::MisplacedLeg { .. })
        ));
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(101), hin(1001)]),
            Err(ConflictError::MisplacedLeg { .. })
        ));
    }

    #[test]
    fn ein_richtungsgleis_laesst_die_gegenrichtung_nicht_zu() {
        // Gleis A der Kante 1 ist an die Kilometrierung gebunden. Genau daraus
        // entsteht später, dass zwei Züge dort nie in Gegenfahrt geraten.
        let netz = reference_network();
        let fehler = Itinerary::new(
            &netz,
            vec![
                ItineraryLeg::new(TrackId::new(202), TravelDirection::AgainstChainage),
                ItineraryLeg::new(TrackId::new(1001), TravelDirection::AgainstChainage),
                ItineraryLeg::new(TrackId::new(102), TravelDirection::AgainstChainage),
            ],
        );
        assert!(matches!(
            fehler,
            Err(ConflictError::DirectionNotAllowed {
                track,
                direction: TravelDirection::AgainstChainage
            }) if track == TrackId::new(1001)
        ));
    }

    #[test]
    fn auf_dem_abstellgleis_faehrt_kein_zug() {
        // E12: Auf einem Abstellgleis wird ausschließlich rangiert.
        let netz = reference_network();
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(311)]),
            Err(ConflictError::NotForTrainRuns(track)) if track == TrackId::new(311)
        ));
    }

    #[test]
    fn zwei_abschnitte_muessen_sich_treffen() {
        let netz = reference_network();
        // Von Nordstadt über die Kante 2 — die dort gar nicht anliegt.
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(101), hin(2001), hin(301)]),
            Err(ConflictError::Disconnected { .. })
        ));
    }

    #[test]
    fn auf_freier_strecke_wird_nicht_gehalten() {
        let netz = reference_network();
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(101), hin(1001).with_dwell(60), hin(201)]),
            Err(ConflictError::DwellOnLine { .. })
        ));
    }

    #[test]
    fn ein_leerer_laufweg_faellt_auf() {
        let netz = reference_network();
        assert_eq!(
            Itinerary::new(&netz, Vec::new()),
            Err(ConflictError::EmptyItinerary)
        );
    }

    #[test]
    fn eine_negative_haltezeit_faellt_auf() {
        let netz = reference_network();
        assert!(matches!(
            Itinerary::new(&netz, vec![hin(101).with_dwell(-1)]),
            Err(ConflictError::NegativeDwell { seconds: -1 })
        ));
    }
}
