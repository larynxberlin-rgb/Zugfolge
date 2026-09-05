# Architecture Decision Records

Dieser Ordner hält die **Grundsatzentscheidungen** des Projekts als einzeln
versionierte Architecture Decision Records (ADR) fest. Grundlage ist das
Arbeitsprinzip aus `AGENTS.md`: *ADR für jede Grundsatzentscheidung.*

Ein ADR dokumentiert eine **bereits getroffene** Entscheidung mitsamt ihrem
Kontext und ihren Konsequenzen. Es ist kein Ort, an dem neu verhandelt wird.
Wer eine Entscheidung ändern will, ändert sie in `../entscheidungen.md`,
begründet es dort, und legt bei Bedarf ein neues ADR nach, das das alte
**ablöst** (Status `Abgelöst durch ADR-XXXX`). Bestehende ADRs werden nicht
umgeschrieben — ihre Historie ist der Wert.

## Verhältnis zu den anderen Dokumenten

- `AGENTS.md` — die bindende Kurztabelle E1–E33. Wird jede Sitzung geladen.
- `../entscheidungen.md` — E1–E33 mit einzeiliger Begründung, die maßgebliche
  Quelle für Wortlaut und Nummerierung.
- **`docs/adr/`** (dieser Ordner) — dieselben Entscheidungen ausführlich: mit
  Kontext, Konsequenzen und Querverweisen. Ein ADR je Entscheidung.

Bei Widerspruch gilt `../entscheidungen.md` für den Entscheidungswortlaut; die
ADRs tragen die Herleitung. Im ursprünglichen Bestand entspricht die ADR-Nummer
der E-Nummer (ADR-0001 = E1). Bei späteren Ablösungen gilt die Zuordnung im Index.

## Format

Jedes ADR folgt der Vorlage in [`TEMPLATE.md`](TEMPLATE.md) — angelehnt an das
Format von Michael Nygard, auf Deutsch und um Projektbezüge ergänzt:

- **Kopf** — Status, Quellenbezug, betroffene Milestones, verwandte ADRs.
- **Kontext** — die Ausgangslage und die Kräfte, die eine Entscheidung nötig
  machten.
- **Entscheidung** — was gilt, in einem Satz zuerst.
- **Begründung** — warum diese und keine andere Wahl.
- **Konsequenzen** — was daraus folgt: Erleichterungen, Einschränkungen,
  berührte Invarianten und Milestones.

Statuswerte: `Angenommen` (bindend), `Vorgeschlagen`, `Abgelöst durch ADR-XXXX`,
`Zurückgezogen`.

## Index

Die folgenden ADRs wurden aus den zuvor in der Konzeptionsphase getroffenen
Grundsatzentscheidungen schriftlich festgehalten; E21 bis E33 kamen später als
eigene Entscheidungen hinzu. Alle einer E-Nummer zugeordneten ADRs sind
**angenommen und bindend**; der zusätzliche ADR-0030 ist ausdrücklich erst
vorgeschlagen.

| ADR | E | Titel |
|-----|---|-------|
| [0001](0001-spnv-erstes-geschaeftsfeld.md) | E1 | SPNV ist das erste vollständig spielbare Geschäftsfeld |
| [0002](0002-betriebsprogramm-als-kern-loop.md) | E2 | Kern-Loop ist das Betriebsprogramm |
| [0003](0003-fahrplanperiode-als-weltparameter.md) | E3 | Fahrplanperiode ist ein Weltparameter, 3–8 Wochen |
| [0004](0004-kapazitaetsschutz-gegen-landgrab.md) | E4 | Kapazität wird aktiv gegen Landgrab geschützt |
| [0005](0005-rust-kern-typescript-plattform.md) | E5 | Rust-Simulationskern, TypeScript-Plattform |
| [0006](0006-baureihen-faktisch-marken-eigen.md) | E6 | Baureihennummern faktisch, Marken eigen |
| [0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md) | E7 | Eigenbetrieb übernimmt gescheiterte Ausschreibungen |
| [0008](0008-insolvenz-als-totalverlust.md) | E8 | Insolvenz bedeutet Totalverlust des EVU |
| [0009](0009-vollstaendige-transparenz-livemap.md) | E9 | Vollständige Transparenz auf der Livemap |
| [0010](0010-trassenfinder-nur-kalibrierwerkzeug.md) | E10 | Trassenfinder ist Kalibrierwerkzeug, keine Laufzeitabhängigkeit |
| [0011](0011-kein-einzelner-optimierungswert.md) | E11 | Kein einzelner Optimierungswert |
| [0012](0012-rangieren-nur-automatisiert.md) | E12 | Rangieren ist ausschließlich automatisiert |
| [0013](0013-automatikmodus-kostenlos.md) | E13 | Der Automatikmodus bleibt in öffentlichen Welten kostenlos |
| [0014](0014-netzabgrenzung-nur-ebo.md) | E14 | Netzabgrenzung: ausschließlich EBO |
| [0015](0015-baustellen-als-planungsverfahren.md) | E15 | Baustellen sind ein eigenes Planungsverfahren |
| [0016](0016-lizenz-polyform-shield.md) | E16 | Lizenz PolyForm Shield 1.0.0 — Source Available |
| [0035](0035-deutschlandweite-spieleroberflaeche.md) | E17 | Deutschlandweite Spieleroberfläche mit der LiveMap im Zentrum (ersetzt ADR-0017) |
| [0018](0018-weltlaufzeit-und-skalierende-perioden.md) | E18 | Weltlaufzeit 6–18 Monate oder unbefristet |
| [0019](0019-realismus-dient-dem-spiel.md) | E19 | Realismus dient dem Spiel |
| [0020](0020-fahrzeuge-konfiguriert-bestellt.md) | E20 | Fahrzeuge werden konfiguriert bestellt |
| [0021](0021-ausschreibungen-variieren.md) | E21 | SPNV-Ausschreibungen variieren nach einem angekündigten Vergabeprofil |
| [0022](0022-jaehrliche-infrastrukturaktualisierung.md) | E22 | Infrastruktur- und Fahrplandaten werden jährlich zum realen Fahrplanwechsel aktualisiert |
| [0023](0023-odoo-als-administrativer-kontrollpunkt.md) | E23 | Odoo ist administrativer Kontroll- und Freigabepunkt, nie fachliche Source of Truth |
| [0024](0024-erweiterter-alpha-schnitt.md) | E24 | Der Alpha-Schnitt wird gezielt um M12.1, M12.2 und M14.1 erweitert |
| [0025](0025-gebietsueberschreitende-fahrtketten.md) | E25 | Gebietsüberschreitende Fahrten bleiben eine Fahrtkette mit deterministischem Außenlauf |
| [0026](0026-karte-als-spielzentrum.md) | E26 | Die selbst gehostete Weltkarte ist das Spielzentrum; der Deutschland-Korpus ist vollständig sichtbar |
| [0027](0027-geschaetzte-zugkartenposition-nur-visuell.md) | E27 | Geschätzte Zugkartenpositionen bleiben rein visuell und von der Betriebswahrheit getrennt |
| [0028](0028-spielhinweise-im-spiel.md) | E28 | Spielhinweise direkt im laufenden Spiel |
| [0029](0029-schaffnermodus-als-serverautoritative-betriebsvertiefung.md) | E29 | Der Schaffnermodus vertieft den serverautoritativen Betrieb |
| [0030](0030-odoo-weltkatalog-und-kommerzielle-teilnahme.md) | – | Odoo-Weltkatalog und kommerzielle Teilnahme an Game-autoritativen Welten (vorgeschlagen) |
| [0017](0017-design-domaenensprache-achromatisch-dunkel.md) | – | Historisches Design: durch ADR-0035 abgelöst |
| [0031](0031-spielerkarte-als-lebendige-welt.md) | E30 | Die Spielerkarte zeigt die lebendige gemeinsame Welt, nicht den Infrastruktur-Editor |
| [0032](0032-eine-autoritative-betriebswirklichkeit.md) | E31 | LiveMap, RZÜ und Betrieb bilden eine autoritative Wirklichkeit |
| [0033](0033-eine-spielwelt-pro-server.md) | E32 | Eine Spielwelt pro Server und Subdomain |
| [0034](0034-spielgenerierte-fahrplaene-im-spielgebiet.md) | E33 | GTFS ist Referenz; eigene Fahrpläne bleiben vollständig im Spielgebiet |

> **Teilablösung:** ADR-0027 ersetzt ausschließlich den Exact-only-Satz zur
> sichtbaren Zugposition in ADR-0026. Der historische Wortlaut bleibt dort
> erhalten; E26 und alle übrigen Teile von ADR-0026 bleiben bindend.

> **Weitere Teilablösung:** ADR-0031 ersetzt für das normale Spielerprofil die
> Vorgabe aus ADR-0026, jedes sichtbare Fachobjekt anklickbar zu machen, und
> präzisiert E26 auf einen A-/B-only-Releasevertrag. Unvollständige
> Pflichtdimensionen bleiben interne Builddiagnose und blockieren den gesamten
> Kandidaten. Der vollständige, selbst gehostete Deutschland-Korpus und alle
> übrigen E26-Verträge bleiben erhalten.

> **Laufzeitablösung:** ADR-0032 ersetzt die pauschale Rangierabstraktion aus
> ADR-0012 und den visuellen Estimate-Vertrag aus ADR-0027. Automatische
> Spielerführung und Kartenrolle bleiben bestehen; Bewegung und öffentliche
> Position sind ab v2 ausschließlich exakt.

> **Nummerierung:** ADR-0030 dokumentiert eine vorgeschlagene Ausgestaltung
> ohne eigene E-Nummer und behält seine historische Nummer. Deshalb entspricht
> die nächste bindende Grundsatzentscheidung E30 dem nächsten freien
> Datensatz ADR-0031.

> **Hinweis zum Umfang.** Milestone 0.1 nennt „E1 bis E16"; die Formulierung
> stammt aus der Zeit vor E17–E20. Da diese vier heute gleichrangig bindend
> sind und das Arbeitsprinzip ein ADR *für jede* Grundsatzentscheidung verlangt,
> sind sie hier mit aufgenommen.
`ADR-0034` dokumentiert E33: [Spielgenerierte Fahrpläne im Spielgebiet](0034-spielgenerierte-fahrplaene-im-spielgebiet.md); ersetzt E25 für neue Spielangebote.
