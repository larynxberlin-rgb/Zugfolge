# Milestones

Nach **Abhängigkeiten** geschnitten, nicht nach Zeit. Aufwand relativ als
S / M / L / XL. Keine Kalenderdaten.

Jeder Milestone endet mit einem **Beweis** — einem vorzeigbaren Zustand, meist
einem Spielerlebnis, nicht einer technischen Eigenschaft.

Diese Datei ist die kanonische Milestone-Statusquelle. M0–M8 sind fachlich
abgenommen; M9 bleibt bis zu den jeweils genannten Zielstack-Protokollen in
Arbeit. Release-Qualifizierung und Signatur aus #48 sind nachgewiesen und
das Issue ist geschlossen. Historische `calibration-only`-Fixtures bleiben
unverändert von den unabhängig qualifizierten Releases getrennt. Neue
Auditbefunde und deren Korrektur-/Abnahmebelege werden zusätzlich in #491
und seinen Einzelissues geführt.

**Aktuelles UI-/UX-Zielbild:** [ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md)
und [Design](design.md) ersetzen die früheren Gestaltungsleitplanken.
Die deutschlandweite LiveMap ist der Einstieg; Graphit, eine eigene rote
Gleismarke, verständliche Spielertexte und kompakte Arbeitsbereiche verbinden
die Anwendungen. [PR #531](https://github.com/larynxberlin-rgb/Zugfolge/pull/531)
enthält den Neuaufbau auf Basis von #530; [Screenshots und Prüfgrenzen](ui-redesign/README.md)
dokumentieren ihn. Frühere M3/M4- und regionale M14.1-Nachweise bleiben
historische Abnahmen. Sie begrenzen weder die aktuelle Gestaltung noch das
Deutschlandziel und belegen keine deutschlandweite Produktionsfreigabe.

- **Alpha-Schnitt: M0 – M9.** Das ist die erste Version, die externe Spieler
  sinnvoll spielen können. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7.

Jeder Teilabschnitt trägt einen **Status**: `offen` (noch nicht begonnen),
`in Arbeit` oder `erledigt`. Ein Punkt gilt erst als `erledigt`, wenn sein
Ergebnis vorzeigbar ist. Bislang erledigt:

- **M0.1** — die ADRs zu E1–E20 (E21 später ergänzt), siehe [`adr/`](adr/README.md);
- **M0.2** — Monorepo, CI, Determinismus-Testharnisch, Wächter und Glossar,
  siehe [`monorepo.md`](monorepo.md) und [`glossar.md`](glossar.md);
- **M0.3** — der Wegwerf-Spike zur Sperrzeitentreppe; er ist mit M3.1 verfallen
  und gelöscht, sein Ergebnis steht in [`infrastruktur.md`](infrastruktur.md) 6
  bis 9;
- **M0.4** — das Rechte-Gate: Quellenregister mit Freigabestatus je Datenquelle,
  durchgesetzt vom Wächter `rights-gate`, siehe [`rechte.md`](rechte.md);
- **M0.5** — Lizenz und Rechteschutz: `LICENSE` mit benanntem Rechteinhaber
  (wirksam), CLA und durchgesetzte Schichtentrennung (`layer-separation`), siehe
  [`rechteschutz.md`](rechteschutz.md). Eine Markenregistrierung erfolgt bewusst
  nicht (Inhaberentscheidung);
- **M1.1** — das Domänenmodell des Betriebsgraphen, siehe
  [`betriebsgraph.md`](betriebsgraph.md) und
  [`crates/zugfolge-infra`](../crates/zugfolge-infra);
- **M1.2** — die Import-Pipeline OSM-PBF → Rohgraph, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 7 und
  [`crates/zugfolge-infra/src/import`](../crates/zugfolge-infra/src/import);
- **M1.3** — der Netzfilter, siehe [`betriebsgraph.md`](betriebsgraph.md)
  Abschnitt 8 und
  [`crates/zugfolge-infra/src/network_filter.rs`](../crates/zugfolge-infra/src/network_filter.rs);
- **M1.4** — die Abdeckungsmessung, siehe [`betriebsgraph.md`](betriebsgraph.md)
  Abschnitt 9 und
  [`crates/zugfolge-infra/src/coverage.rs`](../crates/zugfolge-infra/src/coverage.rs);
- **M1.5** — das Neigungsprofil aus dem Höhenmodell, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 10 und
  [`crates/zugfolge-infra/src/elevation.rs`](../crates/zugfolge-infra/src/elevation.rs);
- **M1.6** — die Blockableitung, siehe [`betriebsgraph.md`](betriebsgraph.md)
  Abschnitt 11 und
  [`crates/zugfolge-infra/src/blocks.rs`](../crates/zugfolge-infra/src/blocks.rs);
- **M1.7** — die Fahrstraßen- und Durchrutschwegableitung, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 12 und
  [`crates/zugfolge-infra/src/interlocking.rs`](../crates/zugfolge-infra/src/interlocking.rs);
- **M1.8** — die Stationsdaten-Anreicherung, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 13 und
  [`crates/zugfolge-infra/src/station.rs`](../crates/zugfolge-infra/src/station.rs);
- **M1.9** — die Zugcharakteristik, siehe [`betriebsgraph.md`](betriebsgraph.md)
  Abschnitt 15 und
  [`crates/zugfolge-infra/src/train.rs`](../crates/zugfolge-infra/src/train.rs);
- **M1.10** — Fahrdynamik und Fahrzeitrechner, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 16 und
  [`crates/zugfolge-infra/src/dynamics.rs`](../crates/zugfolge-infra/src/dynamics.rs);
- **M1.11** — der Anlagenkataster, siehe [`betriebsgraph.md`](betriebsgraph.md)
  Abschnitt 14 und
  [`crates/zugfolge-infra/src/facility.rs`](../crates/zugfolge-infra/src/facility.rs);
- **M1.12** — der `InfraRelease` als unveränderliches, versioniertes Artefakt
  mit Herkunft, Lizenz, Prüfsumme und Confidence je Attribut, siehe
  [`betriebsgraph.md`](betriebsgraph.md) Abschnitt 17 und
  [`crates/zugfolge-infra/src/release.rs`](../crates/zugfolge-infra/src/release.rs);
- **M1.13** — technische Fahrzeitreferenz, GTFS-Fahrplan-Holdout und
  Abweichungsreport: Die korrigierte Trassenfinder-Kalibrierung besteht mit
  1.263 gegenüber 1.260 Sekunden innerhalb der definierten Toleranz; der
  getrennte GTFS-Holdout macht Haltezeit und Fahrplanreserve sichtbar. Das ist
  als Plausibilitäts- und Milestone-Beweis abgenommen. Der reale Pilot bleibt
  als Fixture `calibration-only` und `releaseQualified: false`; die davon
  unabhängige produktive Release-Qualifizierung und echte Signatur sind in
  Issue #48 nachgewiesen (geschlossen). Siehe
  [`referenzkorpus.md`](referenzkorpus.md).

- **M2.1** — Keycloak-Integration, Konten, Rollen, Weltzugänge, siehe
  [`weltgeruest.md`](weltgeruest.md), [`packages/identity`](../packages/identity)
  und [`apps/game-api`](../apps/game-api);
- **M2.2** — Weltisolation: `packages/db` liefert `worlds` als Wurzel der
  Mandantentrennung und das append-only Event-Log `domain_events`, beide über
  Drizzle; der Wächter `world-id` prüft seither Tabelle **und** Index in SQL
  und Drizzle, mit einer benannten, keiner erfundenen Ausnahme für `worlds`
  selbst. Das weltgebundene Repository `worldEventLog` macht das Vergessen der
  `world_id` strukturell unmöglich, und ein Test gegen eine echte, eingebettete
  Postgres-Instanz (PGlite) beweist die Trennung zweier Welten, nicht nur die
  Schemaform. Siehe [`monorepo.md`](monorepo.md) Abschnitt 3 und 4 und
  [`packages/db`](../packages/db);
- **M2.3** — EVU als Entität: Gründung, Stammdaten, Zuordnung zu Welt und
  gründendem Konto, siehe [`weltgeruest.md`](weltgeruest.md) Abschnitt 7 und
  [`packages/operators`](../packages/operators);
- **M2.4** — Ledger-Kern: Integer-Cent, unveränderlich, ausgeglichen, doppelte
  Buchführung, mit `fast-check` property-getestet auf Ausgeglichenheit, siehe
  [`weltgeruest.md`](weltgeruest.md) Abschnitt 8 und
  [`packages/economy`](../packages/economy);
- **M2.5** — Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung, siehe
  [`weltgeruest.md`](weltgeruest.md) Abschnitt 9 und
  [`packages/mailbox`](../packages/mailbox);
- **M2.6** — Datenschutz: Datenminimierung, Auskunft, Löschung,
  Aufbewahrungsfristen, siehe [`weltgeruest.md`](weltgeruest.md) Abschnitt 10
  und [`packages/privacy`](../packages/privacy).

Damit ist **M2 abgeschlossen**: das Weltgerüst — Konten, Weltisolation, EVU,
Ledger, Postfach, Datenschutz — steht vollständig.

- **M3.1** — das Sperrzeitenmodell mit sechs Anteilen, halboffenen Intervallen
  und Parametern je Betriebsstelle und Stellwerksbauart, siehe
  [`infrastruktur.md`](infrastruktur.md) 6 und
  [`crates/zugfolge-conflict`](../crates/zugfolge-conflict);
- **M3.2** — `ServicePattern` und relatives `OccupationProfile` samt
  Zugnummernsystematik und Verkehrstagen, siehe
  [`infrastruktur.md`](infrastruktur.md) 7;
- **M3.3** — der Konfliktprüfer mit erklärbarem Ergebnis und das Belegungsbuch,
  das Invariante 1 durch Konstruktion hält, siehe
  [`infrastruktur.md`](infrastruktur.md) 8;
- **M3.4** — der Trassen-Planner mit Laufweg-, Zeitlagen- und
  Betriebshaltkandidaten, siehe [`infrastruktur.md`](infrastruktur.md) 9 und
  [`crates/zugfolge-planner`](../crates/zugfolge-planner);
- **M3.5** — der deterministische `PlanningRun`: Seed-Tiebreak über den
  gesamten Antragsbestand eines Planungsfensters und Einspruchsfenster, siehe
  [`infrastruktur.md`](infrastruktur.md) 10;
- **M3.6** — die Fahrplanperiode als Ablauf: `SchedulePeriod` mit
  Anmeldefenster, Koordinierung, Veröffentlichung und Betrieb, siehe
  [`infrastruktur.md`](infrastruktur.md) 11;
- **M3.7** — Ad-hoc-Trassen aus Restkapazität, mit Stornierung und Verfall bei
  Nichtnutzung, siehe [`infrastruktur.md`](infrastruktur.md) 12;
- **M3.8** — Rahmenverträge mit Kapazitätsdeckel, siehe
  [`infrastruktur.md`](infrastruktur.md) 13.

---

## M0 — Fundament und Grundsatzentscheidungen

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 0.1 | ADRs schriftlich festhalten — E1 bis E16 sind entschieden und werden dokumentiert, nicht neu verhandelt | S | erledigt |
| 0.2 | Monorepo, CI, Determinismus-Testharnisch, Domänenglossar, **CI-Wächter gegen Payment-Tier-Felder**, **Lizenz-Scan der Abhängigkeiten** | S | erledigt |
| 0.3 | **Wegwerf-Spike Sperrzeitentreppe:** 3 Betriebsstellen, eine zweigleisige Strecke plus eingleisiger Ast, zwei Züge, Konfliktprüfung, Bildfahrplan als Bild | M | erledigt |
| 0.4 | Rechte-Gate: dokumentierter Freigabestatus je Datenquelle, inklusive Trassenfinder-Nutzungsbedingungen | S | erledigt |
| 0.5 | Lizenz und Rechteschutz: `LICENSE`, CLA, Schichtentrennung von Code, Daten und Marke, Markenanmeldung anstoßen | S | erledigt |

> **Beweis:** Ein echter Belegungskonflikt wird korrekt erkannt und in einer
> Sperrzeitentreppe sichtbar gemacht. Das ist die Existenzberechtigung des
> gesamten Projekts — und der billigste Zeitpunkt, sie zu prüfen.
>
> **Geführt in M0.3**: Zwei Züge gerieten auf dem eingleisigen Ast in
> Gegenfahrt, zwei weitere in den Zugfolgefall; beide Konflikte wurden mit
> Ressource, Zeitfenster und Gegenzug gemeldet und im Bildfahrplan sichtbar
> gemacht. Der Spike ist mit M3.1 verfallen und gelöscht; seine Befunde tragen
> seither das Modell in `crates/zugfolge-conflict`.

Drei Befunde des Spikes wirken auf spätere Milestones, ausführlich in seiner
README:

| Befund | Wirkung |
|--------|---------|
| Ein Ressourcenmodell trägt beide Konfliktarten — Zugfolge und Gegenfahrt sind eine Eigenschaft des Netzes, keine zweite Regel | M3.1, M3.3 |
| Der Bahnhofskopf fehlt: Ohne Fahrstraßenausschluss prüft der Konfliktprüfer nur die halbe Wahrheit | M1.7 bleibt der teuerste Posten in M1 |
| Die Prüfung kennt nur die triviale Auflösung („später fahren"); die betrieblich richtige — kreuzen in einer Betriebsstelle — ist ein eigenes Verfahren | M3.4 ist keine Erweiterung des Prüfers |

Alle drei sind mit M3.1 bis M3.4 abgearbeitet; die Zuordnung steht bei M3.

---

## M1 — Betriebsgraph und Infrastruktur-Release

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 1.1 | Domänenmodell: Betriebsstellen, Kanten, Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder, Neigung | M | erledigt |
| 1.2 | Import-Pipeline OSM-PBF → Rohgraph mit Topologie, Geometrie, Tags | L | erledigt |
| 1.3 | **Netzfilter**: nur `railway=rail` in 1435 mm; Tram, Stadtbahn, U-Bahn, Schmalspur, Standseil- und Einschienenbahnen verwerfen; Stromschienennetze über Netzausschlussliste. **Betriebs-, Abstell- und Anschlussgleise bleiben erhalten** | M | erledigt |
| 1.4 | **Abdeckungsmessung**: Coverage-Report je Attribut und Streckenabschnitt. Entscheidet *vor* dem Bau, welche Strecke Klasse A erreichen kann | M | erledigt |
| 1.5 | **Neigungsprofil aus Höhenmodell** — aus einem DEM entlang der Gleisgeometrie abgeleitet und geglättet | M | erledigt |
| 1.6 | **Blockableitung** aus Signalpositionen, Zugbeeinflussung und Topologie; virtuelle Blöcke bei vollständig konservativ schließbaren Lücken; reine LZB-/ETCS-Blöcke bei durchgehender Überwachung; Qualitätsklassifizierung A/B, offene Pflichtbefunde als Releaseblocker | L | erledigt |
| 1.7 | **Fahrstraßen- und Durchrutschwegableitung** im Bahnhofskopf — aus Weichenlage und Signalstandort erzeugt | **XL** | erledigt |
| 1.8 | Stationsdaten-Anreicherung — ausschließlich freigegebene Quellen | M | erledigt |
| 1.9 | **Zugcharakteristik** als eigenes Konzept: Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung. Entkoppelt Fahrzeitrechnung und Trassenplanung vom Fahrzeugkatalog (M5) | M | erledigt |
| 1.10 | Fahrdynamik und Fahrzeitrechner → vorberechnete **ganzzahlige** Fahrzeittabellen je Zugcharakteristik | L | erledigt |
| 1.11 | **Anlagenkataster**: Werkstätten, Behandlungs- und Waschanlagen, Tankstellen, Entsorgungsanlagen, Abstellgleise — mit Kapazität, Öffnungszeit, Nutzlänge, Baureihenkompetenz | M | erledigt |
| 1.12 | `InfraRelease` als unveränderliches, versioniertes Artefakt mit Herkunft, Lizenz, Checksumme und Confidence je Attribut | M | erledigt |
| 1.13 | Technische Fahrzeitreferenz, GTFS-Fahrplan-Holdout und Abweichungsreport für den Pilotkorridor Leipzig–Halle | M | erledigt |

> **Beweis:** Ein reproduzierbarer `InfraRelease`-Kandidat des Pilotkorridors
> Leipzig–Halle, dessen
> berechnete technische Fahrzeit innerhalb definierter Toleranz zur manuell
> dokumentierten Trassenfinder-Referenz liegt — begleitet von einem
> Abdeckungsreport und einem getrennten GTFS-Fahrplan-Holdout, der Haltezeit und
> Fahrplanreserve offenlegt.

> **Abnahmegrenze:** Der automatisierte, lizenzgeprüfte Weg von GTFS-Sollplänen
> bis zum Signatur-Gate ist umgesetzt, und der echte S5X-Holdout umfasst 85
> Fahrten. Die Trassenfinder-Kalibrierung besteht mit +3 Sekunden. Weil derselbe
> technische Wert auch zum Kalibrieren verwendet wurde, bleibt der konkrete
> Report bewusst `calibration-only` und nicht produktiv signierbar. Eine
> disjunkte technische Validierung auf freigegebenen Infrastruktur- und
> Fahrzeugwerten sowie die echte Signatur sind als getrennte
> Release-Härtung in Issue #48 nachgewiesen; die Fixture wird dadurch nicht
> nachträglich zum produktiven Release.

**M1.1 trägt:** `crates/zugfolge-infra` beschreibt Betriebsstellen, Kanten,
Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder und Neigung,
prüft beim Bauen jede Zusicherung des Modells und liefert einen kanonischen
Fingerabdruck, der nicht an der Einfügereihenfolge hängt — die spätere
Prüfsumme des `InfraRelease` (M1.12). Drei Entscheidungen wirken weiter:

| Entscheidung | Wirkung |
|--------------|---------|
| Gefahren wird auf **Gleisen**, die Richtungsbindung liegt am Gleis | Zugfolgefall und Gegenfahrt bleiben eine Eigenschaft des Netzes, keine zweite Regel (M3.1, M3.3) |
| Vmax, Neigung, Elektrifizierung und Zugsicherung sind **ein** Bandmechanismus | M1.5 und M1.6 füllen Bänder, statt je ein eigenes Modell zu bauen |
| Die Herkunft hängt am einzelnen **Band**, nicht am Gleis | M1.4 kann je Attribut und Abschnitt messen, ohne das Modell aufzuschneiden |

**M1.2 trägt:** Die Import-Pipeline liest einen genehmigten OSM-PBF-Extract
(Quelle `osm-pbf-lhe`, `docs/rechte.md`) blockweise und baut daraus einen
Rohgraph — Topologie, Geometrie und Tags, roh und ungefiltert. Ein Knoten wird
nur dann zum eigenen Punkt des Rohgraphen, statt bloß zur Geometrie eines
Wegabschnitts zu gehören, wenn er Anfang oder Ende eines Wegs ist, zwei Wege
verbindet oder selbst einen `railway`-Tag trägt. Der Rohgraph ist bewusst noch
kein `OperatingGraph`: Was zum EBO-Netz gehört, entscheidet erst der
Netzfilter (M1.3). Der PBF-Leser ist von Hand geschrieben — Varint, Zickzack,
Blob-Rahmen — statt über eine generierte Protobuf-Anbindung, weil das Format
selbst nur diesen kleinen, stabilen Ausschnitt von Protobuf braucht. Siehe
`betriebsgraph.md` Abschnitt 7.

**M1.3 trägt:** Der Netzfilter wählt aus dem Rohgraph das EBO-Netz aus —
ausschließlich `railway=rail` in Regelspur, ohne Stromschiene. Jeder andere
`railway`-Wert fällt heraus, auch ein hier nicht ausdrücklich genannter: Nur
`rail` ist zulässig, alles andere gilt als nicht zur EBO gehörig. Betriebs-,
Abstell- und Anschlussgleise bleiben erhalten, weil der Filter kein
`service`-Tag prüft. Das Ergebnis ist wieder ein Rohgraph. Siehe
`betriebsgraph.md` Abschnitt 8.

**M1.4 trägt:** Die Abdeckungsmessung bildet den Vertrauensgrad jedes Bandes
unmittelbar auf eine Qualitätsklasse ab (erfasst → A, abgeleitet → B,
angenommen → C) und zerlegt jedes Gleis an jeder Bandgrenze seiner vier
Profile neu, damit jeder Abschnitt seine eigene erreichbare Klasse trägt.
Das ist die datenseitige Obergrenze, auf der die Blockableitung (M1.6) und
die Fahrstraßenableitung (M1.7) erst noch aufsetzen müssen, um Klasse A
tatsächlich zu erreichen. Siehe `betriebsgraph.md` Abschnitt 9.

**M1.5 trägt:** Aus Höhenstichproben entlang der Gleisgeometrie entsteht ein
geglättetes Neigungsprofil — Stützpunkte im Mindestabstand einer
Bandlänge, linear interpoliert, statt jede Stichprobe einzeln in ein Band zu
übersetzen. Jedes Band trägt `Confidence::Derived`. Das Höhenmodell der
Pilotregion selbst steht im Quellenregister noch auf `pruefung`
(`docs/rechte.md` 3) — M1.5 liefert deshalb das Verfahren, keinen Import; der
folgt erst mit der Freigabe. Siehe `betriebsgraph.md` Abschnitt 10.

**M1.6 trägt:** Die Blockableitung (`derive_block_sections`) zerlegt ein Gleis
aus Signalpositionen, Zugbeeinflussung und Topologie in seine Blockabschnitte.
Ein Hauptsignal setzt eine Blockgrenze, ein Vorsignal nicht; eine durchgehend
LZB- oder ETCS-geführte Strecke ist ein **realer, führerraumsignalisierter
Block** ohne ortsfestes Signal — der reine LZB- und der reine ETCS-Block, gerade
keine Datenlücke. Nur wo weder ein Kennzeichen noch die durchgehende Überwachung
einspringt, füllt das Verfahren eine zu lange Lücke mit **virtuellen Blöcken**.
Jeder freigegebene Block trägt Qualitätsklasse A oder ein vollständig
konservativ geschlossenes B. Ein offener Pflichtbefund erzeugt keinen
Releaseblock, sondern blockiert den Kandidaten. Siehe `betriebsgraph.md`
Abschnitt 11.

**M1.7 trägt:** Die Fahrstraßen- und Durchrutschwegableitung
(`derive_interlocking_routes`) zählt aus Weichenlage und Signalstandort eines
`StationHead` alle Fahrstraßen durch den Weichenfächer auf, hält je Fahrstraße
die belegten Elemente, die geforderten Weichenlagen und den Durchrutschweg fest
und leitet daraus die **Ausschlussmenge** ab — die Konfliktressource des
Bahnhofskopfs, die der Spike aus M0.3 offengelassen hatte. Siehe
`betriebsgraph.md` Abschnitt 12.

**M1.8 trägt:** OpenStation und StaDa sind im Quellenregister freigegeben;
der konkrete Jahreslauf bindet trotzdem nur den tatsächlich verwendeten
Snapshot samt Bereitstellungsweg, Rechten und Prüfsumme. Der Deutschlandlauf
verwendet OpenStation, StaDa bleibt optional. `StationEnrichment` bindet
Bahnhofskategorie und Ausstattung an eine Betriebsstelle mit planmäßigem
Fahrgastwechsel, mit einer **eigenen Herkunft je Feld** (`Attributed<T>`) statt
einer gemeinsamen für den ganzen Eintrag — eine Anreicherung kommt in Schüben,
keine Ersterfassung in einem Zug. `StationEnrichmentCatalogBuilder::build`
prüft jeden Eintrag gegen einen fertigen `OperatingGraph`. Wie M1.5 bis M1.7
ist das Verfahren selbst kein Import; der konkrete Adapter bleibt ein eigener
Jahresbuild-Schritt. Siehe
`betriebsgraph.md` Abschnitt 13.

**M1.9 trägt:** `docs/infrastruktur.md` 2 sagt es wörtlich — „Zugcharakteristik
statt Fahrzeugliste": `TrainCharacteristics` bündelt Masse, Länge, Vmax,
Anfahr- und Bremsvermögen, Antriebsart (`TractionType`) und Zugsicherung
(dieselbe `TrainProtection` wie streckenseitig) zu genau der abstrakten Sicht,
mit der Trassen-Planner (M3.4) und Fahrzeitrechnung (M1.10) arbeiten, ohne ein
konkretes Fahrzeug zu kennen. Die Antriebsart entscheidet über eine
Schnittmengenfrage — dieselbe Form wie bei der Zugsicherung —, ob ein Zug eine
Elektrifizierung nutzen kann; Diesel- und Akkubetrieb sind vom Fahrdraht
unabhängig. Siehe `betriebsgraph.md` Abschnitt 15.

**M1.10 trägt:** Die Fahrdynamik (`crates/zugfolge-infra/src/dynamics.rs`) ist
der in `docs/monorepo.md` 3 vorgesehene, einzige Ort mit Gleitkommarechnung in
diesem Crate. `derive_running_time_table` rechnet über einen `RunPath` — einen
Fahrweg aus `RunSegment`s mit Länge, zulässiger Geschwindigkeit und Neigung —
in zwei Durchgängen die maximal erreichbare Geschwindigkeit an jeder
Segmentgrenze: rückwärts die Bremskurve vor jeder Beschränkung, vorwärts das
tatsächlich Erreichbare aus Anfahrvermögen und Einstiegsgeschwindigkeit. Jedes
Segment liefert daraus ein Trapez- oder Dreiecksgeschwindigkeitsprofil, dessen
Zeit aufgerundet in die **ganzzahlige** Fahrzeittabelle eingeht — eine
vorberechnete Fahrzeit darf nie eine schnellere Fahrt versprechen, als
physikalisch möglich ist. Die Neigung wirkt auf beide Vermögen; reicht eines
unter ihr nicht mehr aus, meldet das Verfahren einen Fehler, statt eine
unmögliche Fahrt zu berechnen. `RunPath::push_track_range` prüft dabei die
Zugsicherungs- und Antriebskompatibilität gegen das befahrene Gleis. Siehe
`betriebsgraph.md` Abschnitt 16.

**M1.11 trägt:** Der Anlagenkataster (`FacilityCatalog`) führt Werkstätten,
Behandlungs- und Waschanlagen, Tankstellen, Entsorgungsanlagen und als Anlage
geführte Abstellgleise — jede mit Kapazität, Öffnungszeit, Nutzlänge und
**Baureihenkompetenz** als Menge, wie `docs/betrieb.md` 4 es fordert: „Anlagen
sind Konfliktressourcen wie Gleise.“ `FacilityCatalogBuilder::build` prüft
jede Anlage gegen einen fertigen `OperatingGraph` — ihr Gleis muss existieren
und darf kein Hauptgleis sein, auf dem Zugfahrten stattfinden. Die **Belegung**
einer Anlage bleibt M5.7 vorbehalten: M1.11 liefert den Kataster, nicht die
Konfliktengine. Siehe `betriebsgraph.md` Abschnitt 14.

**M1.12 trägt:** Der `InfraRelease` friert einen geprüften `OperatingGraph` zu
einem **unveränderlichen, versionierten Artefakt** ein — mit `ReleaseVersion`,
Herkunft **und** Lizenz je Quelle (`ReleaseSource`), einer Prüfsumme über das
Ganze und der Abdeckung je Attribut (`CoverageReport` aus M1.4).
`InfraReleaseBuilder::build` sammelt jede Quelle, die ein Attribut des Netzes
nennt, und prüft, dass jede mit einer Lizenz deklariert ist und keine ohne
Gegenstand — `docs/daten.md` 2: „Jedes importierte Attribut trägt Quelle,
Lizenz, Gültigkeit, Checksumme und Confidence." Die Prüfsumme ist der
Fingerabdruck des Graphen (M1.1), umschlossen von Version und Quellen, und wie
er über `DeterministicModel` und einen Golden-Master auf Linux und Windows
gesichert; mit M1.12 pinnt `rust-toolchain.toml` zusätzlich die Rust-Version,
damit die Reproduzierbarkeit nicht an der Toolchain hängt. Siehe
`betriebsgraph.md` Abschnitt 17.

**M1.13 trägt; die produktive Release-Qualifizierung bleibt getrennt:**
`tools/reference-corpus` erfasst Sollfahrpläne aus dem unter CC BY 4.0
freigegebenen GTFS.DE-Regionalverkehrsfeed, hasht ZIP und Tabellen und paart nur
Halte derselben `trip_id`. Linie, Richtung, Haltefolge und
`TrainCharacteristics` gehören zum Gruppenschlüssel. GTFS-P20, Median,
Mittelwert und Haltezeit bleiben ausdrücklich Fahrplanwerte; die technische
Referenz ist ein getrenntes Artefakt. `artifact-chain.mjs` bindet Capture,
normalisierte Tabellen, disjunkte Kalibrierungs- und Validierungsbestände,
Modell, Report, Release und Bundle durchgehend per Hash. Negative Tests sperren
Überlappung, unzureichende Stichproben, Toleranzverletzung und jede
nachträgliche Manipulation.

Der Linux-Job von Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
hat diese technische Kette auf Commit `e289511` erfolgreich ausgeführt. Der
Kalibrierungsbestand bleibt dennoch `calibration-only`. Unabhängig freigegebene
Infrastruktur- und Fahrzeugwerte sowie die Signatur der benannten
Release-Verantwortung sind mittlerweile in Issue #48 nachgewiesen. Der
getrennte produktive Nachweis ändert nicht den abgenommenen M1-Beweis aus
technischer Plausibilisierung und getrenntem Fahrplan-Holdout. Der
Trassenfinder bleibt auf `entwicklung` (E10). Siehe `betriebsgraph.md`
Abschnitt 18 und
[`referenzkorpus.md`](referenzkorpus.md).

Ausführlich: [`betriebsgraph.md`](betriebsgraph.md).

---

## M2 — Weltgerüst: Konten, Weltisolation, Ledger

Klein, aber vor allem Weiteren zwingend: Ab M3 beantragen **zwei Spieler**
konkurrierende Trassen, und ab da kostet etwas Geld. Beides nachträglich
einzuziehen hieße, jede Abfrage und jede Zeile anzufassen.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 2.1 | Keycloak-Integration, Konten, Rollen, Weltzugänge | M | erledigt |
| 2.2 | **Weltisolation**: `world_id` in jeder Tabelle, jedem Index, jedem Event — mit automatisiertem Nachweis statt Disziplin | M | erledigt |
| 2.3 | EVU als Entität: Gründung, Stammdaten, Zuordnung zu Welt und Spieler | S | erledigt |
| 2.4 | **Ledger-Kern**: Integer-Cent, unveränderlich, ausgeglichen, doppelte Buchführung, Property-Test auf Ausgeglichenheit | M | erledigt |
| 2.5 | Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung — trägt später Trassenangebote, Ausschreibungen und Störungsmeldungen | S | erledigt |
| 2.6 | Datenschutz: Datenminimierung, Auskunft, Löschung, Aufbewahrungsfristen | M | erledigt |

> **Beweis:** Zwei Konten in derselben Welt sehen einander, zwei Konten in
> verschiedenen Welten sehen einander nachweislich nicht — belegt durch einen
> automatisierten Isolationstest, nicht durch Sichtprüfung.

**M2.1 trägt:** Drei world-geschnittene Tabellen — Weltzugang
(`worldAccesses`), Konto (`accounts`) und Kontorolle (`accountRoles`), jede
mit `world_id` als führender Spalte ihres Eindeutigkeitsindex und mit
Fremdschlüssel auf `worlds` (Invariante 4) — liegen als Drizzle-Schema in
`packages/db`, neben `worlds` und `domain_events` aus M2.2.
`packages/identity` bündelt darüber die fachliche Logik: Keycloak bleibt
eigenständiger OIDC-Identity-Provider (`architektur.md` 5), verifiziert wird
ein mitgebrachtes Zugriffstoken, gespeichert wird nur, wofür das Spielsystem
selbst Quelle der Wahrheit ist. Zugang und Konto sind bewusst getrennt, damit
ein entzogener Zugang die Betriebshistorie eines Kontos nicht mit sich reißt
(E8). Der erste Weltverwalter (`world_admin`) entsteht durch
Selbstermächtigung, ausschließlich für das anfragende Konto — jede weitere
Rollenvergabe verlangt bereits diese Rolle in genau der betroffenen Welt.
`apps/game-api` verdrahtet das zu einem Fastify-Dienst mit
Bearer-Token-Authentifizierung. Die Kontoliste einer Welt verlangt selbst ein
Konto in ihr — der erste, hier bereits nachgewiesene Ausschnitt des Beweises
von M2. Siehe [`weltgeruest.md`](weltgeruest.md).

**M2.2 trägt:** `packages/db` liefert `worlds` als Wurzel der
Mandantentrennung — sie *ist* die Welt, keine ihrer Zeilen, und trägt deshalb
selbst keine `world_id` — und das append-only Event-Log `domain_events`,
dessen beide Indizes mit `world_id` beginnen. Der Wächter `world-id` prüft
seither Tabelle **und** Index, in SQL wie in Drizzle, mit genau dieser einen
benannten Ausnahme. Das weltgebundene Repository `worldEventLog` bindet die
`world_id` an den Konstruktor statt an jeden Aufruf, und ein Test gegen eine
echte, eingebettete Postgres-Instanz (PGlite) beweist die Trennung zweier
Welten — nicht nur, dass das Schema es verspricht. Damit ist der
Belegungstest aus dem Beweis von M2 vollständig erbracht: Zwei Konten
derselben Welt sehen einander (M2.1), zwei Welten sehen einander im Event-Log
nachweislich nicht (M2.2). Siehe [`monorepo.md`](monorepo.md) Abschnitt 3 und
4 und [`packages/db`](../packages/db).

**M2.3 trägt:** `packages/operators` gründet ein EVU (`Operator`) für ein
bestehendes Konto und ordnet es Welt und gründendem Konto zu — die Tabelle
`operators` (`packages/db`) trägt `world_id` als führende Spalte ihres
Eindeutigkeitsindex, zusammen mit dem Unternehmensnamen: eindeutig je Welt,
nicht global (E6). Ein Konto kann mehrere EVU gründen, weil Kooperation
zwischen EVU (`wirtschaft.md` 6) getrennte Rechtsträger voraussetzt. Die
EVU-Liste einer Welt trägt denselben Belegungstest wie die Kontoliste aus
M2.1. Siehe [`weltgeruest.md`](weltgeruest.md) Abschnitt 7.

**M2.4 trägt:** `packages/economy` ist der Ledger-Kern aus
`wirtschaft.md` 1: Integer-Cent als `bigint`, unveränderlich (nur Einfügen
und Lesen — derselbe Mechanismus wie beim Event-Log aus M2.2), ausgeglichen
(`postLedgerTransaction` weist jede Transaktion zurück, deren Buchungen
nicht exakt null Cent ergeben) und doppelt geführt (mindestens zwei
Buchungen je Transaktion, auf Konten desselben EVU). Die Ausgeglichenheit ist
mit `fast-check` property-getestet, rein (`balance.property.test.ts`) und
gegen eine echte, eingebettete Datenbank über beliebig viele Transaktionen
(`ledger.test.ts`). `packages/economy/**` unterliegt seither der
Wächterregel `no-wallclock`: Zeitpunkte sind explizite Werte des Aufrufers.
Kostenarten und Kostenstellen bleiben M6.2 vorbehalten, das nur noch darauf
aufsetzt. Siehe [`weltgeruest.md`](weltgeruest.md) Abschnitt 8.

**M2.5 trägt:** `packages/mailbox` liefert das Postfach-Grundgerüst —
Nachrichten mit generischem `messageType` und `payload` (jsonb, derselbe
Schnitt wie beim Event-Log), optionaler Frist (`deadlineAt`) und Quittierung
(`acknowledgedAt`). Nur der Empfänger quittiert, nie stellvertretend ein
Weltverwalter. Trassenangebote, Ausschreibungen und Störungsmeldungen
(spätere Milestones) werden je ein `messageType`, keine eigene Tabelle.
Siehe [`weltgeruest.md`](weltgeruest.md) Abschnitt 9.

**M2.6 trägt:** `packages/privacy` trägt Auskunft (`exportAccountData` —
Konto, Weltzugangsstatus, eigene EVU, Postfach an einer Stelle) und Löschung
(`eraseAccountData` — Anzeigename anonymisiert, Weltzugang entzogen, Konto
selbst bleibt bestehen wie bei einer Insolvenz, E8). `revokeWorldAccess`
(`packages/identity`) trägt dafür seit M2.6 eine Selbstbedienungs-Ausnahme:
Eine Identität entzieht sich jederzeit selbst den Zugang. Ledger und
Event-Log bleiben außerhalb der Löschung — unveränderlich und ohne
natürliche Person — mit `retention.ts` nachvollziehbar begründet. Damit ist
der Beweis von M2 vollständig: Ein EVU wird gegründet, führt einen
ausgeglichenen Ledger, empfängt Postfach-Nachrichten, und sein Konto lässt
sich vollständig auskunfts- und löschbar behandeln. Siehe
[`weltgeruest.md`](weltgeruest.md) Abschnitt 10.

---

## M3 — Sperrzeiten, Konfliktengine, Trassenvergabe

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 3.1 | Sperrzeitenmodell: Fahrstraßenbildezeit, Annäherung, Fahrzeit, Räumung, Auflösung | L | erledigt |
| 3.2 | `ServicePattern` + relatives `OccupationProfile`, inklusive Zugnummernsystematik | M | erledigt |
| 3.3 | Konfliktprüfer mit erklärbarem Ergebnis: welche Ressource, welches Fenster, welcher Gegenzug | L | erledigt |
| 3.4 | Trassen-Planner: Laufweg- und Zeitlagenkandidaten, zulässige Abweichungen | **XL** | erledigt |
| 3.5 | Deterministischer `PlanningRun`, Koordinierungsverfahren, Seed-Tiebreak, Einspruchsfenster | L | erledigt |
| 3.6 | Fahrplanperiode als Ablauf: Anmeldefenster, Koordinierung, Veröffentlichung, Betrieb | M | erledigt |
| 3.7 | Ad-hoc-Trassen aus Restkapazität, Stornierung, Verfall bei Nichtnutzung | M | erledigt |
| 3.8 | Rahmenverträge mit Kapazitätsdeckel | M | erledigt |
| 3.9 | **Gestaltungssystem**: Palette, Komponentenbibliothek, Icons, responsive Arbeitsbereiche und Zugänglichkeit; aktueller Neuaufbau gemäß [Design](design.md) und ADR-0035, ursprüngliche Komponentenabnahme bleibt erhalten | L | erledigt |
| 3.10 | Bildfahrplan-UI, Sperrzeitentreppe, Konflikterklärung im Client — Konvention vor Originalität | L | erledigt |

> **Beweis:** Zwei Spieler beantragen konkurrierende Trassen. Das System
> entscheidet nachvollziehbar, bietet eine Alternative an, und die Entscheidung
> ist bei gleichem Seed exakt reproduzierbar.
>
> **Geführt in M3.5**: Zwei Anträge derselben Wunschlage geraten in
> Widerstreit; unabhängig davon, in welcher Reihenfolge sie dem `PlanningRun`
> übergeben werden, gewinnt derselbe — und über viele Fahrplanperioden hinweg
> entscheidet dabei tatsächlich der veröffentlichte Seed, nicht eine versteckte
> Bevorzugung. Der Verlierer erhält im Einspruchsfenster Gelegenheit, seine
> Abweichungen zu erweitern; ein erneuter Lauf mit demselben Seed liefert dann
> beiden eine Trasse.

**M3.1 bis M3.8 tragen.** Drei Crates, weil es drei Fragen sind: Ist eine
Trasse **zulässig** (`crates/zugfolge-conflict`, M3.1–M3.3, M3.8), welche ist
**gut** (`crates/zugfolge-planner`, M3.4), und wie werden **mehrere**
konkurrierende Anträge gemeinsam entschieden (`crates/zugfolge-planner`,
M3.5–M3.7)?

| Teilabschnitt | Was steht | Wo |
|---------------|-----------|-----|
| M3.1 | sechs Anteile, halboffene Intervalle, Parameter je Betriebsstelle und Stellwerksbauart statt netzweiter Konstanten | `infrastruktur.md` 6 |
| M3.2 | `ServicePattern` mit Verkehrstagen und Zugnummernsystematik über einem relativen `OccupationProfile` — einmal rechnen, oft verschieben | `infrastruktur.md` 7 |
| M3.3 | Belegungsbuch mit erklärbarem Befund; Invariante 1 gilt darin **durch Konstruktion** und ist als Property-Test über 400 Lagen belegt | `infrastruktur.md` 8 |
| M3.4 | Laufweg-, Zeitlagen- und Betriebshaltkandidaten; veröffentlichte Rangfolge statt Zielfunktion (E11) | `infrastruktur.md` 9 |
| M3.5 | `PlanningRun`: der gesamte Antragsbestand eines Fensters als ein `Tie`, aufgelöst über den Seed; Einspruchsfenster mit erneuter, deterministischer Koordinierungsrunde | `infrastruktur.md` 10 |
| M3.6 | `SchedulePeriod`: Anmeldefenster, Koordinierung, Veröffentlichung, Betrieb als ganzzahlige, halboffene Achtel der Periodenlänge | `infrastruktur.md` 11 |
| M3.7 | `AdHocLedger`: Restkapazität ohne Verdrängung, Stornierung, Verfall unter einem Nutzungsschwellwert in Basispunkten | `infrastruktur.md` 12 |
| M3.8 | `FrameworkAgreement` und `FrameworkCapacityLedger`: Kapazitätsdeckel je Korridor, alles-oder-nichts-Bindung, abgerundete Basispunkte | `infrastruktur.md` 13 |

**Der Spike aus M0.3 ist damit abgelöst und gelöscht**, wie seine README es
angekündigt hatte. Alle drei Befunde und alle drei offenen Punkte sind
abgearbeitet:

| Was der Spike hinterließ | Wo es jetzt steht |
|--------------------------|-------------------|
| Ein Ressourcenmodell trägt beide Konfliktarten | `ConflictResource` (M3.1) — die Fallunterscheidung liegt im Netz, nicht im Prüfer |
| Halboffene Intervalle, Mindestzugfolgezeit fällt aus dem Modell | `RelativeOccupation` und `minimum_headway` (M3.1, M3.3) |
| Der Befund ist von sich aus erklärbar | `OccupationConflict::explain` (M3.3) |
| **Offen:** der Bahnhofskopf braucht Ausschlussmengen | `ResourceExclusions` aus M1.7, wirksam seit M3.3 |
| **Offen:** die Fahrdynamik fehlt | `derive_running_time_table_with_exit` (M1.10, um die Bremskurve in den Halt ergänzt) |
| **Offen:** die betrieblich richtige Auflösung ist ein eigenes Verfahren | der Betriebshalt des Planners (M3.4) — er kreuzt zur Wunschzeit, statt später zu fahren |

**M3.9 und M3.10 tragen:** `packages/design-system` konkretisiert Palette,
Form-, Tabellen-, Feedback- und Navigationsbausteine, Icons und Fokusvertrag.
Die ursprünglichen Dichtestufen sind Teil des damaligen Nachweises; heute
bestimmen `railway.css`, `railway.ts` und die aufgabenbezogenen Register die
Spieleroberfläche. Zwei authentifizierte Konten stellen getrennte,
weltgebundene Trassenanträge. `packages/planning-worker` lädt sie mit dem
serverseitig eingefrorenen Infrastruktur-Release, führt den echten Rust-
`PlanningRun` über die fail-closed napi-rs-Grenze aus und schreibt Runtime-
Zustand und `planning.diagram` atomar. Angebote sind revisionsgebunden; eine
angewandte Alternative wird erneut durch Rust geprüft und als höhere
Projektion persistiert.

`apps/game-web` lädt diese Projektion über die echte API und zeigt Bildfahrplan,
alle sechs Sperrzeitanteile, Ressource, Zeitfenster, beteiligte Züge,
Konfliktart, Erklärung und Alternative. Lade-, Leer- und Fehlerzustand sind
robust; Farbe bleibt durch Text, Symbol oder Musterung redundant. Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
beweist auf `e289511` den echten PlanningRun-Smoke, Apply/Replay und den mit
PGlite komponierten Worker. Damit ist M3.10 reproduzierbar nachgewiesen.

---

## M4 — Simulationskern und Livemap

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 4.1 | Ereignisgesteuerter Kern, regionale Single-Writer, expliziter Zeitgeber | L | erledigt |
| 4.2 | `TrainRun`-Zustandsmodell, Materialisierungsfenster 48–72 h | M | erledigt |
| 4.3 | Verspätungs**propagation**: Regelwiderstände, Haltezeiten, Anschlussverzug. Ereignisursachen kommen erst in M8 — hier geht es um Fortpflanzung, nicht um Entstehung | L | erledigt |
| 4.4 | **Dispositionsschnittstelle im Kern**: definierter Entscheidungspunkt je Ereignis, zunächst mit konservativem Standardverhalten. Macht M7 zu einer Implementierung statt zu einer Operation am offenen Herzen | M | erledigt |
| 4.5 | Regionsübergabe mit Bestätigungsprotokoll | M | erledigt |
| 4.6 | Delta-Streaming: Initialsnapshot, Sequenz-Deltas, Interpolation im Client | M | erledigt |
| 4.7 | Eigene Dark-Vector-Tiles, Pipeline → PMTiles — Netz zurückhaltend, Verkehr dominant; ausgeschlossene Netze als blasse Kontextlinien | M | erledigt |
| 4.8 | LiveMap mit Zugdetails und Sichtbarkeitsregeln; deutschlandweite Übersicht und verständliche Zustandsdarstellung nach [Design](design.md): Mint für bestätigte normale Positionen, Abweichungen zusätzlich als Text, fehlende Daten ausdrücklich kenntlich | L | erledigt |
| 4.9 | Event-Log, Replay, Determinismus-Test in CI | M | erledigt |
| 4.10 | **Zeitumstellung**: Verhalten der Fahrplanperiode und laufender Zugfahrten beim Sommerzeitwechsel — Pflichtfall im 1:1-Echtzeitbetrieb | S | erledigt |
| 4.11 | **Lastmessung gegen die Zielgrößen** aus `architektur.md` | M | erledigt |

> **Beweis:** 200 simulierte Züge laufen 24 Stunden stabil, die Karte zeigt sie
> flüssig, und ein Replay erzeugt bitgleiche Zustände.

**M4.6 trägt:** `zugfolge-sim-runtime` und der
`RegionalSimulationWorker` restaurieren je Welt und Region den autoritativen
Rust-Zustand, prüfen Revision, Hash und Producersequenz und persistieren Zustand
und Events vor jeder Livemap-Publikation atomar. Snapshot und Fetch-SSE sind
authentifiziert und weltisoliert. `streamId:sequence`, atomare Subscription,
begrenzte Queue, Heartbeats, Cleanup und gezielter Re-Snapshot schließen Race,
Lücken und Restart-Verwechslungen. Der Client interpoliert nur die Anzeige und
ändert keinen Fachzustand. Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
beweist auf `e289511` den echten Linux-NAPI-Publisher, Postgres/API-Pfad,
Resume/Reset und das Lastziel.

---

## M5 — Flotte, Personal, Umläufe, Versorgung

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 5.1 | Fahrzeugkatalog mit **getrennten Feldern für Baureihenbezeichnung und Handelsname**; Fahrzeug als individuelles Asset mit Fristen, Zulassung, Eigentum | M | erledigt |
| 5.1a | **Fahrzeugkonfiguration** (E20): Sitzaufteilung nach Klassen, Bestuhlungsdichte, Sitzart, Mehrzweckbereiche, Türanzahl und -breite, Ausstattung. **Türen wirken über die Haltezeit in die Simulation** | L | erledigt |
| 5.1b | **Werkstattumbau**: Innenraum umbaubar, Türen und Wagenkasten baulich fest; kostet Geld und belegt eine Werkstattanlage | M | erledigt |
| 5.2 | Formationsbildung, **Abbildung auf Zugcharakteristik (M1.9)**, Kompatibilitätsprüfung gegen Strecke, Bahnsteig, Zugsicherung | M | erledigt |
| 5.3 | Umlaufplanung mit Wende-, Abstell- und Servicezeiten | L | erledigt |
| 5.4 | Wartung, gestufte Fristen, Werkstattaufenthalte, Ausfallwahrscheinlichkeit | M | erledigt |
| 5.5 | Personalpools: Qualifikation nach Baureihe und Streckenkenntnis, Dienstkapazität, Ruhezeiten | L | erledigt |
| 5.6 | **Bedarfsmodell je Fahrzeug**: Energie, Sand, Frischwasser, Fäkalien, Innen- und Außenreinigung | L | erledigt |
| 5.7 | **Anlagenbelegung** — Werkstatt, Behandlung, Wäsche, Tankstelle, Entsorgung, Abstellung durch dieselbe Konfliktengine wie der Fahrweg | L | erledigt |
| 5.8 | **Zusatzfahrten als echte Züge** mit Trasse, Personal, Kosten und Sichtbarkeit | L | erledigt |
| 5.9 | **Rangieraufwand** als Zeitbedarf und kurzzeitige Belegung — automatisiert, nie steuerbar (E12) | M | erledigt |
| 5.10 | **Automatischer Versorgungsplaner** — Stufe „Automatik“, Zielgüte 85–90 % der Handplanung | **XL** | erledigt |
| 5.11 | **Versorgungsvorgaben** — Präferenzen für Ort, Zeitfenster und Anlage | M | erledigt |
| 5.12 | **Optimierungslücke sichtbar machen** — Differenz zwischen Automatik und Optimum, mit größtem Hebel | M | erledigt |
| 5.13 | Durchführbarkeitsprüfung: kein Fahrplan wird freigegeben, der Umlauf, Personal, Wartung oder Versorgung verletzt | M | erledigt |
| 5.14 | Beschaffung: **Leasing sofort verfügbar**, Gebrauchtmarkt kurzfristig, Neubestellung über mehrere Perioden frei konfigurierbar | M | erledigt |

**M5.1 trägt:** `crates/zugfolge-fleet` friert Typen als
`VehicleCatalogRelease` (`vehicle-catalog/v2`) ein. Bau- und Beschaffungsepoche
sind unabhängige Weltparameter; dokumentierte Neubau- und ausdrücklich
geschätzte Leasing-/Gebrauchtfenster entscheiden danach zusätzlich über die
Sichtbarkeit. Faktische `class_designation` und fiktiver `trade_name` sind je
Release eindeutig. Jede verwendete Quelle muss existieren und die genaue
Baureihe abdecken; unbenutzte Quellen und neue Marktfenster außerhalb des
Bauzeitraums werden abgewiesen.

`VehicleAsset` hält je Einzelfahrzeug Welt, Typ, Bau-/Beschaffungsjahr,
Beschaffungsweg, Eigentum, Zulassungen, Wartungsfristen und die eingebaute
`TrainProtection`. Serienausrüstung ist zwingend. Eine an einem Teilbestand
belegte `FactoryOption` ist nur beim Neubau und im Optionszeitraum wählbar; ein
`Retrofit` ist nur als eigener, zeitgebundener Umbau am exakten Typ zulässig.
Leasing und Gebrauchtmarkt übernehmen die Ist-Ausrüstung. Der deterministische
`FleetSnapshot` (`fleet-snapshot/v2`) pinnt die Katalog-Prüfsumme; zwei Golden
Master und Reihenfolgetests sichern Katalog und Flotte.

**M5.2 bis M5.14 stehen:** `crates/zugfolge-fleet/src/operations.rs` führt die
gesamte Durchführungskette zusammen: Formationen werden konservativ auf die
Zugcharakteristik abgebildet und auf Bahnsteig, Zulassung und Zugsicherung
geprüft. Umlauf- und Dienstpläne erzwingen halboffene, ortskonsistente
Zeitfolgen, Qualifikation, Dienstkapazität und Ruhe. Gestufte Wartung und das
ganzzahlige Bedarfsmodell sperren überfällige oder unversorgte Fahrzeuge.
Anlagen verwenden `ConflictResource::Facility`, also dieselbe
Ressourcendarstellung wie der Fahrweg; Zusatzfahrten weisen Trasse, Personal,
Kosten und Sichtbarkeit nach, während Rangieren nur als automatisch berechnete
Belegung existiert. Der deterministische Versorgungsplaner wertet Ort-, Zeit-
und Anlagenvorgaben, nennt die Lücke zu einer oberen Schranke und den größten
mehrperiodige Neubestellung frei konfigurierbar.

Die zuvor fehlenden Integrationen sind geschlossen: `CapacityLedger` liegt in
`zugfolge-conflict`, ist weltisoliert und kapazitätsfähig und trägt Anlagen wie
Rangierbelegungen. Zusatzfahrten reservieren eine echte Sperrzeitentreppe,
fordern einen deckenden Personaldienst und eine zweiphasig gebuchte
Integer-Cent-Kostenzusage an und liefern danach ein
`zugfolge_sim::Command::Materialize`; damit erscheinen sie wie jede andere
Fahrt in Simulation und Livemap. Wartungsaufträge reservieren eine kompatible
Werkstatt und setzen den Fristenstand erst nach Ablauf zurück.
`commit_supply_plan` überführt die Optimierung atomar in reale
Anlagenreservierungen. Beschaffungsaufträge belasten das Ledger vor Entstehung
und liefern genau einmal zum kanalabhängigen Termin. Der Dreiwochen-Test
`automatik_beweist_eine_dreiwoechige_periode_ohne_sperre` fährt die kürzeste
zulässige Fahrplanperiode durch und belegt 88 Prozent Güte gegenüber derselben
Handplanung; der typisierte Freigabeprüfer verhindert dabei jede Fahrt mit
Umlauf-, Personal-, Wartungs- oder Versorgungsverstoß.

Der produktive Flottenpfad nimmt keine fertigen Mobilisierungssnapshots mehr
entgegen. Rust friert einen serververtrauenswürdigen Authority-Release ein und
leitet Formation, Personalbereitschaft, Trassenstatus und den gehashten
Mobilisierungssnapshot ausschließlich aus Intent-Kommandos ab. Zustand,
kompakter Replay-Beleg, historischer Checkpoint und Snapshot werden atomar
persistiert. Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
beweist auf `e289511` diesen M5-Pfad über die produktiven HTTP-Routen bis zum
M6-Single-Writer, Ledger, Postfach und zur Livemap.

> **Beweis:** Ein Kurzzeitspieler stellt sein Versorgungsprofil auf Automatik
> und fährt eine Periode ohne einen Ausfall wegen Frist, Wasser oder Entsorgung.
> Ein Detailverliebter plant dieselbe Flotte von Hand und spart nachweisbar rund
> 10 Prozent — und beide sehen im Bericht, woher der Unterschied kommt.

---

## M6 — SPNV: Ausschreibung, Vertrag, Geld

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 6.1 | `EconomyRelease`: Trassen-, Stations-, Anlagenentgelte, Energie, Personal, Verwaltung, **Vergabeprofil-Katalog samt Punktgewichten** (E21) — versioniert und je Welt gepinnt | L | erledigt |
| 6.2 | Kostenarten und Kostenstellen auf dem Ledger-Kern aus M2.4 | M | erledigt |
| 6.3 | **`WorldProfile`** (E18): Weltlaufzeit, abgeleitete Fahrplanperiode, Vertragslaufzeit, Ausschreibungsvorlauf, Staffelung der Vertragsenden | M | erledigt |
| 6.3a | **Vergabekalender** (`wirtschaft.md` 3.3): beim Weltstart hält der Eigenbetrieb alle Lose; gleichmäßige Fenster über die erste Welthälfte, geschichtet zufällige Zuordnung aus Seed-Substream `tender_release`, vollständig veröffentlicht. **Prüfung beim Weltentwurf, dass Erst- und Wiedervergabe sich überlappen** | M | erledigt |
| 6.3b | **GTFS-Angebotsplanung**: aktive Fahrten auf den Betriebsgraphen binden, stabile Fahrtenbilder und verbundene Lose bilden; Mengengerüst und Fahrzeugvorgaben serverseitig aus einem gehashten Snapshot ableiten | L | erledigt |
| 6.4 | Ausschreibungsgenerator: Leistungsbeschreibung, Qualitätsanforderungen, Laufzeit aus dem `WorldProfile` | M | erledigt |
| 6.4a | **Vergabeprofil** (`wirtschaft.md` 3.7, E21): je Ausschreibung ein `TenderProfile` — Wertungsgewichtung, Anforderungs- und Pönaleschwerpunkt, Sonderauflagen — geschichtet zufällig aus Seed-Substream `tender_profile`, aus dem versionierten Katalog in M6.1 gezogen und in der Leistungsbeschreibung veröffentlicht. **Jeder Hebel muss den E19-Test bestehen; kein reaktiver Wiederholungswächter** | M | erledigt |
| 6.5 | **Auskömmlichkeitsgrenze**: vor Angebotsöffnung veröffentlicht, deterministisch aus `EconomyRelease` berechnet | M | erledigt |
| 6.6 | Angebotsabgabe mit wenigen Feldern (E19): Bestellerentgelt, Fahrzeugkonzept, optionale Qualitätszusagen. **Angebotsfrist 3–7 Tage, kleine Lose 24–48 Stunden, Zuschlag sofort bei Fristende.** Eigene Wertungsaufschlüsselung vor Abgabe sichtbar; Angebotsassistent als Automatikstufe | L | erledigt |
| 6.6a | **Fahrzeugvorgaben der Ausschreibung**: Mindestsitzplätze, Klassenanteil, Barrierefreiheit, Fahrrad- und Rollstuhlplätze, Ausstattung — geprüft gegen die Fahrzeugkonfiguration aus M5.1a | M | erledigt |
| 6.7 | **Betriebsübergang** (`wirtschaft.md` 3): Mobilisierungsphase mit Nachweispflicht auf Fahrzeuge, Personal und Trassen; Altbetreiber fährt mit vollen Pflichten bis zum Fahrplanstichtag; nahtlose Fortsetzung, wenn der Bisherige gewinnt; Eigenbetrieb plus Vertragsstrafe, wenn die Mobilisierung scheitert | L | erledigt |
| 6.8 | Verkehrsvertrag im Betrieb: Bestellerentgelt, Bonus, Pönale, Nachweise | M | erledigt |
| 6.9 | **Eigenbetrieb**: Übernahme, Fahrzeugpool, konservatives Standard-Regelwerk, Kennzeichnung auf der Livemap | L | erledigt |
| 6.10 | **Nachbesserungsleiter**: Notvergabe auf zwei Perioden befristet, danach Neuausschreibung mit verbessertem Paket | M | erledigt |
| 6.11 | **Aufgabenträger-Budget** als endliche Periodenressource — trägt die Anti-Kartell-Wirkung | M | erledigt |
| 6.12 | Ergebnisrechnung, Liquidität, Kredite, Restrukturierung | L | erledigt |
| 6.13 | **Insolvenz-Eskalationsleiter** Stufe 1–5 mit Postfach- und Berichtsmeldungen | M | erledigt |
| 6.14 | **Präqualifikation und Bonität** je Spieler und Welt — endet mit der Welt | M | erledigt |

> **Beweis:** Ein Spieler gewinnt eine Ausschreibung, fährt eine Periode, und
> die Ergebnisrechnung erklärt lückenlos, warum Gewinn oder Verlust entstand.
> Ein zweiter fährt sein EVU gegen die Wand — und konnte es ab Stufe 1 kommen
> sehen. Sein Verkehr läuft nahtlos beim Eigenbetrieb weiter.
>
> Und: Ein dritter Spieler verliert seine Ausschreibung an einen Konkurrenten,
> fährt aber bis zum Fahrplanstichtag mit unveränderten Pflichten weiter — kein
> Qualitätsverfall in den letzten Wochen, weil Pönalen bis zum letzten Tag
> greifen. Der Übergang selbst passiert an einem Stichtag, ohne dass ein
> einziger Zug ausfällt.

**M6.1 bis M6.14 tragen auf Domänenebene.** `packages/economy` implementiert nicht nur die
Datentypen, sondern den vollständigen Ablauf: Ein kanonisch gehashter und an
die Welt gepinnter `EconomyRelease` validiert Kostensätze und Profilkatalog.
`WorldProfile` leitet die vier Weltzuschnitte ab; der geschichtete,
reihenfolgeunabhängige Vergabekalender verteilt jedes Los genau einmal und
weist einen Weltentwurf ohne Überlappung von Erst- und Wiedervergabe zurück.
Die zwei getrennten Seed-Ströme `tender_release` und `tender_profile` sind im
Determinismus-Crate verankert. `packages/gtfs` liefert die zuvor fehlende
Herkunft von Linien und Losen: Kalender, Fahrten und Frequenzen werden gegen
eine explizite Infrastrukturzuordnung normalisiert; daraus entstehen stabile,
gehashte Fahrtenbilder und Los-Mengengerüste. Technische Ausschreibungswerte
können nicht mehr vom Client eingeschleust werden.

Der Ausschreibungsablauf berechnet und veröffentlicht die
Auskömmlichkeitsgrenze aus dem Release, erzwingt die kurzen Fristen, prüft die
sechs Fahrzeugvorgaben gegen die konkrete Formation, zeigt Preis-, Qualitäts-
und Dimensionspunkte vor Abgabe und kann aus Zielmarge ein Assistenzangebot
erzeugen. Bei Fristende erfolgt der deterministische Zuschlag; ungültige oder
verspätete Angebote nehmen nicht teil. Mobilisierung und Stichtagsübergang
prüfen Fahrzeuge, Personal und Trassen. Der Altbetreiber bleibt bis dahin im
Vertrag; ein wiedergewählter Betreiber fährt nahtlos weiter, ein gescheiterter
Gewinner zahlt Pönale und wird durch den sichtbaren Eigenbetrieb ersetzt.

Der laufende Vertrag rechnet Zugkilometer, Bonus, vier Pönaledimensionen und
Pflichtnachweise ab. Eigenbetrieb, Fahrzeugpool, nachrangige Trassen,
Livemap-Kennzeichen, Zweiperioden-Notvergabe, Paketnachbesserung und endliches
Aufgabenträgerbudget sind ausführbare Regeln. Kostenarten und Kostenstellen
klassifizieren die Buchungen des Ledger-Kerns; Ergebnisrechnung, Liquidität,
Kredit und Restrukturierung erklären jede Ergebniszeile. Schließlich bewertet
die Eskalationsleiter alle fünf Stufen, sperrt Trassen, Kredite und Käufe zum
jeweils angekündigten Zeitpunkt, löst Vertragsübernahme und Liquidation aus
und erzeugt konkrete Nachrichten für Postfach und Tagesbericht.
Präqualifikation und Bonität sind weltgebunden, merken Endleistung,
Mobilisierungsversagen und Insolvenz und setzen nach Totalverlust die
befristete Beschränkung auf kleine Lose durch. `m6.test.ts`,
`workflow.test.ts` und `platform-adapters.test.ts` führen diese Kette
einschließlich aller fünf Eskalationsstufen, echter Ledgerbuchung und echter
Postfachzustellung als Abschlussbeweis aus. Die unabhängige
Anforderung-zu-Nachweis-Matrix steht in [`m6-audit.md`](m6-audit.md). Der
persistente Frist-/Outbox-Worker ist in
[`economy-runtime.md`](economy-runtime.md) dokumentiert. Run
[`31482747553`](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/31482747553)
führt auf `e289511` den echten Rust-Single-Writer über die produktiven
M5-HTTP-Routen aus: Altbetreiberpflicht, Wiedergewinn, erfolgreicher Wechsel,
gescheiterte Mobilisierung, Eigenbetrieb, Pönale, Ledger, Postfach,
Livemap-Kennzeichnung sowie deterministischer Replay werden gemeinsam
nachgewiesen. Damit ist M6.7 als Betriebsbeweis abgeschlossen.

---

## M7 — Betriebsprogramm und Betriebszentrale

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 7.1 | Regelmodell: Auslöser, Bedingungen, Maßnahmen, Grenzen, Priorisierung | L | erledigt |
| 7.2 | Regel-Engine an der Dispositionsschnittstelle aus M4.4 — deterministisch, offline wirksam | L | erledigt |
| 7.3 | Regeleditor als Bedingungsbaum plus Einsteigervorlagen | L | erledigt |
| 7.4 | Backtesting gegen die eigenen letzten Betriebstage | M | erledigt |
| 7.5 | Betriebszentrale: laufende Fahrten, Anschlüsse, Umläufe, Störungen, manueller Eingriff | L | erledigt |
| 7.6 | Ereignis-Fenster: Push bei Großstörung, manuelle Disposition mit echtem Mehrwert | M | erledigt |
| 7.7 | Tagesbericht als asynchroner Feedback-Loop | M | erledigt |

> **Beweis:** Ein Spieler ist 48 Stunden offline, eine Streckensperrung tritt
> ein, sein Regelwerk hält den Betrieb erklärbar aufrecht — und der Tagesbericht
> sagt ihm, welche Regel wann was getan hat und warum.

**M7 steht vollständig:** `crates/zugfolge-rules` implementiert das
versionierte `operating-program/v1` mit allen acht Auslösern, zwölf Maßnahmen,
verschachtelten Bedingungen, stabiler Priorität und dreizehn konkreten
Betriebsgrenzen direkt am mutierbaren M4.4-`Dispatcher`. Jede Entscheidung
liefert eine vollständige `DecisionExplanation`; M5-Flottenfehler und die
M3-Planerentscheidung fließen über typisierte Adapter ein. Der Rücktest nutzt
dieselbe Rust-Engine gegen historische Ereignisfakten und verändert weder Log
noch Simulationszustand. Manuelle Eingriffe gelten nur für eine
`decision_id`, brauchen eine Begründung und bestehen dieselben Grenzen.

`packages/dispatch`, Migration `0009_early_freak.sql` und `apps/game-api`
persistieren kanonische SHA-256-Versionen je Welt und EVU, aktivieren sie über
die bestehende Single-Writer-Warteschlange, projizieren das append-only
Event-Log, liefern einen authentifizierten EVU-SSE-Strom mit Resume und
begrenztem Rückstau und erzeugen idempotente Tagesberichte. Das dunkle,
zugängliche `apps/operations-center` enthält Bedingungsbaum, Vorlagen,
Maus-/Touch-/Tastatur-Sortierung, Rücktest, Live-Betrieb, begründeten
Einzelfall-Override und Berichte ohne produktiven Demo-Fallback. Architektur,
API und Betrieb stehen in [`betriebsprogramm.md`](betriebsprogramm.md).

Der Abschlussbeweis `tools/m7-e2e` führt `tools/m7-acceptance` über exakt
172.800 Simulationssekunden aus: Der echte Rust-Kern verarbeitet eine
Streckensperrung, hält die unbetroffene Fahrt aufrecht und erzeugt Abschluss-
und Großereignis. Dieselben Ereignisse laufen danach durch migrierte Datenbank,
Event-Log, EVU-Betriebsprojektion und Tagesbericht. Rust und TypeScript sehen
nachweislich denselben kanonischen Programmhash; zwei Replays liefern denselben
Zustands- und Entscheidungshash.

---

## M8 — Störungen, Baustellen, Ersatzverkehr

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 8.1 | `DisruptionPolicy`-Rahmen: REALISTIC / SIMULATED / MANUAL | S | erledigt |
| 8.2 | Deterministischer Störungs**generator**: getrennte Kanäle für geplante Arbeiten, La und spontane Infrastruktur-, Fahrzeug-, Tür- und Fahrgastwechselstörungen; Häufigkeit nach Netztagen, realen Fahrten und Halten, dazu Schwere, Dauer, Vorlauf, Region und Belastung. Erzeugt die Ursachen, deren Fortpflanzung M4.3 bereits beherrscht | L | erledigt |
| 8.3 | Manueller Spielleitermodus mit Pflichtfeldern, Vier-Augen-Odoo-Handler und autoritativem Game-Audit | M | erledigt |
| 8.4 | Auswirkungsmodell: Sperrung, eingleisiger Betrieb, Langsamfahrstelle, Bahnsteigwechsel | L | erledigt |
| 8.5 | **Baustellenankündigung mit Vorlauf** — Planungsfenster statt Überraschung | M | erledigt |
| 8.6 | **Ersatzkonzept als eigener `PlanningRun`** gegen die Restkapazität | L | erledigt |
| 8.7 | **Maßnahmenkasten** mit Prüfung gegen Streckenkenntnis, Zugsicherung, Wendemöglichkeit, Zuglänge, Fahrzeugeignung | L | erledigt |
| 8.8 | **Wettlauf um Ersatzkapazität** — mehrere EVU konkurrieren um dieselben Umleitungstrassen | M | erledigt |
| 8.9 | **Vertragliche Behandlung**: Minderung statt Pönale bei fristgerechtem, plausiblem Konzept | M | erledigt |
| 8.10 | **Automatisches Standardkonzept** — sicher und teuer | M | erledigt |
| 8.11 | Trassenrückgabe; **SEV als Verpflichtung, Kostenposten und Bewertungsfaktor** — kein Fuhrpark | M | erledigt |
| 8.12 | Realistischer Modus als Adapter — nur bei geklärter Vertragslage | M | erledigt |

> **Beweis:** Eine angekündigte mehrwöchige Baustelle zwingt alle Spieler der
> Pilotregion zur Umplanung. Zwei EVU beantragen dieselbe Umleitungstrasse, nur
> eines bekommt sie — das andere weicht auf Ersatzverkehr aus und sieht genau,
> was ihn das gekostet hat. Der Netzfahrplan bleibt konfliktfrei.

**Abnahme M8.1–M8.11:** `crates/zugfolge-disruption/tests/m8_acceptance.rs`
deckt Generator und Tagesmodell, Haupt-/Feincodes, Policy/Stichtag, manuellen
Audit, alle Wirkungen, spontane Ereignisraten und Zuglaufbindung,
regelwerkskalibrierte Abfahrtsrechte, virtuelle Fahrdienstleitung,
konkurrierende Ersatzplanung, Vertrag, Standardkonzept, SEV, Ledger und
bitgleichen Replay ab. `zugfolge-sim-runtime` beweist die vorab sichtbare
geplante Kartenlage, automatische Wirkung zum Start im echten regionalen
Single-Writer sowie Restore/Idempotenz. Der Game-API-Integrationstest beweist
den atomaren Weg in Event-Log und Postfach und den anschließenden Livemap- und
EVU-Push; Betriebszentrale und Tagesbericht projizieren denselben Event.

**Abnahme M8.12:** Die am 11.08.2026 ausdrücklich freigegebene öffentliche
Quelle wird außerhalb des Simulationskerns alle 30 Minuten mit einem
rollierenden 360-Stunden-Filter über einen
Revisionshandshake und drei JSON-Feeds abgeholt. Jeder unveränderliche Rohstand
und seine markenfreie Normalisierung werden je Welt mit SHA-256 archiviert.
Schemafehler, fehlende Rechte oder ein Providerausfall sind fail-closed; der
letzte sichere Stand bleibt sichtbar und es erfolgt kein Moduswechsel. Die
Tests in `packages/disruption-provider` beweisen Wirkungsgate, 2023-Codeabbildung,
Zeitmaterialisierung und kanonischen Hash. Der Scheduler-Test in
`apps/game-api` beweist Archivierung, Weltbindung, Ausfallzustand und Health.
Der Consumer-Test beweist den 360-Stunden-Abgleich mit der regionalen
Single-Writer-Simulation einschließlich Kartenregistrierung, Wirkung,
Idempotenz sowie explizitem Entfernen geänderter oder entfallener Einträge.

---

## M9 — Onboarding, Betriebsreife, geschlossene Alpha

Der Alpha-Schnitt umfasst gemäß [E24/ADR-0024](adr/0024-erweiterter-alpha-schnitt.md)
zusätzlich ausschließlich M12.1, M12.2 und M14.1. M12.3/M12.4 sowie
M14.2–M14.4 bleiben Ausbau. M12 und M14 werden durch die Vorziehung nicht als
Gesamtmilestones abgeschlossen. Der vorgezogene regionale M14.1-Nachweis
ist in den [Mitteldeutschland-Varianten](mitteldeutschland-alpha.md) dokumentiert.
Die heutige Spieleroberfläche und die Alpha-Orientierung sind deutschlandweit;
welche Strecken tatsächlich bespielbar sind, entscheidet das qualifizierte
Release des Zielservers. Eine größere Maske benötigt ihre eigenen Qualitäts-,
Last- und Freigabenachweise und erbt keine Freigabe aus dem regionalen Pilot.

<!-- zugfolge-alpha-dag:start
{"M12.1":["M2","M5","M6","M8"],"M12.2":["M2","M5","M6","M12.1"],"M14.1":["M1","M2","M4","M5","M6","M8","M9.2"],"M9.9":["M14.1"]}
zugfolge-alpha-dag:end -->

Die historische Auswahl für M14.1 ist erfolgt: **Variante B — Mitteldeutsches
Metropol-Korridornetz** aus `docs/mitteldeutschland-alpha.md`.
Der damalige Nachweis verwendete gebietsüberschreitende GTFS-Fahrten nach
[E25/ADR-0025](adr/0025-gebietsueberschreitende-fahrtketten.md): qualifizierter
Innenabschnitt, Release-Grenzfenster und deterministischer Außenlauf.
Neue Spielangebote werden dagegen nach [E33/ADR-0034](adr/0034-spielgenerierte-fahrplaene-im-spielgebiet.md)
im freigegebenen Spielnetz generiert; der historische Nachweis führt keine
Außenabschnitte in neue Angebote ein.

Nach [E28/ADR-0028](adr/0028-spielhinweise-im-spiel.md) erfolgt die Einführung durch neue Tooltipps
direkt im laufenden Spiel. Jede Welt besitzt einen eigenen Server und eine
feste Subdomain. Die öffentliche `StartingCapitalPolicy` bleibt Blueprint-
und Hashbestandteil und wird bei der ersten EVU-Gründung idempotent angewandt.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 9.1 | Neue Tooltipps an den echten Bedienelementen; per Tastatur und Touch erreichbar, lokal abschaltbar | M | erledigt |
| 9.2 | **Weltstart mit Eigenbetrieb**: das gesamte SPNV-Netz der Region fährt ab Sekunde eins | M | erledigt |
| 9.2a | **Administrativer Weltstartbestand**: optionaler, versionierter und auditierter Pool konkreter Gebrauchtfahrzeuge einschließlich Zustandsprofil und Lebenslauf; Zuweisung an Eigenbetrieb und servereigene Vermieter ohne Fahrzeugduplikate | M | offen |
| 9.3 | Onboarding in der öffentlichen Welt: tatsächliche `StartingCapitalPolicy`, Kapazitäts-Heatmap, Glossar-Layer und Betriebsassistent; keine automatische Startausstattung | M | in Arbeit |
| 9.4 | Admin- und Auditwerkzeuge, Vier-Augen-Prinzip bei Hochrisikoaktionen | M | in Arbeit |
| 9.5 | **Betriebsreife**: Observability, Backup und Restore, Incident-Runbooks. Gehört vor die erste Welt mit echten Spielern, nicht in die Monetarisierungsphase. Der Health-Check-Vertrag (`packages/health`, seit M2) liegt bereits — M9.5 baut Alarmierung, Dashboards und Backup darauf, zieht ihn nicht mehr nachträglich ein | L | in Arbeit |
| 9.6 | Rate Limits, Anti-Bot-Prüfungen, Anomalieerkennung für Trassenfenster und Märkte | M | in Arbeit |
| 9.7 | Telemetrie, Balancing-Dashboards, Feedbackkanal | M | in Arbeit |
| 9.8 | **Weltende** (E18): letzte Periode ohne Ausschreibung, reguläres Vertragsende ohne Insolvenzfolge, Schlusswertung mit mehreren Ranglisten, Archiv und Replay-Export | M | in Arbeit |
| 9.9 | Geschlossene Alpha mit 20–50 externen Spielern in der deutschlandweiten Spieleroberfläche und dem ausdrücklich freigegebenen Spielnetz, einschließlich M12.1/M12.2 | M | offen |
| 9.10 | **Jährliche Infrastrukturaktualisierung** (E22): `InfraRelease`-Neubau aus den jährlich gepinnten, rechtlich freigegebenen OSM-, DB-InfraGO-Open-Data-, GTFS-, Copernicus-DEM- und OpenStation-Ständen; Übernahmeverfahren für eine laufende Welt zum nächsten Periodenwechsel, ohne Invariante 1 zu verletzen | L | in Arbeit |

M9.1 ist nach ausdrücklicher Produktabnahme durch den Projektverantwortlichen
am 2026-09-05 abgeschlossen. Die 20 vollständig neu erstellten Spielhinweise
benötigen keine Backendzustände. Browser- und Integrationstests belegen
Tastatur- und Touchbedienung, Abschalten, Wiederaufnahme sowie ausbleibende
Netzwerk- und Spielaktionen. Die Abnahme umfasst auch die Entfernung des
alten Tutorials und seiner Welten sowie einen festen Weltserver je Subdomain
bei erhaltener Odoo-Verwaltung. Umfang und erfolgreiche CI-Läufe sind unter
[Spielhinweise — Abnahme](spielhinweise.md#abnahme) dokumentiert; die Umsetzung
liegt in [PR #530](https://github.com/larynxberlin-rgb/Zugfolge/pull/530),
der Abschluss in [#159](https://github.com/larynxberlin-rgb/Zugfolge/issues/159).
Die externe Alpha-Abnahme wird unter M9.9 geführt.

M9.3 vergibt keine öffentliche Startausstattung. Sein Geldpfad verwendet die
signierte und bei der Zugangsbestätigung unveränderlich gebundene
`StartingCapitalPolicy`: null und endliche Integer-Cent werden bei der ersten
EVU-Gründung atomar genau einmal ausgeglichen gebucht; der explizite Modus
`unlimited` bleibt nichtnumerisch und erzeugt keine Startbuchung. Beide Modi
sind rangneutral. Der Glossar-Layer ist bereits in den drei Frontends
erreichbar; seine vollständige kontextuelle Verständlichkeit bleibt Teil
der M9.3-Spielerabnahme. Heatmap und Betriebsassistent bleiben Folgearbeit.
Kapitalintegration und Tooltipps schließen diese Abnahmen nicht automatisch ab.

Phase 3 schließt die noch fehlende ausführbare Betriebsschicht für M9.4,
M9.5 und M9.7: Einladungskonten werden nur noch über einen Odoo-
Vier-Augen-Antrag entzogen, wobei das Game Keycloak und den weltgebundenen
Zugang reautorisiert; Spielerfeedback gelangt atomar und pseudonymisiert über
die Game-Outbox nach Odoo; Prometheus/Grafana erhalten live materialisierte
Welt-, Queue-, Bridge- und Marktmetriken. Der versionierte
`alpha:phase3`-Drill umfasst außerdem den isolierten Odoo-Restore mit
Fachzustands-/Filestorehash, Modulupgrade, Odoo-Tests, Anhangsstichprobe und
echte Alert-Ausfälle. Die drei Teilabschnitte bleiben **offen**, bis dieser
Drill gegen den laufenden Zielstack ein Protokoll mit Status `passed` erzeugt;
Repositorytests allein sind kein Betriebsnachweis.

Das geschlossene Issue #48 gehört als produktiver Betriebsreife-Nachweis zu M9. Der vom
Kalibrierungsbestand disjunkte technische Validierungssatz, die benannte
Release-Verantwortung und die echte Signatur des Pilot-`InfraRelease` sind mit
M14.1 nachgewiesen. Die übrige Betriebsreife aus M9.5 bleibt davon unberührt.

> **Beweis:** 20–50 externe Spieler finden sich von der Deutschlandübersicht
> bis zur eigenen Zugfahrt zurecht und betreiben das freigegebene Spielnetz über mehrere
> vollständige Fahrplanperioden ohne manuellen Eingriff, und ein realer
> Fahrplanwechsel spiegelt sich in der laufenden Welt zum nächsten
> Periodenwechsel wider, ohne dass ein Konflikt gegen Invariante 1 entsteht.

---

## M10 — Personenverkehrsnachfrage und SPFV

M10 stellt ein gemeinsames Personenverkehrsmodell für SPNV und SPFV bereit.
SPFV-Linienplanung bleibt ein eigener Ausbau, verwendet aber dieselben Zonen,
Reiseketten, Zugwahl- und Kapazitätsregeln. M10 ist die einzige Quelle für die
Fahrgäste, die M15 später im Schaffnermodus 1:1 projiziert.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 10.1 | Gemeinsames Zonen- und Reisenachfragemodell für SPNV und SPFV aus Bevölkerung, Arbeitsplätzen, POIs, Reiseanlässen, Saison und Tageszeit; **ÖPNV-Anbindung je Station als statisches Attribut** | **XL** | in Arbeit |
| 10.2 | Verkehrsmittel-, Verbindungs- und Zugwahl für beide Personenverkehrsarten: Preis, Reisezeit, Umstiege, Takt, Zuverlässigkeit, Komfort und verfügbare Kapazität | **XL** | in Arbeit |
| 10.3 | Tarif-, Vertriebs-, Kapazitäts- und Komfortmodell einschließlich SPNV-Fahrberechtigungen, Überbelegung, zurückbleibender Fahrgäste, Reservierungen und Komfortklassen | L | in Arbeit |
| 10.3a | **Autoritative SPNV-Fahrgastmanifeste** je Zuglaufabschnitt mit stabilen pseudonymen Fahrgastschlüsseln, Reise-/Umstiegskette, Ein- und Ausstieg, exakter Belegung sowie deterministischem Fahrberechtigungsstatus mit Herkunft `observed` oder `balanced` | L | in Arbeit |
| 10.4 | SPFV-spezifische Linien-, Halte- und Taktplanung als Spielerwerkzeug | M | in Arbeit |
| 10.5 | Gemeinsame Kalibrierung von SPNV und SPFV gegen freigegebene öffentliche Größenordnungen | M | in Arbeit |

> **Beweis:** Ein SPNV-Zug erhält über mehrere Halte reproduzierbare Ein- und
> Aussteiger, Auslastung und Fahrgastmanifeste; Ausfall und Anschlussverlust
> verteilen die Reiseketten nachvollziehbar neu. Eine neue Fernverkehrslinie
> verschiebt dieselben Ströme, und ein Konkurrent kann darauf wirtschaftlich
> sinnvoll reagieren.

Der [Implementierungs- und Abnahmebericht](m10-abnahme.md) trennt den
getesteten Rust-Kern und die Spielerintegration von der noch offenen
Produktions- und gemeinsamen SPNV-/SPFV-Kalibrierungsabnahme.

---

## M11 — SGV

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 11.1 | Warenstrom- und Industriemodell, Terminals, Anschlussgleise, Häfen | L | offen |
| 11.2 | Wagen als eigene Assets, Zugbildung, Behandlungszeiten — Rangieren bleibt automatisiert (E12) | L | offen |
| 11.3 | Verladerverträge — Spot und langfristig, Lieferqualität, Pönale | M | offen |
| 11.4 | Wagenumläufe, Leerfahrten, Ganzzug gegenüber Einzelwagenverkehr | L | offen |
| 11.5 | Gefahrgut, Lademaß, Streckenklassen, Bremshundertstel | M | offen |

> **Beweis:** Ein Einzelwagenverkehr über zwei Knoten ist planbar, wirtschaftlich
> bewertbar und auf realistische Weise störungsanfällig.

---

## M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt

M12.1 und M12.2 werden gemäß E24 einzeln in den Alpha-Schnitt vorgezogen. Ihre
Teilabhängigkeiten sind M2/M5/M6/M8 beziehungsweise M2/M5/M6/M12.1; dadurch
entfällt für diese beiden Teile die Abhängigkeit von M10/M11. M12.3 und M12.4
behalten die bisherigen Ausbauabhängigkeiten. Der Gesamtstatus von M12 bleibt
offen.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 12.1 | EVU-zu-EVU-Verträge: Traktion, Vermietung, Anschluss, Ersatzverkehr | L | in Arbeit |
| 12.2 | **Persistenter Fahrzeug-Sekundärmarkt** mit Fristenstand, mehrdimensionalem Zustand, Lebenslauf, Wertverfall und Rücklauf nach Leasingende, Betriebsaufgabe oder Insolvenz; Neukäufe gehen bei Verwertung als dieselben Assets in diesen Markt | L | in Arbeit |
| 12.2a | **Servereigene Vermieter**: mehrere fiktive, deterministisch profilierte Anbieter mit Baureihen- und Verkehrstyppräferenzen; transparente, je Anbieter verschiedene Kalkulation, jedoch stets über dem Marktpreisband vergleichbarer EVU-Angebote | M | offen |
| 12.3 | Bietergemeinschaften, Kooperationstarife | M | offen |
| 12.4 | Öffentliche Qualitätsrankings mit Wirkung auf Ausschreibungswertung | M | offen |

Der Stufe-4-Implementierungsnachweis verbindet die dunkle, zustandsredundante
Spieleroberfläche in `apps/game-web` mit den produktiven Game-API-Routen. Zwei
getrennt authentifizierte EVU durchlaufen Angebot und Annahme mit Cent-Ledger,
Postfach und Audit. Ein paralleler Lauf handelt 20 konkrete Fahrzeugassets über
Angebot, Reservierung und Rust-Flotten-Single-Writer-Übergabe; Identität,
Historienkette und Doppelbindungs-Schutz bleiben erhalten. Offen bleibt der
externe Zwei-Browser-Lauf gegen die Alpha-Zielumgebung; deshalb sind M12.1 und
M12.2 noch nicht als erledigt markiert.

---

## M13 — Odoo und Monetarisierung

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 13.1 | Odoo Community selbst gehostet, strikt getrennt, OCA-Module versionsgepinnt | M | in Arbeit |
| 13.2 | Game-Outbox → Bridge → Odoo, signierter Webhook-Receiver, nächtlicher Reconciler | L | in Arbeit |
| 13.3 | Entitlements, Zugfolge Plus, Kosmetik, Weltplätze, Odoo-Weltauswahl, kommerziell freigegebene Weltteilnahmen und private Welten | M | in Arbeit |
| 13.4 | **Planungsarbeitsplatz**: mehrere Bildfahrplanfenster, Layouts, Vergleichsansichten | M | offen |
| 13.5 | **Sammelbearbeitung und Vorlagenverwaltung** für die Handplanung | M | offen |
| 13.6 | **Exporte**: Bildfahrplan, Umlauf- und Dienstpläne, Geschäftsberichte, Replay-Filme | M | offen |
| 13.7 | **Archiv- und Auswertungstiefe** jenseits des entscheidungsrelevanten Zeitraums | S | offen |
| 13.8 | **Erweiterte Automatisierung ausschließlich in privaten Welten** (E13) | M | offen |
| 13.9 | SLO 99,9 % nachweisen — baut auf der Betriebsreife aus M9.5 auf | M | offen |

> **Härtetest:** Odoo abschalten. Login, Simulation, Livemap und bestehende
> Entitlements müssen unverändert weiterlaufen.

Der Repository-Stand enthält `/welten`, `/my/worlds`, vier Odoo-Website-
Builder-Snippets, Keycloak-OIDC-Portalbindung, Payment→Queue→Game-Teilnahme,
idempotente Ergebnisprojektion und den öffentlichen Snapshotcache. M13.1–M13.3
bleiben **in Arbeit**, bis Odoo 19 mit OCA `queue_job`, realem Payment-/Refund-
Ereignis, Browsereditor, getrenntem Game-Dienst und Reconciliation extern
abgenommen ist. Für „stark aktiv“ ist außerdem eine der in ADR-0030
dokumentierten Policies fachlich freizugeben; bis dahin bleibt die Zahl leer.

---

## M14 — Netzausweitung

M14.1 wird gemäß E24 einzeln in den Alpha-Schnitt vorgezogen und gegen
M1/M2/M4/M5/M6/M8 sowie den produktiven Eigenbetriebs-Weltstart M9.2
abgenommen. M9.9 hängt umgekehrt von der spielbaren Region ab und ist deshalb
keine Voraussetzung von M14.1. M14.2–M14.4 bleiben Ausbau; der Gesamtstatus
von M14 bleibt offen.

Der Titel bezeichnet den Ausbau von Datenabdeckung und Betriebsfähigkeit.
Die Oberfläche zeigt Deutschland bereits als zusammenhängende Spielwelt.
M14.1 ist der abgeschlossene regionale Vorläufer; M14.2 und M14.3 müssen
die tatsächlich freigegebene Deutschlandabdeckung und deren Last belegen.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 14.1 | Pilotregion → Mitteldeutschland; Variante-B-Grenze, qualifizierte Fahrtketten/Grenzportale und spielbarer Eigenbetrieb | L | erledigt |
| 14.2 | **Deutschlandweiter InfraCorpus und Karte als Spielzentrum**: vollständiger Deutschland-Import unabhängig von der spielbaren Maske, dimensionsweiser Qualitätsreport, selbst gehostete Welt-Basiskarte und Deutschland-PMTiles, anklickbare Fachobjekte, Bahnhofstafel/FIS, jährlicher KI-Neubau und Odoo-Paketimport | **XL** | in Arbeit |
| 14.3 | Lastprofile, horizontale Regionenverteilung, Kapazitätsplanung | L | offen |
| 14.4 | Weltenstart-Kadenz und Migrationsregeln | M | offen |

**Stand M14.2, Jahreskandidat 2026.1:** Der reale Voll-Lauf erzeugt 1.600.662
Objekte (A 0/B 1.489.960/C 110.702); die getrennte interne Planprüfung ist
vollständig. Das reale 14,4-GB-Transportpaket ist gepackt, verifiziert,
installiert und beim zweiten Installationslauf bytegleich wiederverwendet; der
Odoo-/Game-Vertrag ist stagefähig. Echte Signatur, namentliche Freigabe,
erneute Game-Qualifizierung und produktiver Odoo-/Periodenlauf fehlen. Deshalb
bleibt `activationEligible=false` und der Teilabschnitt ausdrücklich in
Arbeit.

---

## M15 — Schaffnermodus

Der Schaffnermodus ist gemäß E29 eine optionale, serverautoritative Vertiefung
des regulären SPNV-Betriebs. Er baut auf M4/M5/M6/M8 und dem gemeinsamen
Personenverkehrsmodell M10 auf. Die Stationsszenen aus M15.5 benötigen für ihre
vollständige Releaseabdeckung zusätzlich M14.2. M15 gehört nicht zum
Alpha-Schnitt. Vollständiger Fachvertrag:
[`schaffnermodus.md`](schaffnermodus.md).

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 15.1 | **E29, ADR und versionierter Fachvertrag** einschließlich M10-/M8-Autoritätsgrenzen, Kontrolle, Dialog, Wirtschaft, Datenschutz und Abnahme | M | erledigt |
| 15.2 | **M10-Fahrgastmanifeste und deterministische 1:1-Projektion**: jeder tatsächlich reisende Fahrgast wird logisch materialisiert, stabil platziert und kontrollierbar; Rendering darf nur optisch degradieren | L | in Arbeit |
| 15.3 | **Eigene Pixelart-Designsprache und freigegebener Asset-Korpus**: finale erzeugte Figuren-, Innenraum-, Bahnhof- und Umgebungsassets mit `ArtAtlasManifestV1`, Herkunft, Hash und Rechtegates | **XL** | offen |
| 15.4 | **Konfigurationsgetreue begehbare Fahrzeuginnenräume**: `InteriorLayoutV1` aus Formation und Fahrzeugkonfiguration, Begehbarkeits-, Kollisions- und Kapazitätsnachweis | **XL** | offen |
| 15.5 | **Fließende Umgebung und modulare Bahnhofsszenen**: Umland/Vorstadt/Stadt, Tageszeit, tatsächliche Geschwindigkeit, Signal-/Bahnhofshalte, kleine/mittlere/große Stationen und dynamische Namen | **XL** | offen |
| 15.6 | **Versionierter Sprechblasen-Dialogkorpus**: mindestens 150 geprüfte Dialogbäume und 600 Fahrgastäußerungen, verdeckter Sachverhalt, mindestens zwölf Situationsfamilien, kein Laufzeit-Sprachmodell | L | offen |
| 15.7 | **Autoritative Schaffnersitzung**: Eigentümerberechtigung, Exklusivität, Kommandorevision, Idempotenz, Reconnect, Restore und bitgleiches Replay | L | offen |
| 15.8 | **Browserintegration**: Bewegung, Interaktion, Sprechblasen, Pixi/WebGL-Projektion, Desktop, Touch, Tastatur, Screenreader und reduzierte Bewegung | **XL** | offen |
| 15.9 | **Kontrollhalt über Konfliktengine und virtuelle Fahrdienstleiter**: `FareControlHoldV1`, tatsächliche Ressourcenweiterbelegung, Höchstwartezeit, erneute Abfahrtsprüfung und Netzfolgen für alle Zugarten | **XL** | offen |
| 15.10 | **Polizeireaktion, EBE-Fallabschluss und Verspätungsursache**: deterministische Verfügbarkeit, Bündelung höchstens eines Polizeihalts je Zuglauf, Feststellung, vorläufige/reguläre EBE und `authority.police.fare-control` | L | offen |
| 15.11 | **Forderungen, Ausfälle und gedeckelte Kontrollprämie**: offene EBE, spätere Zahlung/Reduzierung/Abschreibung, Integer-Cent-Ledger, höchstens vierfache Prämie und 0,5-Prozent-Tagesdeckel | M | offen |
| 15.12 | **Performance-, Determinismus- und Gesamtannahme**: voller SPNV-Verband, Mehrzug-Golden-Master, Property-Tests für Invariante 1, Browser-/Barrierefreiheitsabnahme und zusammenhängender Spielbeweis | L | offen |

**Teilabhängigkeiten:** M15.1 ist der Einstieg. M15.2 folgt M10.3a und M15.1.
M15.3 und M15.6 können danach parallel beginnen. M15.4 folgt M15.3 und M5;
M15.5 folgt M15.3 und M14.2; M15.7 folgt M15.1/M15.2; M15.8 folgt
M15.3–M15.7; M15.9 folgt M15.7/M15.8 und M8; M15.10 folgt M15.6/M15.9;
M15.11 folgt M15.10 und M6; M15.12 schließt alle Teile zusammen.

**M15.1/M15.2-Stand:** Der versionierte Fachvertrag und seine
Aktions-/Autoritätsmatrix sind vollständig dokumentiert. E28 ist mit #530
auf `main` veröffentlicht. M15.2 liefert den Rust-Projektionskern und eine
autorisierte interne Plattformgrenze. Produktive M10-Haltquittungen,
freigegebene Innenraumlayouts und die spielbare Browserabnahme bleiben offen;
M15.2 und M15 insgesamt werden dadurch nicht geschlossen. Reproduzierbare
Prüfungen, Issue-/PR-Abgleich und Grenzen: [Teilabnahme](m15-abnahme.md).

> **Beweis:** Ein eigener ausgelasteter SPNV-Zug wird mit den tatsächlichen
> M10-Fahrgästen betreten. Der Spieler läuft durch den konfigurationsgetreuen
> Innenraum, erlebt fließende Umgebung, Signal- und Bahnhofshalte und führt
> verschiedene Sprechblasenkontrollen durch. Eine Identitätsverweigerung löst
> am nächsten Bahnhof einen echten Polizeihalt aus: Das Bahnsteiggleis bleibt
> belegt, virtuelle Fahrdienstleiter ordnen Folge-, Kreuzungs-, Güter-, Leer-
> und Rangierfahrten konfliktfrei neu, M10 revidiert Reiseketten, und Ledger
> sowie Pönalen zeigen die vollständige Kausalitätskette. Reload und Replay
> ergeben denselben Zustand auf Desktop und Touchgerät.

---

## Änderungshistorie der Milestone-Struktur

Nach einer Vollprüfung auf Reihenfolge, Zuteilung und Vollständigkeit wurden
folgende Fehler behoben. Die Nummerierung ab dem alten M2 verschiebt sich
dadurch um eins.

| Befund | Korrektur |
|--------|-----------|
| Der Trassen-Planner brauchte Formationen, die es erst zwei Milestones später gab | **Zugcharakteristik** als M1.9 eingezogen. Fahrzeitrechnung und Planung sind damit vom Fahrzeugkatalog entkoppelt — so arbeiten reale Fahrplanrechner auch. M5.2 bildet echte Fahrzeuge darauf ab. |
| Konten und Weltisolation lagen ganz am Ende, obwohl der Beweis von M3 zwei Spieler verlangt und Invariante 4 `world_id` ab dem ersten Commit fordert | Neuer **M2 „Weltgerüst“** vor der Trassenvergabe: Keycloak, Weltisolation mit automatisiertem Nachweis, EVU-Entität, Ledger-Kern, Postfach, Datenschutz. |
| Der Ledger lag hinter den ersten Kosten (Storno, Rahmenverträge) | Ledger-Kern nach M2.4 vorgezogen; M6.2 setzt nur noch Kostenarten darauf. |
| Die Regel-Engine hätte den fertigen Simulationskern nachträglich aufschneiden müssen | **Dispositionsschnittstelle M4.4** als definierter Entscheidungspunkt, zunächst mit Standardverhalten. M7 wird dadurch Implementierung statt Operation am offenen Herzen. |
| Observability, Backup und Runbooks lagen in der Monetarisierungsphase, obwohl die Alpha vorher echte Spieler hat | **Betriebsreife nach M9.5** gezogen, vor die erste Welt mit echten Spielern. |
| Das Postfach war in den Oberflächen genannt, aber in keinem Milestone | Grundgerüst als M2.5, danach von Ausschreibungen, Fristen und Störungsmeldungen genutzt. |
| Verspätungs*entstehung* und -*fortpflanzung* standen doppelt in zwei Milestones | Getrennt: M4.3 beherrscht die Fortpflanzung, M8.2 erzeugt die Ursachen. |
| Datenschutz, Rate Limits und Anti-Bot fehlten trotz Nennung in den Sicherheitsanforderungen | M2.6 und M9.6 ergänzt. |
| Zeitumstellung im 1:1-Echtzeitbetrieb war nirgends behandelt | M4.10 ergänzt — Pflichtfall, kein Detail. |
| Die Fahrstraßenableitung im Bahnhofskopf war mit L zu niedrig bewertet | Auf **XL** angehoben. Sie ist der schwerste Einzelposten in M1. |
