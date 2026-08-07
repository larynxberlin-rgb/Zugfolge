# Milestones

Nach **Abhängigkeiten** geschnitten, nicht nach Zeit. Aufwand relativ als
S / M / L / XL. Keine Kalenderdaten.

Jeder Milestone endet mit einem **Beweis** — einem vorzeigbaren Zustand, meist
einem Spielerlebnis, nicht einer technischen Eigenschaft.

- **Alpha-Schnitt: M0 – M9.** Das ist die erste Version, die externe Spieler
  sinnvoll spielen können. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7.

Jeder Teilabschnitt trägt einen **Status**: `offen` (noch nicht begonnen),
`in Arbeit` oder `erledigt`. Ein Punkt gilt erst als `erledigt`, wenn sein
Ergebnis vorzeigbar ist. Bislang erledigt:

- **M0.1** — die ADRs zu E1–E20, siehe [`adr/`](adr/README.md);
- **M0.2** — Monorepo, CI, Determinismus-Testharnisch, Wächter und Glossar,
  siehe [`monorepo.md`](monorepo.md) und [`glossar.md`](glossar.md);
- **M0.3** — der Wegwerf-Spike zur Sperrzeitentreppe, siehe
  [`spikes/blocking-time-staircase/`](../spikes/blocking-time-staircase/README.md);
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
  [`crates/zugfolge-infra/src/import`](../crates/zugfolge-infra/src/import).

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
> **Geführt in M0.3** (`spikes/blocking-time-staircase/`): Zwei Züge geraten auf
> dem eingleisigen Ast in Gegenfahrt, zwei weitere in den Zugfolgefall; beide
> Konflikte werden mit Ressource, Zeitfenster und Gegenzug gemeldet und im
> Bildfahrplan sichtbar. Die konfliktfreien Gegenproben sind ebenfalls
> abgelegt, damit die Prüfung nicht bloß immer Rot meldet.

Drei Befunde des Spikes wirken auf spätere Milestones, ausführlich in seiner
README:

| Befund | Wirkung |
|--------|---------|
| Ein Ressourcenmodell trägt beide Konfliktarten — Zugfolge und Gegenfahrt sind eine Eigenschaft des Netzes, keine zweite Regel | M3.1, M3.3 |
| Der Bahnhofskopf fehlt: Ohne Fahrstraßenausschluss prüft der Konfliktprüfer nur die halbe Wahrheit | M1.7 bleibt der teuerste Posten in M1 |
| Die Prüfung kennt nur die triviale Auflösung („später fahren"); die betrieblich richtige — kreuzen in einer Betriebsstelle — ist ein eigenes Verfahren | M3.4 ist keine Erweiterung des Prüfers |

---

## M1 — Betriebsgraph und Infrastruktur-Release

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 1.1 | Domänenmodell: Betriebsstellen, Kanten, Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder, Neigung | M | erledigt |
| 1.2 | Import-Pipeline OSM-PBF → Rohgraph mit Topologie, Geometrie, Tags | L | erledigt |
| 1.3 | **Netzfilter**: nur `railway=rail` in 1435 mm; Tram, Stadtbahn, U-Bahn, Schmalspur, Standseil- und Einschienenbahnen verwerfen; Stromschienennetze über Netzausschlussliste. **Betriebs-, Abstell- und Anschlussgleise bleiben erhalten** | M | offen |
| 1.4 | **Abdeckungsmessung**: Coverage-Report je Attribut und Streckenabschnitt. Entscheidet *vor* dem Bau, welche Strecke Klasse A erreichen kann | M | offen |
| 1.5 | **Neigungsprofil aus Höhenmodell** — aus einem DEM entlang der Gleisgeometrie abgeleitet und geglättet | M | offen |
| 1.6 | **Blockableitung** aus Signalpositionen, Zugbeeinflussung und Topologie; virtuelle Blöcke bei Lücken; Qualitätsklassifizierung A/B/C | L | offen |
| 1.7 | **Fahrstraßen- und Durchrutschwegableitung** im Bahnhofskopf — aus Weichenlage und Signalstandort erzeugt | **XL** | offen |
| 1.8 | Stationsdaten-Anreicherung — ausschließlich freigegebene Quellen | M | offen |
| 1.9 | **Zugcharakteristik** als eigenes Konzept: Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung. Entkoppelt Fahrzeitrechnung und Trassenplanung vom Fahrzeugkatalog (M5) | M | offen |
| 1.10 | Fahrdynamik und Fahrzeitrechner → vorberechnete **ganzzahlige** Fahrzeittabellen je Zugcharakteristik | L | offen |
| 1.11 | **Anlagenkataster**: Werkstätten, Behandlungs- und Waschanlagen, Tankstellen, Entsorgungsanlagen, Abstellgleise — mit Kapazität, Öffnungszeit, Nutzlänge, Baureihenkompetenz | M | offen |
| 1.12 | `InfraRelease` als unveränderliches, versioniertes Artefakt mit Herkunft, Lizenz, Checksumme und Confidence je Attribut | M | offen |
| 1.13 | Referenzkorpus Leipzig–Halle–Erfurt und Abweichungsreport gegen reale Fahrzeiten | M | offen |

> **Beweis:** Ein signierter `InfraRelease` der Pilotregion, dessen berechnete
> Fahrzeiten innerhalb definierter Toleranz zur Referenz liegen — begleitet von
> einem Abdeckungsreport, der je Streckenabschnitt offenlegt, worauf die
> Qualitätsklasse beruht.

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

Ausführlich: [`betriebsgraph.md`](betriebsgraph.md).

---

## M2 — Weltgerüst: Konten, Weltisolation, Ledger

Klein, aber vor allem Weiteren zwingend: Ab M3 beantragen **zwei Spieler**
konkurrierende Trassen, und ab da kostet etwas Geld. Beides nachträglich
einzuziehen hieße, jede Abfrage und jede Zeile anzufassen.

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 2.1 | Keycloak-Integration, Konten, Rollen, Weltzugänge | M | offen |
| 2.2 | **Weltisolation**: `world_id` in jeder Tabelle, jedem Index, jedem Event — mit automatisiertem Nachweis statt Disziplin | M | offen |
| 2.3 | EVU als Entität: Gründung, Stammdaten, Zuordnung zu Welt und Spieler | S | offen |
| 2.4 | **Ledger-Kern**: Integer-Cent, unveränderlich, ausgeglichen, doppelte Buchführung, Property-Test auf Ausgeglichenheit | M | offen |
| 2.5 | Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung — trägt später Trassenangebote, Ausschreibungen und Störungsmeldungen | S | offen |
| 2.6 | Datenschutz: Datenminimierung, Auskunft, Löschung, Aufbewahrungsfristen | M | offen |

> **Beweis:** Zwei Konten in derselben Welt sehen einander, zwei Konten in
> verschiedenen Welten sehen einander nachweislich nicht — belegt durch einen
> automatisierten Isolationstest, nicht durch Sichtprüfung.

---

## M3 — Sperrzeiten, Konfliktengine, Trassenvergabe

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 3.1 | Sperrzeitenmodell: Fahrstraßenbildezeit, Annäherung, Fahrzeit, Räumung, Auflösung | L | offen |
| 3.2 | `ServicePattern` + relatives `OccupationProfile`, inklusive Zugnummernsystematik | M | offen |
| 3.3 | Konfliktprüfer mit erklärbarem Ergebnis: welche Ressource, welches Fenster, welcher Gegenzug | L | offen |
| 3.4 | Trassen-Planner: Laufweg- und Zeitlagenkandidaten, zulässige Abweichungen | **XL** | offen |
| 3.5 | Deterministischer `PlanningRun`, Koordinierungsverfahren, Seed-Tiebreak, Einspruchsfenster | L | offen |
| 3.6 | Fahrplanperiode als Ablauf: Anmeldefenster, Koordinierung, Veröffentlichung, Betrieb | M | offen |
| 3.7 | Ad-hoc-Trassen aus Restkapazität, Stornierung, Verfall bei Nichtnutzung | M | offen |
| 3.8 | Rahmenverträge mit Kapazitätsdeckel | M | offen |
| 3.9 | **Gestaltungssystem konkretisieren** (`design.md` 2.7): Farbwerte gegen reale Datendichte prüfen, Komponentenbibliothek, Icon-Set, beide Dichtestufen. Erste echte Oberfläche, deshalb hier und nicht früher | L | offen |
| 3.10 | Bildfahrplan-UI, Sperrzeitentreppe, Konflikterklärung im Client — Konvention vor Originalität | L | offen |

> **Beweis:** Zwei Spieler beantragen konkurrierende Trassen. Das System
> entscheidet nachvollziehbar, bietet eine Alternative an, und die Entscheidung
> ist bei gleichem Seed exakt reproduzierbar.

---

## M4 — Simulationskern und Livemap

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 4.1 | Ereignisgesteuerter Kern, regionale Single-Writer, expliziter Zeitgeber | L | offen |
| 4.2 | `TrainRun`-Zustandsmodell, Materialisierungsfenster 48–72 h | M | offen |
| 4.3 | Verspätungs**propagation**: Regelwiderstände, Haltezeiten, Anschlussverzug. Ereignisursachen kommen erst in M8 — hier geht es um Fortpflanzung, nicht um Entstehung | L | offen |
| 4.4 | **Dispositionsschnittstelle im Kern**: definierter Entscheidungspunkt je Ereignis, zunächst mit konservativem Standardverhalten. Macht M7 zu einer Implementierung statt zu einer Operation am offenen Herzen | M | offen |
| 4.5 | Regionsübergabe mit Bestätigungsprotokoll | M | offen |
| 4.6 | Delta-Streaming: Initialsnapshot, Sequenz-Deltas, Interpolation im Client | M | offen |
| 4.7 | Eigene Dark-Vector-Tiles, Pipeline → PMTiles — Netz zurückhaltend, Verkehr dominant; ausgeschlossene Netze als blasse Kontextlinien | M | offen |
| 4.8 | Livemap-Frontend inklusive Zuglaufansicht und Sichtbarkeitsregeln; Zustandsdarstellung nach `design.md` 2.4, **Normalzustand farblos** | L | offen |
| 4.9 | Event-Log, Replay, Determinismus-Test in CI | M | offen |
| 4.10 | **Zeitumstellung**: Verhalten der Fahrplanperiode und laufender Zugfahrten beim Sommerzeitwechsel — Pflichtfall im 1:1-Echtzeitbetrieb | S | offen |
| 4.11 | **Lastmessung gegen die Zielgrößen** aus `architektur.md` | M | offen |

> **Beweis:** 200 simulierte Züge laufen 24 Stunden stabil, die Karte zeigt sie
> flüssig, und ein Replay erzeugt bitgleiche Zustände.

---

## M5 — Flotte, Personal, Umläufe, Versorgung

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 5.1 | Fahrzeugkatalog mit **getrennten Feldern für Baureihenbezeichnung und Handelsname**; Fahrzeug als individuelles Asset mit Fristen, Zulassung, Eigentum | M | offen |
| 5.1a | **Fahrzeugkonfiguration** (E20): Sitzaufteilung nach Klassen, Bestuhlungsdichte, Sitzart, Mehrzweckbereiche, Türanzahl und -breite, Ausstattung. **Türen wirken über die Haltezeit in die Simulation** | L | offen |
| 5.1b | **Werkstattumbau**: Innenraum umbaubar, Türen und Wagenkasten baulich fest; kostet Geld und belegt eine Werkstattanlage | M | offen |
| 5.2 | Formationsbildung, **Abbildung auf Zugcharakteristik (M1.9)**, Kompatibilitätsprüfung gegen Strecke, Bahnsteig, Zugsicherung | M | offen |
| 5.3 | Umlaufplanung mit Wende-, Abstell- und Servicezeiten | L | offen |
| 5.4 | Wartung, gestufte Fristen, Werkstattaufenthalte, Ausfallwahrscheinlichkeit | M | offen |
| 5.5 | Personalpools: Qualifikation nach Baureihe und Streckenkenntnis, Dienstkapazität, Ruhezeiten | L | offen |
| 5.6 | **Bedarfsmodell je Fahrzeug**: Energie, Sand, Frischwasser, Fäkalien, Innen- und Außenreinigung | L | offen |
| 5.7 | **Anlagenbelegung** — Werkstatt, Behandlung, Wäsche, Tankstelle, Entsorgung, Abstellung durch dieselbe Konfliktengine wie der Fahrweg | L | offen |
| 5.8 | **Zusatzfahrten als echte Züge** mit Trasse, Personal, Kosten und Sichtbarkeit | L | offen |
| 5.9 | **Rangieraufwand** als Zeitbedarf und kurzzeitige Belegung — automatisiert, nie steuerbar (E12) | M | offen |
| 5.10 | **Automatischer Versorgungsplaner** — Stufe „Automatik“, Zielgüte 85–90 % der Handplanung | **XL** | offen |
| 5.11 | **Versorgungsvorgaben** — Präferenzen für Ort, Zeitfenster und Anlage | M | offen |
| 5.12 | **Optimierungslücke sichtbar machen** — Differenz zwischen Automatik und Optimum, mit größtem Hebel | M | offen |
| 5.13 | Durchführbarkeitsprüfung: kein Fahrplan wird freigegeben, der Umlauf, Personal, Wartung oder Versorgung verletzt | M | offen |
| 5.14 | Beschaffung: **Leasing sofort verfügbar**, Gebrauchtmarkt kurzfristig, Neubestellung über mehrere Perioden frei konfigurierbar | M | offen |

> **Beweis:** Ein Kurzzeitspieler stellt sein Versorgungsprofil auf Automatik
> und fährt eine Periode ohne einen Ausfall wegen Frist, Wasser oder Entsorgung.
> Ein Detailverliebter plant dieselbe Flotte von Hand und spart nachweisbar rund
> 10 Prozent — und beide sehen im Bericht, woher der Unterschied kommt.

---

## M6 — SPNV: Ausschreibung, Vertrag, Geld

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 6.1 | `EconomyRelease`: Trassen-, Stations-, Anlagenentgelte, Energie, Personal, Verwaltung — versioniert und je Welt gepinnt | L | offen |
| 6.2 | Kostenarten und Kostenstellen auf dem Ledger-Kern aus M2.4 | M | offen |
| 6.3 | **`WorldProfile`** (E18): Weltlaufzeit, abgeleitete Fahrplanperiode, Vertragslaufzeit, Ausschreibungsvorlauf, Staffelung der Vertragsenden | M | offen |
| 6.3a | **Vergabekalender** (`wirtschaft.md` 3.3): beim Weltstart hält der Eigenbetrieb alle Lose; gleichmäßige Fenster über die erste Welthälfte, geschichtet zufällige Zuordnung aus Seed-Substream `tender_release`, vollständig veröffentlicht. **Prüfung beim Weltentwurf, dass Erst- und Wiedervergabe sich überlappen** | M | offen |
| 6.4 | Ausschreibungsgenerator: Leistungsbeschreibung, Qualitätsanforderungen, Laufzeit aus dem `WorldProfile` | M | offen |
| 6.5 | **Auskömmlichkeitsgrenze**: vor Angebotsöffnung veröffentlicht, deterministisch aus `EconomyRelease` berechnet | M | offen |
| 6.6 | Angebotsabgabe mit wenigen Feldern (E19): Bestellerentgelt, Fahrzeugkonzept, optionale Qualitätszusagen. **Angebotsfrist 3–7 Tage, kleine Lose 24–48 Stunden, Zuschlag sofort bei Fristende.** Eigene Wertungsaufschlüsselung vor Abgabe sichtbar; Angebotsassistent als Automatikstufe | L | offen |
| 6.6a | **Fahrzeugvorgaben der Ausschreibung**: Mindestsitzplätze, Klassenanteil, Barrierefreiheit, Fahrrad- und Rollstuhlplätze, Ausstattung — geprüft gegen die Fahrzeugkonfiguration aus M5.1a | M | offen |
| 6.7 | **Betriebsübergang** (`wirtschaft.md` 3): Mobilisierungsphase mit Nachweispflicht auf Fahrzeuge, Personal und Trassen; Altbetreiber fährt mit vollen Pflichten bis zum Fahrplanstichtag; nahtlose Fortsetzung, wenn der Bisherige gewinnt; Eigenbetrieb plus Vertragsstrafe, wenn die Mobilisierung scheitert | L | offen |
| 6.8 | Verkehrsvertrag im Betrieb: Bestellerentgelt, Bonus, Pönale, Nachweise | M | offen |
| 6.9 | **Eigenbetrieb**: Übernahme, Fahrzeugpool, konservatives Standard-Regelwerk, Kennzeichnung auf der Livemap | L | offen |
| 6.10 | **Nachbesserungsleiter**: Notvergabe auf zwei Perioden befristet, danach Neuausschreibung mit verbessertem Paket | M | offen |
| 6.11 | **Aufgabenträger-Budget** als endliche Periodenressource — trägt die Anti-Kartell-Wirkung | M | offen |
| 6.12 | Ergebnisrechnung, Liquidität, Kredite, Restrukturierung | L | offen |
| 6.13 | **Insolvenz-Eskalationsleiter** Stufe 1–5 mit Postfach- und Berichtsmeldungen | M | offen |
| 6.14 | **Präqualifikation und Bonität** je Spieler und Welt — endet mit der Welt | M | offen |

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

---

## M7 — Betriebsprogramm und Betriebszentrale

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 7.1 | Regelmodell: Auslöser, Bedingungen, Maßnahmen, Grenzen, Priorisierung | L | offen |
| 7.2 | Regel-Engine an der Dispositionsschnittstelle aus M4.4 — deterministisch, offline wirksam | L | offen |
| 7.3 | Regeleditor als Bedingungsbaum plus Einsteigervorlagen | L | offen |
| 7.4 | Backtesting gegen die eigenen letzten Betriebstage | M | offen |
| 7.5 | Betriebszentrale: laufende Fahrten, Anschlüsse, Umläufe, Störungen, manueller Eingriff | L | offen |
| 7.6 | Ereignis-Fenster: Push bei Großstörung, manuelle Disposition mit echtem Mehrwert | M | offen |
| 7.7 | Tagesbericht als asynchroner Feedback-Loop | M | offen |

> **Beweis:** Ein Spieler ist 48 Stunden offline, eine Streckensperrung tritt
> ein, sein Regelwerk hält den Betrieb erklärbar aufrecht — und der Tagesbericht
> sagt ihm, welche Regel wann was getan hat und warum.

---

## M8 — Störungen, Baustellen, Ersatzverkehr

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 8.1 | `DisruptionPolicy`-Rahmen: REALISTIC / SIMULATED / MANUAL | S | offen |
| 8.2 | Deterministischer Störungs**generator**: Häufigkeit, Schwere, Dauer, Vorlauf, Region, Belastung. Erzeugt die Ursachen, deren Fortpflanzung M4.3 bereits beherrscht | L | offen |
| 8.3 | Manueller Spielleitermodus mit Pflichtfeldern und Audit | M | offen |
| 8.4 | Auswirkungsmodell: Sperrung, eingleisiger Betrieb, Langsamfahrstelle, Bahnsteigwechsel | L | offen |
| 8.5 | **Baustellenankündigung mit Vorlauf** — Planungsfenster statt Überraschung | M | offen |
| 8.6 | **Ersatzkonzept als eigener `PlanningRun`** gegen die Restkapazität | L | offen |
| 8.7 | **Maßnahmenkasten** mit Prüfung gegen Streckenkenntnis, Zugsicherung, Wendemöglichkeit, Zuglänge, Fahrzeugeignung | L | offen |
| 8.8 | **Wettlauf um Ersatzkapazität** — mehrere EVU konkurrieren um dieselben Umleitungstrassen | M | offen |
| 8.9 | **Vertragliche Behandlung**: Minderung statt Pönale bei fristgerechtem, plausiblem Konzept | M | offen |
| 8.10 | **Automatisches Standardkonzept** — sicher und teuer | M | offen |
| 8.11 | Trassenrückgabe; **SEV als Verpflichtung, Kostenposten und Bewertungsfaktor** — kein Fuhrpark | M | offen |
| 8.12 | Realistischer Modus als Adapter — nur bei geklärter Vertragslage | M | offen |

> **Beweis:** Eine angekündigte mehrwöchige Baustelle zwingt alle Spieler der
> Pilotregion zur Umplanung. Zwei EVU beantragen dieselbe Umleitungstrasse, nur
> eines bekommt sie — das andere weicht auf Ersatzverkehr aus und sieht genau,
> was ihn das gekostet hat. Der Netzfahrplan bleibt konfliktfrei.

---

## M9 — Onboarding, Betriebsreife, geschlossene Alpha

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 9.1 | Tutorial-Welt, beschleunigt, fünf geführte Kapitel | L | offen |
| 9.2 | **Weltstart mit Eigenbetrieb**: das gesamte SPNV-Netz der Region fährt ab Sekunde eins | M | offen |
| 9.3 | Onboarding in der öffentlichen Welt: Startpaket, Kapazitäts-Heatmap, Glossar-Layer | M | offen |
| 9.4 | Admin- und Auditwerkzeuge, Vier-Augen-Prinzip bei Hochrisikoaktionen | M | offen |
| 9.5 | **Betriebsreife**: Observability, Backup und Restore, Incident-Runbooks. Gehört vor die erste Welt mit echten Spielern, nicht in die Monetarisierungsphase | L | offen |
| 9.6 | Rate Limits, Anti-Bot-Prüfungen, Anomalieerkennung für Trassenfenster und Märkte | M | offen |
| 9.7 | Telemetrie, Balancing-Dashboards, Feedbackkanal | M | offen |
| 9.8 | **Weltende** (E18): letzte Periode ohne Ausschreibung, reguläres Vertragsende ohne Insolvenzfolge, Schlusswertung mit mehreren Ranglisten, Archiv und Replay-Export | M | offen |
| 9.9 | Geschlossene Alpha in der Pilotregion | M | offen |

> **Beweis:** 20–50 externe Spieler betreiben die Pilotregion über mehrere
> vollständige Fahrplanperioden ohne manuellen Eingriff.

---

## M10 — SPFV

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 10.1 | Zonen- und Nachfragemodell; **ÖPNV-Anbindung je Station als statisches Attribut** | **XL** | offen |
| 10.2 | Verkehrsmittel- und Zugwahl: Preis, Reisezeit, Umstiege, Takt, Zuverlässigkeit, Komfort | L | offen |
| 10.3 | Tarif- und Vertriebsmodell, Auslastung, Reservierung, Komfortklassen | L | offen |
| 10.4 | Linien-, Halte- und Taktplanung als Spielerwerkzeug | M | offen |
| 10.5 | Kalibrierung gegen öffentliche Größenordnungen | M | offen |

> **Beweis:** Eine neue Fernverkehrslinie verschiebt nachvollziehbar die Ströme,
> und ein Konkurrent kann darauf wirtschaftlich sinnvoll reagieren.

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

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 12.1 | EVU-zu-EVU-Verträge: Traktion, Vermietung, Anschluss, Ersatzverkehr | L | offen |
| 12.2 | Fahrzeug-Sekundärmarkt mit Fristenstand und Wertverfall | M | offen |
| 12.3 | Bietergemeinschaften, Kooperationstarife | M | offen |
| 12.4 | Öffentliche Qualitätsrankings mit Wirkung auf Ausschreibungswertung | M | offen |

---

## M13 — Odoo und Monetarisierung

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 13.1 | Odoo Community selbst gehostet, strikt getrennt, OCA-Module versionsgepinnt | M | offen |
| 13.2 | Game-Outbox → Bridge → Odoo, signierter Webhook-Receiver, nächtlicher Reconciler | L | offen |
| 13.3 | Entitlements, Zugfolge Plus, Kosmetik, Weltplätze, private Welten | M | offen |
| 13.4 | **Planungsarbeitsplatz**: mehrere Bildfahrplanfenster, Layouts, Vergleichsansichten | M | offen |
| 13.5 | **Sammelbearbeitung und Vorlagenverwaltung** für die Handplanung | M | offen |
| 13.6 | **Exporte**: Bildfahrplan, Umlauf- und Dienstpläne, Geschäftsberichte, Replay-Filme | M | offen |
| 13.7 | **Archiv- und Auswertungstiefe** jenseits des entscheidungsrelevanten Zeitraums | S | offen |
| 13.8 | **Erweiterte Automatisierung ausschließlich in privaten Welten** (E13) | M | offen |
| 13.9 | SLO 99,9 % nachweisen — baut auf der Betriebsreife aus M9.5 auf | M | offen |

> **Härtetest:** Odoo abschalten. Login, Simulation, Livemap und bestehende
> Entitlements müssen unverändert weiterlaufen.

---

## M14 — Netzausweitung

| # | Teilabschnitt | Größe | Status |
|---|---------------|-------|--------|
| 14.1 | Pilotregion → Mitteldeutschland | L | offen |
| 14.2 | Etappenweise Ausweitung auf Deutschland, je Etappe mit Qualitätsklassen-Report | **XL** | offen |
| 14.3 | Lastprofile, horizontale Regionenverteilung, Kapazitätsplanung | L | offen |
| 14.4 | Weltenstart-Kadenz und Migrationsregeln | M | offen |

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
