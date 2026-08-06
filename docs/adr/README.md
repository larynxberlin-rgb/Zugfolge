# Architecture Decision Records

Dieser Ordner hält die **Grundsatzentscheidungen** des Projekts als einzeln
versionierte Architecture Decision Records (ADR) fest. Grundlage ist das
Arbeitsprinzip aus `CLAUDE.md`: *ADR für jede Grundsatzentscheidung.*

Ein ADR dokumentiert eine **bereits getroffene** Entscheidung mitsamt ihrem
Kontext und ihren Konsequenzen. Es ist kein Ort, an dem neu verhandelt wird.
Wer eine Entscheidung ändern will, ändert sie in `../entscheidungen.md`,
begründet es dort, und legt bei Bedarf ein neues ADR nach, das das alte
**ablöst** (Status `Abgelöst durch ADR-XXXX`). Bestehende ADRs werden nicht
umgeschrieben — ihre Historie ist der Wert.

## Verhältnis zu den anderen Dokumenten

- `CLAUDE.md` — die bindende Kurztabelle E1–E20. Wird jede Sitzung geladen.
- `../entscheidungen.md` — E1–E20 mit einzeiliger Begründung, die maßgebliche
  Quelle für Wortlaut und Nummerierung.
- **`docs/adr/`** (dieser Ordner) — dieselben Entscheidungen ausführlich: mit
  Kontext, Konsequenzen und Querverweisen. Ein ADR je Entscheidung.

Bei Widerspruch gilt `../entscheidungen.md` für den Entscheidungswortlaut; die
ADRs tragen die Herleitung. Die ADR-Nummer entspricht der E-Nummer
(ADR-0001 = E1).

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
Grundsatzentscheidungen schriftlich festgehalten. Alle Status: **Angenommen —
bindend**.

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
| [0017](0017-design-domaenensprache-achromatisch-dunkel.md) | E17 | Design: Domänensprache, achromatische Marke, dunkel |
| [0018](0018-weltlaufzeit-und-skalierende-perioden.md) | E18 | Weltlaufzeit 6–18 Monate oder unbefristet |
| [0019](0019-realismus-dient-dem-spiel.md) | E19 | Realismus dient dem Spiel |
| [0020](0020-fahrzeuge-konfiguriert-bestellt.md) | E20 | Fahrzeuge werden konfiguriert bestellt |

> **Hinweis zum Umfang.** Milestone 0.1 nennt „E1 bis E16"; die Formulierung
> stammt aus der Zeit vor E17–E20. Da diese vier heute gleichrangig bindend
> sind und das Arbeitsprinzip ein ADR *für jede* Grundsatzentscheidung verlangt,
> sind sie hier mit aufgenommen.
