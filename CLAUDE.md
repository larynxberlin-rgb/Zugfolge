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
| `docs/produkt.md` | Produktdefinition, Oberflächen, Onboarding, Netzabgrenzung, Spielertypen, Anti-Monokultur | Produktfragen, UI, Zielgruppe, Was-gehört-dazu |
| `docs/infrastruktur.md` | Konfliktressourcen, Trassenvergabe, Fahrplanperiode, Kapazitätsschutz, Simulation, Livemap | Solver, Sperrzeiten, Planner, Livemap |
| `docs/betrieb.md` | Betriebsprogramm, Fahrzeuge, Personal, Versorgung, Zusatzfahrten, Störungen, Baustellenfahrplan | Disposition, Flotte, Umläufe, Wartung, Baustellen |
| `docs/wirtschaft.md` | Spielkreislauf, Geschäftsfelder, Nachfrage, Ausschreibung, Eigenbetrieb, Insolvenz, Kooperation | Verträge, Märkte, Geld, Ausschreibungen |
| `docs/daten.md` | Datenlage OSM/ORM, Quellen, Rechte, Qualitätsklassen | Import-Pipeline, InfraRelease, Lizenzfragen zu Daten |
| `docs/architektur.md` | Systemarchitektur, Lastgrößen, irreversible Entscheidungen, Determinismus, Sicherheit | Technischer Entwurf, Skalierung, Persistenz |
| `docs/design.md` | Farbsystem, Barrierefreiheit, Dunkelmodus, Typografie, Dichte, Wortmarke | jede Oberflächenarbeit, jedes Diagramm, jede Zustandsdarstellung |
| `docs/geschaeft.md` | Odoo, Monetarisierung, Monetarisierungsgrenze, Lizenz, Marken | Bezahlfunktionen, Lizenz, Namensrechte |
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

Konzeption abgeschlossen, E1–E16 entschieden, Milestones auf Reihenfolge und
Vollständigkeit geprüft.

- **Alpha-Schnitt:** M0 – M9. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7.
- **Nächster Schritt:** M0.3, der Wegwerf-Spike zur Sperrzeitentreppe — drei
  Betriebsstellen, zwei Züge. Der billigste Zeitpunkt zu prüfen, ob die
  Konfliktprüfung trägt; alles Weitere hängt daran.

Repository: https://github.com/larynxberlin-rgb/Zugfolge — noch nicht
initialisiert. `LICENSE` trägt bis zum Einsetzen des Volltexts einen
Warnblock und ist bis dahin **nicht gültig**.
