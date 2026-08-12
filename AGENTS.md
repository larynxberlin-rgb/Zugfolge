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
| `docs/entscheidungen.md` | E1–E26 mit voller Begründung | eine Entscheidung infrage steht oder geändert werden soll |
| `docs/adr/` | E1–E26 je als Architecture Decision Record: Kontext, Konsequenzen, Querverweise | eine Grundsatzentscheidung ausführlich nachschlagen oder eine neue festhalten |
| `docs/monorepo.md` | Verzeichnisaufbau, Domänengrenzen, Werkzeugkette, Durchsetzung der Invarianten | Code beitragen, neues Paket oder Crate anlegen, CI verstehen |
| `docs/glossar.md` | Domänenglossar: deutscher Fachbegriff → Bezeichner im Code → Bedeutung → Quelle | jede Benennung im Code, jeder neue Fachbegriff |
| `docs/produkt.md` | Produktdefinition, Oberflächen, Onboarding, Netzabgrenzung, Spielertypen, Anti-Monokultur | Produktfragen, UI, Zielgruppe, Was-gehört-dazu |
| `docs/infrastruktur.md` | Konfliktressourcen, Trassenvergabe, Fahrplanperiode, Kapazitätsschutz, Simulation, Livemap | Solver, Sperrzeiten, Planner, Livemap |
| `docs/betrieb.md` | Betriebsprogramm, Fahrzeuge, Personal, Versorgung, Zusatzfahrten, Störungen, Baustellenfahrplan | Disposition, Flotte, Umläufe, Wartung, Baustellen |
| `docs/stoerungen.md` | M8-Fachvertrag: Policies, Ursachenkennungen, Abfahrtsrechte, virtuelle Fahrdienstleiter, Ersatzplanung | Störungen, Baustellen, Ersatzverkehr, Verspätungsursachen |
| `docs/wirtschaft.md` | Spielkreislauf, Geschäftsfelder, Nachfrage, Ausschreibung, Eigenbetrieb, Insolvenz, Kooperation | Verträge, Märkte, Geld, Ausschreibungen |
| `docs/daten.md` | Datenlage OSM/ORM, Quellen, Rechte, Qualitätsklassen | Import-Pipeline, InfraRelease, Lizenzfragen zu Daten |
| `docs/architektur.md` | Systemarchitektur, Lastgrößen, irreversible Entscheidungen, Determinismus, Sicherheit | Technischer Entwurf, Skalierung, Persistenz |
| `docs/design.md` | Farbsystem, Barrierefreiheit, Dunkelmodus, Typografie, Dichte, Wortmarke | jede Oberflächenarbeit, jedes Diagramm, jede Zustandsdarstellung |
| `docs/geschaeft.md` | Odoo, Monetarisierung, Monetarisierungsgrenze, Lizenz, Marken | Bezahlfunktionen, Lizenz, Namensrechte |
| `docs/milestones.md` | M0–M14 mit Teilabschnitten und Beweisen | Planung, Reihenfolge, „was als Nächstes“ |
| `docs/risiken.md` | R1–R17 mit Gegenmaßnahmen | Risikoabwägung, Review |

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
| E21 | SPNV-Ausschreibungen variieren nach einem angekündigten, seed-deterministischen Vergabeprofil |
| E22 | Infrastruktur- und Fahrplandaten werden jährlich zum realen Fahrplanwechsel aktualisiert |
| E23 | Odoo ist administrativer Kontroll- und Freigabepunkt, nie fachliche Source of Truth |
| E24 | Der Alpha-Schnitt wird gezielt um M12.1, M12.2 und M14.1 erweitert |
| E25 | Gebietsüberschreitende Fahrten bleiben eine Fahrtkette mit deterministischem Außenlauf |
| E26 | Die selbst gehostete Weltkarte ist das Spielzentrum; der Deutschland-Korpus ist vollständig sichtbar |

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

Konzeption abgeschlossen, E1–E26 entschieden, Milestones auf Reihenfolge und
Vollständigkeit geprüft. **M0 bis M8 sind fachlich abgenommen und
reproduzierbar nachgewiesen.** M1.13 akzeptiert die Trassenfinder-Kalibrierung
innerhalb der definierten Toleranz und den getrennten GTFS-Fahrplan-Holdout als
Milestone-Beweis; die unabhängige produktive Release-Qualifizierung und echte
Signatur bleiben als M9-Betriebsreife-Folgearbeit in Issue #48 erhalten.

- **Alpha-Schnitt:** M0–M9 plus ausschließlich die vorgezogenen M12.1, M12.2
  und M14.1 (E24). M12 und M14 bleiben als Gesamtmilestones Ausbau.
- **Kritischer Pfad bis M7:** M0.3 → M1 → M3 → M4 → M7 ist erfüllt.
- **Nächster Schritt:** M9 — Betriebsreife, Onboarding und geschlossene Alpha.

Repository: https://github.com/larynxberlin-rgb/Zugfolge. `LICENSE` steht unter
PolyForm Shield 1.0.0, nennt Sebastian Barowski als Rechteinhaber und ist damit
**wirksam**.
