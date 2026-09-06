//! Der Trassen-Planner — **M3.4**.
//!
//! `docs/infrastruktur.md` 2.2: „Der Planner erzeugt Laufweg- und
//! Zeitkandidaten mit relativen Belegungsprofilen." 2.7: „Annahme,
//! Alternativtrasse und Ablehnung enthalten eine maschinenlesbare und
//! verständliche Begründung."
//!
//! ## Warum das kein erweiterter Konfliktprüfer ist
//!
//! Der Spike aus M0.3 hat diesen Punkt ausdrücklich offengelassen. Sein
//! Prüfer konnte sagen, *dass* zwei Züge auf dem eingleisigen Ast kollidieren,
//! und er konnte die kleinste auflösende Verspätung nennen: „6:57 min später".
//! Betrieblich richtig war aber: „6 min früher und in Sandberg kreuzen".
//!
//! Der Unterschied zwischen **zulässig** und **gut** ist der ganze Auftrag von
//! M3.4. Er entsteht nicht aus einer besseren Prüfung, sondern aus drei
//! Freiheitsgraden, die der Prüfer gar nicht kennt:
//!
//! 1. **Laufweg** — welches Streckengleis, welches Bahnsteiggleis
//!    ([`crate::route`]).
//! 2. **Zeitlage** — früher oder später innerhalb der beantragten Abweichung.
//! 3. **Betriebshalt** — an einer kreuzungsfähigen Betriebsstelle warten, bis
//!    der Gegenzug durch ist. Das ist die Kreuzung, und ihre Dauer wird
//!    ausgerechnet, nicht geraten.
//!
//! ## Das Ergebnis
//!
//! Drei Ausgänge, alle mit Begründung: [`PathDecision::Granted`] (die
//! Wunschlage ist frei), [`PathDecision::Alternative`] (sie ist es nicht, aber
//! etwas innerhalb der zulässigen Abweichungen), [`PathDecision::Rejected`]
//! (auch das nicht). Die Begründung einer Ablehnung ist immer der Prüfbericht
//! der Wunschlage — welche Ressource, welches Fenster, welcher Gegenzug.
//!
//! ## Was hier bewusst noch nicht steht
//!
//! Der Planner behandelt **einen** Antrag gegen ein bestehendes
//! Belegungsbuch. Wie mehrere konkurrierende Anträge eines Planungsfensters
//! gemeinsam und reihenfolgeunabhängig behandelt werden, ist der
//! deterministische `PlanningRun` aus M3.5 — mit Seed-Tiebreak und
//! Einspruchsfenster. Der Planner ist dessen Baustein, nicht sein Ersatz.

use std::collections::BTreeMap;

use zugfolge_conflict::{
    ConflictReport, Infrastructure, Itinerary, ItineraryLeg, OccupationLedger, OccupationProfile,
    SECONDS_PER_DAY, ServicePattern, derive_occupation_profile,
};
use zugfolge_determinism::SimTime;
use zugfolge_infra::{Length, OperatingPointId};

use crate::candidate::{CandidateDeviation, PathCandidate, rank};
use crate::error::PlannerError;
use crate::request::{PathRequest, PathRequestId};
use crate::route::enumerate_itineraries;

/// Die Stellschrauben des Planners.
///
/// Sie sind Schranken, keine Regeln: Sie entscheiden, **wie weit** gesucht
/// wird, nie **was** zulässig ist. Was zulässig ist, steht im Antrag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlannerOptions {
    max_route_candidates: usize,
    max_candidates: usize,
    horizon_days: i64,
    minimum_operational_dwell_s: i64,
    max_dwell_rounds: usize,
}

impl PlannerOptions {
    /// Höchstzahl der Laufwegkandidaten.
    pub const fn max_route_candidates(&self) -> usize {
        self.max_route_candidates
    }

    /// Höchstzahl der zurückgelieferten Trassenkandidaten.
    pub const fn max_candidates(&self) -> usize {
        self.max_candidates
    }

    /// Über wie viele Tage ein Kandidat geprüft wird.
    pub const fn horizon_days(&self) -> i64 {
        self.horizon_days
    }

    /// Setzt die Höchstzahl der Laufwegkandidaten.
    #[must_use]
    pub const fn with_max_route_candidates(mut self, value: usize) -> Self {
        self.max_route_candidates = value;
        self
    }

    /// Setzt den Prüfhorizont in Tagen.
    #[must_use]
    pub const fn with_horizon_days(mut self, value: i64) -> Self {
        self.horizon_days = if value < 1 { 1 } else { value };
        self
    }
}

impl Default for PlannerOptions {
    fn default() -> Self {
        Self {
            max_route_candidates: 8,
            max_candidates: 16,
            // Eine Woche deckt jedes Verkehrstagemuster genau einmal ab.
            horizon_days: 7,
            // Ein Betriebshalt unter einer Minute ist betrieblich keiner:
            // Bremsen, Stehen und Anfahren kosten sie ohnehin.
            minimum_operational_dwell_s: 60,
            max_dwell_rounds: 6,
        }
    }
}

/// Der Ausgang eines Trassenantrags.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathDecision {
    /// Die Wunschlage ist frei und wird zugeteilt.
    Granted,
    /// Die Wunschlage ist belegt; angeboten wird eine Trasse innerhalb der
    /// zulässigen Abweichungen.
    Alternative,
    /// Auch innerhalb der zulässigen Abweichungen ist keine Trasse frei.
    Rejected,
}

impl PathDecision {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Granted => "granted",
            Self::Alternative => "alternative",
            Self::Rejected => "rejected",
        }
    }

    /// Deutsche Bezeichnung.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Granted => "Annahme",
            Self::Alternative => "Alternativtrasse",
            Self::Rejected => "Ablehnung",
        }
    }
}

/// Das Ergebnis eines Trassenantrags, mit Begründung.
#[derive(Clone, Debug)]
pub struct PlannerOutcome {
    request: PathRequestId,
    decision: PathDecision,
    candidates: Vec<PathCandidate>,
    desired_conflicts: ConflictReport,
    desired_boundary_violation: Option<String>,
}

impl PlannerOutcome {
    /// Die Kennung des Antrags.
    pub const fn request(&self) -> PathRequestId {
        self.request
    }

    /// Der Ausgang.
    pub const fn decision(&self) -> PathDecision {
        self.decision
    }

    /// Die angebotene Trasse — bei einer Ablehnung keine.
    pub fn offer(&self) -> Option<&PathCandidate> {
        self.candidates.first()
    }

    /// Alle zulässigen Kandidaten, nach der veröffentlichten Rangfolge
    /// geordnet.
    ///
    /// Dass hier mehr als einer steht, ist Absicht: E11 verbietet einen
    /// einzelnen Optimierungswert, also muss die Alternative sichtbar bleiben
    /// und darf nicht in einer Zahl verschwinden.
    pub fn candidates(&self) -> &[PathCandidate] {
        &self.candidates
    }

    /// Warum die Wunschlage nicht frei war — leer, wenn sie es war.
    pub const fn desired_conflicts(&self) -> &ConflictReport {
        &self.desired_conflicts
    }

    /// Warum die Wunschlage den festgelegten Aussenanschluss verfehlt.
    pub fn desired_boundary_violation(&self) -> Option<&str> {
        self.desired_boundary_violation.as_deref()
    }

    /// Die Begründung als deutscher Text.
    pub fn explain(&self) -> String {
        let kopf = format!("{}: {}", self.request, self.decision.label());
        match self.decision {
            PathDecision::Granted => self.offer().map_or(kopf.clone(), |kandidat| {
                format!("{kopf}. {}", kandidat.explain())
            }),
            PathDecision::Alternative => {
                let angebot = self
                    .offer()
                    .map_or_else(String::new, PathCandidate::explain);
                if let Some(violation) = &self.desired_boundary_violation {
                    return format!(
                        "{kopf}. Die Wunschlage verfehlt das verbindliche Grenzfenster: {violation}.\nAngeboten wird: {angebot}"
                    );
                }
                format!(
                    "{kopf}. Die Wunschlage ist belegt:\n{}\nAngeboten wird: {angebot}",
                    self.desired_conflicts.explain()
                )
            }
            PathDecision::Rejected => self.desired_boundary_violation.as_ref().map_or_else(
                || format!(
                    "{kopf}. Innerhalb der zulässigen Abweichungen ist keine Trasse frei. \
                     Die Wunschlage scheitert an:\n{}",
                    self.desired_conflicts.explain()
                ),
                |violation| format!(
                    "{kopf}. Keine zulässige Zeitlage erreicht den gebundenen Aussenlauf. {violation}"
                ),
            ),
        }
    }
}

/// Der Trassen-Planner.
#[derive(Clone, Debug)]
pub struct TrainPathPlanner<'a> {
    infrastructure: &'a Infrastructure,
    options: PlannerOptions,
}

impl<'a> TrainPathPlanner<'a> {
    /// Ein Planner mit den Vorgabeschranken.
    pub fn new(infrastructure: &'a Infrastructure) -> Self {
        Self {
            infrastructure,
            options: PlannerOptions::default(),
        }
    }

    /// Ein Planner mit eigenen Schranken.
    pub const fn with_options(infrastructure: &'a Infrastructure, options: PlannerOptions) -> Self {
        Self {
            infrastructure,
            options,
        }
    }

    /// Die Schranken.
    pub const fn options(&self) -> PlannerOptions {
        self.options
    }

    /// Behandelt einen Trassenantrag gegen ein bestehendes Belegungsbuch.
    ///
    /// # Errors
    ///
    /// - [`PlannerError::NoRoute`] oder [`PlannerError::UnservableStop`], wenn
    ///   das Netz den Antrag gar nicht tragen kann.
    /// - [`PlannerError::Conflict`], wenn die Fahrdynamik jeden Laufweg
    ///   zurückweist — etwa weil die Zugsicherung oder die Antriebsart des
    ///   Zuges nicht zur Strecke passt.
    pub fn plan(
        &self,
        ledger: &OccupationLedger,
        request: &PathRequest,
    ) -> Result<PlannerOutcome, PlannerError> {
        let basis = self.basisprofile(request)?;
        let schnellste = basis
            .iter()
            .map(|(_, profil)| profil.running_time_s())
            .min()
            .unwrap_or(0);
        let kuerzeste = basis
            .iter()
            .map(|(laufweg, _)| laufweg.length())
            .min()
            .unwrap_or(Length::ZERO);

        // Die Wunschlage auf dem schnellsten Laufweg — sie trägt die
        // Begründung, falls es nicht bei ihr bleibt.
        let (wunsch_laufweg, wunsch_profil) = basis
            .iter()
            .min_by_key(|(laufweg, profil)| (profil.running_time_s(), laufweg.length()))
            .ok_or(PlannerError::NoRoute {
                origin: request.origin(),
                destination: request.destination(),
            })?;
        let desired_arrival = request
            .desired_departure()
            .plus_seconds(wunsch_profil.running_time_s());
        let desired_boundary_violation =
            request.boundary_violation(request.desired_departure(), desired_arrival);
        let wunsch_bericht = if desired_boundary_violation.is_some() {
            ConflictReport::default()
        } else {
            self.erste_kollision(
                ledger,
                &self.angebot(request, wunsch_laufweg, wunsch_profil, 0)?,
                request.desired_departure(),
            )
            .map_or_else(ConflictReport::default, |kollision| kollision.report)
        };

        let mut kandidaten = self.kandidaten(ledger, request, &basis, schnellste, kuerzeste)?;
        rank(&mut kandidaten);
        kandidaten.truncate(self.options.max_candidates);

        let decision = match kandidaten.first() {
            Some(bester) if bester.deviation().is_exact() => PathDecision::Granted,
            Some(_) => PathDecision::Alternative,
            None => PathDecision::Rejected,
        };

        Ok(PlannerOutcome {
            request: request.id(),
            decision,
            candidates: kandidaten,
            desired_conflicts: wunsch_bericht,
            desired_boundary_violation,
        })
    }

    /// Die Laufwegkandidaten samt ihrem Belegungsprofil ohne Betriebshalt.
    fn basisprofile(
        &self,
        request: &PathRequest,
    ) -> Result<Vec<(Itinerary, OccupationProfile)>, PlannerError> {
        let laufwege = enumerate_itineraries(
            self.infrastructure.graph(),
            request,
            self.options.max_route_candidates,
        )?;

        let mut basis = Vec::with_capacity(laufwege.len());
        let mut letzter_fehler = None;
        for laufweg in laufwege {
            match derive_occupation_profile(self.infrastructure, &laufweg, request.train()) {
                Ok(profil) => basis.push((laufweg, profil)),
                // Ein einzelner unbefahrbarer Laufweg ist kein Fehler des
                // Antrags — erst wenn **jeder** scheitert, ist er einer.
                Err(fehler) => letzter_fehler = Some(fehler),
            }
        }

        if basis.is_empty() {
            return Err(letzter_fehler.map_or(
                PlannerError::NoRoute {
                    origin: request.origin(),
                    destination: request.destination(),
                },
                PlannerError::Conflict,
            ));
        }
        Ok(basis)
    }

    /// Erzeugt alle zulässigen Trassenkandidaten.
    fn kandidaten(
        &self,
        ledger: &OccupationLedger,
        request: &PathRequest,
        basis: &[(Itinerary, OccupationProfile)],
        schnellste: i64,
        kuerzeste: Length,
    ) -> Result<Vec<PathCandidate>, PlannerError> {
        let toleranz = request.tolerances();
        let mut kandidaten: Vec<PathCandidate> = Vec::new();
        // Ein Laufweg mit Betriebshalt hängt an (Laufweg, Abschnitt,
        // Haltezeit) — nicht an der Zeitlage. Er wird deshalb einmal gerechnet
        // und wiederverwendet; sonst rechnete der Planner dieselbe
        // Fahrdynamik für jede Zeitlage neu.
        let mut halteprofile: BTreeMap<(usize, usize, i64), (Itinerary, OccupationProfile)> =
            BTreeMap::new();

        for shift in toleranz.shifts() {
            for (nummer, (laufweg, profil)) in basis.iter().enumerate() {
                let umweg = laufweg.length() - kuerzeste;
                let mehrfahrzeit = profil.running_time_s().saturating_sub(schnellste);
                if mehrfahrzeit > toleranz.extra_running_time_s() {
                    continue;
                }

                // Ohne Betriebshalt.
                let angebot = self.angebot(request, laufweg, profil, shift)?;
                let abfahrt = request.desired_departure().plus_seconds(shift);
                if request
                    .boundary_violation(abfahrt, abfahrt.plus_seconds(profil.running_time_s()))
                    .is_some()
                {
                    continue;
                }
                if self.erste_kollision(ledger, &angebot, abfahrt).is_none() {
                    let erste_abfahrt = self.erste_abfahrt(&angebot, abfahrt);
                    kandidaten.push(PathCandidate::new(
                        angebot,
                        CandidateDeviation::new(shift, mehrfahrzeit, Vec::new(), umweg),
                        erste_abfahrt,
                    ));
                    continue;
                }

                if toleranz.max_operational_stops() == 0 {
                    continue;
                }

                // Mit einem Betriebshalt an einer kreuzungsfähigen
                // Betriebsstelle. Das ist die Kreuzung — die betrieblich
                // richtige Auflösung, die der Prüfer nicht kennt.
                for (abschnitt, punkt) in self.betriebshalte(laufweg, request) {
                    let Some((halt_laufweg, halt_profil, _)) = self.betriebshalt(
                        ledger,
                        request,
                        laufweg,
                        nummer,
                        abschnitt,
                        shift,
                        &mut halteprofile,
                    )?
                    else {
                        continue;
                    };
                    let mehrfahrzeit = halt_profil.running_time_s().saturating_sub(schnellste);
                    if mehrfahrzeit > toleranz.extra_running_time_s() {
                        continue;
                    }
                    let angebot = self.angebot(request, &halt_laufweg, &halt_profil, shift)?;
                    if request
                        .boundary_violation(
                            abfahrt,
                            abfahrt.plus_seconds(halt_profil.running_time_s()),
                        )
                        .is_some()
                    {
                        continue;
                    }
                    kandidaten.push(PathCandidate::new(
                        angebot.clone(),
                        CandidateDeviation::new(shift, mehrfahrzeit, vec![punkt], umweg),
                        self.erste_abfahrt(&angebot, abfahrt),
                    ));
                    break;
                }
            }
        }

        Ok(kandidaten)
    }

    /// Sucht die kürzeste Haltezeit an einem Abschnitt, nach der die Trasse
    /// konfliktfrei liegt.
    ///
    /// Der Zuwachs kommt aus dem Prüfbericht selbst: Ein Konflikt **hinter**
    /// dem Betriebshalt löst sich, wenn der Zug so lange stehen bleibt, bis die
    /// fremde Sperrzeit abgelaufen ist. Ein Konflikt **vor** dem Betriebshalt
    /// löst sich dadurch nie — dann gibt das Verfahren auf, statt sinnlos
    /// weiterzuwarten.
    #[expect(
        clippy::too_many_arguments,
        reason = "M3.4: Die Suche braucht Belegungsbuch, Antrag, Laufweg, seine \
                  Nummer, den Abschnitt, die Zeitlage und den Zwischenspeicher — \
                  sie in eine Struktur zu bündeln verschöbe die Aufzählung nur"
    )]
    fn betriebshalt(
        &self,
        ledger: &OccupationLedger,
        request: &PathRequest,
        laufweg: &Itinerary,
        nummer: usize,
        abschnitt: usize,
        shift: i64,
        cache: &mut BTreeMap<(usize, usize, i64), (Itinerary, OccupationProfile)>,
    ) -> Result<Option<(Itinerary, OccupationProfile, i64)>, PlannerError> {
        let abfahrt = request.desired_departure().plus_seconds(shift);
        let mut haltezeit = auf_volle_minute(self.options.minimum_operational_dwell_s);

        for _ in 0..self.options.max_dwell_rounds {
            let schluessel = (nummer, abschnitt, haltezeit);
            let (halt_laufweg, halt_profil) = match cache.get(&schluessel) {
                Some(vorhanden) => vorhanden.clone(),
                None => {
                    let gebaut = mit_haltezeit(self.infrastructure, laufweg, abschnitt, haltezeit)?;
                    let profil =
                        derive_occupation_profile(self.infrastructure, &gebaut, request.train())
                            .map_err(PlannerError::Conflict)?;
                    cache.insert(schluessel, (gebaut.clone(), profil.clone()));
                    (gebaut, profil)
                }
            };

            let angebot = self.angebot(request, &halt_laufweg, &halt_profil, shift)?;
            let Some(kollision) = self.erste_kollision(ledger, &angebot, abfahrt) else {
                return Ok(Some((halt_laufweg, halt_profil, haltezeit)));
            };

            // Wann verlässt der Zug den Betriebshalt? Ab dann — und nur ab
            // dann — hilft längeres Warten.
            let halt_ende = halt_profil
                .occupations()
                .iter()
                .filter(|belegung| {
                    belegung.resource()
                        == zugfolge_conflict::ConflictResource::Track(
                            halt_laufweg.legs()[abschnitt].track(),
                        )
                })
                .map(zugfolge_conflict::RelativeOccupation::exit_s)
                .next_back()
                .unwrap_or(0);

            let bezug = kollision.departure.seconds();
            let zuwachs = kollision
                .report
                .conflicts()
                .iter()
                .filter(|befund| befund.own().entry().seconds() - bezug >= halt_ende)
                .map(zugfolge_conflict::OccupationConflict::resolving_shift_s)
                .max();

            let Some(zuwachs) = zuwachs.filter(|wert| *wert > 0) else {
                return Ok(None);
            };
            haltezeit = haltezeit.saturating_add(auf_volle_minute(zuwachs));
        }

        Ok(None)
    }

    /// Die Abschnitte, an deren Ende ein Betriebshalt möglich ist.
    ///
    /// Möglich ist er in einer Betriebsstelle, die kreuzen kann (also Weichen
    /// hat), die nicht Anfang oder Ziel ist und an der nicht ohnehin gehalten
    /// wird. Ein Haltepunkt auf freier Strecke kann nicht kreuzen — dort steht
    /// ein wartender Zug im Weg.
    fn betriebshalte(
        &self,
        laufweg: &Itinerary,
        request: &PathRequest,
    ) -> Vec<(usize, OperatingPointId)> {
        let letzter = laufweg.legs().len().saturating_sub(1);
        laufweg
            .legs()
            .iter()
            .enumerate()
            .filter(|(index, leg)| {
                *index > 0 && *index < letzter && leg.is_in_station() && leg.dwell_s() == 0
            })
            .filter_map(|(index, leg)| {
                let punkt = leg.to();
                if request.stop_at(punkt).is_some() {
                    return None;
                }
                let betriebsstelle = self.infrastructure.graph().operating_point(punkt)?;
                betriebsstelle
                    .kind()
                    .allows_crossing()
                    .then_some((index, punkt))
            })
            .collect()
    }

    /// Baut das Verkehrsangebot eines Kandidaten.
    fn angebot(
        &self,
        request: &PathRequest,
        laufweg: &Itinerary,
        profil: &OccupationProfile,
        shift: i64,
    ) -> Result<ServicePattern, PlannerError> {
        let abfahrt = request.desired_departure().plus_seconds(shift);
        let pattern = ServicePattern::new(
            request.number(),
            request.train().id(),
            laufweg.clone(),
            profil.clone(),
            abfahrt.seconds().rem_euclid(SECONDS_PER_DAY),
            request.operating_days(),
        )
        .map_err(PlannerError::Conflict)?;
        Ok(match request.service_window() {
            Some(window) => pattern.with_service_window(window),
            None => pattern,
        })
    }

    /// Die erste Kollision im Prüfhorizont — `None`, wenn jede Fahrt frei
    /// liegt.
    fn erste_kollision(
        &self,
        ledger: &OccupationLedger,
        pattern: &ServicePattern,
        departure: SimTime,
    ) -> Option<DayConflict> {
        let tag0 = departure.seconds().div_euclid(SECONDS_PER_DAY);
        for tag in tag0..tag0.saturating_add(self.options.horizon_days) {
            // Ein Tag ohne Verkehr wird übersprungen, nicht als konfliktfrei
            // gewertet — sonst bliebe bei einem Angebot Montag bis Freitag
            // alles nach dem ersten Samstag ungeprüft.
            let Some(fahrt) = pattern.materialise(tag) else {
                continue;
            };
            let bericht = ledger.check(&fahrt);
            if !bericht.is_clear() {
                return Some(DayConflict {
                    departure: fahrt.departure(),
                    report: bericht,
                });
            }
        }
        None
    }

    /// Die erste Abfahrt im Prüfhorizont.
    fn erste_abfahrt(&self, pattern: &ServicePattern, departure: SimTime) -> SimTime {
        let tag0 = departure.seconds().div_euclid(SECONDS_PER_DAY);
        (tag0..tag0.saturating_add(self.options.horizon_days))
            .find(|tag| pattern.runs_on(*tag))
            .map_or(departure, |tag| pattern.departure_on(tag))
    }
}

/// Eine Kollision an einem konkreten Verkehrstag.
#[derive(Clone, Debug)]
struct DayConflict {
    departure: SimTime,
    report: ConflictReport,
}

/// Baut denselben Laufweg mit einer Haltezeit an einem Abschnitt.
fn mit_haltezeit(
    infrastructure: &Infrastructure,
    laufweg: &Itinerary,
    abschnitt: usize,
    haltezeit: i64,
) -> Result<Itinerary, PlannerError> {
    let legs: Vec<ItineraryLeg> = laufweg
        .legs()
        .iter()
        .enumerate()
        .map(|(index, leg)| {
            if index == abschnitt {
                leg.leg().with_dwell(haltezeit)
            } else {
                leg.leg()
            }
        })
        .collect();
    Itinerary::new(infrastructure.graph(), legs).map_err(PlannerError::Conflict)
}

/// Rundet eine Dauer auf volle Minuten auf.
///
/// Ein Fahrplan wird in Minuten veröffentlicht. Eine Haltezeit von 3:47 min
/// stünde in keinem Aushang und wäre auch betrieblich nicht zu halten.
const fn auf_volle_minute(seconds: i64) -> i64 {
    if seconds <= 0 {
        return 0;
    }
    seconds.saturating_add(59) / 60 * 60
}

#[cfg(test)]
mod tests {
    use super::auf_volle_minute;

    #[test]
    fn haltezeiten_werden_auf_volle_minuten_aufgerundet() {
        assert_eq!(auf_volle_minute(1), 60);
        assert_eq!(auf_volle_minute(60), 60);
        assert_eq!(auf_volle_minute(61), 120);
        assert_eq!(auf_volle_minute(0), 0);
        assert_eq!(auf_volle_minute(-5), 0);
    }
}
