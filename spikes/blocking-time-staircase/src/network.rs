//! Die Beispielinfrastruktur des Spikes.
//!
//! Drei Betriebsstellen, dazwischen eine zweigleisige Strecke und ein
//! eingleisiger Ast — genau der Zuschnitt aus `docs/milestones.md`, M0.3.
//!
//! **Die Namen sind erfunden.** M0.4 (Rechte-Gate) ist offen, also arbeitet der
//! Spike bewusst nicht mit realer Infrastruktur. Die Größenordnungen — Blocklänge,
//! Vorsignalabstand, Durchrutschweg, Fahrstraßenbilde- und -auflösezeit — sind
//! dagegen realistisch gewählt, sonst prüfte der Spike nichts.
//!
//! Alle Längen in Millimetern, alle Geschwindigkeiten in Millimetern je Sekunde,
//! alle Zeiten in Sekunden (Invariante 3: keine Gleitkommazahlen).

use core::fmt;

/// Geschwindigkeit in Millimetern je Sekunde aus einer Angabe in km/h.
///
/// Aufgerundet, damit aus der Umrechnung keine unbeabsichtigt strengere
/// Fahrzeit entsteht.
const fn kmh(value: i64) -> i64 {
    // 1 km/h = 1_000_000 mm / 3600 s
    (value * 1_000_000 + 3599) / 3600
}

/// Streckengeschwindigkeit der zweigleisigen Strecke: 160 km/h.
pub const LINE_SPEED_MM_S: i64 = kmh(160);
/// Streckengeschwindigkeit des eingleisigen Astes: 100 km/h.
pub const BRANCH_SPEED_MM_S: i64 = kmh(100);
/// Geschwindigkeit über die Bahnhofsgleise: 60 km/h.
///
/// Bewusst niedrig: Der Spike rechnet ohne Anfahr- und Bremskurve (das ist
/// M1.10). Die niedrigere Bahnhofsgeschwindigkeit bildet den Zeitverlust beim
/// Anfahren und Bremsen grob nach, statt ihn zu unterschlagen.
pub const STATION_SPEED_MM_S: i64 = kmh(60);

/// Kennung einer Konfliktressource innerhalb eines [`Network`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceId(u16);

impl ResourceId {
    /// Der Index in [`Network::sections`].
    pub const fn index(self) -> usize {
        self.0 as usize
    }

    /// Der rohe Zahlenwert — geht so in den Zustands-Hash ein.
    pub const fn raw(self) -> u16 {
        self.0
    }
}

impl fmt::Display for ResourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "R{}", self.0)
    }
}

/// Kennung eines Segments innerhalb eines [`Network`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SegmentId(u16);

impl SegmentId {
    /// Der Index in [`Network::segments`].
    pub const fn index(self) -> usize {
        self.0 as usize
    }
}

/// Fahrtrichtung entlang des Korridors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Direction {
    /// Nordstadt → Talheim, in Richtung steigender Kilometrierung.
    Outbound,
    /// Talheim → Nordstadt, in Richtung fallender Kilometrierung.
    Inbound,
}

impl Direction {
    /// Die Gegenrichtung.
    pub const fn opposite(self) -> Self {
        match self {
            Self::Outbound => Self::Inbound,
            Self::Inbound => Self::Outbound,
        }
    }

    /// Kurzbezeichnung für Bericht und Bildfahrplan.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Outbound => "Richtung Talheim",
            Self::Inbound => "Richtung Nordstadt",
        }
    }
}

/// Wie ein Gleis befahren wird — und damit, wer sich um es streiten kann.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackUsage {
    /// Richtungsgleis der zweigleisigen Strecke: nur eine Fahrtrichtung.
    Directional(Direction),
    /// Eingleisiger Abschnitt: **beide** Richtungen teilen sich dieselbe
    /// Konfliktressource. Genau hier entsteht die Gegenfahrt.
    Bidirectional,
    /// Bahnhofsgleis: von beiden Richtungen befahrbar, aber immer nur von einem
    /// Zug.
    Platform,
}

impl TrackUsage {
    /// Ob ein Zug dieser Richtung das Gleis befahren darf.
    pub const fn allows(self, direction: Direction) -> bool {
        match self {
            Self::Directional(erlaubt) => matches!(
                (erlaubt, direction),
                (Direction::Outbound, Direction::Outbound)
                    | (Direction::Inbound, Direction::Inbound)
            ),
            Self::Bidirectional | Self::Platform => true,
        }
    }
}

/// Eine Betriebsstelle — Bahnhof, Haltepunkt, Abzweigstelle.
#[derive(Clone, Debug)]
pub struct OperatingPoint {
    /// Betriebsstellenkürzel, etwa `Nst`.
    pub code: &'static str,
    /// Ausgeschriebener Name.
    pub name: &'static str,
}

/// Ein Abschnitt des Korridors: entweder eine Betriebsstelle oder freie Strecke.
#[derive(Clone, Debug)]
pub struct Segment {
    /// Kennung.
    pub id: SegmentId,
    /// Betriebsstelle, falls dieses Segment eine ist.
    pub operating_point: Option<OperatingPoint>,
    /// Anzeigename im Bildfahrplan.
    pub name: &'static str,
    /// Anfang entlang des Korridors.
    pub start_mm: i64,
    /// Ende entlang des Korridors.
    pub end_mm: i64,
    /// Anzahl nebeneinanderliegender Gleise — bestimmt die Zeichnung.
    pub lanes: u8,
}

impl Segment {
    /// Länge des Segments.
    pub const fn length_mm(&self) -> i64 {
        self.end_mm - self.start_mm
    }
}

/// Ein Blockabschnitt oder Bahnhofsgleis — die Konfliktressource des Spikes.
///
/// Der Spike kennt bewusst nur diese eine Art von Konfliktressource. Weichen,
/// Fahrstraßen und kreuzende Bewegungen im Bahnhofskopf fehlen; sie hängen an
/// der Fahrstraßenableitung aus M1.7 und sind in der README als offener Punkt
/// vermerkt.
#[derive(Clone, Debug)]
pub struct BlockSection {
    /// Kennung.
    pub id: ResourceId,
    /// Segment, in dem der Abschnitt liegt.
    pub segment: SegmentId,
    /// Voller Name für Bericht und Konflikterklärung.
    pub name: String,
    /// Kurzname für die Beschriftung im Bildfahrplan.
    pub short: String,
    /// Gleisbezeichnung innerhalb des Segments, etwa `Gleis 2` oder `Gleis A`.
    pub track: String,
    /// Spurindex innerhalb des Segments — nur für die Zeichnung.
    pub lane: u8,
    /// Anfang entlang des Korridors.
    pub start_mm: i64,
    /// Ende entlang des Korridors.
    pub end_mm: i64,
    /// Befahrbarkeit.
    pub usage: TrackUsage,
    /// Zulässige Geschwindigkeit im Abschnitt.
    pub max_speed_mm_s: i64,
}

impl BlockSection {
    /// Länge des Abschnitts.
    pub const fn length_mm(&self) -> i64 {
        self.end_mm - self.start_mm
    }

    /// Ob der Abschnitt eingleisig ist und damit Gegenfahrten ausschließt.
    pub const fn is_single_track(&self) -> bool {
        matches!(self.usage, TrackUsage::Bidirectional)
    }
}

/// Der Annäherungsabschnitt vor einem Hauptsignal — der Vorsignalabstand.
#[derive(Clone, Copy, Debug)]
pub struct ApproachSection {
    /// Länge des Abschnitts.
    pub length_mm: i64,
}

/// Der Durchrutschweg hinter dem Zielsignal.
#[derive(Clone, Copy, Debug)]
pub struct OverlapPath {
    /// Länge des Weges.
    pub length_mm: i64,
}

/// Die signaltechnischen Zeiten und Längen, aus denen sich die Sperrzeit
/// zusammensetzt.
///
/// Im echten Netz hängen sie am Stellwerkstyp, an der Zugsicherung und am
/// einzelnen Signal. Der Spike hält sie netzweit konstant — das ist die
/// größte Vereinfachung des Modells und in der README benannt.
#[derive(Clone, Copy, Debug)]
pub struct SignallingParameters {
    /// Fahrstraßenbildezeit: Stellen und Festlegen des Fahrwegs.
    pub route_setting_time_s: i64,
    /// Signalsichtzeit: vom Erkennen des Vorsignals bis zum Vorsignal selbst.
    pub signal_sighting_time_s: i64,
    /// Fahrstraßenauflösezeit nach dem Räumen.
    pub route_release_time_s: i64,
    /// Annäherungsabschnitt vor dem Hauptsignal.
    pub approach: ApproachSection,
    /// Durchrutschweg hinter dem Zielsignal.
    pub overlap: OverlapPath,
}

impl SignallingParameters {
    /// Die Werte des Spikes: 12 s Bildezeit, 5 s Signalsicht, 6 s Auflösung,
    /// 1000 m Vorsignalabstand, 200 m Durchrutschweg.
    pub const fn spike_defaults() -> Self {
        Self {
            route_setting_time_s: 12,
            signal_sighting_time_s: 5,
            route_release_time_s: 6,
            approach: ApproachSection {
                length_mm: 1_000_000,
            },
            overlap: OverlapPath { length_mm: 200_000 },
        }
    }
}

/// Der betriebliche Graph des Spikes.
#[derive(Clone, Debug)]
pub struct Network {
    segments: Vec<Segment>,
    sections: Vec<BlockSection>,
    signalling: SignallingParameters,
}

impl Network {
    /// Die Beispielinfrastruktur aus M0.3.
    ///
    /// ```text
    /// Nordstadt ══════ zweigleisig, 12 km ══════ Sandberg ─── eingleisig, 9 km ─── Talheim
    ///  Gleis 1/2/3        Gleis A (Ri. Talheim)   Gleis 1/2/3                       Gleis 1/2
    ///                     Gleis B (Ri. Nordstadt)
    /// ```
    pub fn example() -> Self {
        let mut builder = Builder::new(SignallingParameters::spike_defaults());
        builder.operating_point(
            "Nst",
            "Nordstadt",
            800_000,
            &["Gleis 1", "Gleis 2", "Gleis 3"],
        );
        builder.double_track("Nordstadt – Sandberg", 12_000_000, 3);
        builder.operating_point(
            "Sbg",
            "Sandberg",
            1_000_000,
            &["Gleis 1", "Gleis 2", "Gleis 3"],
        );
        builder.single_track("Sandberg – Talheim", "Sbg–Tlh", 9_000_000, 2);
        builder.operating_point("Tlh", "Talheim", 600_000, &["Gleis 1", "Gleis 2"]);
        builder.finish()
    }

    /// Alle Segmente in Reihenfolge der Kilometrierung.
    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    /// Alle Konfliktressourcen.
    pub fn sections(&self) -> &[BlockSection] {
        &self.sections
    }

    /// Die signaltechnischen Parameter.
    pub const fn signalling(&self) -> SignallingParameters {
        self.signalling
    }

    /// Länge des gesamten Korridors.
    pub fn length_mm(&self) -> i64 {
        self.segments.last().map_or(0, |segment| segment.end_mm)
    }

    /// Ein Abschnitt zu seiner Kennung.
    ///
    /// # Panics
    ///
    /// Wenn die Kennung nicht aus diesem Netz stammt.
    pub fn section(&self, id: ResourceId) -> &BlockSection {
        self.sections
            .get(id.index())
            .unwrap_or_else(|| panic!("unbekannte Konfliktressource {id}"))
    }

    /// Das Segment zu seiner Kennung.
    ///
    /// # Panics
    ///
    /// Wenn die Kennung nicht aus diesem Netz stammt.
    pub fn segment(&self, id: SegmentId) -> &Segment {
        self.segments
            .get(id.index())
            .unwrap_or_else(|| panic!("unbekanntes Segment {}", id.index()))
    }

    /// Die Betriebsstelle, in der ein Abschnitt liegt — falls er in einer liegt.
    pub fn operating_point_of(&self, id: ResourceId) -> Option<&OperatingPoint> {
        self.segment(self.section(id).segment)
            .operating_point
            .as_ref()
    }

    /// Baut einen Laufweg in Fahrtrichtung über die angegebenen Gleise der
    /// Betriebsstellen.
    ///
    /// `platforms` nennt für jede berührte Betriebsstelle in Fahrtreihenfolge
    /// das Gleis. Die Abschnitte der freien Strecke ergeben sich aus der
    /// Richtung: auf der zweigleisigen Strecke das Richtungsgleis, auf dem
    /// eingleisigen Ast der einzige Abschnitt.
    ///
    /// # Panics
    ///
    /// Wenn ein Gleis nicht existiert oder die Anzahl der Gleisangaben nicht zur
    /// Zahl der Betriebsstellen passt. Ein Laufweg, der nicht auf das Netz
    /// passt, ist ein Fehler im Szenario und soll laut auffallen.
    pub fn itinerary(&self, direction: Direction, platforms: &[&str]) -> Itinerary {
        let mut sections: Vec<ResourceId> = Vec::new();
        let mut naechstes_gleis = 0_usize;

        let reihenfolge: Vec<&Segment> = match direction {
            Direction::Outbound => self.segments.iter().collect(),
            Direction::Inbound => self.segments.iter().rev().collect(),
        };

        for segment in reihenfolge {
            let mut treffer: Vec<&BlockSection> = self
                .sections
                .iter()
                .filter(|section| section.segment == segment.id)
                .filter(|section| section.usage.allows(direction))
                .collect();

            if segment.operating_point.is_some() {
                let gleis = platforms.get(naechstes_gleis).unwrap_or_else(|| {
                    panic!(
                        "für {} ist kein Gleis angegeben — {} Betriebsstellen, {} Angaben",
                        segment.name,
                        self.segments
                            .iter()
                            .filter(|s| s.operating_point.is_some())
                            .count(),
                        platforms.len()
                    )
                });
                naechstes_gleis += 1;
                let gewaehlt = treffer
                    .iter()
                    .find(|section| section.track == *gleis)
                    .unwrap_or_else(|| panic!("{} hat kein {gleis}", segment.name));
                sections.push(gewaehlt.id);
                continue;
            }

            treffer.sort_by_key(|section| match direction {
                Direction::Outbound => section.start_mm,
                Direction::Inbound => -section.start_mm,
            });
            sections.extend(treffer.iter().map(|section| section.id));
        }

        assert_eq!(
            naechstes_gleis,
            platforms.len(),
            "es wurden mehr Gleise angegeben als Betriebsstellen befahren werden"
        );

        Itinerary {
            direction,
            sections,
        }
    }
}

/// Der Laufweg einer Zugfahrt: die Folge der befahrenen Konfliktressourcen.
#[derive(Clone, Debug)]
pub struct Itinerary {
    /// Fahrtrichtung entlang des Korridors.
    pub direction: Direction,
    /// Die befahrenen Abschnitte in Fahrtreihenfolge.
    pub sections: Vec<ResourceId>,
}

/// Hilfskonstrukt, das die Kilometrierung fortschreibt, damit sie nirgends von
/// Hand addiert werden muss.
struct Builder {
    segments: Vec<Segment>,
    sections: Vec<BlockSection>,
    signalling: SignallingParameters,
    position_mm: i64,
}

impl Builder {
    fn new(signalling: SignallingParameters) -> Self {
        Self {
            segments: Vec::new(),
            sections: Vec::new(),
            signalling,
            position_mm: 0,
        }
    }

    fn next_segment_id(&self) -> SegmentId {
        SegmentId(u16::try_from(self.segments.len()).expect("Segmentzahl passt in 16 Bit"))
    }

    fn next_resource_id(&self) -> ResourceId {
        ResourceId(u16::try_from(self.sections.len()).expect("Ressourcenzahl passt in 16 Bit"))
    }

    fn operating_point(
        &mut self,
        code: &'static str,
        name: &'static str,
        length_mm: i64,
        tracks: &[&'static str],
    ) {
        let id = self.next_segment_id();
        let start_mm = self.position_mm;
        let end_mm = start_mm + length_mm;
        self.segments.push(Segment {
            id,
            operating_point: Some(OperatingPoint { code, name }),
            name,
            start_mm,
            end_mm,
            lanes: u8::try_from(tracks.len()).expect("Gleiszahl passt in 8 Bit"),
        });

        for (lane, track) in tracks.iter().enumerate() {
            let resource = self.next_resource_id();
            self.sections.push(BlockSection {
                id: resource,
                segment: id,
                name: format!("{name} {track}"),
                short: format!("{code} {}", track.trim_start_matches("Gleis ")),
                track: (*track).to_owned(),
                lane: u8::try_from(lane).expect("Spurindex passt in 8 Bit"),
                start_mm,
                end_mm,
                usage: TrackUsage::Platform,
                max_speed_mm_s: STATION_SPEED_MM_S,
            });
        }

        self.position_mm = end_mm;
    }

    fn double_track(&mut self, name: &'static str, length_mm: i64, blocks: i64) {
        let id = self.next_segment_id();
        let start_mm = self.position_mm;
        let end_mm = start_mm + length_mm;
        self.segments.push(Segment {
            id,
            operating_point: None,
            name,
            start_mm,
            end_mm,
            lanes: 2,
        });

        for (lane, (gleis, richtung)) in [
            ("Gleis A", Direction::Outbound),
            ("Gleis B", Direction::Inbound),
        ]
        .into_iter()
        .enumerate()
        {
            let kuerzel = if lane == 0 { 'A' } else { 'B' };
            for block in 0..blocks {
                let resource = self.next_resource_id();
                let block_start = start_mm + length_mm * block / blocks;
                let block_end = start_mm + length_mm * (block + 1) / blocks;
                self.sections.push(BlockSection {
                    id: resource,
                    segment: id,
                    name: format!("{name} Block {}, {gleis}", block + 1),
                    short: format!("{kuerzel}{}", block + 1),
                    track: gleis.to_owned(),
                    lane: u8::try_from(lane).expect("Spurindex passt in 8 Bit"),
                    start_mm: block_start,
                    end_mm: block_end,
                    usage: TrackUsage::Directional(richtung),
                    max_speed_mm_s: LINE_SPEED_MM_S,
                });
            }
        }

        self.position_mm = end_mm;
    }

    fn single_track(
        &mut self,
        name: &'static str,
        short: &'static str,
        length_mm: i64,
        blocks: i64,
    ) {
        let id = self.next_segment_id();
        let start_mm = self.position_mm;
        let end_mm = start_mm + length_mm;
        self.segments.push(Segment {
            id,
            operating_point: None,
            name,
            start_mm,
            end_mm,
            lanes: 1,
        });

        for block in 0..blocks {
            let resource = self.next_resource_id();
            let block_start = start_mm + length_mm * block / blocks;
            let block_end = start_mm + length_mm * (block + 1) / blocks;
            self.sections.push(BlockSection {
                id: resource,
                segment: id,
                name: format!("{name} Block {} (eingleisig)", block + 1),
                short: format!("{short} {}", block + 1),
                track: "eingleisig".to_owned(),
                lane: 0,
                start_mm: block_start,
                end_mm: block_end,
                usage: TrackUsage::Bidirectional,
                max_speed_mm_s: BRANCH_SPEED_MM_S,
            });
        }

        self.position_mm = end_mm;
    }

    fn finish(self) -> Network {
        Network {
            segments: self.segments,
            sections: self.sections,
            signalling: self.signalling,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Direction, Network, TrackUsage};

    #[test]
    fn das_netz_hat_drei_betriebsstellen() {
        let netz = Network::example();
        let betriebsstellen = netz
            .segments()
            .iter()
            .filter(|segment| segment.operating_point.is_some())
            .count();
        assert_eq!(betriebsstellen, 3);
    }

    #[test]
    fn abschnitte_liegen_lueckenlos_hintereinander() {
        // Der Korridor ist die Weg-Achse des Bildfahrplans. Eine Lücke oder
        // Überlappung wäre dort sofort sichtbar — und im Modell falsch.
        let netz = Network::example();
        for segment in netz.segments() {
            let mut je_spur = vec![segment.start_mm; usize::from(segment.lanes)];
            for section in netz.sections() {
                if section.segment != segment.id {
                    continue;
                }
                let spur = usize::from(section.lane);
                assert_eq!(
                    je_spur[spur], section.start_mm,
                    "Lücke vor {} auf Spur {spur}",
                    section.name
                );
                je_spur[spur] = section.end_mm;
            }
            for ende in je_spur {
                assert_eq!(ende, segment.end_mm, "{} endet nicht bündig", segment.name);
            }
        }
    }

    #[test]
    fn der_ast_ist_eingleisig_die_strecke_nicht() {
        let netz = Network::example();
        let eingleisig = netz
            .sections()
            .iter()
            .filter(|section| section.is_single_track())
            .count();
        assert_eq!(eingleisig, 2, "der Ast besteht aus zwei Blockabschnitten");

        for section in netz.sections() {
            if let TrackUsage::Directional(richtung) = section.usage {
                assert!(!section.usage.allows(richtung.opposite()));
            }
        }
    }

    #[test]
    fn der_laufweg_folgt_der_fahrtrichtung() {
        let netz = Network::example();
        let hin = netz.itinerary(Direction::Outbound, &["Gleis 1", "Gleis 2", "Gleis 1"]);
        let zurueck = netz.itinerary(Direction::Inbound, &["Gleis 2", "Gleis 3", "Gleis 2"]);

        assert_eq!(hin.sections.len(), zurueck.sections.len());
        let erster = netz.section(hin.sections[0]);
        assert_eq!(erster.name, "Nordstadt Gleis 1");
        let letzter = netz.section(*zurueck.sections.last().expect("Laufweg ist nicht leer"));
        assert_eq!(letzter.name, "Nordstadt Gleis 2");

        // Beide Richtungen benutzen dieselben eingleisigen Abschnitte — das ist
        // der Grund, warum es in diesem Netz überhaupt eine Gegenfahrt gibt.
        let hin_eingleisig: Vec<_> = hin
            .sections
            .iter()
            .filter(|id| netz.section(**id).is_single_track())
            .collect();
        let zurueck_eingleisig: Vec<_> = zurueck
            .sections
            .iter()
            .filter(|id| netz.section(**id).is_single_track())
            .collect();
        assert_eq!(hin_eingleisig.len(), 2);
        for id in &hin_eingleisig {
            assert!(zurueck_eingleisig.contains(id));
        }
    }

    #[test]
    #[should_panic(expected = "hat kein Gleis 9")]
    fn ein_unbekanntes_gleis_faellt_auf() {
        let _ =
            Network::example().itinerary(Direction::Outbound, &["Gleis 9", "Gleis 2", "Gleis 1"]);
    }
}
