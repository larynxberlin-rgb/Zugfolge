//! Die Fehler des Betriebsgraphen.
//!
//! Ein Fehler dieses Crates ist immer eine Aussage über die **Daten**, nie über
//! die Programmierung: Ein Gleis ohne Vmax-Profil, eine Kante ins Leere, ein
//! Bahnsteig, der über sein Gleis hinausragt. Genau solche Fälle wird der
//! Import aus M1.2 massenhaft finden, und dann entscheidet die Meldung, ob
//! jemand sie beheben kann. Deshalb nennt jede Variante das betroffene Objekt
//! und den betroffenen Wert — nicht nur, dass etwas nicht stimmt.

use core::fmt;

use crate::identity::{
    FacilityId, HeadElementId, HeadNodeId, HeadSignalId, OperatingPointId, PlatformId, SwitchId,
    TrackEdgeId, TrackId,
};
use crate::units::{Length, Speed};

/// Was am Betriebsgraphen oder einem seiner Bausteine nicht stimmt.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum InfraError {
    /// Eine Quellenkennung passt nicht in die Form des Quellenregisters.
    SourceId(String),
    /// Ein Betriebsstellenkürzel hat nicht die zulässige Form.
    OperatingPointCode(String),
    /// Ein Pflichtname ist leer.
    EmptyName {
        /// Was namenlos geblieben ist.
        what: &'static str,
    },
    /// Eine Länge muss positiv sein, ist es aber nicht.
    NonPositiveLength {
        /// Welche Länge gemeint ist.
        what: &'static str,
        /// Der angegebene Wert.
        value: Length,
    },
    /// Eine Geschwindigkeit muss positiv sein, ist es aber nicht.
    NonPositiveSpeed {
        /// Welche Geschwindigkeit gemeint ist.
        what: &'static str,
        /// Der angegebene Wert.
        value: Speed,
    },
    /// Eine Koordinate liegt außerhalb der Erde.
    Coordinate {
        /// Geografische Breite in Zehnmillionstel Grad.
        latitude_e7: i32,
        /// Geografische Länge in Zehnmillionstel Grad.
        longitude_e7: i32,
    },
    /// Ein Bandprofil hat keine Bänder.
    EmptyProfile {
        /// Das betroffene Attribut.
        attribute: &'static str,
    },
    /// Ein Bandprofil beginnt nicht am Anfang des Gleises.
    ProfileStart {
        /// Das betroffene Attribut.
        attribute: &'static str,
        /// Wo das erste Band beginnt.
        first: Length,
    },
    /// Ein Bandprofil endet nicht am Ende des Gleises.
    ProfileEnd {
        /// Das betroffene Attribut.
        attribute: &'static str,
        /// Wo das letzte Band endet.
        last: Length,
        /// Wo es enden müsste.
        length: Length,
    },
    /// Ein Band hat keine Ausdehnung oder läuft rückwärts.
    ProfileBand {
        /// Das betroffene Attribut.
        attribute: &'static str,
        /// Das wievielte Band, ab null gezählt.
        index: usize,
    },
    /// Zwischen zwei Bändern klafft eine Lücke, oder sie überschneiden sich.
    ProfileGap {
        /// Das betroffene Attribut.
        attribute: &'static str,
        /// Das wievielte Band, ab null gezählt.
        index: usize,
        /// Wo das vorherige Band endet.
        ends: Length,
        /// Wo dieses Band beginnt.
        starts: Length,
    },
    /// Ein Bandprofil deckt eine andere Länge ab als sein Gleis.
    ProfileLength {
        /// Das betroffene Attribut.
        attribute: &'static str,
        /// Die vom Profil abgedeckte Länge.
        profile: Length,
        /// Die Länge des Gleises.
        track: Length,
    },
    /// Ein Pflichtprofil fehlt.
    MissingProfile {
        /// Das fehlende Attribut.
        attribute: &'static str,
    },
    /// Die Nutzlänge eines Gleises ist größer als das Gleis.
    UsableLengthExceedsLength {
        /// Das betroffene Gleis.
        track: TrackId,
        /// Die angegebene Nutzlänge.
        usable: Length,
        /// Die Länge des Gleises.
        length: Length,
    },
    /// Ein Graph ohne Betriebsstellen ist kein Netz.
    EmptyGraph,
    /// Eine Betriebsstellenkennung wurde zweimal vergeben.
    DuplicateOperatingPoint(OperatingPointId),
    /// Eine Kantenkennung wurde zweimal vergeben.
    DuplicateEdge(TrackEdgeId),
    /// Eine Gleiskennung wurde zweimal vergeben.
    DuplicateTrack(TrackId),
    /// Eine Bahnsteigkennung wurde zweimal vergeben.
    DuplicatePlatform(PlatformId),
    /// Zwei Betriebsstellen tragen dasselbe Kürzel.
    DuplicateOperatingPointCode {
        /// Das doppelt vergebene Kürzel.
        code: String,
        /// Die zuerst gefundene Betriebsstelle.
        first: OperatingPointId,
        /// Die zweite Betriebsstelle.
        second: OperatingPointId,
    },
    /// Eine Kante endet an einer Betriebsstelle, die es nicht gibt.
    UnknownEdgeEndpoint {
        /// Die betroffene Kante.
        edge: TrackEdgeId,
        /// Die unbekannte Betriebsstelle.
        point: OperatingPointId,
    },
    /// Eine Kante beginnt und endet an derselben Betriebsstelle.
    SelfLoopEdge(TrackEdgeId),
    /// Ein Gleis liegt auf einer Kante oder in einer Betriebsstelle, die es
    /// nicht gibt.
    UnknownTrackOwner(TrackId),
    /// Ein Bahnsteig liegt an einem Gleis, das es nicht gibt.
    UnknownPlatformTrack {
        /// Der betroffene Bahnsteig.
        platform: PlatformId,
        /// Das unbekannte Gleis.
        track: TrackId,
    },
    /// Ein Bahnsteig liegt an einem Gleis der freien Strecke.
    PlatformOnLine {
        /// Der betroffene Bahnsteig.
        platform: PlatformId,
        /// Das Gleis auf freier Strecke.
        track: TrackId,
    },
    /// Ein Bahnsteig ragt über sein Gleis hinaus.
    PlatformOutsideTrack {
        /// Der betroffene Bahnsteig.
        platform: PlatformId,
        /// Wo der Bahnsteig endet.
        end: Length,
        /// Wo das Gleis endet.
        track_length: Length,
    },
    /// Zwei Gleise desselben Eigentümers tragen dieselbe Bezeichnung.
    DuplicateTrackDesignation {
        /// Die doppelt vergebene Bezeichnung.
        designation: String,
        /// Das zuerst gefundene Gleis.
        first: TrackId,
        /// Das zweite Gleis.
        second: TrackId,
    },
    /// Eine Kante trägt kein einziges Gleis.
    EdgeWithoutTrack(TrackEdgeId),
    /// Eine Betriebsstelle hat kein einziges Gleis.
    OperatingPointWithoutTrack(OperatingPointId),
    /// Eine Betriebsstelle hängt an keiner Kante.
    IsolatedOperatingPoint(OperatingPointId),
    /// Ein Höhenmodell wurde ohne eine einzige Stichprobe angeliefert.
    EmptyElevationSamples,
    /// Zwei Höhenstichproben liegen nicht in aufsteigender Reihenfolge — der
    /// Verlauf entlang des Gleises wäre sonst nicht eindeutig.
    UnorderedElevationSamples {
        /// Die Position, an der die Reihenfolge bricht.
        at: Length,
    },
    /// Die Höhenstichproben beginnen nicht am Gleisanfang oder enden nicht am
    /// Gleisende — ein Neigungsprofil, das nicht das ganze Gleis abdeckt,
    /// ließe einen Abschnitt ohne Wert.
    ElevationSamplesDoNotCoverTrack {
        /// Die Position der ersten Stichprobe.
        first: Length,
        /// Die Position der letzten Stichprobe.
        last: Length,
        /// Die Länge des Gleises, die die Stichproben abdecken müssten.
        track_length: Length,
    },
    /// Ein Signal liegt außerhalb seines Gleises — eine Signalposition muss
    /// zwischen Gleisanfang und Gleisende liegen (M1.6).
    SignalOutsideTrack {
        /// Die Position des Signals.
        at: Length,
        /// Die Länge des Gleises.
        track_length: Length,
    },
    /// Zwei Signale liegen nicht in aufsteigender Reihenfolge — die
    /// Blockableitung erwartet die Signale sortiert entlang des Gleises (M1.6).
    UnorderedSignals {
        /// Die Position, an der die Reihenfolge bricht.
        at: Length,
    },
    /// Ein Bahnhofskopf ohne ein einziges Fahrwegelement ist keiner (M1.7).
    EmptyStationHead,
    /// Eine Knotenkennung wurde zweimal vergeben (M1.7).
    DuplicateHeadNode(HeadNodeId),
    /// Eine Elementkennung wurde zweimal vergeben (M1.7).
    DuplicateHeadElement(HeadElementId),
    /// Eine Weichenkennung wurde zweimal vergeben (M1.7).
    DuplicateSwitch(SwitchId),
    /// Eine Signalkennung wurde zweimal vergeben (M1.7).
    DuplicateHeadSignal(HeadSignalId),
    /// Ein Fahrwegelement endet an einem Knoten, den es nicht gibt (M1.7).
    UnknownElementNode {
        /// Das betroffene Element.
        element: HeadElementId,
        /// Der unbekannte Knoten.
        node: HeadNodeId,
    },
    /// Ein Fahrwegelement beginnt und endet am selben Knoten (M1.7).
    SelfLoopHeadElement(HeadElementId),
    /// Ein Knoten hat nicht die Anzahl Elemente, die seine Art verlangt: ein
    /// Endpunkt genau eines, ein Stoß genau zwei, eine Weiche genau drei (M1.7).
    HeadNodeDegree {
        /// Der betroffene Knoten.
        node: HeadNodeId,
        /// Die Art des Knotens.
        kind: &'static str,
        /// Die von der Art verlangte Anzahl.
        expected: usize,
        /// Die tatsächliche Anzahl.
        actual: usize,
    },
    /// Eine Weiche nennt nicht genau die drei verschiedenen Elemente, die an
    /// ihrem Knoten liegen — Spitze, Stammgleis und Zweiggleis (M1.7).
    SwitchNodeMismatch {
        /// Die betroffene Weiche.
        switch: SwitchId,
    },
    /// Ein Signal steht an einem Element oder Knoten, den es nicht gibt, oder
    /// der genannte Knoten ist kein Ende des genannten Elements (M1.7).
    SignalPlacement {
        /// Das betroffene Signal.
        signal: HeadSignalId,
    },
    /// Eine Baureihenbezeichnung hat nicht die zulässige Form (M1.11).
    FleetClass(String),
    /// Eine Zeitangabe innerhalb eines Tages liegt außerhalb von 0 bis
    /// 86 399 Sekunden nach Mitternacht (M1.11).
    TimeOfDay(u32),
    /// Öffnungszeit und Schließzeit einer täglichen Öffnungszeit sind gleich —
    /// das wäre weder durchgehend geöffnet noch ein Tagesfenster (M1.11).
    EmptyOpeningWindow,
    /// Eine Anlage nennt keine einzige Baureihe, die sie behandeln kann — eine
    /// Anlage ohne Kompetenz könnte nie belegt werden (M1.11).
    EmptyFleetCompetence(FacilityId),
    /// Eine Kapazität muss positiv sein, ist es aber nicht.
    NonPositiveCapacity {
        /// Was ohne Kapazität geblieben ist.
        what: &'static str,
        /// Der angegebene Wert.
        value: u32,
    },
    /// Eine Anlagenkennung wurde zweimal vergeben (M1.11).
    DuplicateFacility(FacilityId),
    /// Eine Anlage liegt auf einem Gleis, das es nicht gibt (M1.11).
    UnknownFacilityTrack {
        /// Die betroffene Anlage.
        facility: FacilityId,
        /// Das unbekannte Gleis.
        track: TrackId,
    },
    /// Eine Anlage liegt auf einem durchgehenden Hauptgleis — dort finden
    /// Zugfahrten statt, keine Anlagen (M1.11).
    FacilityOnMainTrack {
        /// Die betroffene Anlage.
        facility: FacilityId,
        /// Das Hauptgleis.
        track: TrackId,
    },
    /// Eine Betriebsstelle wurde zweimal mit Stationsdaten angereichert
    /// (M1.8).
    DuplicateStationEnrichment(OperatingPointId),
    /// Stationsdaten nennen eine Betriebsstelle, die es nicht gibt (M1.8).
    UnknownEnrichmentPoint(OperatingPointId),
    /// Stationsdaten reichern eine Betriebsstelle an, an der planmäßig kein
    /// Fahrgastwechsel stattfindet — dort gibt es keine Station anzureichern
    /// (M1.8).
    EnrichmentWithoutPassengerStop(OperatingPointId),
}

impl fmt::Display for InfraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SourceId(id) => write!(
                formatter,
                "'{id}' ist keine Quellenkennung — erlaubt sind Kleinbuchstaben, \
                 Ziffern und Bindestriche, wie im Quellenregister"
            ),
            Self::OperatingPointCode(code) => write!(
                formatter,
                "'{code}' ist kein Betriebsstellenkürzel — zwei bis acht Buchstaben, \
                 Ziffern oder Leerzeichen, ohne Leerzeichen am Rand"
            ),
            Self::EmptyName { what } => {
                write!(formatter, "{what} ohne Namen")
            }
            Self::NonPositiveLength { what, value } => {
                write!(formatter, "{what} muss positiv sein, ist aber {value}")
            }
            Self::NonPositiveSpeed { what, value } => {
                write!(formatter, "{what} muss positiv sein, ist aber {value}")
            }
            Self::Coordinate {
                latitude_e7,
                longitude_e7,
            } => write!(
                formatter,
                "Koordinate {latitude_e7}/{longitude_e7} liegt außerhalb des gültigen Bereichs"
            ),
            Self::EmptyProfile { attribute } => write!(
                formatter,
                "Profil '{attribute}' hat kein einziges Band und beschreibt damit nichts"
            ),
            Self::ProfileStart { attribute, first } => write!(
                formatter,
                "Profil '{attribute}' beginnt erst bei {first} — der Abschnitt davor hätte keinen Wert"
            ),
            Self::ProfileEnd {
                attribute,
                last,
                length,
            } => write!(
                formatter,
                "Profil '{attribute}' endet bei {last}, das Gleis erst bei {length} — \
                 der Rest hätte keinen Wert"
            ),
            Self::ProfileBand { attribute, index } => write!(
                formatter,
                "Band {index} in Profil '{attribute}' hat keine Ausdehnung oder läuft rückwärts"
            ),
            Self::ProfileGap {
                attribute,
                index,
                ends,
                starts,
            } => write!(
                formatter,
                "Profil '{attribute}': Band {index} beginnt bei {starts}, das vorherige endet \
                 bei {ends} — eine Lücke oder eine Überschneidung"
            ),
            Self::ProfileLength {
                attribute,
                profile,
                track,
            } => write!(
                formatter,
                "Profil '{attribute}' deckt {profile} ab, das Gleis ist {track} lang"
            ),
            Self::MissingProfile { attribute } => write!(
                formatter,
                "Profil '{attribute}' fehlt — ein stillschweigend angenommener Wert wäre ein \
                 Wert ohne Quelle"
            ),
            Self::UsableLengthExceedsLength {
                track,
                usable,
                length,
            } => write!(
                formatter,
                "Gleis {track}: Nutzlänge {usable} ist größer als die Gleislänge {length}"
            ),
            Self::EmptyGraph => {
                formatter.write_str("Betriebsgraph ohne Betriebsstellen ist kein Netz")
            }
            Self::DuplicateOperatingPoint(id) => {
                write!(formatter, "Betriebsstelle {id} ist zweimal angelegt")
            }
            Self::DuplicateEdge(id) => write!(formatter, "Kante {id} ist zweimal angelegt"),
            Self::DuplicateTrack(id) => write!(formatter, "Gleis {id} ist zweimal angelegt"),
            Self::DuplicatePlatform(id) => write!(formatter, "Bahnsteig {id} ist zweimal angelegt"),
            Self::DuplicateOperatingPointCode {
                code,
                first,
                second,
            } => write!(
                formatter,
                "Kürzel '{code}' tragen sowohl {first} als auch {second} — ein Kürzel bezeichnet \
                 genau eine Betriebsstelle"
            ),
            Self::UnknownEdgeEndpoint { edge, point } => write!(
                formatter,
                "Kante {edge} endet an der unbekannten Betriebsstelle {point}"
            ),
            Self::SelfLoopEdge(id) => write!(
                formatter,
                "Kante {id} beginnt und endet an derselben Betriebsstelle"
            ),
            Self::UnknownTrackOwner(id) => write!(
                formatter,
                "Gleis {id} liegt auf einer Kante oder in einer Betriebsstelle, die es nicht gibt"
            ),
            Self::UnknownPlatformTrack { platform, track } => write!(
                formatter,
                "Bahnsteig {platform} liegt am unbekannten Gleis {track}"
            ),
            Self::PlatformOnLine { platform, track } => write!(
                formatter,
                "Bahnsteig {platform} liegt am Streckengleis {track} — Bahnsteige gehören in \
                 eine Betriebsstelle"
            ),
            Self::PlatformOutsideTrack {
                platform,
                end,
                track_length,
            } => write!(
                formatter,
                "Bahnsteig {platform} endet bei {end}, sein Gleis schon bei {track_length}"
            ),
            Self::DuplicateTrackDesignation {
                designation,
                first,
                second,
            } => write!(
                formatter,
                "Bezeichnung '{designation}' tragen sowohl {first} als auch {second} am selben Ort"
            ),
            Self::EdgeWithoutTrack(id) => write!(
                formatter,
                "Kante {id} trägt kein Gleis — auf ihr könnte niemand fahren"
            ),
            Self::OperatingPointWithoutTrack(id) => write!(
                formatter,
                "Betriebsstelle {id} hat kein Gleis — dort könnte kein Zug stehen"
            ),
            Self::IsolatedOperatingPoint(id) => write!(
                formatter,
                "Betriebsstelle {id} hängt an keiner Kante und ist vom Netz getrennt"
            ),
            Self::EmptyElevationSamples => formatter.write_str(
                "Höhenmodell ohne eine einzige Stichprobe — daraus lässt sich kein Neigungsprofil ableiten",
            ),
            Self::UnorderedElevationSamples { at } => write!(
                formatter,
                "Höhenstichproben sind bei {at} nicht mehr aufsteigend sortiert"
            ),
            Self::ElevationSamplesDoNotCoverTrack {
                first,
                last,
                track_length,
            } => write!(
                formatter,
                "Höhenstichproben reichen von {first} bis {last}, das Gleis aber von 0 bis \
                 {track_length} — der Rest hätte keinen Wert"
            ),
            Self::SignalOutsideTrack { at, track_length } => write!(
                formatter,
                "Signal bei {at} liegt außerhalb des Gleises von 0 bis {track_length}"
            ),
            Self::UnorderedSignals { at } => write!(
                formatter,
                "Signale sind bei {at} nicht mehr aufsteigend sortiert"
            ),
            Self::EmptyStationHead => formatter.write_str(
                "Bahnhofskopf ohne ein einziges Fahrwegelement — daraus lässt sich keine Fahrstraße ableiten",
            ),
            Self::DuplicateHeadNode(id) => write!(formatter, "Knoten {id} ist zweimal angelegt"),
            Self::DuplicateHeadElement(id) => {
                write!(formatter, "Fahrwegelement {id} ist zweimal angelegt")
            }
            Self::DuplicateSwitch(id) => write!(formatter, "Weiche {id} ist zweimal angelegt"),
            Self::DuplicateHeadSignal(id) => write!(formatter, "Signal {id} ist zweimal angelegt"),
            Self::UnknownElementNode { element, node } => write!(
                formatter,
                "Fahrwegelement {element} endet am unbekannten Knoten {node}"
            ),
            Self::SelfLoopHeadElement(id) => write!(
                formatter,
                "Fahrwegelement {id} beginnt und endet am selben Knoten"
            ),
            Self::HeadNodeDegree {
                node,
                kind,
                expected,
                actual,
            } => write!(
                formatter,
                "Knoten {node} ({kind}) hat {actual} Elemente, erwartet werden {expected}"
            ),
            Self::SwitchNodeMismatch { switch } => write!(
                formatter,
                "Weiche {switch} nennt nicht genau die drei verschiedenen Elemente an ihrem Knoten"
            ),
            Self::SignalPlacement { signal } => write!(
                formatter,
                "Signal {signal} steht nicht an einem Ende eines vorhandenen Elements"
            ),
            Self::FleetClass(bezeichnung) => write!(
                formatter,
                "'{bezeichnung}' ist keine Baureihenbezeichnung — ein bis zehn Zeichen aus \
                 Buchstaben, Ziffern, Punkt und Bindestrich"
            ),
            Self::TimeOfDay(sekunden) => write!(
                formatter,
                "{sekunden} Sekunden nach Mitternacht liegen außerhalb eines Tages (0 bis 86399)"
            ),
            Self::EmptyOpeningWindow => formatter.write_str(
                "Öffnungs- und Schließzeit sind gleich — das wäre weder durchgehend geöffnet \
                 noch ein Tagesfenster",
            ),
            Self::EmptyFleetCompetence(id) => write!(
                formatter,
                "Anlage {id} nennt keine einzige Baureihe, die sie behandeln kann"
            ),
            Self::NonPositiveCapacity { what, value } => {
                write!(formatter, "{what} muss positiv sein, ist aber {value}")
            }
            Self::DuplicateFacility(id) => write!(formatter, "Anlage {id} ist zweimal angelegt"),
            Self::UnknownFacilityTrack { facility, track } => write!(
                formatter,
                "Anlage {facility} liegt am unbekannten Gleis {track}"
            ),
            Self::FacilityOnMainTrack { facility, track } => write!(
                formatter,
                "Anlage {facility} liegt am durchgehenden Hauptgleis {track} — dort finden \
                 Zugfahrten statt, keine Anlagen"
            ),
            Self::DuplicateStationEnrichment(id) => write!(
                formatter,
                "Betriebsstelle {id} ist zweimal mit Stationsdaten angereichert"
            ),
            Self::UnknownEnrichmentPoint(id) => write!(
                formatter,
                "Stationsdaten nennen die unbekannte Betriebsstelle {id}"
            ),
            Self::EnrichmentWithoutPassengerStop(id) => write!(
                formatter,
                "Betriebsstelle {id} hat keinen planmäßigen Fahrgastwechsel — dort gibt es \
                 keine Station anzureichern"
            ),
        }
    }
}

impl core::error::Error for InfraError {}

#[cfg(test)]
mod tests {
    use super::InfraError;
    use crate::identity::{OperatingPointId, TrackId};
    use crate::units::Length;

    #[test]
    fn eine_meldung_nennt_objekt_und_wert() {
        let fehler = InfraError::UsableLengthExceedsLength {
            track: TrackId::new(7),
            usable: Length::from_metres(500),
            length: Length::from_metres(400),
        };
        let text = fehler.to_string();
        assert!(text.contains("G7"), "{text}");
        assert!(text.contains("500000 mm"), "{text}");
        assert!(text.contains("400000 mm"), "{text}");
    }

    #[test]
    fn eine_meldung_erklaert_die_folge() {
        let text = InfraError::IsolatedOperatingPoint(OperatingPointId::new(3)).to_string();
        assert!(text.contains("Bst3"), "{text}");
        assert!(text.contains("vom Netz getrennt"), "{text}");
    }
}
