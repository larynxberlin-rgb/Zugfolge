//! Ein Beispielnetz — die Prüfstrecke des Domänenmodells.
//!
//! **Die Daten sind erfunden.** Auch der Import (M1.2, `import_pbf`) bildet
//! noch keinen `OperatingGraph` — er liefert einen `RawGraph`, den erst
//! spätere Schritte in dieses Modell abbilden. Ein Beispiel mit realen Namen
//! und Werten würde vortäuschen, es gäbe hier schon echte Infrastruktur. Die
//! Größenordnungen — Blocklängen,
//! Bahnsteighöhen, Neigungen, Streckengeschwindigkeiten — sind dagegen
//! realistisch gewählt, sonst prüfte das Beispiel nichts.
//!
//! Die Quellenkennung `beispielnetz` steht bewusst **nicht** im
//! Quellenregister. Das Rechte-Gate prüft die Herkunft von Importen
//! (Invariante 8) — hier wurde nichts importiert, es gibt also nichts
//! freizugeben. Ein erfundener Eintrag im Register wäre eine Freigabe ohne
//! Gegenstand.
//!
//! Der Zuschnitt setzt den Korridor des Spikes aus M0.3 fort und erweitert ihn
//! um genau die Fälle, die das Modell tragen muss:
//!
//! ```text
//! Nordstadt ══ 5 km ══ Waldhof ══ 7 km ══ Sandberg ── 9 km, eingleisig ── Talheim
//!  Bf, 3 Gleise         Hp, 2 Gleise      Bf, 3 Gleise + Abstellgleis      Bf, 2 Gleise
//!  760 mm               550 mm            760 mm                          380 mm
//!  ├─ zweigleisig, Richtungsgleise ──────┤├─ Systemwechsel: ab hier ohne Fahrdraht
//!  ├─ 160 km/h, Gz 100 ──────────────────┤├─ 100 km/h, Gz 80
//!  ├─ PZB und LZB ───────────────────────┤├─ nur PZB
//! ```
//!
//! Damit sind im Beispiel enthalten: Richtungsgleise **und** ein eingleisiger
//! Abschnitt, ein Haltepunkt ohne Kreuzungsmöglichkeit, ein Abstellgleis, ein
//! Wechsel der Elektrifizierung, ein Wechsel der Zugsicherung, ein
//! mehrbändiges Neigungsprofil und vier verschiedene Bahnsteighöhen.

use crate::bands::{Band, BandProfile};
use crate::edge::TrackEdge;
use crate::electrification::{Electrification, PowerSystem};
use crate::graph::OperatingGraph;
use crate::identity::{OperatingPointCode, OperatingPointId, PlatformId, TrackEdgeId, TrackId};
use crate::operating_point::{Coordinate, OperatingPoint, OperatingPointKind};
use crate::platform::Platform;
use crate::protection::{ProtectionSystem, TrainProtection};
use crate::provenance::{Confidence, Provenance, SourceId};
use crate::speed::SpeedLimit;
use crate::track::{Track, TrackDirection, TrackKind, TrackOwner};
use crate::units::{Gradient, Length, Speed};

/// Die Herkunft aller Angaben des Beispielnetzes.
fn herkunft(confidence: Confidence) -> Provenance {
    Provenance::new(
        SourceId::new("beispielnetz").expect("gültige Quellenkennung"),
        confidence,
    )
}

/// Die Attribute, die alle Gleise eines Abschnitts teilen.
struct Ausstattung {
    speed: SpeedLimit,
    electrification: Electrification,
    protection: TrainProtection,
}

/// Was ein einzelnes Gleis von seinem Abschnitt unterscheidet.
struct Gleisplan<'a> {
    id: TrackId,
    owner: TrackOwner,
    designation: &'a str,
    kind: TrackKind,
    direction: TrackDirection,
    length: Length,
}

/// Baut ein Gleis mit gleichmäßigen Profilen und einem eigenen Neigungsprofil.
fn gleis(
    plan: &Gleisplan<'_>,
    ausstattung: &Ausstattung,
    gradient: BandProfile<Gradient>,
) -> Track {
    Track::builder(plan.id, plan.owner, plan.designation, plan.length)
        .kind(plan.kind)
        .direction(plan.direction)
        .speed(
            BandProfile::uniform(
                "vmax",
                plan.length,
                ausstattung.speed,
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(gradient)
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                plan.length,
                ausstattung.electrification,
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(
            BandProfile::uniform(
                "zugsicherung",
                plan.length,
                ausstattung.protection.clone(),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .build()
        .expect("gültiges Gleis")
}

/// Ein gleichmäßiges Neigungsprofil.
///
/// Die Neigung ist überall `Derived`: Sie stammt nirgends aus der Quelle,
/// sondern wird aus einem Höhenmodell abgeleitet (M1.5). Genau das soll der
/// Vertrauensgrad sichtbar halten.
fn neigung(length: Length, gradient: Gradient) -> BandProfile<Gradient> {
    BandProfile::uniform("neigung", length, gradient, herkunft(Confidence::Derived))
        .expect("Profil deckt das Gleis")
}

/// Eine Betriebsstelle des Beispielnetzes.
fn betriebsstelle(
    id: u32,
    code: &str,
    name: &str,
    kind: OperatingPointKind,
    position: (i32, i32),
) -> OperatingPoint {
    OperatingPoint::new(
        OperatingPointId::new(id),
        OperatingPointCode::new(code).expect("gültiges Kürzel"),
        name,
        kind,
        Coordinate::new(position.0, position.1).expect("Punkt liegt auf der Erde"),
        herkunft(Confidence::Surveyed),
    )
    .expect("gültige Betriebsstelle")
}

/// Ein Bahnsteig des Beispielnetzes.
fn bahnsteig(id: u32, track: u32, designation: &str, height_mm: i64) -> Platform {
    Platform::new(
        PlatformId::new(id),
        TrackId::new(track),
        designation,
        Length::from_metres(20),
        Length::from_metres(140),
        Length::from_millimetres(height_mm),
        herkunft(Confidence::Surveyed),
    )
    .expect("gültiger Bahnsteig")
}

/// Die Ausstattung der elektrifizierten Hauptstrecke.
fn hauptstrecke() -> Ausstattung {
    Ausstattung {
        speed: SpeedLimit::uniform(Speed::from_km_h(160))
            .expect("positiv")
            .with_freight(Speed::from_km_h(100))
            .expect("positiv"),
        electrification: Electrification::Overhead(PowerSystem::Ac15kV),
        protection: TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
    }
}

/// Die Ausstattung des eingleisigen, nicht elektrifizierten Astes.
fn nebenstrecke() -> Ausstattung {
    Ausstattung {
        speed: SpeedLimit::uniform(Speed::from_km_h(100))
            .expect("positiv")
            .with_freight(Speed::from_km_h(80))
            .expect("positiv"),
        electrification: Electrification::Unelectrified,
        protection: TrainProtection::single(ProtectionSystem::Pzb),
    }
}

/// Die Ausstattung eines Bahnhofsgleises.
fn bahnhofsgleis(electrification: Electrification) -> Ausstattung {
    Ausstattung {
        speed: SpeedLimit::uniform(Speed::from_km_h(60)).expect("positiv"),
        electrification,
        protection: TrainProtection::single(ProtectionSystem::Pzb),
    }
}

/// Das Neigungsprofil des eingleisigen Astes — der Fall, für den es Bänder
/// überhaupt gibt.
fn ast_neigung(length: Length) -> BandProfile<Gradient> {
    BandProfile::new(
        "neigung",
        length,
        vec![
            Band::new(
                Length::ZERO,
                Length::from_metres(3_000),
                Gradient::LEVEL,
                herkunft(Confidence::Derived),
            ),
            Band::new(
                Length::from_metres(3_000),
                Length::from_metres(7_000),
                Gradient::from_per_mille_tenths(125),
                herkunft(Confidence::Derived),
            ),
            Band::new(
                Length::from_metres(7_000),
                length,
                Gradient::from_per_mille_tenths(-80),
                herkunft(Confidence::Derived),
            ),
        ],
    )
    .expect("Profil ist lückenlos")
}

/// Baut die vier Betriebsstellen mit ihren Gleisen und Bahnsteigen.
fn betriebsstellen_gleise() -> Vec<Track> {
    let mit_fahrdraht = bahnhofsgleis(Electrification::Overhead(PowerSystem::Ac15kV));
    let ohne_fahrdraht = bahnhofsgleis(Electrification::Unelectrified);
    let mut gleise = Vec::new();

    for (id, nummer) in [(101_u32, "Gleis 1"), (102, "Gleis 2"), (103, "Gleis 3")] {
        gleise.push(gleis(
            &Gleisplan {
                id: TrackId::new(id),
                owner: TrackOwner::OperatingPoint(OperatingPointId::new(1)),
                designation: nummer,
                kind: TrackKind::ThroughMainTrack,
                direction: TrackDirection::Bidirectional,
                length: Length::from_metres(800),
            },
            &mit_fahrdraht,
            neigung(Length::from_metres(800), Gradient::LEVEL),
        ));
    }

    // Der Haltepunkt liegt auf freier Strecke: seine Gleise sind
    // Richtungsgleise, und es gibt kein drittes zum Kreuzen.
    for (id, nummer, richtung) in [
        (201_u32, "Gleis 1", TrackDirection::WithChainage),
        (202, "Gleis 2", TrackDirection::AgainstChainage),
    ] {
        gleise.push(gleis(
            &Gleisplan {
                id: TrackId::new(id),
                owner: TrackOwner::OperatingPoint(OperatingPointId::new(2)),
                designation: nummer,
                kind: TrackKind::ThroughMainTrack,
                direction: richtung,
                length: Length::from_metres(300),
            },
            &mit_fahrdraht,
            neigung(Length::from_metres(300), Gradient::LEVEL),
        ));
    }

    for (id, nummer) in [(301_u32, "Gleis 1"), (302, "Gleis 2"), (303, "Gleis 3")] {
        gleise.push(gleis(
            &Gleisplan {
                id: TrackId::new(id),
                owner: TrackOwner::OperatingPoint(OperatingPointId::new(3)),
                designation: nummer,
                kind: TrackKind::ThroughMainTrack,
                direction: TrackDirection::Bidirectional,
                length: Length::from_metres(1_000),
            },
            &mit_fahrdraht,
            neigung(Length::from_metres(1_000), Gradient::LEVEL),
        ));
    }

    // Ein Abstellgleis: langsam, ohne Fahrdraht, ohne Zugbeeinflussung — auf
    // ihm wird ausschließlich rangiert (E12).
    gleise.push(gleis(
        &Gleisplan {
            id: TrackId::new(311),
            owner: TrackOwner::OperatingPoint(OperatingPointId::new(3)),
            designation: "Gleis 11",
            kind: TrackKind::StablingTrack,
            direction: TrackDirection::Bidirectional,
            length: Length::from_metres(400),
        },
        &Ausstattung {
            speed: SpeedLimit::uniform(Speed::from_km_h(25)).expect("positiv"),
            electrification: Electrification::Unelectrified,
            protection: TrainProtection::unprotected(),
        },
        neigung(Length::from_metres(400), Gradient::LEVEL),
    ));

    for (id, nummer) in [(401_u32, "Gleis 1"), (402, "Gleis 2")] {
        gleise.push(gleis(
            &Gleisplan {
                id: TrackId::new(id),
                owner: TrackOwner::OperatingPoint(OperatingPointId::new(4)),
                designation: nummer,
                kind: TrackKind::ThroughMainTrack,
                direction: TrackDirection::Bidirectional,
                length: Length::from_metres(600),
            },
            &ohne_fahrdraht,
            neigung(Length::from_metres(600), Gradient::LEVEL),
        ));
    }

    gleise
}

/// Baut die Gleise der freien Strecke.
fn streckengleise() -> Vec<Track> {
    let haupt = hauptstrecke();
    let neben = nebenstrecke();
    let mut gleise = Vec::new();

    for (kante, laenge_m, erstes_gleis, steigung) in [
        (1_u32, 5_000_i64, 1001_u32, Gradient::from_per_mille(5)),
        (2, 7_000, 2001, Gradient::from_per_mille(-3)),
    ] {
        let laenge = Length::from_metres(laenge_m);
        for (versatz, bezeichnung, richtung) in [
            (0_u32, "Gleis A", TrackDirection::WithChainage),
            (1, "Gleis B", TrackDirection::AgainstChainage),
        ] {
            gleise.push(gleis(
                &Gleisplan {
                    id: TrackId::new(erstes_gleis.saturating_add(versatz)),
                    owner: TrackOwner::Edge(TrackEdgeId::new(kante)),
                    designation: bezeichnung,
                    kind: TrackKind::ThroughMainTrack,
                    direction: richtung,
                    length: laenge,
                },
                &haupt,
                neigung(laenge, steigung),
            ));
        }
    }

    // Der eingleisige Ast: **beide** Richtungen teilen sich dieses Gleis. Genau
    // daraus entsteht die Gegenfahrt — es braucht dafür keine zweite Regel,
    // nur diese Richtungsbindung (Befund des Spikes aus M0.3).
    let ast = Length::from_metres(9_000);
    gleise.push(gleis(
        &Gleisplan {
            id: TrackId::new(3001),
            owner: TrackOwner::Edge(TrackEdgeId::new(3)),
            designation: "Streckengleis",
            kind: TrackKind::ThroughMainTrack,
            direction: TrackDirection::Bidirectional,
            length: ast,
        },
        &neben,
        ast_neigung(ast),
    ));

    gleise
}

/// Das Beispielnetz als geprüfter Betriebsgraph.
///
/// # Panics
///
/// Nie im Normalfall — die Werte sind fest verdrahtet und geprüft. Schlägt der
/// Bau fehl, ist eine Regel des Modells verschärft worden, und das soll laut
/// auffallen.
pub fn reference_network() -> OperatingGraph {
    let mut builder = OperatingGraph::builder()
        .operating_point(betriebsstelle(
            1,
            "NST",
            "Nordstadt",
            OperatingPointKind::Station,
            (513_000_000, 123_000_000),
        ))
        .operating_point(betriebsstelle(
            2,
            "WDH",
            "Waldhof",
            OperatingPointKind::Halt,
            (513_400_000, 124_200_000),
        ))
        .operating_point(betriebsstelle(
            3,
            "SBG",
            "Sandberg",
            OperatingPointKind::Station,
            (513_800_000, 125_500_000),
        ))
        .operating_point(betriebsstelle(
            4,
            "TLH",
            "Talheim",
            OperatingPointKind::Station,
            (513_000_000, 127_000_000),
        ))
        .edge(
            TrackEdge::new(
                TrackEdgeId::new(1),
                OperatingPointId::new(1),
                OperatingPointId::new(2),
                "Nordstadt – Waldhof",
                Length::from_metres(5_000),
                herkunft(Confidence::Surveyed),
            )
            .expect("gültige Kante"),
        )
        .edge(
            TrackEdge::new(
                TrackEdgeId::new(2),
                OperatingPointId::new(2),
                OperatingPointId::new(3),
                "Waldhof – Sandberg",
                Length::from_metres(7_000),
                herkunft(Confidence::Surveyed),
            )
            .expect("gültige Kante"),
        )
        .edge(
            TrackEdge::new(
                TrackEdgeId::new(3),
                OperatingPointId::new(3),
                OperatingPointId::new(4),
                "Sandberg – Talheim",
                Length::from_metres(9_000),
                herkunft(Confidence::Surveyed),
            )
            .expect("gültige Kante"),
        );

    for gleis in betriebsstellen_gleise().into_iter().chain(streckengleise()) {
        builder = builder.track(gleis);
    }

    for (id, gleis, bezeichnung, hoehe) in [
        (1_u32, 101_u32, "Bahnsteig 1", 760_i64),
        (2, 102, "Bahnsteig 2", 760),
        (3, 201, "Bahnsteig 1", 550),
        (4, 202, "Bahnsteig 2", 550),
        (5, 301, "Bahnsteig 1", 760),
        (6, 302, "Bahnsteig 2", 760),
        (7, 401, "Bahnsteig 1", 380),
        (8, 402, "Bahnsteig 2", 380),
    ] {
        builder = builder.platform(bahnsteig(id, gleis, bezeichnung, hoehe));
    }

    builder.build().expect("das Beispielnetz ist gültig")
}

#[cfg(test)]
mod tests {
    use super::reference_network;
    use crate::identity::{OperatingPointId, TrackId};
    use crate::operating_point::OperatingPointKind;
    use crate::protection::ProtectionSystem;
    use crate::provenance::Confidence;
    use crate::track::{TrackKind, TrackOwner};
    use crate::units::{Gradient, Length, Speed};

    #[test]
    fn das_beispielnetz_ist_vollstaendig() {
        let netz = reference_network();
        assert_eq!(netz.operating_point_count(), 4);
        assert_eq!(netz.edge_count(), 3);
        assert_eq!(netz.track_count(), 16);
        assert_eq!(netz.platform_count(), 8);
    }

    #[test]
    fn der_korridor_haengt_zusammen() {
        let netz = reference_network();
        let nachbarn: Vec<_> = netz.neighbours(OperatingPointId::new(2)).collect();
        assert_eq!(
            nachbarn,
            vec![OperatingPointId::new(1), OperatingPointId::new(3)]
        );
        // Die Endpunkte hängen an genau einer Kante.
        assert_eq!(netz.edges_at(OperatingPointId::new(1)).count(), 1);
        assert_eq!(netz.edges_at(OperatingPointId::new(4)).count(), 1);
    }

    #[test]
    fn nur_der_haltepunkt_kann_nicht_kreuzen() {
        let netz = reference_network();
        for betriebsstelle in netz.operating_points() {
            let erwartet = betriebsstelle.kind() != OperatingPointKind::Halt;
            assert_eq!(
                betriebsstelle.kind().allows_crossing(),
                erwartet,
                "{betriebsstelle}"
            );
        }
    }

    #[test]
    fn der_fahrdraht_endet_in_sandberg() {
        let netz = reference_network();
        let hauptstrecke = netz.track(TrackId::new(1001)).expect("Gleis A der Kante 1");
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");

        assert!(hauptstrecke.is_fully_electrified());
        assert!(!ast.is_fully_electrified());
        // Und mit dem Fahrdraht endet auch die durchgehende Überwachung.
        assert!(hauptstrecke.has_continuous_supervision());
        assert!(!ast.has_continuous_supervision());
        assert!(
            ast.protection_at(Length::ZERO)
                .is_some_and(|sicherung| sicherung.contains(ProtectionSystem::Pzb))
        );
    }

    #[test]
    fn das_neigungsprofil_des_astes_hat_drei_baender() {
        let netz = reference_network();
        let ast = netz
            .track(TrackId::new(3001))
            .expect("das eingleisige Gleis");
        assert_eq!(ast.gradient().band_count(), 3);
        assert_eq!(
            ast.gradient_at(Length::from_metres(1_000)),
            Some(Gradient::LEVEL)
        );
        assert_eq!(
            ast.gradient_at(Length::from_metres(5_000)),
            Some(Gradient::from_per_mille_tenths(125))
        );
        assert_eq!(
            ast.gradient_at(Length::from_metres(8_000)),
            Some(Gradient::from_per_mille_tenths(-80))
        );
    }

    #[test]
    fn sandberg_hat_ein_abstellgleis() {
        let netz = reference_network();
        let gleise: Vec<_> = netz
            .tracks_of(TrackOwner::OperatingPoint(OperatingPointId::new(3)))
            .collect();
        assert_eq!(gleise.len(), 4);
        let abstellgleis = netz.track(TrackId::new(311)).expect("Gleis 11");
        assert_eq!(abstellgleis.kind(), TrackKind::StablingTrack);
        assert!(abstellgleis.kind().allows_stabling());
        assert!(!abstellgleis.kind().carries_train_runs());
        assert_eq!(abstellgleis.maximum_speed(), Speed::from_km_h(25));
    }

    #[test]
    fn bahnsteige_haengen_an_bahnhofsgleisen() {
        let netz = reference_network();
        assert_eq!(netz.platforms_of(TrackId::new(101)).count(), 1);
        // Am dritten Gleis in Nordstadt liegt kein Bahnsteig.
        assert_eq!(netz.platforms_of(TrackId::new(103)).count(), 0);
        // Und auf freier Strecke schon gar nicht.
        assert_eq!(netz.platforms_of(TrackId::new(1001)).count(), 0);
    }

    #[test]
    fn die_neigung_faerbt_den_vertrauensgrad_des_netzes() {
        // Kein einziges Neigungsband stammt aus der Quelle — alle sind aus
        // einem Höhenmodell abgeleitet. Damit kann das Netz als Ganzes nicht
        // besser als 'abgeleitet' sein, und genau das soll M1.4 später sehen.
        assert_eq!(reference_network().confidence(), Confidence::Derived);
    }
}
