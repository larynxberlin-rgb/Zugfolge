//! Das relative Belegungsprofil und seine Ableitung — **M3.1** und **M3.2**.
//!
//! `docs/infrastruktur.md` 5 verlangt, wiederkehrenden Verkehr als
//! `ServicePattern` **plus relativem `OccupationProfile`** zu speichern. Der
//! Grund ist Rechenlast: Ein Verkehrsangebot fährt in einer Fahrplanperiode
//! dutzende Male, und die Sperrzeiten sind an jedem dieser Tage dieselben — nur
//! um eine Zeitlage verschoben. Wer sie je Verkehrstag neu rechnet, rechnet
//! dasselbe hundertfach.
//!
//! Deshalb rechnet [`derive_occupation_profile`] **einmal** und relativ zur
//! Abfahrt. Was daraus wird — eine Sperrzeitentreppe an einem konkreten Tag —
//! ist eine Addition, keine zweite Rechnung. Genau das macht den Planner aus
//! M3.4 bezahlbar: Er probiert Zeitlagen aus, und jede kostet ihn eine
//! Verschiebung statt einer Fahrdynamikrechnung.
//!
//! ## Das Verfahren
//!
//! 1. **Ressourcen auflegen.** Jeder Abschnitt des Laufwegs liefert seine
//!    Konfliktressourcen ([`crate::infrastructure::Infrastructure::spans_of`]),
//!    umgerechnet auf eine durchlaufende Position entlang des Laufwegs.
//! 2. **Fahrweg schneiden.** Der `RunPath` (M1.10) wird an jeder
//!    Ressourcengrenze geschnitten — und zusätzlich dort, wo ein
//!    Annäherungsabschnitt beginnt und wo eine Räumfahrt endet. Dadurch liegt
//!    für jeden gebrauchten Zeitpunkt ein Stützpunkt der Fahrzeittabelle vor
//!    und muss nirgends interpoliert werden.
//! 3. **Fahrzeit rechnen.** Zwischen zwei Halten ist der Laufweg ein
//!    Fahrabschnitt, der aus dem Stand beginnt und im Stand endet
//!    (`derive_running_time_table_with_exit`, M1.10).
//! 4. **Anteile zusammensetzen.** Aus Ankunfts- und Abfahrtszeit je Position
//!    und den Parametern der Betriebsstelle (M3.1) entstehen die sechs Anteile
//!    jeder Sperrzeit.
//!
//! ## Zwei bewusste Vereinfachungen
//!
//! **Der Halt liegt am Ende des Bahnhofsgleises.** Das Bahnhofsgleis ist über
//! die ganze Haltezeit eine einzige Konfliktressource; wo genau am Bahnsteig
//! der Zug steht, ändert daran nichts, sondern nur die Ankunftszeit um wenige
//! Sekunden. Die Formation und mit ihr die Halteposition kommen in M5.
//!
//! **Die Fahrstraße wird für die Dauer des Bahnhofsgleises belegt.** Genauer
//! wäre: von der Fahrstraßenbildung bis zum Räumen des Kopfs. Solange die
//! Zuordnung von Fahrstraße zu Bahnsteiggleis aus keiner freigegebenen Quelle
//! kommt (`docs/rechte.md`), wäre jede feinere Angabe erfunden. Die
//! Ausschlussmenge wirkt trotzdem vollständig — und das war die Lücke des
//! Spikes aus M0.3.

use std::collections::{BTreeMap, BTreeSet};

use zugfolge_determinism::{SimTime, StateHasher};
use zugfolge_infra::{
    Length, OperatingPointId, RunPath, TrackId, TrainCharacteristics, TravelDirection,
    derive_running_time_table_with_exit,
};

use crate::blocking::{BlockingTimeStaircase, RelativeOccupation};
use crate::error::ConflictError;
use crate::infrastructure::Infrastructure;
use crate::itinerary::Itinerary;
use crate::resource::ConflictResource;

/// Die relative Belegung der Konfliktressourcen eines Laufwegs.
///
/// Unabhängig vom Verkehrstag: Alle Zeiten zählen ab der Abfahrt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OccupationProfile {
    occupations: Vec<RelativeOccupation>,
    running_time_s: i64,
    length: Length,
    station_calls: Vec<RelativeStationCall>,
}

/// Fahrdynamisch berechnete Ankunft und Abfahrt einer Betriebsstelle.
/// Die Fachschicht entscheidet, welche dieser Stellen Verkehrshalte sind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelativeStationCall {
    /// Betriebsstelle im geprüften Laufweg.
    pub station: OperatingPointId,
    /// Ankunft in Sekunden ab Abfahrt des Zuglaufs.
    pub arrival_s: i64,
    /// Abfahrt einschließlich der tatsächlichen Haltezeit.
    pub departure_s: i64,
}

impl OccupationProfile {
    /// Betriebsstellenzeiten aus derselben Zeitachse wie die Sperrzeiten.
    pub fn station_calls(&self) -> &[RelativeStationCall] {
        &self.station_calls
    }

    /// Die Belegungen in Fahrtreihenfolge.
    pub fn occupations(&self) -> &[RelativeOccupation] {
        &self.occupations
    }

    /// Die reine Fahr- und Haltezeit von der Abfahrt bis zur Ankunft, in
    /// Sekunden — ohne Räum- und Auflösezeit der letzten Ressource.
    pub const fn running_time_s(&self) -> i64 {
        self.running_time_s
    }

    /// Die Länge des Laufwegs.
    pub const fn length(&self) -> Length {
        self.length
    }

    /// Die früheste belegte Sekunde, relativ zur Abfahrt — in aller Regel
    /// negativ, weil die erste Fahrstraße vor der Abfahrt gestellt wird.
    pub fn first_second_s(&self) -> i64 {
        self.occupations
            .iter()
            .map(RelativeOccupation::start_s)
            .min()
            .unwrap_or(0)
    }

    /// Die letzte belegte Sekunde, relativ zur Abfahrt.
    pub fn last_second_s(&self) -> i64 {
        self.occupations
            .iter()
            .map(RelativeOccupation::end_s)
            .max()
            .unwrap_or(0)
    }

    /// Die belegten Konfliktressourcen, ohne Wiederholung.
    pub fn resources(&self) -> BTreeSet<ConflictResource> {
        self.occupations
            .iter()
            .map(RelativeOccupation::resource)
            .collect()
    }

    /// Macht aus dem Profil die Sperrzeitentreppe eines Verkehrstags.
    pub fn at(&self, departure: SimTime) -> BlockingTimeStaircase {
        BlockingTimeStaircase::new(
            departure,
            self.occupations
                .iter()
                .map(|belegung| belegung.at(departure))
                .collect(),
        )
    }

    /// Schreibt das Profil in den Zustands-Hash.
    pub(crate) fn write_canonical(&self, hasher: &mut StateHasher) {
        hasher.int("running_time_s", self.running_time_s);
        hasher.int("length_mm", self.length.millimetres());
        hasher.seq("occupations", self.occupations.len());
        for belegung in &self.occupations {
            belegung.write_canonical(hasher);
        }
    }
}

/// Ein Anspruch auf eine Konfliktressource, mit seiner Lage entlang des
/// Laufwegs.
#[derive(Clone, Copy, Debug)]
struct Claim {
    resource: ConflictResource,
    direction: TravelDirection,
    governing_point: zugfolge_infra::OperatingPointId,
    from: Length,
    to: Length,
}

/// Rechnet das relative Belegungsprofil eines Laufwegs.
///
/// # Errors
///
/// - [`ConflictError::UnknownTrack`], wenn der Laufweg ein Gleis nennt, das die
///   Infrastruktur nicht kennt.
/// - [`ConflictError::Infra`], wenn die Fahrdynamik den Fahrweg zurückweist —
///   unpassende Zugsicherung, unpassende Antriebsart, zu steile Neigung.
pub fn derive_occupation_profile(
    infrastructure: &Infrastructure,
    itinerary: &Itinerary,
    train: &TrainCharacteristics,
) -> Result<OccupationProfile, ConflictError> {
    let claims = anspruechen(infrastructure, itinerary, train)?;
    let total = itinerary.length();

    let schnitte = schnittpunkte(infrastructure, train, &claims, total);
    let halte = haltepositionen(itinerary);
    let zeitachse = zeitachse(infrastructure, itinerary, train, &schnitte, &halte)?;

    let mut occupations = Vec::with_capacity(claims.len());
    for claim in &claims {
        let parameter = infrastructure.signalling().at(claim.governing_point);

        let entry_s = zeitachse.departure(claim.from);
        let travel_end_s = zeitachse.arrival(claim.to);
        let exit_s = zeitachse.departure(claim.to);

        // Die letzte Ressource eines Laufwegs kennt keine Räumfahrt: Der Zug
        // verlässt den Laufweg nicht, er endet auf ihm.
        let cleared_s = if claim.to >= total {
            exit_s
        } else {
            let raeumweg = claim.to + train.length() + parameter.overlap_length();
            let ziel = if raeumweg > total { total } else { raeumweg };
            exit_s.max(zeitachse.arrival(ziel))
        };
        let end_s = cleared_s.saturating_add(parameter.route_release_time_s());

        let annaeherung = claim.from - parameter.approach_distance();
        let annaeherung = if annaeherung.is_negative() {
            Length::ZERO
        } else {
            annaeherung
        };
        // Ein stehender Zug nähert sich dem Ausfahrsignal nicht: Die
        // Annäherungsfahrt beginnt frühestens, wenn der Zug wieder losfährt.
        let approach_start_s = zeitachse
            .arrival(annaeherung)
            .max(zeitachse.motion_start(claim.from));
        let sighting_s = approach_start_s.saturating_sub(parameter.signal_sighting_time_s());
        let start_s = sighting_s.saturating_sub(parameter.route_setting_time_s());

        let belegung = RelativeOccupation::new(
            claim.resource,
            claim.direction,
            claim.governing_point,
            start_s,
            sighting_s,
            approach_start_s,
            entry_s,
            travel_end_s,
            exit_s,
            cleared_s,
            end_s,
        );
        debug_assert!(
            belegung.is_ordered(),
            "die Anteile der Sperrzeit stehen nicht in zeitlicher Reihenfolge"
        );
        occupations.push(belegung);
    }

    let mut station_calls = vec![RelativeStationCall {
        station: itinerary.origin(),
        arrival_s: 0,
        departure_s: 0,
    }];
    let mut position = Length::ZERO;
    for (index, leg) in itinerary.legs().iter().enumerate() {
        position = position + leg.length();
        if index > 0 && leg.is_in_station() {
            station_calls.push(RelativeStationCall {
                station: leg.to(),
                arrival_s: zeitachse.arrival(position),
                departure_s: zeitachse.departure(position),
            });
        }
    }

    Ok(OccupationProfile {
        occupations,
        running_time_s: zeitachse.arrival(total),
        length: total,
        station_calls,
    })
}

/// Legt die Ressourcenansprüche des Laufwegs mit ihrer Lage entlang des
/// Laufwegs auf.
fn anspruechen(
    infrastructure: &Infrastructure,
    itinerary: &Itinerary,
    train: &TrainCharacteristics,
) -> Result<Vec<Claim>, ConflictError> {
    let mut claims: Vec<Claim> = Vec::new();
    let mut offset = Length::ZERO;

    for leg in itinerary.legs() {
        let spans = infrastructure.spans_of_for_train(leg.track(), train)?;
        let laenge = leg.length();

        let mut eigene: Vec<Claim> = spans
            .iter()
            .map(|span| {
                let (von, bis) = match leg.direction() {
                    TravelDirection::WithChainage => (span.start(), span.end()),
                    TravelDirection::AgainstChainage => {
                        (laenge - span.end(), laenge - span.start())
                    }
                };
                Claim {
                    resource: span.resource(),
                    direction: leg.direction(),
                    governing_point: leg.governing_point(),
                    from: offset + von,
                    to: offset + bis,
                }
            })
            .collect();
        eigene.sort_by_key(|claim| claim.from);

        // Die Fahrstraße des Bahnhofskopfs belegt denselben Bereich wie das
        // Gleis, an dem sie hängt.
        if let Some(route) = leg.route() {
            eigene.push(Claim {
                resource: ConflictResource::Route {
                    point: leg.governing_point(),
                    route,
                },
                direction: leg.direction(),
                governing_point: leg.governing_point(),
                from: offset,
                to: offset + laenge,
            });
        }

        claims.append(&mut eigene);
        offset = offset + laenge;
    }

    Ok(claims)
}

/// Alle Positionen, an denen die Fahrzeittabelle einen Stützpunkt braucht.
fn schnittpunkte(
    infrastructure: &Infrastructure,
    train: &TrainCharacteristics,
    claims: &[Claim],
    total: Length,
) -> BTreeSet<Length> {
    let mut punkte: BTreeSet<Length> = BTreeSet::new();
    punkte.insert(Length::ZERO);
    punkte.insert(total);

    let mut merke = |position: Length| {
        if position.is_positive() && position < total {
            punkte.insert(position);
        }
    };

    for claim in claims {
        let parameter = infrastructure.signalling().at(claim.governing_point);
        merke(claim.from);
        merke(claim.to);
        merke(claim.from - parameter.approach_distance());
        merke(claim.to + train.length() + parameter.overlap_length());
    }

    punkte
}

/// Die Positionen, an denen der Zug hält, mit ihrer Haltezeit.
fn haltepositionen(itinerary: &Itinerary) -> Vec<(Length, i64)> {
    let mut halte = Vec::new();
    let mut offset = Length::ZERO;
    for leg in itinerary.legs() {
        offset = offset + leg.length();
        if leg.dwell_s() > 0 {
            halte.push((offset, leg.dwell_s()));
        }
    }
    halte
}

/// Die Zeitachse einer Fahrt: zu jeder Stützstelle die Ankunfts- und die
/// Abfahrtszeit, in Sekunden ab der Abfahrt.
struct Timeline {
    arrival: BTreeMap<Length, i64>,
    departure: BTreeMap<Length, i64>,
    stops: Vec<(Length, i64)>,
}

impl Timeline {
    /// Die Ankunftszeit an einer Position: der Zeitpunkt, zu dem die Spitze sie
    /// erreicht.
    ///
    /// Positionen zwischen zwei Stützstellen gibt es nicht — der Fahrweg wurde
    /// an jeder gebrauchten Stelle geschnitten. Trifft es doch einmal zu, gilt
    /// die nächstgelegene vorherige Stützstelle; das ist die Zeit der sicheren
    /// Seite, weil sie die Sperrzeit eher verlängert.
    fn arrival(&self, position: Length) -> i64 {
        debug_assert!(
            self.arrival.contains_key(&position),
            "die Zeitachse hat an {position} keine Stützstelle — der Fahrweg wurde \
             nicht an jeder gebrauchten Stelle geschnitten"
        );
        self.arrival
            .get(&position)
            .copied()
            .or_else(|| {
                self.arrival
                    .range(..=position)
                    .next_back()
                    .map(|(_, zeit)| *zeit)
            })
            .unwrap_or(0)
    }

    /// Die Abfahrtszeit an einer Position: der Zeitpunkt, zu dem die Spitze sie
    /// verlässt. An einer Halteposition ist das die Ankunft plus Haltezeit.
    fn departure(&self, position: Length) -> i64 {
        self.departure
            .get(&position)
            .copied()
            .unwrap_or_else(|| self.arrival(position))
    }

    /// Der Zeitpunkt, zu dem der Zug vor dieser Position zuletzt losgefahren
    /// ist — die Abfahrt selbst, wenn er seither nicht gehalten hat.
    fn motion_start(&self, position: Length) -> i64 {
        self.stops
            .iter()
            .rfind(|(halt, _)| *halt <= position)
            .map_or(0, |(halt, _)| self.departure(*halt))
    }
}

/// Rechnet die Zeitachse einer Fahrt: je Fahrabschnitt zwischen zwei Halten
/// eine Fahrzeittabelle, aneinandergehängt.
fn zeitachse(
    infrastructure: &Infrastructure,
    itinerary: &Itinerary,
    train: &TrainCharacteristics,
    schnitte: &BTreeSet<Length>,
    halte: &[(Length, i64)],
) -> Result<Timeline, ConflictError> {
    let total = itinerary.length();
    let mut grenzen: Vec<Length> = vec![Length::ZERO];
    grenzen.extend(halte.iter().map(|(position, _)| *position));
    if grenzen.last().copied() != Some(total) {
        grenzen.push(total);
    }

    let mut arrival: BTreeMap<Length, i64> = BTreeMap::new();
    let mut departure: BTreeMap<Length, i64> = BTreeMap::new();
    arrival.insert(Length::ZERO, 0);
    departure.insert(Length::ZERO, 0);

    let mut abschnittsbeginn = 0_i64;
    for fenster in grenzen.windows(2) {
        let [von, bis] = fenster else { continue };
        let (von, bis) = (*von, *bis);
        if von >= bis {
            continue;
        }

        let fahrweg = fahrweg(infrastructure, itinerary, train, schnitte, von, bis)?;
        let tabelle = derive_running_time_table_with_exit(
            &fahrweg,
            train,
            zugfolge_infra::Speed::ZERO,
            zugfolge_infra::Speed::ZERO,
        )?;

        for checkpoint in tabelle.checkpoints() {
            let position = von + checkpoint.position();
            let zeit = abschnittsbeginn.saturating_add(checkpoint.elapsed().seconds());
            arrival.entry(position).or_insert(zeit);
            departure.insert(position, zeit);
        }

        let ankunft = abschnittsbeginn.saturating_add(tabelle.total().seconds());
        let haltezeit = halte
            .iter()
            .find(|(position, _)| *position == bis)
            .map_or(0, |(_, dauer)| *dauer);
        arrival.entry(bis).or_insert(ankunft);
        departure.insert(bis, ankunft.saturating_add(haltezeit));
        abschnittsbeginn = ankunft.saturating_add(haltezeit);
    }

    Ok(Timeline {
        arrival,
        departure,
        stops: halte.to_vec(),
    })
}

/// Baut den Fahrweg eines Fahrabschnitts, geschnitten an allen Stützstellen.
fn fahrweg(
    infrastructure: &Infrastructure,
    itinerary: &Itinerary,
    train: &TrainCharacteristics,
    schnitte: &BTreeSet<Length>,
    von: Length,
    bis: Length,
) -> Result<RunPath, ConflictError> {
    let mut pfad = RunPath::new();
    let mut offset = Length::ZERO;

    for leg in itinerary.legs() {
        let leg_von = offset;
        let leg_bis = offset + leg.length();
        offset = leg_bis;

        let lo = if leg_von > von { leg_von } else { von };
        let hi = if leg_bis < bis { leg_bis } else { bis };
        if lo >= hi {
            continue;
        }

        let mut punkte: Vec<Length> = vec![lo];
        punkte.extend(schnitte.range(lo..hi).copied().filter(|punkt| *punkt > lo));
        punkte.push(hi);
        punkte.dedup();

        let track = infrastructure.track(leg.track())?;
        for paar in punkte.windows(2) {
            let [p, q] = paar else { continue };
            let (lokal_von, lokal_bis) = lokal(leg.direction(), leg_von, leg.length(), *p, *q);
            pfad.push_track_range(train, track, leg.direction(), lokal_von, lokal_bis)?;
        }
    }

    Ok(pfad)
}

/// Rechnet einen Bereich des Laufwegs in Positionen entlang der Kilometrierung
/// des befahrenen Gleises um.
fn lokal(
    direction: TravelDirection,
    leg_start: Length,
    leg_length: Length,
    from: Length,
    to: Length,
) -> (Length, Length) {
    match direction {
        TravelDirection::WithChainage => (from - leg_start, to - leg_start),
        TravelDirection::AgainstChainage => (
            leg_length - (to - leg_start),
            leg_length - (from - leg_start),
        ),
    }
}

/// Die Konfliktressourcen eines Gleises, wie sie ein Laufweg sieht — für
/// Berichte und Prüfungen.
pub fn resources_of(
    infrastructure: &Infrastructure,
    track: TrackId,
) -> Result<Vec<ConflictResource>, ConflictError> {
    Ok(infrastructure
        .spans_of(track)?
        .into_iter()
        .map(|span| span.resource())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{derive_occupation_profile, resources_of};
    use crate::blocking::BlockingPhase;
    use crate::example::{nordstadt_bis_talheim, reference_infrastructure, regional_train};
    use crate::itinerary::{Itinerary, ItineraryLeg};
    use zugfolge_determinism::SimTime;
    use zugfolge_infra::{TrackId, TravelDirection};

    #[test]
    fn die_sperrzeit_umschliesst_die_fahrzeit_auf_jeder_ressource() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");

        assert!(!profil.occupations().is_empty());
        for belegung in profil.occupations() {
            assert!(belegung.is_ordered(), "{belegung:?}");
            assert!(
                belegung.duration_s() > 0,
                "eine Sperrzeit ohne Dauer: {belegung:?}"
            );
        }
    }

    #[test]
    fn die_stufen_bilden_eine_treppe() {
        // Die Treppe steigt in der **Fahrt**: Jede Stufe wird später befahren
        // und später geräumt als die vorige.
        //
        // Sie steigt ausdrücklich **nicht** zwingend im Beginn der Sperrzeit:
        // Ein langsameres Stellwerk stellt seinen Fahrweg früher, seine
        // Sperrzeit beginnt also eher — genau das ist der Unterschied zur
        // netzweiten Konstante des Spikes aus M0.3.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");

        for paar in profil.occupations().windows(2) {
            assert!(
                paar[0].entry_s() <= paar[1].entry_s(),
                "{:?} vor {:?}",
                paar[0],
                paar[1]
            );
            assert!(paar[0].end_s() <= paar[1].end_s());
        }
    }

    #[test]
    fn ein_langsameres_stellwerk_beginnt_seine_sperrzeit_frueher() {
        // Talheim hat im Beispielaufbau ein mechanisches Stellwerk, der Rest
        // des Netzes elektronische. Die Sperrzeit des Talheimer Gleises muss
        // deshalb deutlich vor der Einfahrt beginnen — das ist die Wirkung von
        // M3.1 gegenüber der netzweiten Konstante des Spikes.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");

        let letzte = *profil.occupations().last().expect("mindestens eine Stufe");
        let talheim = infra.signalling().at(laufweg.destination());
        let elektronisch = infra.signalling().default_parameters();
        assert!(talheim.route_setting_time_s() > elektronisch.route_setting_time_s());
        assert_eq!(
            letzte.approach_start_s() - letzte.start_s(),
            talheim.route_setting_time_s() + talheim.signal_sighting_time_s()
        );
    }

    #[test]
    fn aufeinanderfolgende_stufen_ueberschneiden_sich() {
        // Genau diese Überschneidung ist der Grund, warum ein zweiter Zug nicht
        // beliebig dicht folgen darf.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let treppe = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil")
            .at(SimTime::from_seconds(28_800));

        let ueberschneidungen = treppe
            .steps()
            .windows(2)
            .filter(|paar| paar[0].overlaps(&paar[1]))
            .count();
        assert!(
            ueberschneidungen > 0,
            "keine einzige Stufe überschneidet ihre Nachfolgerin"
        );
    }

    #[test]
    fn die_sperrzeit_beginnt_nicht_vor_der_abfahrt() {
        // Ein Zug, der im Bahnhof steht, nähert sich dem Ausfahrsignal nicht.
        // Ohne diese Klammer begänne die Sperrzeit des ersten Streckenblocks
        // vor der Abfahrt.
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");

        let erste = profil.occupations()[0];
        let parameter = infra.signalling().at(laufweg.origin());
        // Nur Fahrstraßenbildung und Signalsichtzeit liegen vor der Abfahrt.
        assert_eq!(
            erste.start_s(),
            -parameter.signal_sighting_time_s() - parameter.route_setting_time_s()
        );
        let (phase, von, bis) = erste.phases()[2];
        assert_eq!(phase, BlockingPhase::Approach);
        assert_eq!(von, bis, "die Annäherungsfahrt hat die Länge null");
    }

    #[test]
    fn die_haltezeit_verlaengert_die_sperrzeit_des_bahnsteiggleises() {
        // Verglichen werden zwei **haltende** Fahrten, nicht Halt gegen
        // Durchfahrt: Ein zusätzlicher Halt ändert auch die Fahrdynamik, weil
        // der Zug bremst und wieder anfährt. Eine längere Haltezeit ändert
        // ausschließlich die Standzeit — und genau um sie muss die Sperrzeit
        // des Gleises wachsen, auf dem der Zug steht.
        let infra = reference_infrastructure();
        let zug = regional_train();
        let bauen = |haltezeit: i64| {
            Itinerary::new(
                infra.graph(),
                vec![
                    ItineraryLeg::new(TrackId::new(101), TravelDirection::WithChainage)
                        .with_dwell(haltezeit),
                    ItineraryLeg::new(TrackId::new(1001), TravelDirection::WithChainage),
                    ItineraryLeg::new(TrackId::new(201), TravelDirection::WithChainage),
                ],
            )
            .expect("gültiger Laufweg")
        };

        let kurz = derive_occupation_profile(&infra, &bauen(30), &zug).expect("gültig");
        let lang = derive_occupation_profile(&infra, &bauen(120), &zug).expect("gültig");
        assert_eq!(
            lang.occupations()[0].duration_s() - kurz.occupations()[0].duration_s(),
            90,
            "die Haltezeit gehört zur Sperrzeit des Gleises, auf dem der Zug steht"
        );
        assert_eq!(lang.running_time_s() - kurz.running_time_s(), 90);
    }

    #[test]
    fn ein_profil_ist_wiederholbar() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let zug = regional_train();
        assert_eq!(
            derive_occupation_profile(&infra, &laufweg, &zug).expect("gültig"),
            derive_occupation_profile(&infra, &laufweg, &zug).expect("gültig")
        );
    }

    #[test]
    fn das_profil_belegt_jede_ressource_seines_laufwegs() {
        let infra = reference_infrastructure();
        let laufweg = nordstadt_bis_talheim(&infra);
        let profil = derive_occupation_profile(&infra, &laufweg, &regional_train())
            .expect("gültiges Profil");
        let belegt = profil.resources();

        for leg in laufweg.legs() {
            for ressource in resources_of(&infra, leg.track()).expect("bekanntes Gleis") {
                assert!(
                    belegt.contains(&ressource),
                    "{ressource} bleibt unbelegt, obwohl der Laufweg darüber führt"
                );
            }
        }
    }
}
