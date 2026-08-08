//! Ein Beispielaufbau — die Prüfstrecke der Konfliktengine.
//!
//! **Die Daten sind erfunden.** Sie setzen das Beispielnetz aus M1.1
//! (`zugfolge_infra::reference_network`) fort und ergänzen, was die
//! Konfliktengine zusätzlich braucht: eine Blockteilung der Streckengleise
//! (M1.6), einen Bahnhofskopf mit Fahrstraßen und Ausschlussmengen (M1.7) und
//! Sperrzeitparameter je Betriebsstelle (M3.1).
//!
//! Der Aufbau ist so gewählt, dass er beide Konfliktarten trägt: Die
//! zweigleisige Hauptstrecke hat Richtungsgleise, der Ast nach Talheim ist
//! eingleisig und gehört beiden Richtungen. Genau daraus entstehen
//! Zugfolgefall und Gegenfahrt, ohne dass der Prüfer sie unterscheiden müsste.
//!
//! Er ist öffentlich, weil der Planner (M3.4) und seine Tests denselben Aufbau
//! brauchen — wie `reference_network` in M1.1.

use zugfolge_infra::{Acceleration, Confidence, HeadSignal};
use zugfolge_infra::{
    DEFAULT_MAX_BLOCK_LENGTH, HeadElement, HeadElementId, HeadNode, HeadNodeId, HeadNodeKind,
    HeadSignalId, InterlockingPlan, Length, Mass, OperatingPointId, ProtectionSystem, Provenance,
    Signal, SourceId, Speed, SpeedCategory, StationHead, Switch, SwitchId, TrackId, TractionType,
    TrainCharacteristics, TrainCharacteristicsId, TrainProtection, TravelDirection,
    derive_block_sections, derive_interlocking_routes, reference_network,
};

use crate::infrastructure::Infrastructure;
use crate::itinerary::{Itinerary, ItineraryLeg};
use crate::signalling::{InterlockingKind, SignallingModel, SignallingParameters};

/// Die Herkunft aller Angaben des Beispielaufbaus.
///
/// Die Quellenkennung `beispielnetz` steht bewusst **nicht** im
/// Quellenregister: Hier wurde nichts importiert, es gibt also nichts
/// freizugeben (Invariante 8).
fn herkunft() -> Provenance {
    Provenance::new(
        SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
        Confidence::Surveyed,
    )
}

/// Ein Regionaltriebwagen: 140 m lang, 140 km/h schnell, Diesel, PZB.
///
/// Diesel und PZB, damit er den ganzen Korridor befahren kann — der Ast nach
/// Talheim hat weder Fahrdraht noch LZB.
///
/// # Panics
///
/// Nie im Normalfall; die Werte sind fest verdrahtet und gültig.
pub fn regional_train() -> TrainCharacteristics {
    TrainCharacteristics::new(
        TrainCharacteristicsId::new(1),
        "Regionaltriebwagen",
        Mass::from_tonnes(120),
        Length::from_metres(140),
        Speed::from_km_h(140),
        SpeedCategory::Standard,
        Acceleration::from_millimetres_per_second_squared(600),
        Acceleration::from_millimetres_per_second_squared(800),
        TractionType::Diesel,
        TrainProtection::single(ProtectionSystem::Pzb),
    )
    .expect("gültige Zugcharakteristik")
}

/// Ein schwerer, langsamer Güterzug: 500 m lang, 100 km/h, träge.
///
/// Er dient dem Nachweis, dass Sperrzeiten von der Zugcharakteristik abhängen
/// und nicht bloß vom Netz.
///
/// # Panics
///
/// Nie im Normalfall; die Werte sind fest verdrahtet und gültig.
pub fn freight_train() -> TrainCharacteristics {
    TrainCharacteristics::new(
        TrainCharacteristicsId::new(2),
        "Güterzug",
        Mass::from_tonnes(1_400),
        Length::from_metres(500),
        Speed::from_km_h(100),
        SpeedCategory::Freight,
        Acceleration::from_millimetres_per_second_squared(200),
        Acceleration::from_millimetres_per_second_squared(400),
        TractionType::Diesel,
        TrainProtection::single(ProtectionSystem::Pzb),
    )
    .expect("gültige Zugcharakteristik")
}

/// Die Hauptsignale eines Streckengleises, alle 2000 m.
fn hauptsignale(laenge_m: i64) -> Vec<Signal> {
    let mut signale = Vec::new();
    let mut position = 2_000_i64;
    while position < laenge_m {
        signale.push(Signal::main(Length::from_metres(position)));
        position = position.saturating_add(2_000);
    }
    signale
}

/// Der Bahnhofskopf einer Betriebsstelle: zwei Streckengleise, zwei
/// Bahnsteiggleise und eine Verbindung dazwischen.
///
/// ```text
///   LWa ─eWa─ (W1) ─e1─ P1        LWb ─eWb─ (W2) ─e2─ P2
///                  \                            /
///                   ╰────────── eC ────────────╯
/// ```
///
/// Die Verbindung `eC` ist der Grund, warum es Ausschlussmengen braucht: Eine
/// Fahrt von `LWa` nach `P2` und eine von `LWb` nach `P1` benutzen
/// verschiedene Bahnsteiggleise und schließen einander trotzdem aus.
///
/// # Panics
///
/// Nie im Normalfall; der Kopf ist fest verdrahtet und gültig.
pub fn reference_station_head(point: OperatingPointId) -> StationHead {
    let node = |id: u32, kind: HeadNodeKind| HeadNode::new(HeadNodeId::new(id), kind);
    let element = |id: u32, from: u32, to: u32, laenge_m: i64| {
        HeadElement::new(
            HeadElementId::new(id),
            HeadNodeId::new(from),
            HeadNodeId::new(to),
            Length::from_metres(laenge_m),
        )
        .expect("gültiges Fahrwegelement")
    };
    let signal = |id: u32, node: u32, element: u32| {
        HeadSignal::new(
            HeadSignalId::new(id),
            HeadNodeId::new(node),
            HeadElementId::new(element),
        )
    };

    StationHead::builder(point, herkunft())
        .node(node(1, HeadNodeKind::Terminus))
        .node(node(2, HeadNodeKind::Terminus))
        .node(node(3, HeadNodeKind::Switch))
        .node(node(4, HeadNodeKind::Switch))
        .node(node(5, HeadNodeKind::Terminus))
        .node(node(6, HeadNodeKind::Terminus))
        .element(element(10, 1, 3, 300))
        .element(element(11, 2, 4, 300))
        .element(element(12, 3, 5, 400))
        .element(element(13, 4, 6, 400))
        .element(element(14, 3, 4, 120))
        .switch(Switch::new(
            SwitchId::new(1),
            HeadNodeId::new(3),
            HeadElementId::new(10),
            HeadElementId::new(12),
            HeadElementId::new(14),
        ))
        .switch(Switch::new(
            SwitchId::new(2),
            HeadNodeId::new(4),
            HeadElementId::new(11),
            HeadElementId::new(13),
            HeadElementId::new(14),
        ))
        .signal(signal(1, 1, 10))
        .signal(signal(2, 2, 11))
        .build()
        .expect("gültiger Bahnhofskopf")
}

/// Der Fahrstraßenplan eines Bahnhofskopfs (M1.7).
///
/// # Panics
///
/// Nie im Normalfall; der Kopf ist fest verdrahtet und gültig.
pub fn reference_interlocking_plan(point: OperatingPointId) -> InterlockingPlan {
    derive_interlocking_routes(&reference_station_head(point), Length::from_metres(200))
        .expect("gültige Fahrstraßenableitung")
}

/// Der Beispielaufbau: Betriebsgraph, Blockteilung, Bahnhofskopf und
/// Sperrzeitparameter.
///
/// Talheim trägt bewusst ein **mechanisches Stellwerk** — damit der Aufbau
/// zeigt, dass die Sperrzeitparameter je Betriebsstelle gelten und nicht
/// netzweit (M3.1).
///
/// # Panics
///
/// Nie im Normalfall; alle Werte sind fest verdrahtet und geprüft.
pub fn reference_infrastructure() -> Infrastructure {
    let netz = reference_network();
    let quelle = SourceId::new("beispielnetz").expect("gültige Quellenkennung");

    let mut builder = Infrastructure::builder(netz.clone());
    for (id, laenge_m) in [
        (1001_u32, 5_000_i64),
        (1002, 5_000),
        (2001, 7_000),
        (2002, 7_000),
        (3001, 9_000),
    ] {
        let gleis = netz
            .track(TrackId::new(id))
            .expect("Gleis des Beispielnetzes");
        let abschnitte = derive_block_sections(
            gleis,
            &hauptsignale(laenge_m),
            DEFAULT_MAX_BLOCK_LENGTH,
            quelle.clone(),
        )
        .expect("gültige Blockableitung");
        builder = builder.blocks(TrackId::new(id), abschnitte);
    }

    let mechanisch = SignallingParameters::new(
        InterlockingKind::Mechanical,
        8,
        Length::from_metres(700),
        Length::from_metres(100),
    )
    .expect("gültige Parameter");

    builder
        .interlocking(reference_interlocking_plan(OperatingPointId::new(3)))
        .signalling(SignallingModel::default().with_point(OperatingPointId::new(4), mechanisch))
        .build()
        .expect("gültiger Beispielaufbau")
}

/// Der Laufweg Nordstadt – Talheim über Gleis 1, mit Halt in Waldhof und
/// Sandberg.
///
/// # Panics
///
/// Nie im Normalfall; der Laufweg ist fest verdrahtet und gültig.
pub fn nordstadt_bis_talheim(infrastructure: &Infrastructure) -> Itinerary {
    let hin = |track: u32| ItineraryLeg::new(TrackId::new(track), TravelDirection::WithChainage);
    Itinerary::new(
        infrastructure.graph(),
        vec![
            hin(101),
            hin(1001),
            hin(201).with_dwell(30),
            hin(2001),
            hin(301).with_dwell(60),
            hin(3001),
            hin(401),
        ],
    )
    .expect("gültiger Laufweg")
}

/// Der Laufweg Talheim – Nordstadt, die Gegenrichtung.
///
/// # Panics
///
/// Nie im Normalfall; der Laufweg ist fest verdrahtet und gültig.
pub fn talheim_bis_nordstadt(infrastructure: &Infrastructure) -> Itinerary {
    let bahnhof =
        |track: u32| ItineraryLeg::new(TrackId::new(track), TravelDirection::AgainstChainage);
    Itinerary::new(
        infrastructure.graph(),
        vec![
            bahnhof(402),
            bahnhof(3001),
            bahnhof(302).with_dwell(60),
            bahnhof(2002),
            bahnhof(202).with_dwell(30),
            bahnhof(1002),
            bahnhof(102),
        ],
    )
    .expect("gültiger Laufweg")
}

#[cfg(test)]
mod tests {
    use super::{
        freight_train, nordstadt_bis_talheim, reference_infrastructure,
        reference_interlocking_plan, regional_train, talheim_bis_nordstadt,
    };
    use zugfolge_infra::{OperatingPointId, TrackId};

    #[test]
    fn die_streckengleise_sind_in_bloecke_geteilt() {
        let infra = reference_infrastructure();
        // 5000 m mit Hauptsignalen bei 2000 und 4000 ⇒ drei Blöcke.
        assert_eq!(infra.block_count(TrackId::new(1001)), 3);
        // 9000 m mit Signalen alle 2000 m ⇒ fünf Blöcke.
        assert_eq!(infra.block_count(TrackId::new(3001)), 5);
        // Bahnhofsgleise bekommen keine Blockteilung.
        assert_eq!(infra.block_count(TrackId::new(101)), 0);
    }

    #[test]
    fn der_bahnhofskopf_liefert_ausschlussmengen() {
        let plan = reference_interlocking_plan(OperatingPointId::new(3));
        assert_eq!(plan.route_count(), 4);
        assert!(
            plan.routes().any(|route| !route.excludes().is_empty()),
            "kein einziger Fahrstraßenausschluss"
        );
    }

    #[test]
    fn beide_laufwege_haengen_zusammen() {
        let infra = reference_infrastructure();
        let hin = nordstadt_bis_talheim(&infra);
        let zurueck = talheim_bis_nordstadt(&infra);
        assert_eq!(hin.origin(), zurueck.destination());
        assert_eq!(hin.destination(), zurueck.origin());
        assert_eq!(hin.length(), zurueck.length());
    }

    #[test]
    fn der_gueterzug_ist_langsamer_und_laenger() {
        assert!(freight_train().length() > regional_train().length());
        assert!(freight_train().max_speed() < regional_train().max_speed());
    }
}
