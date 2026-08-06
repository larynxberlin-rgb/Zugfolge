//! Der Bildfahrplan als Bild — Weg-Zeit-Diagramm mit Sperrzeitentreppe.
//!
//! Konvention schlägt Originalität (`docs/design.md` 1): Zeit läuft waagerecht,
//! der Weg senkrecht, Betriebsstellen sind waagerechte Linien, jede Zugfahrt
//! eine schräge Linie. Die Sperrzeiten liegen als Treppe darunter.
//!
//! Gestaltung nach `docs/design.md`: durchgehend dunkel, kein reines Schwarz,
//! die Zeichenfläche ist die dunkelste Fläche. **Farbe gehört dem Betrieb** —
//! die Normalfälle sind achromatisch, farbig ist ausschließlich der Konflikt.
//! Und weil ein Zustand nie allein über den Farbton kodiert werden darf (2.3),
//! trägt jeder Konflikt zusätzlich Schraffur und Kennung, und die beiden Züge
//! unterscheiden sich in der Strichart, nicht in der Farbe.
//!
//! Die Zahlen im SVG sind ganzzahlige Pixel. Die wenigen Dezimalwerte im
//! Ergebnis — Deckkraft, Strichstärke — sind feste Textbausteine, keine
//! gerechneten Werte; Invariante 3 bleibt unberührt.

use crate::blocking::BlockingTimeStaircase;
use crate::case::Case;
use crate::conflict::OccupationConflict;
use crate::network::{Direction, Network, ResourceId};
use crate::{clock, duration};

const WIDTH: i64 = 1440;
const PLOT_LEFT: i64 = 214;
const PLOT_RIGHT: i64 = 1410;
const PLOT_TOP: i64 = 104;
const PLOT_BOTTOM: i64 = 724;

/// Zeitraster: feine Linie je Minute, beschriftete Linie alle fünf Minuten.
const MINOR_GRID_S: i64 = 60;
const MAJOR_GRID_S: i64 = 300;

const BACKGROUND: &str = "#12141A";
const PLOT_BACKGROUND: &str = "#0B0D12";
const STATION_BAND: &str = "#171A22";
const GRID: &str = "#1E2230";
const GRID_MAJOR: &str = "#2B3141";
const STATION_LINE: &str = "#3D4557";
const TEXT: &str = "#D7DCE8";
const TEXT_DIM: &str = "#8B93A7";
const BAND: &str = "#7C8598";
const TRAIN: &str = "#EAEEF7";
const CONFLICT: &str = "#E2585B";

const SANS: &str = "IBM Plex Sans, Inter, Source Sans 3, system-ui, sans-serif";
const MONO: &str = "IBM Plex Mono, ui-monospace, SFMono-Regular, monospace";

/// Umrechnung zwischen Modellwerten und Bildkoordinaten.
struct Layout {
    t0: i64,
    t1: i64,
    corridor_mm: i64,
    height: i64,
}

impl Layout {
    fn new(network: &Network, staircases: &[BlockingTimeStaircase], conflicts: usize) -> Self {
        let erste = staircases
            .iter()
            .map(|treppe| treppe.first_second().seconds())
            .min()
            .unwrap_or(0);
        let letzte = staircases
            .iter()
            .map(|treppe| treppe.last_second().seconds())
            .max()
            .unwrap_or(MAJOR_GRID_S);

        let t0 = floor_to(erste - 90, MAJOR_GRID_S);
        let t1 = ceil_to(letzte + 90, MAJOR_GRID_S);
        let zeilen = i64::try_from(conflicts).expect("Befundzahl passt in 64 Bit");

        Self {
            t0,
            t1: if t1 > t0 { t1 } else { t0 + MAJOR_GRID_S },
            corridor_mm: network.length_mm().max(1),
            height: PLOT_BOTTOM + 96 + 22 * (zeilen + 1),
        }
    }

    fn x(&self, seconds: i64) -> i64 {
        PLOT_LEFT + (seconds - self.t0) * (PLOT_RIGHT - PLOT_LEFT) / (self.t1 - self.t0)
    }

    fn y(&self, position_mm: i64) -> i64 {
        PLOT_TOP + position_mm * (PLOT_BOTTOM - PLOT_TOP) / self.corridor_mm
    }
}

fn floor_to(value: i64, step: i64) -> i64 {
    value - value.rem_euclid(step)
}

fn ceil_to(value: i64, step: i64) -> i64 {
    let rest = value.rem_euclid(step);
    if rest == 0 {
        value
    } else {
        value + step - rest
    }
}

/// Zeichnerischer Versatz eines Gleises innerhalb seines Segments.
///
/// Zwei Richtungsgleise liegen an derselben Stelle des Korridors und wären
/// deckungsgleich. Der Versatz von wenigen Pixeln trennt sie optisch, ohne die
/// Weg-Achse zu verfälschen — das steht in der Legende.
fn lane_offset(network: &Network, section: ResourceId) -> i64 {
    let abschnitt = network.section(section);
    let segment = network.segment(abschnitt.segment);
    if segment.lanes <= 1 {
        return 0;
    }
    // Betriebsstellen sind im Bild schmale Bänder — dort fällt der Versatz
    // kleiner aus, sonst ragen die Gleise aus ihrer eigenen Betriebsstelle.
    let schritt = if segment.operating_point.is_some() {
        3
    } else {
        5
    };
    let spur = i64::from(abschnitt.lane);
    let spuren = i64::from(segment.lanes);
    (2 * spur - (spuren - 1)) * schritt
}

/// Ersetzt die drei Zeichen, die in XML-Text nicht roh stehen dürfen.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Zeichnet den Bildfahrplan eines Betriebsfalls als eigenständiges SVG.
pub fn render(case: &Case) -> String {
    let treppen = case.staircases();
    let befunde = case.conflicts();
    let layout = Layout::new(&case.network, &treppen, befunde.len());

    let mut svg = String::with_capacity(48 * 1024);
    kopf(&mut svg, case, &layout);
    flaeche(&mut svg, &case.network, &layout);
    zeitraster(&mut svg, &layout);
    for (index, treppe) in treppen.iter().enumerate() {
        sperrzeiten(&mut svg, &case.network, &layout, treppe, index);
    }
    konflikte(&mut svg, &case.network, &layout, &befunde);
    for (index, treppe) in treppen.iter().enumerate() {
        zuglauf(&mut svg, &case.network, &layout, treppe, index);
    }
    rahmen(&mut svg, &layout);
    legende(&mut svg, case, &layout, &treppen, &befunde);
    svg.push_str("</svg>\n");
    svg
}

fn kopf(svg: &mut String, case: &Case, layout: &Layout) {
    svg.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{WIDTH}\" height=\"{}\" \
         viewBox=\"0 0 {WIDTH} {}\" role=\"img\" \
         aria-label=\"Bildfahrplan mit Sperrzeitentreppe: {}\">\n",
        layout.height,
        layout.height,
        escape(case.title)
    ));
    svg.push_str("  <defs>\n");
    // Zwei Schraffuren, gegenläufig: Sie trennen die beiden Züge ohne Farbe.
    for (index, winkel) in [45, -45].into_iter().enumerate() {
        svg.push_str(&format!(
            "    <pattern id=\"schraffur{index}\" width=\"9\" height=\"9\" \
             patternUnits=\"userSpaceOnUse\" patternTransform=\"rotate({winkel})\">\
             <line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"9\" stroke=\"{BAND}\" stroke-width=\"2.4\"/>\
             </pattern>\n"
        ));
    }
    svg.push_str(&format!(
        "    <pattern id=\"konflikt\" width=\"7\" height=\"7\" patternUnits=\"userSpaceOnUse\" \
         patternTransform=\"rotate(45)\">\
         <line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"7\" stroke=\"{CONFLICT}\" stroke-width=\"2.6\"/>\
         </pattern>\n"
    ));
    svg.push_str("  </defs>\n");
    svg.push_str(&format!(
        "  <rect width=\"{WIDTH}\" height=\"{}\" fill=\"{BACKGROUND}\"/>\n",
        layout.height
    ));
    svg.push_str(&format!(
        "  <text x=\"36\" y=\"46\" fill=\"{TEXT}\" font-family=\"{SANS}\" font-size=\"23\" \
         font-weight=\"600\">{}</text>\n",
        escape(case.title)
    ));
    svg.push_str(&format!(
        "  <text x=\"36\" y=\"72\" fill=\"{TEXT_DIM}\" font-family=\"{SANS}\" \
         font-size=\"14\">{}</text>\n",
        escape(case.summary)
    ));
    svg.push_str(&format!(
        "  <text x=\"{}\" y=\"46\" fill=\"{TEXT_DIM}\" font-family=\"{MONO}\" font-size=\"13\" \
         text-anchor=\"end\">Zugfolge · Spike M0.3 · {}</text>\n",
        WIDTH - 36,
        escape(case.id)
    ));
}

fn flaeche(svg: &mut String, network: &Network, layout: &Layout) {
    svg.push_str(&format!(
        "  <rect x=\"{PLOT_LEFT}\" y=\"{PLOT_TOP}\" width=\"{}\" height=\"{}\" \
         fill=\"{PLOT_BACKGROUND}\"/>\n",
        PLOT_RIGHT - PLOT_LEFT,
        PLOT_BOTTOM - PLOT_TOP
    ));

    for segment in network.segments() {
        let oben = layout.y(segment.start_mm);
        let unten = layout.y(segment.end_mm);

        if segment.operating_point.is_some() {
            svg.push_str(&format!(
                "  <rect x=\"{PLOT_LEFT}\" y=\"{oben}\" width=\"{}\" height=\"{}\" \
                 fill=\"{STATION_BAND}\"/>\n",
                PLOT_RIGHT - PLOT_LEFT,
                (unten - oben).max(1)
            ));
        }

        for kante in [oben, unten] {
            svg.push_str(&format!(
                "  <line x1=\"{PLOT_LEFT}\" y1=\"{kante}\" x2=\"{PLOT_RIGHT}\" y2=\"{kante}\" \
                 stroke=\"{STATION_LINE}\" stroke-width=\"1\"/>\n"
            ));
        }

        let mitte = (oben + unten) / 2;
        if let Some(betriebsstelle) = segment.operating_point.as_ref() {
            svg.push_str(&format!(
                "  <text x=\"{}\" y=\"{}\" fill=\"{TEXT}\" font-family=\"{SANS}\" \
                 font-size=\"14\" font-weight=\"600\" text-anchor=\"end\">{}</text>\n",
                PLOT_LEFT - 12,
                mitte + 5,
                escape(betriebsstelle.name)
            ));
            svg.push_str(&format!(
                "  <text x=\"{}\" y=\"{}\" fill=\"{TEXT_DIM}\" font-family=\"{MONO}\" \
                 font-size=\"11\" text-anchor=\"start\">{}</text>\n",
                PLOT_LEFT + 8,
                mitte + 4,
                escape(betriebsstelle.code)
            ));
        } else {
            let gleisig = if segment.lanes > 1 {
                "zweigleisig"
            } else {
                "eingleisig"
            };
            svg.push_str(&format!(
                "  <text x=\"{}\" y=\"{}\" fill=\"{TEXT_DIM}\" font-family=\"{SANS}\" \
                 font-size=\"12\" text-anchor=\"end\">{}</text>\n",
                PLOT_LEFT - 12,
                mitte,
                escape(segment.name)
            ));
            svg.push_str(&format!(
                "  <text x=\"{}\" y=\"{}\" fill=\"{TEXT_DIM}\" font-family=\"{SANS}\" \
                 font-size=\"11\" text-anchor=\"end\" font-style=\"italic\">{gleisig}, {} km</text>\n",
                PLOT_LEFT - 12,
                mitte + 16,
                segment.length_mm() / 1_000_000
            ));
        }
    }

    // Blockgrenzen: gestrichelt, damit sie die Treppe stützen, ohne sie zu
    // übertönen.
    for section in network.sections() {
        if network.segment(section.segment).operating_point.is_some() {
            continue;
        }
        let y = layout.y(section.end_mm);
        svg.push_str(&format!(
            "  <line x1=\"{PLOT_LEFT}\" y1=\"{y}\" x2=\"{PLOT_RIGHT}\" y2=\"{y}\" \
             stroke=\"{GRID_MAJOR}\" stroke-width=\"1\" stroke-dasharray=\"3 5\"/>\n"
        ));
    }
}

fn zeitraster(svg: &mut String, layout: &Layout) {
    let mut zeit = layout.t0;
    while zeit <= layout.t1 {
        let x = layout.x(zeit);
        let gross = zeit.rem_euclid(MAJOR_GRID_S) == 0;
        svg.push_str(&format!(
            "  <line x1=\"{x}\" y1=\"{PLOT_TOP}\" x2=\"{x}\" y2=\"{PLOT_BOTTOM}\" stroke=\"{}\" \
             stroke-width=\"1\"/>\n",
            if gross { GRID_MAJOR } else { GRID }
        ));
        if gross {
            let beschriftung = clock(zugfolge_determinism::SimTime::from_seconds(zeit));
            svg.push_str(&format!(
                "  <text x=\"{x}\" y=\"{}\" fill=\"{TEXT_DIM}\" font-family=\"{MONO}\" \
                 font-size=\"11\" text-anchor=\"middle\">{}</text>\n",
                PLOT_TOP - 10,
                &beschriftung[..5]
            ));
        }
        zeit += MINOR_GRID_S;
    }
}

fn sperrzeiten(
    svg: &mut String,
    network: &Network,
    layout: &Layout,
    staircase: &BlockingTimeStaircase,
    index: usize,
) {
    let muster = index % 2;
    svg.push_str(&format!("  <g id=\"sperrzeiten-{index}\">\n"));
    for stufe in &staircase.steps {
        let abschnitt = network.section(stufe.section);
        let versatz = lane_offset(network, stufe.section);
        let x = layout.x(stufe.start.seconds());
        let breite = (layout.x(stufe.end.seconds()) - x).max(1);
        let y = layout.y(abschnitt.start_mm) + versatz;
        let hoehe = (layout.y(abschnitt.end_mm) + versatz - y).max(2);
        svg.push_str(&format!(
            "    <rect x=\"{x}\" y=\"{y}\" width=\"{breite}\" height=\"{hoehe}\" \
             fill=\"url(#schraffur{muster})\" fill-opacity=\"0.30\" stroke=\"{BAND}\" \
             stroke-width=\"0.9\" stroke-opacity=\"0.75\"/>\n"
        ));

        // Die reine Fahrzeit als Marke innerhalb der Sperrzeit. Der Abstand zum
        // Rand des Rechtecks ist der eigentliche Gegenstand des Spikes: Er
        // gehört zur Sperrzeit, obwohl dort kein Zug im Abschnitt ist.
        for zeitpunkt in [stufe.entry, stufe.exit] {
            let marke = layout.x(zeitpunkt.seconds());
            svg.push_str(&format!(
                "    <line x1=\"{marke}\" y1=\"{y}\" x2=\"{marke}\" y2=\"{}\" stroke=\"{BAND}\" \
                 stroke-width=\"0.8\" stroke-opacity=\"0.55\" stroke-dasharray=\"2 3\"/>\n",
                y + hoehe
            ));
        }
    }
    svg.push_str("  </g>\n");
}

fn konflikte(
    svg: &mut String,
    network: &Network,
    layout: &Layout,
    conflicts: &[OccupationConflict],
) {
    for befund in conflicts {
        let abschnitt = network.section(befund.section);
        let versatz = lane_offset(network, befund.section);
        let x = layout.x(befund.overlap_start.seconds());
        let breite = (layout.x(befund.overlap_end.seconds()) - x).max(2);
        let y = layout.y(abschnitt.start_mm) + versatz;
        let hoehe = (layout.y(abschnitt.end_mm) + versatz - y).max(3);
        svg.push_str(&format!(
            "  <rect x=\"{x}\" y=\"{y}\" width=\"{breite}\" height=\"{hoehe}\" \
             fill=\"url(#konflikt)\" fill-opacity=\"0.55\" stroke=\"{CONFLICT}\" \
             stroke-width=\"1.6\"/>\n"
        ));
        // Die Kennung sitzt in der Mitte des Konfliktfensters: Am oberen Rand
        // liefe sie in die Sperrzeit des darüberliegenden Abschnitts hinein.
        svg.push_str(&format!(
            "  <rect x=\"{}\" y=\"{}\" width=\"26\" height=\"16\" rx=\"3\" fill=\"{CONFLICT}\"/>\n",
            x + breite / 2 - 13,
            y + hoehe / 2 - 8
        ));
        svg.push_str(&format!(
            "  <text x=\"{}\" y=\"{}\" fill=\"{BACKGROUND}\" font-family=\"{MONO}\" \
             font-size=\"11\" font-weight=\"700\" text-anchor=\"middle\">{}</text>\n",
            x + breite / 2,
            y + hoehe / 2 + 4,
            escape(&befund.label)
        ));
    }
}

fn zuglauf(
    svg: &mut String,
    network: &Network,
    layout: &Layout,
    staircase: &BlockingTimeStaircase,
    index: usize,
) {
    let strichart = if index == 0 { "none" } else { "9 5" };
    let mut punkte: Vec<(i64, i64)> = Vec::new();

    for stufe in &staircase.steps {
        let abschnitt = network.section(stufe.section);
        let versatz = lane_offset(network, stufe.section);
        let (von_mm, bis_mm) = match staircase.direction {
            Direction::Outbound => (abschnitt.start_mm, abschnitt.end_mm),
            Direction::Inbound => (abschnitt.end_mm, abschnitt.start_mm),
        };
        punkte.push((layout.x(stufe.entry.seconds()), layout.y(von_mm) + versatz));
        punkte.push((
            layout.x(stufe.travel_end.seconds()),
            layout.y(bis_mm) + versatz,
        ));
        if stufe.exit != stufe.travel_end {
            punkte.push((layout.x(stufe.exit.seconds()), layout.y(bis_mm) + versatz));
        }
    }

    let pfad = punkte
        .iter()
        .map(|(x, y)| format!("{x},{y}"))
        .collect::<Vec<_>>()
        .join(" ");
    svg.push_str(&format!(
        "  <polyline points=\"{pfad}\" fill=\"none\" stroke=\"{TRAIN}\" stroke-width=\"2\" \
         stroke-dasharray=\"{strichart}\" stroke-linejoin=\"round\"/>\n"
    ));

    if let Some((x, y)) = punkte.first() {
        // Die Beschriftung sitzt auf der Seite, zu der der Zuglauf läuft —
        // sonst liegt sie beim ersten Zug über der Zeitachse.
        let zeile = i64::try_from(index).expect("Zugzahl passt in 64 Bit") * 15;
        let versatz = match staircase.direction {
            Direction::Outbound => 20 + zeile,
            Direction::Inbound => -12 - zeile,
        };
        svg.push_str(&format!(
            "  <text x=\"{}\" y=\"{}\" fill=\"{TRAIN}\" font-family=\"{MONO}\" font-size=\"12\" \
             font-weight=\"600\">{}</text>\n",
            x + 8,
            y + versatz,
            escape(staircase.number)
        ));
    }
}

fn rahmen(svg: &mut String, _layout: &Layout) {
    svg.push_str(&format!(
        "  <rect x=\"{PLOT_LEFT}\" y=\"{PLOT_TOP}\" width=\"{}\" height=\"{}\" fill=\"none\" \
         stroke=\"{STATION_LINE}\" stroke-width=\"1\"/>\n",
        PLOT_RIGHT - PLOT_LEFT,
        PLOT_BOTTOM - PLOT_TOP
    ));
}

fn legende(
    svg: &mut String,
    case: &Case,
    layout: &Layout,
    staircases: &[BlockingTimeStaircase],
    conflicts: &[OccupationConflict],
) {
    let mut y = PLOT_BOTTOM + 34;

    for (index, treppe) in staircases.iter().enumerate() {
        let x = 36 + i64::try_from(index).expect("Zugzahl passt in 64 Bit") * 330;
        let strichart = if index == 0 { "none" } else { "9 5" };
        svg.push_str(&format!(
            "  <line x1=\"{x}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{TRAIN}\" \
             stroke-width=\"2\" stroke-dasharray=\"{strichart}\"/>\n",
            y - 4,
            x + 26,
            y - 4
        ));
        svg.push_str(&format!(
            "  <rect x=\"{}\" y=\"{}\" width=\"20\" height=\"12\" fill=\"url(#schraffur{})\" \
             fill-opacity=\"0.30\" stroke=\"{BAND}\" stroke-width=\"0.9\"/>\n",
            x + 34,
            y - 12,
            index % 2
        ));
        svg.push_str(&format!(
            "  <text x=\"{}\" y=\"{y}\" fill=\"{TEXT}\" font-family=\"{SANS}\" \
             font-size=\"12\">{} · Zuglauf und Sperrzeit · {}</text>\n",
            x + 62,
            escape(treppe.number),
            escape(treppe.direction.label())
        ));
    }

    // Die Anteile stehen nicht als Satz im Code, sondern kommen aus dem Modell:
    // Ändert sich die Sperrzeitenrechnung, ändert sich die Legende mit.
    let anteile = staircases
        .first()
        .map(BlockingTimeStaircase::phase_labels)
        .unwrap_or_default()
        .join(" + ");
    y += 22;
    svg.push_str(&format!(
        "  <text x=\"36\" y=\"{y}\" fill=\"{TEXT_DIM}\" font-family=\"{SANS}\" font-size=\"12\">\
         Sperrzeit = {anteile}. Nebeneinanderliegende Gleise sind zur Unterscheidung um \
         wenige Pixel versetzt gezeichnet.</text>\n"
    ));

    y += 26;
    if conflicts.is_empty() {
        svg.push_str(&format!(
            "  <text x=\"36\" y=\"{y}\" fill=\"{TEXT}\" font-family=\"{SANS}\" font-size=\"13\" \
             font-weight=\"600\">Kein Belegungskonflikt.</text>\n"
        ));
        return;
    }

    svg.push_str(&format!(
        "  <text x=\"36\" y=\"{y}\" fill=\"{CONFLICT}\" font-family=\"{SANS}\" font-size=\"13\" \
         font-weight=\"600\">{} Belegungskonflikt(e)</text>\n",
        conflicts.len()
    ));

    for befund in conflicts {
        y += 22;
        let abschnitt = case.network.section(befund.section);
        svg.push_str(&format!(
            "  <text x=\"36\" y=\"{y}\" fill=\"{TEXT}\" font-family=\"{MONO}\" \
             font-size=\"12\">{}</text>\n",
            escape(&befund.label)
        ));
        svg.push_str(&format!(
            "  <text x=\"72\" y=\"{y}\" fill=\"{TEXT}\" font-family=\"{SANS}\" \
             font-size=\"12\">{} · {} · {} bis {} ({} min) · {} gegen {}</text>\n",
            escape(&abschnitt.name),
            escape(befund.kind.label()),
            clock(befund.overlap_start),
            clock(befund.overlap_end),
            duration(befund.overlap_seconds()),
            escape(case.runs[befund.first_run].number),
            escape(case.runs[befund.second_run].number),
        ));
    }

    debug_assert!(y < layout.height, "die Legende läuft aus dem Bild");
}

#[cfg(test)]
mod tests {
    use super::render;
    use crate::case::Case;

    #[test]
    fn jeder_fall_ergibt_ein_gueltiges_svg() {
        for fall in Case::all() {
            let svg = render(&fall);
            assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
            assert!(svg.ends_with("</svg>\n"));
            assert_eq!(
                svg.matches("<svg").count(),
                1,
                "{}: mehr als ein Wurzelelement",
                fall.id
            );
            assert_eq!(
                svg.matches('<').count(),
                svg.matches('>').count(),
                "{}: unausgeglichene spitze Klammern",
                fall.id
            );
        }
    }

    #[test]
    fn das_bild_zeigt_die_befunde_die_der_bericht_nennt() {
        // Bild und Bericht dürfen nicht auseinanderlaufen — sonst zeigt der
        // Beweis von M0.3 etwas anderes, als die Prüfung sagt.
        for fall in Case::all() {
            let svg = render(&fall);
            for befund in fall.conflicts() {
                assert!(
                    svg.contains(&format!(">{}</text>", befund.label)),
                    "{}: {} fehlt im Bild",
                    fall.id,
                    befund.label
                );
            }
            if fall.conflicts().is_empty() {
                assert!(svg.contains("Kein Belegungskonflikt"), "{}", fall.id);
            }
        }
    }

    #[test]
    fn das_bild_ist_reproduzierbar() {
        for fall in Case::all() {
            assert_eq!(render(&fall), render(&fall), "{}", fall.id);
        }
    }

    #[test]
    fn jede_betriebsstelle_ist_beschriftet() {
        let fall = Case::crossing_conflict();
        let svg = render(&fall);
        for name in ["Nordstadt", "Sandberg", "Talheim"] {
            assert!(svg.contains(name), "{name} fehlt im Bild");
        }
    }
}
