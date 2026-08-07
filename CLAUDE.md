# Zugfolge — Arbeitsgrundlage

Persistentes, serverautoritäres Browsergame: Eisenbahn-Unternehmenssimulation
mit hohem betrieblichem, infrastrukturellem und wirtschaftlichem Realismus.
Öffentliche Welten laufen dauerhaft in 1:1-Echtzeit ohne Wipes. Erste
Pilotregion: **Leipzig–Halle–Erfurt**, Stand 2026.

**Diese Datei wird in jeder Sitzung geladen. Sie enthält nur, was immer gilt.**
Alles Weitere steht in `docs/` — vor inhaltlicher Arbeit die passende Datei
lesen, nicht raten.

---

## Dokumentkarte

| Datei | Inhalt | Lesen wenn |
|-------|--------|------------|
| `docs/entscheidungen.md` | E1–E20 mit voller Begründung | eine Entscheidung infrage steht oder geändert werden soll |
| `docs/adr/` | E1–E20 je als Architecture Decision Record: Kontext, Konsequenzen, Querverweise | eine Grundsatzentscheidung ausführlich nachschlagen oder eine neue festhalten |
| `docs/monorepo.md` | Verzeichnisaufbau, Domänengrenzen, Werkzeugkette, Durchsetzung der Invarianten | Code beitragen, neues Paket oder Crate anlegen, CI verstehen |
| `docs/glossar.md` | Domänenglossar: deutscher Fachbegriff → Bezeichner im Code → Bedeutung → Quelle | jede Benennung im Code, jeder neue Fachbegriff |
| `docs/produkt.md` | Produktdefinition, Oberflächen, Onboarding, Netzabgrenzung, Spielertypen, Anti-Monokultur | Produktfragen, UI, Zielgruppe, Was-gehört-dazu |
| `docs/infrastruktur.md` | Konfliktressourcen, Trassenvergabe, Fahrplanperiode, Kapazitätsschutz, Simulation, Livemap | Solver, Sperrzeiten, Planner, Livemap |
| `docs/betriebsgraph.md` | Domänenmodell der Infrastruktur (M1.1): Bausteine, Zusicherungen, Einheiten, Fingerabdruck, Abgrenzung | am Betriebsgraphen arbeiten, Import, Netzfilter, Blöcke, Fahrstraßen |
| `docs/betrieb.md` | Betriebsprogramm, Fahrzeuge, Personal, Versorgung, Zusatzfahrten, Störungen, Baustellenfahrplan | Disposition, Flotte, Umläufe, Wartung, Baustellen |
| `docs/wirtschaft.md` | Spielkreislauf, Geschäftsfelder, Nachfrage, Ausschreibung, Eigenbetrieb, Insolvenz, Kooperation | Verträge, Märkte, Geld, Ausschreibungen |
| `docs/daten.md` | Datenlage OSM/ORM, Quellen, Rechte, Qualitätsklassen | Import-Pipeline, InfraRelease, Lizenzfragen zu Daten |
| `docs/rechte.md` | Rechte-Gate: Freigabestatus je Datenquelle, Quellenregister, Trassenfinder-Nutzungsbedingungen | eine Datenquelle nutzen oder aufnehmen, Import beginnen (Invariante 8) |
| `docs/architektur.md` | Systemarchitektur, Lastgrößen, irreversible Entscheidungen, Determinismus, Sicherheit | Technischer Entwurf, Skalierung, Persistenz |
| `docs/design.md` | Farbsystem, Barrierefreiheit, Dunkelmodus, Typografie, Dichte, Wortmarke | jede Oberflächenarbeit, jedes Diagramm, jede Zustandsdarstellung |
| `docs/geschaeft.md` | Odoo, Monetarisierung, Monetarisierungsgrenze, Lizenz, Marken | Bezahlfunktionen, Lizenz, Namensrechte |
| `docs/rechteschutz.md` | Umsetzung von M0.5: LICENSE, CLA, Schichtentrennung, Marke — und ihre Durchsetzung | Lizenz einsetzen, Beitrag annehmen, proprietäre Schicht, Marke |
| `docs/milestones.md` | M0–M13 mit Teilabschnitten und Beweisen | Planung, Reihenfolge, „was als Nächstes“ |
| `docs/risiken.md` | R1–R15 mit Gegenmaßnahmen | Risikoabwägung, Review |

---

## Harte Invarianten

Kein Beitrag darf diese verletzen:

1. **Keine zwei Züge dürfen zur gleichen Zeit inkompatible Belegungen derselben
   Konfliktressource besitzen.** Zentrale fachliche Invariante.
2. **Kein `now()` im Simulationskern.** Simulationszeit ist ein expliziter Wert.
3. **Keine Gleitkommazahlen im zustandsrelevanten Pfad.** Geld als `i64` Cent,
   Zeiten als Sekunden seit Weltepoche, Positionen als Millimeter entlang Kante.
4. **`world_id` in jeder Abfrage, jedem Index und jedem Event.**
5. **Kein Payment-Tier-Feld** in Planner, Nachfrage, Wirtschaft, Trassenvergabe
   oder Live-Disposition. CI-Wächter prüft das.
6. **Kein externer Dienst im heißen Pfad.** Jede Kostenberechnung kommt aus dem
   gepinnten `EconomyRelease` der Welt.
7. **Kein Datenbankzugriff aus dem Simulationskern.** Kommandos rein, Events
   raus.
8. **Kein Import ohne dokumentierte Rechtefreigabe.**

---

## Grundsatzentscheidungen (bindend)

Diese sind getroffen und werden nicht in jeder Sitzung neu verhandelt.
Begründungen: `docs/entscheidungen.md`. Änderungen dort eintragen und begründen.

| Nr. | Entscheidung |
|-----|--------------|
| E1 | SPNV ist das erste vollständig spielbare Geschäftsfeld |
| E2 | Kern-Loop ist das Betriebsprogramm (Dispo-Regelwerk), auch offline wirksam |
| E3 | Fahrplanperiode ist ein Weltparameter, 3–8 Wochen (8 = unbefristete Welt) |
| E4 | Kapazität wird aktiv gegen Landgrab geschützt |
| E5 | Rust-Simulationskern, TypeScript-Plattform — der Schnitt folgt der Last |
| E6 | Baureihennummern faktisch, Produkt- und Unternehmensmarken eigen |
| E7 | Gescheiterte Ausschreibungen übernimmt der Eigenbetrieb des Aufgabenträgers |
| E8 | Insolvenz bedeutet Totalverlust des EVU, mit telegrafierter Eskalationsleiter |
| E9 | Vollständige Transparenz auf der Livemap |
| E10 | Trassenfinder ist Kalibrierwerkzeug der Entwicklung, keine Laufzeitabhängigkeit |
| E11 | Kein einzelner Optimierungswert |
| E12 | Rangieren ist ausschließlich automatisiert |
| E13 | Der Automatikmodus bleibt in öffentlichen Welten kostenlos |
| E14 | Netzabgrenzung: ausschließlich EBO, ohne Übergang zu BOStrab |
| E15 | Baustellen sind ein eigenes Planungsverfahren, kein bloßer Schaden |
| E16 | Lizenz PolyForm Shield 1.0.0 — Source Available, nicht Open Source |
| E17 | Design: Domänensprache statt Markenzitat, achromatische Marke, durchgehend dunkel |
| E18 | Weltlaufzeit 6–18 Monate oder unbefristet; Perioden- und Vertragslängen skalieren mit |
| E19 | Realismus dient dem Spiel — Schritte ohne Entscheidung werden abstrahiert |
| E20 | Fahrzeuge werden konfiguriert bestellt; Werkstätten bauen den Innenraum um |

---

## Stack

| Schicht | Wahl |
|---------|------|
| Simulationskern, Solver, Release-Pipeline | Rust, angebunden über napi-rs |
| Game-Services | TypeScript, Node.js LTS, Fastify |
| Datenbank | PostgreSQL + PostGIS, Zugriff über Drizzle |
| Frontend | React + Vite, MapLibre GL, PMTiles |
| Identität | Keycloak |

Message-Broker und Cache erst, wenn eine **Messung** sie verlangt. Details und
Lastgrößen: `docs/architektur.md`.

---

## Arbeitsprinzipien

- **Spezifikation vor Code.** Jede Regel — Sperrzeiten, Entgelte, Wertung — ist
  eine versionierte, testbare Spezifikationsdatei, kein Code-Kommentar.
- **Golden-Master-Tests** gegen reale Fahrplanausschnitte der Pilotregion mit
  definierter Toleranz.
- **Property-Tests** für Invariante 1.
- **Determinismus-Test in CI:** gleicher Seed ⇒ gleicher Zustands-Hash.
- **ADR für jede Grundsatzentscheidung.**
- Kein generierter Code ohne einen Test, der ohne ihn fehlschlägt.
- Monorepo mit harten Domänengrenzen, je Domäne eine eigene Agenten-Anleitung.
- Milestones sind nach **Abhängigkeiten** geschnitten, nicht nach Zeit. Aufwand
  relativ als S / M / L / XL. Keine Kalenderdaten.

## Sprachregelungen

- Das Projekt heißt **Source Available**, niemals „Open Source“.
- Vergleichbare Verkehrssimulationen werden generisch benannt, nicht namentlich.

---

## Stand

Konzeption abgeschlossen, E1–E20 entschieden, Milestones auf Reihenfolge und
Vollständigkeit geprüft. **M0 ist abgeschlossen: M0.1 bis M0.5 sind erledigt** —
ADRs, Monorepo, CI, Determinismus-Testharnisch, Wächter, Glossar, Lizenz-Scan,
der Wegwerf-Spike zur Sperrzeitentreppe, das Rechte-Gate und der Rechteschutz.
**M1 hat begonnen: M1.1 und M1.2 sind erledigt** — das Domänenmodell des
Betriebsgraphen und die Import-Pipeline OSM-PBF → Rohgraph stehen in
`crates/zugfolge-infra`.

- **Alpha-Schnitt:** M0 – M9. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7. Die ersten Schritte sind geführt.
- **M0.3 hat getragen:** `spikes/blocking-time-staircase/` rechnet die
  Sperrzeitentreppe zweier Züge über drei Betriebsstellen, erkennt Gegenfahrt
  und Zugfolgefall mit Ressource, Zeitfenster und Gegenzug und zeichnet den
  Bildfahrplan. Drei Befunde wirken weiter: ein Ressourcenmodell trägt beide
  Konfliktarten (M3.1, M3.3); der Bahnhofskopf braucht Ausschlussmengen statt
  einzelner Ressourcen (M1.7); die betrieblich richtige Auflösung eines
  Konflikts ist ein eigenes Verfahren (M3.4). Der Spike **verfällt mit M3.1**
  und wird dann gelöscht, nicht weitergepflegt.
- **M0.4 und M0.5 haben getragen:** Das Rechte-Gate führt jede Datenquelle mit
  Freigabestatus im Quellenregister (`tools/guards/quellenregister.json`), und
  der Wächter `rights-gate` setzt Invariante 8 durch — heute die Registerpflege,
  ab dem ersten Import auch die Herkunft. `LICENSE` nennt den Rechteinhaber und
  ist wirksam; der Wächter `layer-separation` hält die proprietären Schichten
  aus dem öffentlichen Baum. Siehe `docs/rechte.md` und `docs/rechteschutz.md`.
- **M1.1 steht:** `crates/zugfolge-infra` beschreibt Betriebsstellen, Kanten,
  Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder und Neigung.
  Drei Entscheidungen wirken weiter: Gefahren wird auf **Gleisen**, und die
  Richtungsbindung liegt am Gleis — Zugfolgefall und Gegenfahrt bleiben damit
  eine Eigenschaft des Netzes (M3.1, M3.3). Die vier veränderlichen Attribute
  teilen sich **einen** Bandmechanismus (M1.5, M1.6 füllen ihn). Und die
  Herkunft hängt am einzelnen Band, damit M1.4 je Attribut und Abschnitt messen
  kann. Der Graph liefert einen kanonischen Fingerabdruck — die spätere
  Prüfsumme des `InfraRelease` (M1.12). Siehe `docs/betriebsgraph.md`.
- **M1.2 steht:** `crates/zugfolge-infra/src/import` liest einen genehmigten
  OSM-PBF-Extract (Quelle `osm-pbf-lhe`) blockweise über einen selbst
  geschriebenen Protobuf-/Blob-Leser und baut daraus einen Rohgraph —
  Topologie, Geometrie und Tags, roh und ungefiltert. Ein Knoten wird nur dann
  zum eigenen Punkt des Rohgraphen, wenn er Anfang, Ende oder Verzweigung
  eines Wegs ist oder selbst einen `railway`-Tag trägt; alle anderen bleiben
  Geometriepunkte ihrer Kante. Der Rohgraph ist bewusst noch kein
  `OperatingGraph` — das entscheidet erst der Netzfilter. Siehe
  `docs/betriebsgraph.md` Abschnitt 7.
- **Nächster Schritt:** M1.3, der Netzfilter — er wählt aus dem Rohgraph nur
  `railway=rail` in Regelspur aus und wirft Tram-, Stadtbahn- und
  Stromschienennetze über die Netzausschlussliste heraus, behält aber
  Betriebs-, Abstell- und Anschlussgleise.

Repository: https://github.com/larynxberlin-rgb/Zugfolge. `LICENSE` steht unter
PolyForm Shield 1.0.0, nennt Sebastian Barowski als Rechteinhaber und ist damit
**wirksam**.
