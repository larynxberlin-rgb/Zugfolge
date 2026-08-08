//! Laufwegkandidaten — die erste Hälfte von **M3.4**.
//!
//! Ein Trassenantrag nennt Anfang, Ziel und Halte. Welche **Gleise** ein Zug
//! dabei befährt, ist offen: Auf einer zweigleisigen Strecke gibt es je
//! Richtung mindestens eines, in einem Bahnhof mehrere Bahnsteiggleise. Genau
//! diese Wahl ist der Laufwegkandidat, und sie ist keine Kosmetik: Zwei Züge,
//! die verschiedene Bahnsteiggleise benutzen, geraten nicht in Konflikt — zwei,
//! die dasselbe wollen, schon.
//!
//! ## Das Verfahren
//!
//! 1. **Betriebsstellenfolgen** vom Anfang zum Ziel aufzählen, ohne eine
//!    Betriebsstelle zweimal zu berühren, und nur die behalten, die jeden
//!    beantragten Halt berühren.
//! 2. **Gleise wählen**: je Betriebsstelle ein befahrbares Gleis, je Kante ein
//!    Streckengleis, das die Fahrtrichtung zulässt. An einem beantragten Halt
//!    kommen nur Gleise mit einem Bahnsteig in Frage, der die Zuglänge
//!    aufnimmt — ein Halt ohne Bahnsteig ist kein Halt.
//! 3. **Deckeln.** Die Zahl der Kombinationen wächst mit dem Produkt der
//!    Gleiszahlen. Der Planner nimmt die ersten `limit` in einer festgelegten
//!    Reihenfolge: je Stelle das Gleis mit der kleinsten Kennung zuerst, danach
//!    die Abwandlungen von hinten nach vorn. Das ist bewusst kein Zufall — die
//!    Auswahl muss bei gleicher Eingabe dieselbe sein.

use std::collections::{BTreeSet, VecDeque};

use zugfolge_conflict::{Itinerary, ItineraryLeg};
use zugfolge_infra::{
    Length, OperatingGraph, OperatingPointId, TrackId, TrackOwner, TravelDirection,
};

use crate::error::PlannerError;
use crate::request::PathRequest;

/// Wie viele Betriebsstellen ein Laufweg höchstens berührt.
///
/// Die Schranke hält die Aufzählung endlich, auch in einem dicht vermaschten
/// Netz. Ein Laufweg über mehr als 64 Betriebsstellen ist kein Laufweg mehr,
/// sondern ein Rundkurs.
const MAX_POINTS: usize = 64;

/// Wie viele Betriebsstellenfolgen die Suche höchstens sammelt.
///
/// **Diese Schranke ist kein Geschmacksurteil, sondern eine Notwendigkeit.**
/// Die Zahl der einfachen Wege zwischen zwei Punkten wächst in einem vermaschten
/// Netz exponentiell; eine vollständige Aufzählung wäre auf der Pilotregion nicht
/// zu beenden. Die Suche geht deshalb **in die Breite** und bricht ab, sobald sie
/// genug hat — was sie dann in der Hand hat, sind die **kürzesten** Folgen, nicht
/// die zuerst gefundenen. Das ist der Unterschied zwischen einem Deckel und einer
/// Willkür.
const MAX_POINT_SEQUENCES: usize = 16;

/// Wie viele Teilwege die Suche höchstens betrachtet.
///
/// Das Sicherheitsventil für den Fall, dass das Ziel gar nicht erreichbar ist:
/// Ohne es liefe die Breitensuche durch das ganze Netz, bevor sie aufgäbe.
const MAX_EXPANSIONS: usize = 50_000;

/// Ein Schritt einer Betriebsstellenfolge: das Gleis, das gewählt werden muss.
struct Choice {
    /// Die Gleise, die an dieser Stelle in Frage kommen.
    tracks: Vec<TrackId>,
    /// Die Fahrtrichtung auf ihnen.
    direction: TravelDirection,
    /// Die Haltezeit am Ende dieses Abschnitts.
    dwell_s: i64,
}

/// Zählt die Laufwegkandidaten eines Antrags auf.
///
/// # Errors
///
/// - [`PlannerError::NoRoute`], wenn keine Betriebsstellenfolge Anfang, Ziel
///   und alle Halte verbindet.
/// - [`PlannerError::UnservableStop`], wenn an einem beantragten Halt kein
///   Bahnsteig die Zuglänge aufnimmt.
/// - [`PlannerError::Conflict`], wenn ein gebauter Laufweg die Prüfung aus
///   M3.1 nicht besteht — das wäre ein Fehler dieser Aufzählung und fällt
///   deshalb laut auf.
pub fn enumerate_itineraries(
    graph: &OperatingGraph,
    request: &PathRequest,
    limit: usize,
) -> Result<Vec<Itinerary>, PlannerError> {
    let folgen = punktfolgen(graph, request);
    if folgen.is_empty() {
        return Err(PlannerError::NoRoute {
            origin: request.origin(),
            destination: request.destination(),
        });
    }

    let mut laufwege: Vec<Itinerary> = Vec::new();
    let mut fehlender_halt: Option<OperatingPointId> = None;

    for folge in folgen {
        let schritte = match schritte(graph, request, &folge) {
            Ok(schritte) => schritte,
            Err(halt) => {
                fehlender_halt = fehlender_halt.or(Some(halt));
                continue;
            }
        };

        for kombination in kombinationen(&schritte, limit.saturating_sub(laufwege.len())) {
            let legs: Vec<ItineraryLeg> = kombination
                .iter()
                .zip(&schritte)
                .map(|(track, schritt)| {
                    ItineraryLeg::new(*track, schritt.direction).with_dwell(schritt.dwell_s)
                })
                .collect();
            laufwege.push(Itinerary::new(graph, legs)?);
            if laufwege.len() >= limit {
                return Ok(laufwege);
            }
        }
    }

    if laufwege.is_empty() {
        return Err(fehlender_halt.map_or(
            PlannerError::NoRoute {
                origin: request.origin(),
                destination: request.destination(),
            },
            PlannerError::UnservableStop,
        ));
    }
    Ok(laufwege)
}

/// Die kürzesten Betriebsstellenfolgen vom Anfang zum Ziel, die jeden
/// beantragten Halt berühren.
///
/// Die Suche geht **in die Breite**: Sie findet kurze Folgen zuerst und bricht
/// ab, sobald sie [`MAX_POINT_SEQUENCES`] beisammen hat. Eine Tiefensuche wäre
/// hier falsch — sie fände zuerst irgendeinen Weg und bei einem Deckel eben
/// diesen, nicht den kürzesten. Innerhalb einer Ebene ist die Reihenfolge durch
/// die Kennung der Nachbarn festgelegt, nicht durch den Zufall der Aufzählung.
fn punktfolgen(graph: &OperatingGraph, request: &PathRequest) -> Vec<Vec<OperatingPointId>> {
    let pflicht: BTreeSet<OperatingPointId> =
        request.stops().iter().map(|halt| halt.point()).collect();

    let mut gefunden: Vec<Vec<OperatingPointId>> = Vec::new();
    let mut warteschlange: VecDeque<Vec<OperatingPointId>> = VecDeque::new();
    warteschlange.push_back(vec![request.origin()]);
    let mut betrachtet = 0_usize;

    while let Some(pfad) = warteschlange.pop_front() {
        betrachtet = betrachtet.saturating_add(1);
        if betrachtet > MAX_EXPANSIONS {
            break;
        }
        let Some(aktuell) = pfad.last().copied() else {
            continue;
        };

        if aktuell == request.destination() {
            if pflicht.iter().all(|halt| pfad.contains(halt)) {
                gefunden.push(pfad);
                if gefunden.len() >= MAX_POINT_SEQUENCES {
                    break;
                }
            }
            // Über das Ziel hinaus wird nicht weitergesucht: Ein Laufweg endet
            // dort, wo der Antrag ihn enden lässt.
            continue;
        }
        if pfad.len() >= MAX_POINTS {
            continue;
        }

        for nachbar in graph.neighbours(aktuell) {
            if pfad.contains(&nachbar) {
                continue;
            }
            let mut naechster = pfad.clone();
            naechster.push(nachbar);
            warteschlange.push_back(naechster);
        }
    }

    gefunden.sort_by(|a, b| (a.len(), a.as_slice()).cmp(&(b.len(), b.as_slice())));
    gefunden
}

/// Die Wahlmöglichkeiten je Abschnitt einer Betriebsstellenfolge.
///
/// Meldet als Fehler die Betriebsstelle, an der ein beantragter Halt nicht
/// bedienbar ist.
fn schritte(
    graph: &OperatingGraph,
    request: &PathRequest,
    points: &[OperatingPointId],
) -> Result<Vec<Choice>, OperatingPointId> {
    let mut schritte: Vec<Choice> = Vec::new();

    for (index, punkt) in points.iter().enumerate() {
        let halt = request.stop_at(*punkt);
        // Am Ziel wird nicht gehalten, dort endet die Fahrt.
        let letzter = index + 1 == points.len();
        let dwell = if letzter {
            0
        } else {
            halt.map_or(0, |halt| halt.minimum_dwell_s())
        };

        // Die Fahrtrichtung im Bahnhofsgleis folgt der Kante, auf die es
        // hinausführt — am Ziel der, aus der es kommt.
        let richtung = if letzter {
            richtung_zwischen(graph, points[index.saturating_sub(1)], *punkt)
        } else {
            richtung_zwischen(graph, *punkt, points[index.saturating_add(1)])
        };
        let Some((_, richtung)) = richtung else {
            return Err(*punkt);
        };

        let mut gleise: Vec<TrackId> = graph
            .tracks_of(TrackOwner::OperatingPoint(*punkt))
            .filter(|gleis| gleis.kind().carries_train_runs())
            .filter(|gleis| gleis.direction().allows(richtung))
            .filter(|gleis| halt.is_none() || hat_bahnsteig(graph, gleis.id(), request))
            .map(|gleis| gleis.id())
            .collect();
        gleise.sort_unstable();
        if gleise.is_empty() {
            return Err(*punkt);
        }
        schritte.push(Choice {
            tracks: gleise,
            direction: richtung,
            dwell_s: dwell,
        });

        if letzter {
            break;
        }

        let Some((kante, richtung)) = richtung_zwischen(graph, *punkt, points[index + 1]) else {
            return Err(*punkt);
        };
        let mut streckengleise: Vec<TrackId> = graph
            .tracks_of(TrackOwner::Edge(kante))
            .filter(|gleis| gleis.kind().carries_train_runs())
            .filter(|gleis| gleis.direction().allows(richtung))
            .map(|gleis| gleis.id())
            .collect();
        streckengleise.sort_unstable();
        if streckengleise.is_empty() {
            return Err(*punkt);
        }
        schritte.push(Choice {
            tracks: streckengleise,
            direction: richtung,
            dwell_s: 0,
        });
    }

    Ok(schritte)
}

/// Die Kante zwischen zwei benachbarten Betriebsstellen und die Fahrtrichtung
/// auf ihr.
fn richtung_zwischen(
    graph: &OperatingGraph,
    from: OperatingPointId,
    to: OperatingPointId,
) -> Option<(zugfolge_infra::TrackEdgeId, TravelDirection)> {
    graph.edges_at(from).find_map(|kante| {
        if kante.other_end(from) != Some(to) {
            return None;
        }
        let richtung = if kante.end_of(TravelDirection::WithChainage) == to {
            TravelDirection::WithChainage
        } else {
            TravelDirection::AgainstChainage
        };
        Some((kante.id(), richtung))
    })
}

/// Ob an einem Gleis ein Bahnsteig liegt, der die beantragte Zuglänge
/// aufnimmt.
fn hat_bahnsteig(graph: &OperatingGraph, track: TrackId, request: &PathRequest) -> bool {
    let laenge: Length = request.train().length();
    graph
        .platforms_of(track)
        .any(|bahnsteig| bahnsteig.accommodates(laenge))
}

/// Die Gleiskombinationen einer Betriebsstellenfolge, in festgelegter
/// Reihenfolge und auf `limit` gedeckelt.
fn kombinationen(steps: &[Choice], limit: usize) -> Vec<Vec<TrackId>> {
    if steps.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut ergebnis: Vec<Vec<TrackId>> = Vec::new();
    let mut zeiger: Vec<usize> = vec![0; steps.len()];

    loop {
        ergebnis.push(
            zeiger
                .iter()
                .zip(steps)
                .map(|(index, schritt)| schritt.tracks[*index])
                .collect(),
        );
        if ergebnis.len() >= limit {
            break;
        }

        // Zählwerk: die hinterste Stelle zuerst — so bleibt der vordere Teil
        // des Laufwegs möglichst lange der kanonische.
        let mut stelle = steps.len();
        loop {
            if stelle == 0 {
                return ergebnis;
            }
            stelle -= 1;
            zeiger[stelle] += 1;
            if zeiger[stelle] < steps[stelle].tracks.len() {
                break;
            }
            zeiger[stelle] = 0;
        }
    }

    ergebnis
}

#[cfg(test)]
mod tests {
    use super::enumerate_itineraries;
    use crate::error::PlannerError;
    use crate::request::{PathRequest, PathRequestId, PathTolerances, RequestedStop};
    use zugfolge_conflict::example::{freight_train, reference_infrastructure, regional_train};
    use zugfolge_conflict::{OperatingDays, TrainCategory, TrainNumber};
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::{OperatingPointId, TrainCharacteristics};

    fn antrag(zug: TrainCharacteristics, von: u32, nach: u32, halte: &[(u32, i64)]) -> PathRequest {
        PathRequest::new(
            PathRequestId::new(1),
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            zug,
            OperatingPointId::new(von),
            OperatingPointId::new(nach),
            halte
                .iter()
                .map(|(punkt, dauer)| {
                    RequestedStop::new(OperatingPointId::new(*punkt), *dauer)
                        .expect("gültiger Halt")
                })
                .collect(),
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::EXACT,
        )
        .expect("gültiger Antrag")
    }

    #[test]
    fn der_planner_findet_mehrere_laufwege() {
        let infra = reference_infrastructure();
        let laufwege =
            enumerate_itineraries(infra.graph(), &antrag(regional_train(), 1, 4, &[]), 32)
                .expect("mindestens ein Laufweg");

        assert!(laufwege.len() > 1, "nur ein einziger Laufwegkandidat");
        for laufweg in &laufwege {
            assert_eq!(laufweg.origin(), OperatingPointId::new(1));
            assert_eq!(laufweg.destination(), OperatingPointId::new(4));
        }
        // Kein Kandidat kommt doppelt vor.
        for (index, laufweg) in laufwege.iter().enumerate() {
            assert!(
                !laufwege
                    .iter()
                    .skip(index + 1)
                    .any(|andere| andere == laufweg),
                "ein Laufweg steht zweimal in der Liste"
            );
        }
    }

    #[test]
    fn die_kuerzesten_laufwege_stehen_vorn() {
        // Die Breitensuche findet kurze Folgen zuerst. Das ist der Grund, warum
        // der Deckel aus MAX_POINT_SEQUENCES kein willkürlicher Schnitt ist:
        // Was er abschneidet, sind die längeren Wege.
        let infra = reference_infrastructure();
        let laufwege =
            enumerate_itineraries(infra.graph(), &antrag(regional_train(), 1, 4, &[]), 32)
                .expect("Laufwege");
        let erster = laufwege[0].legs().len();
        for laufweg in &laufwege {
            assert!(
                laufweg.legs().len() >= erster,
                "ein kürzerer Laufweg steht hinter einem längeren"
            );
        }
    }

    #[test]
    fn die_aufzaehlung_ist_wiederholbar_und_gedeckelt() {
        let infra = reference_infrastructure();
        let antrag = antrag(regional_train(), 1, 4, &[]);
        let erste = enumerate_itineraries(infra.graph(), &antrag, 5).expect("Laufwege");
        let zweite = enumerate_itineraries(infra.graph(), &antrag, 5).expect("Laufwege");
        assert_eq!(erste, zweite);
        assert_eq!(erste.len(), 5);
    }

    #[test]
    fn ein_beantragter_halt_liegt_auf_jedem_kandidaten() {
        let infra = reference_infrastructure();
        let laufwege = enumerate_itineraries(
            infra.graph(),
            &antrag(regional_train(), 1, 4, &[(2, 30), (3, 60)]),
            16,
        )
        .expect("Laufwege");

        for laufweg in &laufwege {
            let halte: Vec<_> = laufweg.stops().collect();
            assert!(halte.contains(&OperatingPointId::new(2)), "{halte:?}");
            assert!(halte.contains(&OperatingPointId::new(3)), "{halte:?}");
            assert_eq!(laufweg.total_dwell_s(), 90);
        }
    }

    #[test]
    fn ein_halt_ohne_passenden_bahnsteig_ist_nicht_bedienbar() {
        // Die Bahnsteige des Beispielnetzes sind 140 m lang; ein 500 m langer
        // Güterzug passt an keinen. Ein Halt ohne Bahnsteig ist kein Halt.
        let infra = reference_infrastructure();
        let ergebnis = enumerate_itineraries(
            infra.graph(),
            &antrag(freight_train(), 1, 4, &[(2, 60)]),
            16,
        );
        assert!(
            matches!(ergebnis, Err(PlannerError::UnservableStop(punkt)) if punkt == OperatingPointId::new(2))
        );
    }

    #[test]
    fn ohne_halt_faehrt_auch_der_gueterzug() {
        let infra = reference_infrastructure();
        let laufwege = enumerate_itineraries(infra.graph(), &antrag(freight_train(), 1, 4, &[]), 8)
            .expect("Laufwege");
        assert!(!laufwege.is_empty());
    }

    #[test]
    fn ein_unerreichbares_ziel_meldet_keinen_laufweg() {
        let infra = reference_infrastructure();
        let antrag = PathRequest::new(
            PathRequestId::new(1),
            TrainNumber::new(TrainCategory::Regional, 26_802).expect("gültige Nummer"),
            regional_train(),
            OperatingPointId::new(1),
            OperatingPointId::new(99),
            Vec::new(),
            SimTime::from_seconds(28_800),
            OperatingDays::DAILY,
            PathTolerances::EXACT,
        )
        .expect("gültiger Antrag");
        assert!(matches!(
            enumerate_itineraries(infra.graph(), &antrag, 8),
            Err(PlannerError::NoRoute { .. })
        ));
    }
}
