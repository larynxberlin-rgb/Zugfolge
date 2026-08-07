//! Blockableitung aus Signalpositionen, Zugbeeinflussung und Topologie — **M1.6**.
//!
//! `docs/daten.md` 1 nennt die Blockabschnitte ausdrücklich als eine der drei
//! Angaben, die OSM **nicht** als Objekte führt und die deshalb abgeleitet
//! werden müssen — aus Signalstandort, Zugbeeinflussung und Topologie. Diese
//! Datei liefert das Verfahren: [`derive_block_sections`] zerlegt ein Gleis in
//! die lückenlose Folge seiner [`BlockSection`]s.
//!
//! ## Die drei Eingaben
//!
//! **Signalpositionen.** Ein Hauptsignal begrenzt einen Block; ein Vorsignal
//! kündigt es nur an und begrenzt keinen. Neben dem ortsfesten Hauptsignal
//! kennt das Verfahren die **Blockkennzeichen der Führerraumsignalisierung**:
//! Eine reine LZB- oder eine reine ETCS-Strecke hat gar keine ortsfesten
//! Hauptsignale, ihre Blockgrenzen liegen als LZB-Blockkennzeichen oder
//! ETCS-Blockmarken vor ([`SignalKind`]). Aus allen diesen Grenzen und den
//! beiden Gleisenden — der Topologie: ein Gleis endet an einer Betriebsstelle,
//! und dort beginnt ein neuer Block — entstehen die **realen Blockgrenzen**.
//!
//! **Zugbeeinflussung entscheidet die Art des Blocks.** Läuft ein Abschnitt
//! durchgehend unter LZB oder ETCS Level 2, ist er **führerraumsignalisiert**
//! ([`BlockKind::CabSignalled`]) — ein realer Block, auch ohne ein einziges
//! ortsfestes Signal und auch über große Länge. Das ist der Fall der reinen
//! LZB- und der reinen ETCS-Strecke. Ein ungesicherter Abschnitt dagegen trägt
//! keine Zugfahrten (`docs/betriebsgraph.md` 2) und erreicht nur Klasse C.
//!
//! **Lücken werden zu virtuellen Blöcken.** Nur wo weder ein Signal noch ein
//! Blockkennzeichen vorliegt **und** keine durchgehende Überwachung einspringt,
//! gilt ein zu langer Abschnitt als Datenlücke: Ein so langer Block ohne jede
//! Sicherungsangabe ist unwahrscheinlich, also wurde vermutlich etwas nicht
//! erfasst. Solche Lücken füllt das Verfahren konservativ mit gleich langen
//! **virtuellen Blöcken** ([`BlockKind::Virtual`], `docs/daten.md` 5, Klasse B).
//!
//! ## Qualitätsklassifizierung A/B/C
//!
//! Jeder Block trägt eine [`QualityClass`](crate::QualityClass), wie der
//! Milestone verlangt. Sie fasst die drei Eingaben zusammen: ein realer Block —
//! signalisiert **oder** führerraumsignalisiert — auf erfasster, durchgehend
//! gesicherter Strecke erreicht Klasse A; ein virtueller Block Klasse B; ein
//! Block über einem ungesicherten Abschnitt Klasse C. Das setzt die Abbildung
//! aus M1.4 fort — dort war die erfasste Signal- und Blockprüfung noch offen,
//! hier wird sie geliefert.
//!
//! **Was diese Datei nicht ist: ein Import.** Wie beim Neigungsprofil (M1.5)
//! liefert M1.6 nur das Verfahren. Die Signale werden aus einem genehmigten
//! Extract gelesen, sobald ein eigener Import sie bereitstellt; an dieser
//! Funktion ändert sich dadurch nichts. [`Signal`] ist eine Position-Art-Angabe,
//! gleich woher sie stammt.

use std::collections::BTreeSet;

use crate::bands::BandProfile;
use crate::coverage::QualityClass;
use crate::error::InfraError;
use crate::identity::TrackId;
use crate::protection::{ProtectionSystem, TrainProtection};
use crate::provenance::{Confidence, SourceId};
use crate::track::Track;
use crate::units::Length;

/// Eine geeignete Standard-Höchstlänge für Blöcke.
///
/// 2000 m sind kürzer als der längste betrieblich übliche Blockabschnitt und
/// lang genug, dass ein Bahnhofsgleis oder ein kurzer Streckenabschnitt ein
/// einziger Block bleibt. Als Obergrenze für virtuelle Blöcke ist der Wert
/// bewusst konservativ: kürzere Blöcke senken die Kapazität, und eine zu hoch
/// angesetzte Kapazität wäre die gefährlichere Annahme. Auf reale und
/// führerraumsignalisierte Blöcke wirkt er nicht — die dürfen länger sein.
pub const DEFAULT_MAX_BLOCK_LENGTH: Length = Length::from_metres(2_000);

/// Die Art eines Signals oder Blockkennzeichens.
///
/// Für die Blockgrenzen zählt jedes Kennzeichen, das einen Block begrenzt —
/// das ortsfeste Hauptsignal ebenso wie das Blockkennzeichen der
/// Führerraumsignalisierung, das auf reinen LZB- und ETCS-Strecken an dessen
/// Stelle tritt. Das Vorsignal kündigt nur an und begrenzt keinen Block.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SignalKind {
    /// Hauptsignal — ortsfestes Signal, begrenzt einen Blockabschnitt (Ein-,
    /// Aus-, Block- oder Zwischensignal).
    Main,
    /// Vorsignal — kündigt ein Hauptsignal an, begrenzt keinen Block.
    Distant,
    /// LZB-Blockkennzeichen — Blockgrenze einer LZB-geführten Strecke, ohne
    /// ortsfestes Hauptsignal. Der Grenzstein des reinen LZB-Blocks.
    LzbBlockMarker,
    /// ETCS-Blockmarke — Blockgrenze einer ETCS-geführten Strecke, ohne
    /// ortsfestes Hauptsignal. Der Grenzstein des reinen ETCS-Blocks.
    EtcsBlockMarker,
}

impl SignalKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Distant => "distant",
            Self::LzbBlockMarker => "lzb-block-marker",
            Self::EtcsBlockMarker => "etcs-block-marker",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Main => "Hauptsignal",
            Self::Distant => "Vorsignal",
            Self::LzbBlockMarker => "LZB-Blockkennzeichen",
            Self::EtcsBlockMarker => "ETCS-Blockmarke",
        }
    }

    /// Ob das Kennzeichen einen Blockabschnitt begrenzt. Jedes außer dem
    /// Vorsignal tut das.
    pub const fn bounds_block(self) -> bool {
        !matches!(self, Self::Distant)
    }

    /// Ob es ein ortsfestes Hauptsignal ist — im Unterschied zu einem
    /// Blockkennzeichen der Führerraumsignalisierung.
    pub const fn is_lineside_main(self) -> bool {
        matches!(self, Self::Main)
    }
}

/// Ein Signal oder Blockkennzeichen an einer Position entlang eines Gleises.
///
/// `position` zählt wie jede Position in diesem Modell ab dem Gleisanfang in
/// Richtung wachsender Kilometrierung (Invariante 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Signal {
    position: Length,
    kind: SignalKind,
}

impl Signal {
    /// Ein Signal an einer Position mit einer Art.
    pub const fn new(position: Length, kind: SignalKind) -> Self {
        Self { position, kind }
    }

    /// Ein Hauptsignal an einer Position.
    pub const fn main(position: Length) -> Self {
        Self::new(position, SignalKind::Main)
    }

    /// Ein Vorsignal an einer Position.
    pub const fn distant(position: Length) -> Self {
        Self::new(position, SignalKind::Distant)
    }

    /// Ein LZB-Blockkennzeichen an einer Position.
    pub const fn lzb_block_marker(position: Length) -> Self {
        Self::new(position, SignalKind::LzbBlockMarker)
    }

    /// Eine ETCS-Blockmarke an einer Position.
    pub const fn etcs_block_marker(position: Length) -> Self {
        Self::new(position, SignalKind::EtcsBlockMarker)
    }

    /// Die Position entlang des Gleises.
    pub const fn position(&self) -> Length {
        self.position
    }

    /// Die Art des Signals.
    pub const fn kind(&self) -> SignalKind {
        self.kind
    }
}

/// Wie ein Block entstanden ist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BlockKind {
    /// Von ortsfesten Hauptsignalen begrenzt — der konventionelle, ortsfest
    /// signalisierte Block.
    Signalled,
    /// Von der Führerraumsignalisierung begrenzt — LZB oder ETCS Level 2, ohne
    /// ortsfestes Hauptsignal. Der reine LZB- oder ETCS-Block.
    CabSignalled,
    /// Konservativ erzeugt, weil weder ein Signal noch ein Blockkennzeichen
    /// vorliegt und keine durchgehende Überwachung einspringt.
    Virtual,
}

impl BlockKind {
    /// Stabile Kennung, etwa für Berichte in anderen Systemen.
    pub const fn tag(self) -> &'static str {
        match self {
            Self::Signalled => "signalled",
            Self::CabSignalled => "cab-signalled",
            Self::Virtual => "virtual",
        }
    }

    /// Deutsche Bezeichnung für Berichte und Meldungen.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Signalled => "signalisiert",
            Self::CabSignalled => "führerraumsignalisiert",
            Self::Virtual => "virtuell",
        }
    }

    /// Ob der Block auf einer realen Grenze beruht — einem Signal oder der
    /// durchgehenden Überwachung — und nicht bloß konservativ erzeugt wurde.
    pub const fn is_real(self) -> bool {
        matches!(self, Self::Signalled | Self::CabSignalled)
    }

    /// Der Vertrauensgrad, den diese Art von Block für sich trägt: ein realer
    /// Block ist erfasst, ein virtueller nur abgeleitet.
    const fn basis_confidence(self) -> Confidence {
        match self {
            Self::Signalled | Self::CabSignalled => Confidence::Surveyed,
            Self::Virtual => Confidence::Derived,
        }
    }
}

/// Ein Blockabschnitt: ein Stück Gleis, das zur selben Zeit nur ein Zug
/// befahren darf (`docs/glossar.md`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockSection {
    track: TrackId,
    start: Length,
    end: Length,
    kind: BlockKind,
    protection: TrainProtection,
    class: QualityClass,
    source: SourceId,
}

impl BlockSection {
    /// Das Gleis, auf dem der Block liegt.
    pub const fn track(&self) -> TrackId {
        self.track
    }

    /// Der Anfang des Blocks, ab dem Gleisanfang gezählt.
    pub const fn start(&self) -> Length {
        self.start
    }

    /// Das Ende des Blocks.
    pub const fn end(&self) -> Length {
        self.end
    }

    /// Die Ausdehnung des Blocks.
    pub fn length(&self) -> Length {
        self.end - self.start
    }

    /// Wie der Block entstanden ist.
    pub const fn kind(&self) -> BlockKind {
        self.kind
    }

    /// Die Zugsicherung, die über den ganzen Block verfügbar ist — die
    /// Schnittmenge der Systeme über seine Länge. Auf einem reinen LZB-Block
    /// steht hier genau LZB, auf einem reinen ETCS-Block genau ETCS L2. Leer,
    /// wenn kein System den ganzen Block durchzieht.
    pub const fn protection(&self) -> &TrainProtection {
        &self.protection
    }

    /// Die Qualitätsklasse des Blocks.
    pub const fn class(&self) -> QualityClass {
        self.class
    }

    /// Die Herkunft der Signale und Sicherungsdaten, aus denen der Block
    /// abgeleitet wurde.
    pub const fn source(&self) -> &SourceId {
        &self.source
    }

    /// Ob eine Position in diesen Block fällt — Anfang einschließlich, Ende
    /// ausschließlich.
    pub fn contains(&self, position: Length) -> bool {
        self.start <= position && position < self.end
    }
}

/// Die für die Blockbildung wichtige Zusammenfassung der Zugsicherung über
/// einen Abschnitt.
struct ProtectionSummary {
    /// Der schwächste Vertrauensgrad der überdeckten Sicherungsbänder.
    confidence: Confidence,
    /// Ob ein Teil des Abschnitts ohne Zugbeeinflussung ist.
    any_unprotected: bool,
    /// Ob der Abschnitt durchgehend führerraumsignalisiert ist (LZB oder ETCS
    /// Level 2 über die volle Länge).
    continuous: bool,
    /// Die Systeme, die den **ganzen** Abschnitt durchziehen.
    governing: TrainProtection,
}

/// `start + round(index * span / count)` — ganzzahlig, wie jede Rechnung in
/// diesem Modell (Invariante 3). `span` und `count` sind nicht negativ.
fn split_point(start: Length, span: Length, index: i64, count: i64) -> Length {
    let numerator = span.millimetres().saturating_mul(index);
    let half = count / 2;
    let offset = numerator.saturating_add(half) / count;
    start + Length::from_millimetres(offset)
}

/// Fasst die Zugsicherung über einen Abschnitt zusammen.
fn protection_over(
    protection: &BandProfile<TrainProtection>,
    start: Length,
    end: Length,
) -> ProtectionSummary {
    let mut confidence = Confidence::Surveyed;
    let mut any_unprotected = false;
    let mut continuous = true;
    let mut common: Option<BTreeSet<ProtectionSystem>> = None;
    let mut seen = false;

    for band in protection.bands() {
        // Nur Bänder, die den Abschnitt wirklich überdecken.
        if band.end() <= start || band.start() >= end {
            continue;
        }
        seen = true;
        confidence = confidence.weakest(band.confidence());
        if band.value().is_unprotected() {
            any_unprotected = true;
        }
        if !band.value().has_continuous_supervision() {
            continuous = false;
        }
        let systems: BTreeSet<ProtectionSystem> = band.value().systems().collect();
        common = Some(match common {
            Some(bisher) => bisher.intersection(&systems).copied().collect(),
            None => systems,
        });
    }

    if !seen {
        // Kann nicht vorkommen, weil das Profil das Gleis lückenlos abdeckt und
        // der Block im Gleis liegt — aber ein ungesicherter Rückfall ist die
        // sichere Annahme.
        any_unprotected = true;
        continuous = false;
    }

    ProtectionSummary {
        confidence,
        any_unprotected,
        continuous,
        governing: TrainProtection::from_systems(common.unwrap_or_default()),
    }
}

/// Bildet einen einzelnen Block und bestimmt seine Klasse aus Art und
/// Zugsicherung.
fn make_block(
    track: &Track,
    start: Length,
    end: Length,
    kind: BlockKind,
    source: &SourceId,
) -> BlockSection {
    let summary = protection_over(track.protection(), start, end);

    let class = if summary.any_unprotected {
        // Ein ungesicherter Abschnitt trägt keine Zugfahrten (E12) — kein
        // belastbarer Block, gleich wie sorgfältig seine Grenzen sind.
        QualityClass::C
    } else {
        QualityClass::from_confidence(kind.basis_confidence().weakest(summary.confidence))
    };

    BlockSection {
        track: track.id(),
        start,
        end,
        kind,
        protection: summary.governing,
        class,
        source: source.clone(),
    }
}

/// Wie ein Rohabschnitt zwischen zwei realen Grenzen zu behandeln ist.
enum SegmentPlan {
    /// Ein einziger Block der genannten Art.
    Single(BlockKind),
    /// Eine Datenlücke — in gleich lange virtuelle Blöcke zerlegen.
    SplitVirtual,
}

/// Entscheidet, ob ein Rohabschnitt ein Block bleibt oder eine Datenlücke ist.
///
/// Der Kern des Verfahrens: Eine durchgehend führerraumsignalisierte Strecke
/// ist **nie** eine Lücke — ihr Block ist real, auch ohne Hauptsignal und auch
/// über große Länge (der reine LZB- oder ETCS-Block). Nur wo jede reale Grenze
/// **und** die durchgehende Überwachung fehlen, wird ein zu langer Abschnitt
/// konservativ zerlegt.
fn plan_segment(
    raw_length_mm: i64,
    max_mm: i64,
    summary: &ProtectionSummary,
    any_main: bool,
    both_marked: bool,
    any_marked: bool,
) -> SegmentPlan {
    if summary.any_unprotected {
        return SegmentPlan::Single(BlockKind::Virtual);
    }
    if summary.continuous {
        // Durchgehend überwacht: ein realer Block, auch lang. Rein
        // führerraumsignalisiert, wenn kein Hauptsignal ihn begrenzt; sonst ein
        // ortsfest signalisierter Block mit LZB-/ETCS-Überlagerung.
        return SegmentPlan::Single(if any_main {
            BlockKind::Signalled
        } else {
            BlockKind::CabSignalled
        });
    }
    if both_marked {
        // Beidseitig von realen Grenzen begrenzt — ein realer Block, auch lang.
        return SegmentPlan::Single(BlockKind::Signalled);
    }
    if raw_length_mm <= max_mm {
        return SegmentPlan::Single(if any_marked {
            BlockKind::Signalled
        } else {
            BlockKind::Virtual
        });
    }
    SegmentPlan::SplitVirtual
}

/// Leitet die Blockabschnitte eines Gleises aus seinen Signalen, seiner
/// Zugsicherung und seiner Länge ab.
///
/// `signals` muss aufsteigend nach Position sortiert sein; jedes Signal liegt
/// zwischen Gleisanfang und Gleisende. Blockgrenzen setzen Hauptsignale und
/// Blockkennzeichen, nicht das Vorsignal. `max_block_length` ist die
/// Höchstlänge, mit der eine Datenlücke in virtuelle Blöcke zerlegt wird;
/// [`DEFAULT_MAX_BLOCK_LENGTH`] ist ein brauchbarer Standardwert. `source`
/// benennt die Herkunft der Signale.
///
/// Das Ergebnis deckt das Gleis lückenlos und überschneidungsfrei ab: Jede
/// Position liegt in genau einem Block.
///
/// # Errors
///
/// - [`InfraError::NonPositiveLength`], wenn `max_block_length` nicht positiv
///   ist.
/// - [`InfraError::UnorderedSignals`], wenn zwei Signale nicht aufsteigend
///   sortiert sind.
/// - [`InfraError::SignalOutsideTrack`], wenn ein Signal außerhalb des Gleises
///   liegt.
pub fn derive_block_sections(
    track: &Track,
    signals: &[Signal],
    max_block_length: Length,
    source: SourceId,
) -> Result<Vec<BlockSection>, InfraError> {
    if !max_block_length.is_positive() {
        return Err(InfraError::NonPositiveLength {
            what: "Blockhöchstlänge",
            value: max_block_length,
        });
    }

    let length = track.length();
    let mut previous: Option<Length> = None;
    let mut main_positions: BTreeSet<Length> = BTreeSet::new();
    let mut marker_positions: BTreeSet<Length> = BTreeSet::new();
    for signal in signals {
        if let Some(vorher) = previous {
            if signal.position() < vorher {
                return Err(InfraError::UnorderedSignals {
                    at: signal.position(),
                });
            }
        }
        previous = Some(signal.position());
        if signal.position().is_negative() || signal.position() > length {
            return Err(InfraError::SignalOutsideTrack {
                at: signal.position(),
                track_length: length,
            });
        }
        if signal.kind().bounds_block() {
            marker_positions.insert(signal.position());
            if signal.kind().is_lineside_main() {
                main_positions.insert(signal.position());
            }
        }
    }

    // Reale Grenzen: die beiden Gleisenden (Topologie) und jede Blockgrenze.
    let mut boundaries: BTreeSet<Length> = BTreeSet::new();
    boundaries.insert(Length::ZERO);
    boundaries.insert(length);
    boundaries.extend(marker_positions.iter().copied());

    let points: Vec<Length> = boundaries.into_iter().collect();
    let mut sections = Vec::with_capacity(points.len().saturating_sub(1));

    let max_mm = max_block_length.millimetres();
    for fenster in points.windows(2) {
        let [start, end] = fenster else { continue };
        let (start, end) = (*start, *end);
        let raw_length = (end - start).millimetres();
        let any_main = main_positions.contains(&start) || main_positions.contains(&end);
        let both_marked = marker_positions.contains(&start) && marker_positions.contains(&end);
        let any_marked = marker_positions.contains(&start) || marker_positions.contains(&end);
        let summary = protection_over(track.protection(), start, end);

        match plan_segment(
            raw_length,
            max_mm,
            &summary,
            any_main,
            both_marked,
            any_marked,
        ) {
            SegmentPlan::Single(kind) => {
                sections.push(make_block(track, start, end, kind, &source));
            }
            SegmentPlan::SplitVirtual => {
                let count = raw_length.saturating_add(max_mm - 1) / max_mm;
                for schritt in 0..count {
                    let block_start = split_point(start, end - start, schritt, count);
                    let block_end = split_point(start, end - start, schritt + 1, count);
                    sections.push(make_block(
                        track,
                        block_start,
                        block_end,
                        BlockKind::Virtual,
                        &source,
                    ));
                }
            }
        }
    }

    Ok(sections)
}

#[cfg(test)]
mod tests {
    use super::{
        BlockKind, BlockSection, DEFAULT_MAX_BLOCK_LENGTH, Signal, SignalKind,
        derive_block_sections,
    };
    use crate::bands::{Band, BandProfile};
    use crate::coverage::QualityClass;
    use crate::electrification::{Electrification, PowerSystem};
    use crate::error::InfraError;
    use crate::identity::{TrackEdgeId, TrackId};
    use crate::protection::{ProtectionSystem, TrainProtection};
    use crate::provenance::{Confidence, Provenance, SourceId};
    use crate::speed::SpeedLimit;
    use crate::track::{Track, TrackKind, TrackOwner};
    use crate::units::{Gradient, Length, Speed};

    fn quelle() -> SourceId {
        SourceId::new("beispielnetz").expect("gültige Quellenkennung")
    }

    fn herkunft(confidence: Confidence) -> Provenance {
        Provenance::new(quelle(), confidence)
    }

    /// Ein Streckengleis mit wählbarer Länge und Zugsicherung.
    fn gleis(length: Length, protection: BandProfile<TrainProtection>) -> Track {
        Track::builder(
            TrackId::new(1),
            TrackOwner::Edge(TrackEdgeId::new(1)),
            "Streckengleis",
            length,
        )
        .kind(TrackKind::ThroughMainTrack)
        .speed(
            BandProfile::uniform(
                "vmax",
                length,
                SpeedLimit::uniform(Speed::from_km_h(160)).expect("positiv"),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .gradient(
            BandProfile::uniform(
                "neigung",
                length,
                Gradient::LEVEL,
                herkunft(Confidence::Derived),
            )
            .expect("Profil deckt das Gleis"),
        )
        .electrification(
            BandProfile::uniform(
                "elektrifizierung",
                length,
                Electrification::Overhead(PowerSystem::Ac15kV),
                herkunft(Confidence::Surveyed),
            )
            .expect("Profil deckt das Gleis"),
        )
        .protection(protection)
        .build()
        .expect("gültiges Gleis")
    }

    fn einheitliche_sicherung(
        length: Length,
        protection: TrainProtection,
        confidence: Confidence,
    ) -> BandProfile<TrainProtection> {
        BandProfile::uniform("zugsicherung", length, protection, herkunft(confidence))
            .expect("Profil deckt das Gleis")
    }

    fn pzb(length: Length) -> BandProfile<TrainProtection> {
        einheitliche_sicherung(
            length,
            TrainProtection::single(ProtectionSystem::Pzb),
            Confidence::Surveyed,
        )
    }

    #[test]
    fn hauptsignale_setzen_die_blockgrenzen() {
        let length = Length::from_metres(3_000);
        let track = gleis(length, pzb(length));
        // Zwei Hauptsignale bei 1000 und 2000 m, dazu ein Vorsignal, das keine
        // Grenze setzen darf.
        let signals = [
            Signal::main(Length::from_metres(1_000)),
            Signal::distant(Length::from_metres(1_800)),
            Signal::main(Length::from_metres(2_000)),
        ];
        let bloecke = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        // Grenzen: 0, 1000, 2000, 3000 — drei Blöcke, das Vorsignal zählt nicht.
        assert_eq!(bloecke.len(), 3);
        assert_eq!(bloecke[0].start(), Length::ZERO);
        assert_eq!(bloecke[0].end(), Length::from_metres(1_000));
        assert_eq!(bloecke[1].end(), Length::from_metres(2_000));
        assert_eq!(bloecke[2].end(), length);
        assert!(bloecke.iter().all(|b| b.kind() == BlockKind::Signalled));
        // Erfasste Signale, erfasste Sicherung, PZB durchgehend → Klasse A.
        assert!(bloecke.iter().all(|b| b.class() == QualityClass::A));
    }

    #[test]
    fn die_bloecke_decken_das_gleis_lueckenlos_ab() {
        let length = Length::from_metres(5_000);
        let track = gleis(length, pzb(length));
        let signals = [Signal::main(Length::from_metres(1_500))];
        let bloecke = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.first().map(BlockSection::start), Some(Length::ZERO));
        assert_eq!(bloecke.last().map(BlockSection::end), Some(length));
        for paar in bloecke.windows(2) {
            assert_eq!(
                paar[0].end(),
                paar[1].start(),
                "keine Lücke, keine Überschneidung"
            );
        }
    }

    #[test]
    fn eine_reine_lzb_strecke_ist_ein_realer_block_ohne_signal() {
        // Eine lange, durchgehend LZB-geführte Strecke ganz ohne ortsfestes
        // Hauptsignal: **ein** realer, führerraumsignalisierter Block — keine
        // Datenlücke, kein virtueller Block, nicht in Stücke zerlegt.
        let length = Length::from_metres(12_000);
        let protection = einheitliche_sicherung(
            length,
            TrainProtection::from_systems([ProtectionSystem::Pzb, ProtectionSystem::Lzb]),
            Confidence::Surveyed,
        );
        let track = gleis(length, protection);
        let bloecke = derive_block_sections(&track, &[], DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 1, "ein einziger LZB-Block über 12 km");
        assert_eq!(bloecke[0].kind(), BlockKind::CabSignalled);
        assert_eq!(bloecke[0].class(), QualityClass::A);
        assert!(bloecke[0].protection().contains(ProtectionSystem::Lzb));
    }

    #[test]
    fn eine_reine_etcs_strecke_ist_ein_realer_block_ohne_signal() {
        // Reine ETCS-Level-2-Strecke ohne Hauptsignale: ein
        // führerraumsignalisierter Block, Klasse A.
        let length = Length::from_metres(20_000);
        let protection = einheitliche_sicherung(
            length,
            TrainProtection::single(ProtectionSystem::EtcsLevel2),
            Confidence::Surveyed,
        );
        let track = gleis(length, protection);
        let bloecke = derive_block_sections(&track, &[], DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 1);
        assert_eq!(bloecke[0].kind(), BlockKind::CabSignalled);
        assert_eq!(bloecke[0].class(), QualityClass::A);
        assert!(
            bloecke[0]
                .protection()
                .contains(ProtectionSystem::EtcsLevel2)
        );
        assert!(!bloecke[0].protection().contains(ProtectionSystem::Pzb));
    }

    #[test]
    fn blockkennzeichen_teilen_eine_lzb_strecke() {
        // Auf derselben LZB-Strecke geben LZB-Blockkennzeichen die genauen
        // Blockgrenzen: aus einem langen Block werden mehrere, alle real und
        // führerraumsignalisiert.
        let length = Length::from_metres(12_000);
        let protection = einheitliche_sicherung(
            length,
            TrainProtection::single(ProtectionSystem::Lzb),
            Confidence::Surveyed,
        );
        let track = gleis(length, protection);
        let signals = [
            Signal::lzb_block_marker(Length::from_metres(4_000)),
            Signal::lzb_block_marker(Length::from_metres(8_000)),
        ];
        let bloecke = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 3);
        assert!(bloecke.iter().all(|b| b.kind() == BlockKind::CabSignalled));
        assert!(bloecke.iter().all(|b| b.class() == QualityClass::A));
        assert_eq!(bloecke[1].start(), Length::from_metres(4_000));
        assert_eq!(bloecke[1].end(), Length::from_metres(8_000));
    }

    #[test]
    fn eine_lange_luecke_ohne_sicherung_wird_zu_virtuellen_bloecken() {
        // Kein Hauptsignal, kein Blockkennzeichen und nur punktförmige
        // Sicherung (PZB): das ganze Gleis ist ein zu langer Abschnitt ohne
        // Zeugnis → virtuelle Blöcke von höchstens 2000 m.
        let length = Length::from_metres(9_000);
        let track = gleis(length, pzb(length));
        let bloecke = derive_block_sections(&track, &[], DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 5, "9000 m bei 2000 m Höchstlänge → 5 Blöcke");
        assert!(bloecke.iter().all(|b| b.kind() == BlockKind::Virtual));
        assert!(bloecke.iter().all(|b| b.class() == QualityClass::B));
        assert!(
            bloecke
                .iter()
                .all(|b| b.length().millimetres() <= DEFAULT_MAX_BLOCK_LENGTH.millimetres()),
            "kein virtueller Block ist länger als die Höchstlänge"
        );
    }

    #[test]
    fn ein_langer_block_zwischen_zwei_signalen_bleibt_real() {
        let length = Length::from_metres(6_000);
        let track = gleis(length, pzb(length));
        // Zwei Hauptsignale bei 500 und 5500 m: der 5000-m-Block dazwischen ist
        // beidseitig signalisiert und wird deshalb NICHT zerlegt, obwohl er die
        // Höchstlänge überschreitet — reale Signalisierung erlaubt lange Blöcke.
        let signals = [
            Signal::main(Length::from_metres(500)),
            Signal::main(Length::from_metres(5_500)),
        ];
        let bloecke = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        let mittelblock = bloecke
            .iter()
            .find(|b| b.start() == Length::from_metres(500))
            .expect("der lange Mittelblock");
        assert_eq!(mittelblock.end(), Length::from_metres(5_500));
        assert_eq!(mittelblock.kind(), BlockKind::Signalled);
        assert_eq!(bloecke.len(), 3);
    }

    #[test]
    fn ein_ungesicherter_abschnitt_traegt_klasse_c() {
        let length = Length::from_metres(2_000);
        // Erste Hälfte PZB, zweite Hälfte ohne Zugbeeinflussung.
        let protection = BandProfile::new(
            "zugsicherung",
            length,
            vec![
                Band::new(
                    Length::ZERO,
                    Length::from_metres(1_000),
                    TrainProtection::single(ProtectionSystem::Pzb),
                    herkunft(Confidence::Surveyed),
                ),
                Band::new(
                    Length::from_metres(1_000),
                    length,
                    TrainProtection::unprotected(),
                    herkunft(Confidence::Surveyed),
                ),
            ],
        )
        .expect("Profil ist lückenlos");
        let track = gleis(length, protection);
        let signals = [Signal::main(Length::from_metres(1_000))];
        let bloecke = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 2);
        // Der gesicherte erste Block ist Klasse A, der ungesicherte zweite C.
        assert_eq!(bloecke[0].class(), QualityClass::A);
        assert!(bloecke[0].protection().contains(ProtectionSystem::Pzb));
        assert_eq!(bloecke[1].class(), QualityClass::C);
        assert!(bloecke[1].protection().is_unprotected());
    }

    #[test]
    fn ein_virtueller_block_ueber_angenommener_sicherung_wird_c() {
        let length = Length::from_metres(1_500);
        // Kurzes Gleis ohne Signal, nur punktförmige, angenommene Sicherung →
        // ein virtueller Block; angenommen verrechnet mit virtuell → C.
        let protection = einheitliche_sicherung(
            length,
            TrainProtection::single(ProtectionSystem::Pzb),
            Confidence::Assumed,
        );
        let track = gleis(length, protection);
        let bloecke = derive_block_sections(&track, &[], DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");

        assert_eq!(bloecke.len(), 1);
        assert_eq!(bloecke[0].kind(), BlockKind::Virtual);
        assert_eq!(bloecke[0].class(), QualityClass::C);
    }

    #[test]
    fn die_ableitung_ist_wiederholbar() {
        let length = Length::from_metres(7_000);
        let track = gleis(length, pzb(length));
        let signals = [
            Signal::main(Length::from_metres(1_000)),
            Signal::main(Length::from_metres(2_000)),
        ];
        let erste = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");
        let zweite = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect("gültige Ableitung");
        // Ein reines Verfahren ohne verborgenen Zustand: gleiche Eingabe, gleiche
        // Ausgabe. Das ist der Determinismusnachweis eines Rechenschritts.
        assert_eq!(erste, zweite);
    }

    #[test]
    fn unsortierte_signale_fallen_auf() {
        let length = Length::from_metres(3_000);
        let track = gleis(length, pzb(length));
        let signals = [
            Signal::main(Length::from_metres(2_000)),
            Signal::main(Length::from_metres(1_000)),
        ];
        let fehler = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect_err("die Signale sind nicht aufsteigend sortiert");
        assert!(matches!(fehler, InfraError::UnorderedSignals { .. }));
    }

    #[test]
    fn ein_signal_ausserhalb_des_gleises_faellt_auf() {
        let length = Length::from_metres(3_000);
        let track = gleis(length, pzb(length));
        let signals = [Signal::main(Length::from_metres(3_500))];
        let fehler = derive_block_sections(&track, &signals, DEFAULT_MAX_BLOCK_LENGTH, quelle())
            .expect_err("das Signal liegt hinter dem Gleisende");
        assert!(matches!(fehler, InfraError::SignalOutsideTrack { .. }));
    }

    #[test]
    fn eine_nicht_positive_hoechstlaenge_faellt_auf() {
        let length = Length::from_metres(3_000);
        let track = gleis(length, pzb(length));
        let fehler = derive_block_sections(&track, &[], Length::ZERO, quelle())
            .expect_err("eine Höchstlänge von null ist keine");
        assert!(matches!(fehler, InfraError::NonPositiveLength { .. }));
    }

    #[test]
    fn signalart_kennt_ihre_wirkung() {
        assert!(SignalKind::Main.bounds_block());
        assert!(SignalKind::Main.is_lineside_main());
        assert!(SignalKind::LzbBlockMarker.bounds_block());
        assert!(!SignalKind::LzbBlockMarker.is_lineside_main());
        assert!(SignalKind::EtcsBlockMarker.bounds_block());
        assert!(!SignalKind::Distant.bounds_block());
        assert_eq!(SignalKind::Main.label(), "Hauptsignal");
    }
}
