# Milestones

Nach **Abhängigkeiten** geschnitten, nicht nach Zeit. Aufwand relativ als
S / M / L / XL. Keine Kalenderdaten.

Jeder Milestone endet mit einem **Beweis** — einem vorzeigbaren Zustand, meist
einem Spielerlebnis, nicht einer technischen Eigenschaft.

- **Alpha-Schnitt: M0 – M9.** Das ist die erste Version, die externe Spieler
  sinnvoll spielen können. Alles ab M10 ist Ausbau.
- **Kritischer Pfad:** M0.3 → M1 → M3 → M4 → M7.

---

## M0 — Fundament und Grundsatzentscheidungen

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 0.1 | ADRs schriftlich festhalten — E1 bis E16 sind entschieden und werden dokumentiert, nicht neu verhandelt | S |
| 0.2 | Monorepo, CI, Determinismus-Testharnisch, Domänenglossar, **CI-Wächter gegen Payment-Tier-Felder**, **Lizenz-Scan der Abhängigkeiten** | S |
| 0.3 | **Wegwerf-Spike Sperrzeitentreppe:** 3 Betriebsstellen, eine zweigleisige Strecke plus eingleisiger Ast, zwei Züge, Konfliktprüfung, Bildfahrplan als Bild | M |
| 0.4 | Rechte-Gate: dokumentierter Freigabestatus je Datenquelle, inklusive Trassenfinder-Nutzungsbedingungen | S |
| 0.5 | Lizenz und Rechteschutz: `LICENSE`, CLA, Schichtentrennung von Code, Daten und Marke, Markenanmeldung anstoßen | S |

> **Beweis:** Ein echter Belegungskonflikt wird korrekt erkannt und in einer
> Sperrzeitentreppe sichtbar gemacht. Das ist die Existenzberechtigung des
> gesamten Projekts — und der billigste Zeitpunkt, sie zu prüfen.

---

## M1 — Betriebsgraph und Infrastruktur-Release

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 1.1 | Domänenmodell: Betriebsstellen, Kanten, Gleise, Bahnsteige, Elektrifizierung, Zugsicherung, Vmax-Bänder, Neigung | M |
| 1.2 | Import-Pipeline OSM-PBF → Rohgraph mit Topologie, Geometrie, Tags | L |
| 1.3 | **Netzfilter**: nur `railway=rail` in 1435 mm; Tram, Stadtbahn, U-Bahn, Schmalspur, Standseil- und Einschienenbahnen verwerfen; Stromschienennetze über Netzausschlussliste. **Betriebs-, Abstell- und Anschlussgleise bleiben erhalten** | M |
| 1.4 | **Abdeckungsmessung**: Coverage-Report je Attribut und Streckenabschnitt. Entscheidet *vor* dem Bau, welche Strecke Klasse A erreichen kann | M |
| 1.5 | **Neigungsprofil aus Höhenmodell** — aus einem DEM entlang der Gleisgeometrie abgeleitet und geglättet | M |
| 1.6 | **Blockableitung** aus Signalpositionen, Zugbeeinflussung und Topologie; virtuelle Blöcke bei Lücken; Qualitätsklassifizierung A/B/C | L |
| 1.7 | **Fahrstraßen- und Durchrutschwegableitung** im Bahnhofskopf — aus Weichenlage und Signalstandort erzeugt | **XL** |
| 1.8 | Stationsdaten-Anreicherung — ausschließlich freigegebene Quellen | M |
| 1.9 | **Zugcharakteristik** als eigenes Konzept: Masse, Länge, Vmax, Anfahr- und Bremsvermögen, Antriebsart, Zugsicherung. Entkoppelt Fahrzeitrechnung und Trassenplanung vom Fahrzeugkatalog (M5) | M |
| 1.10 | Fahrdynamik und Fahrzeitrechner → vorberechnete **ganzzahlige** Fahrzeittabellen je Zugcharakteristik | L |
| 1.11 | **Anlagenkataster**: Werkstätten, Behandlungs- und Waschanlagen, Tankstellen, Entsorgungsanlagen, Abstellgleise — mit Kapazität, Öffnungszeit, Nutzlänge, Baureihenkompetenz | M |
| 1.12 | `InfraRelease` als unveränderliches, versioniertes Artefakt mit Herkunft, Lizenz, Checksumme und Confidence je Attribut | M |
| 1.13 | Referenzkorpus Leipzig–Halle–Erfurt und Abweichungsreport gegen reale Fahrzeiten | M |

> **Beweis:** Ein signierter `InfraRelease` der Pilotregion, dessen berechnete
> Fahrzeiten innerhalb definierter Toleranz zur Referenz liegen — begleitet von
> einem Abdeckungsreport, der je Streckenabschnitt offenlegt, worauf die
> Qualitätsklasse beruht.

---

## M2 — Weltgerüst: Konten, Weltisolation, Ledger

Klein, aber vor allem Weiteren zwingend: Ab M3 beantragen **zwei Spieler**
konkurrierende Trassen, und ab da kostet etwas Geld. Beides nachträglich
einzuziehen hieße, jede Abfrage und jede Zeile anzufassen.

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 2.1 | Keycloak-Integration, Konten, Rollen, Weltzugänge | M |
| 2.2 | **Weltisolation**: `world_id` in jeder Tabelle, jedem Index, jedem Event — mit automatisiertem Nachweis statt Disziplin | M |
| 2.3 | EVU als Entität: Gründung, Stammdaten, Zuordnung zu Welt und Spieler | S |
| 2.4 | **Ledger-Kern**: Integer-Cent, unveränderlich, ausgeglichen, doppelte Buchführung, Property-Test auf Ausgeglichenheit | M |
| 2.5 | Postfach-Grundgerüst: Nachrichten, Fristen, Quittierung — trägt später Trassenangebote, Ausschreibungen und Störungsmeldungen | S |
| 2.6 | Datenschutz: Datenminimierung, Auskunft, Löschung, Aufbewahrungsfristen | M |

> **Beweis:** Zwei Konten in derselben Welt sehen einander, zwei Konten in
> verschiedenen Welten sehen einander nachweislich nicht — belegt durch einen
> automatisierten Isolationstest, nicht durch Sichtprüfung.

---

## M3 — Sperrzeiten, Konfliktengine, Trassenvergabe

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 3.1 | Sperrzeitenmodell: Fahrstraßenbildezeit, Annäherung, Fahrzeit, Räumung, Auflösung | L |
| 3.2 | `ServicePattern` + relatives `OccupationProfile`, inklusive Zugnummernsystematik | M |
| 3.3 | Konfliktprüfer mit erklärbarem Ergebnis: welche Ressource, welches Fenster, welcher Gegenzug | L |
| 3.4 | Trassen-Planner: Laufweg- und Zeitlagenkandidaten, zulässige Abweichungen | **XL** |
| 3.5 | Deterministischer `PlanningRun`, Koordinierungsverfahren, Seed-Tiebreak, Einspruchsfenster | L |
| 3.6 | Fahrplanperiode als Ablauf: Anmeldefenster, Koordinierung, Veröffentlichung, Betrieb | M |
| 3.7 | Ad-hoc-Trassen aus Restkapazität, Stornierung, Verfall bei Nichtnutzung | M |
| 3.8 | Rahmenverträge mit Kapazitätsdeckel | M |
| 3.9 | **Gestaltungssystem konkretisieren** (`design.md` 2.7): Farbwerte gegen reale Datendichte prüfen, Komponentenbibliothek, Icon-Set, beide Dichtestufen. Erste echte Oberfläche, deshalb hier und nicht früher | L |
| 3.10 | Bildfahrplan-UI, Sperrzeitentreppe, Konflikterklärung im Client — Konvention vor Originalität | L |

> **Beweis:** Zwei Spieler beantragen konkurrierende Trassen. Das System
> entscheidet nachvollziehbar, bietet eine Alternative an, und die Entscheidung
> ist bei gleichem Seed exakt reproduzierbar.

---

## M4 — Simulationskern und Livemap

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 4.1 | Ereignisgesteuerter Kern, regionale Single-Writer, expliziter Zeitgeber | L |
| 4.2 | `TrainRun`-Zustandsmodell, Materialisierungsfenster 48–72 h | M |
| 4.3 | Verspätungs**propagation**: Regelwiderstände, Haltezeiten, Anschlussverzug. Ereignisursachen kommen erst in M8 — hier geht es um Fortpflanzung, nicht um Entstehung | L |
| 4.4 | **Dispositionsschnittstelle im Kern**: definierter Entscheidungspunkt je Ereignis, zunächst mit konservativem Standardverhalten. Macht M7 zu einer Implementierung statt zu einer Operation am offenen Herzen | M |
| 4.5 | Regionsübergabe mit Bestätigungsprotokoll | M |
| 4.6 | Delta-Streaming: Initialsnapshot, Sequenz-Deltas, Interpolation im Client | M |
| 4.7 | Eigene Dark-Vector-Tiles, Pipeline → PMTiles — Netz zurückhaltend, Verkehr dominant; ausgeschlossene Netze als blasse Kontextlinien | M |
| 4.8 | Livemap-Frontend inklusive Zuglaufansicht und Sichtbarkeitsregeln; Zustandsdarstellung nach `design.md` 2.4, **Normalzustand farblos** | L |
| 4.9 | Event-Log, Replay, Determinismus-Test in CI | M |
| 4.10 | **Zeitumstellung**: Verhalten der Fahrplanperiode und laufender Zugfahrten beim Sommerzeitwechsel — Pflichtfall im 1:1-Echtzeitbetrieb | S |
| 4.11 | **Lastmessung gegen die Zielgrößen** aus `architektur.md` | M |

> **Beweis:** 200 simulierte Züge laufen 24 Stunden stabil, die Karte zeigt sie
> flüssig, und ein Replay erzeugt bitgleiche Zustände.

---

## M5 — Flotte, Personal, Umläufe, Versorgung

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 5.1 | Fahrzeugkatalog mit **getrennten Feldern für Baureihenbezeichnung und Handelsname**; Fahrzeug als individuelles Asset mit Fristen, Zulassung, Eigentum | M |
| 5.2 | Formationsbildung, **Abbildung auf Zugcharakteristik (M1.9)**, Kompatibilitätsprüfung gegen Strecke, Bahnsteig, Zugsicherung | M |
| 5.3 | Umlaufplanung mit Wende-, Abstell- und Servicezeiten | L |
| 5.4 | Wartung, gestufte Fristen, Werkstattaufenthalte, Ausfallwahrscheinlichkeit | M |
| 5.5 | Personalpools: Qualifikation nach Baureihe und Streckenkenntnis, Dienstkapazität, Ruhezeiten | L |
| 5.6 | **Bedarfsmodell je Fahrzeug**: Energie, Sand, Frischwasser, Fäkalien, Innen- und Außenreinigung | L |
| 5.7 | **Anlagenbelegung** — Werkstatt, Behandlung, Wäsche, Tankstelle, Entsorgung, Abstellung durch dieselbe Konfliktengine wie der Fahrweg | L |
| 5.8 | **Zusatzfahrten als echte Züge** mit Trasse, Personal, Kosten und Sichtbarkeit | L |
| 5.9 | **Rangieraufwand** als Zeitbedarf und kurzzeitige Belegung — automatisiert, nie steuerbar (E12) | M |
| 5.10 | **Automatischer Versorgungsplaner** — Stufe „Automatik“, Zielgüte 85–90 % der Handplanung | **XL** |
| 5.11 | **Versorgungsvorgaben** — Präferenzen für Ort, Zeitfenster und Anlage | M |
| 5.12 | **Optimierungslücke sichtbar machen** — Differenz zwischen Automatik und Optimum, mit größtem Hebel | M |
| 5.13 | Durchführbarkeitsprüfung: kein Fahrplan wird freigegeben, der Umlauf, Personal, Wartung oder Versorgung verletzt | M |
| 5.14 | Beschaffung: Kauf, Leasing, Gebrauchtmarkt | M |

> **Beweis:** Ein Kurzzeitspieler stellt sein Versorgungsprofil auf Automatik
> und fährt eine Periode ohne einen Ausfall wegen Frist, Wasser oder Entsorgung.
> Ein Detailverliebter plant dieselbe Flotte von Hand und spart nachweisbar rund
> 10 Prozent — und beide sehen im Bericht, woher der Unterschied kommt.

---

## M6 — SPNV: Ausschreibung, Vertrag, Geld

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 6.1 | `EconomyRelease`: Trassen-, Stations-, Anlagenentgelte, Energie, Personal, Verwaltung — versioniert und je Welt gepinnt | L |
| 6.2 | Kostenarten und Kostenstellen auf dem Ledger-Kern aus M2.4 | M |
| 6.3 | Ausschreibungsgenerator: Leistungsbeschreibung, Qualitätsanforderungen, Laufzeit | M |
| 6.4 | **Auskömmlichkeitsgrenze**: vor Angebotsöffnung veröffentlicht, deterministisch aus `EconomyRelease` berechnet | M |
| 6.5 | Angebotsabgabe, Wertung nach Preis und Qualität, Zuschlag, Mobilisierungsphase | L |
| 6.6 | Verkehrsvertrag im Betrieb: Bestellerentgelt, Bonus, Pönale, Nachweise | M |
| 6.7 | **Eigenbetrieb**: Übernahme, Fahrzeugpool, konservatives Standard-Regelwerk, Kennzeichnung auf der Livemap | L |
| 6.8 | **Nachbesserungsleiter**: Notvergabe auf zwei Perioden befristet, danach Neuausschreibung mit verbessertem Paket | M |
| 6.9 | **Aufgabenträger-Budget** als endliche Periodenressource — trägt die Anti-Kartell-Wirkung | M |
| 6.10 | Ergebnisrechnung, Liquidität, Kredite, Restrukturierung | L |
| 6.11 | **Insolvenz-Eskalationsleiter** Stufe 1–5 mit Postfach- und Berichtsmeldungen | M |
| 6.12 | **Präqualifikation und Bonität** je Spieler und Welt | M |

> **Beweis:** Ein Spieler gewinnt eine Ausschreibung, fährt eine Periode, und
> die Ergebnisrechnung erklärt lückenlos, warum Gewinn oder Verlust entstand.
> Ein zweiter fährt sein EVU gegen die Wand — und konnte es ab Stufe 1 kommen
> sehen. Sein Verkehr läuft nahtlos beim Eigenbetrieb weiter.

---

## M7 — Betriebsprogramm und Betriebszentrale

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 7.1 | Regelmodell: Auslöser, Bedingungen, Maßnahmen, Grenzen, Priorisierung | L |
| 7.2 | Regel-Engine an der Dispositionsschnittstelle aus M4.4 — deterministisch, offline wirksam | L |
| 7.3 | Regeleditor als Bedingungsbaum plus Einsteigervorlagen | L |
| 7.4 | Backtesting gegen die eigenen letzten Betriebstage | M |
| 7.5 | Betriebszentrale: laufende Fahrten, Anschlüsse, Umläufe, Störungen, manueller Eingriff | L |
| 7.6 | Ereignis-Fenster: Push bei Großstörung, manuelle Disposition mit echtem Mehrwert | M |
| 7.7 | Tagesbericht als asynchroner Feedback-Loop | M |

> **Beweis:** Ein Spieler ist 48 Stunden offline, eine Streckensperrung tritt
> ein, sein Regelwerk hält den Betrieb erklärbar aufrecht — und der Tagesbericht
> sagt ihm, welche Regel wann was getan hat und warum.

---

## M8 — Störungen, Baustellen, Ersatzverkehr

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 8.1 | `DisruptionPolicy`-Rahmen: REALISTIC / SIMULATED / MANUAL | S |
| 8.2 | Deterministischer Störungs**generator**: Häufigkeit, Schwere, Dauer, Vorlauf, Region, Belastung. Erzeugt die Ursachen, deren Fortpflanzung M4.3 bereits beherrscht | L |
| 8.3 | Manueller Spielleitermodus mit Pflichtfeldern und Audit | M |
| 8.4 | Auswirkungsmodell: Sperrung, eingleisiger Betrieb, Langsamfahrstelle, Bahnsteigwechsel | L |
| 8.5 | **Baustellenankündigung mit Vorlauf** — Planungsfenster statt Überraschung | M |
| 8.6 | **Ersatzkonzept als eigener `PlanningRun`** gegen die Restkapazität | L |
| 8.7 | **Maßnahmenkasten** mit Prüfung gegen Streckenkenntnis, Zugsicherung, Wendemöglichkeit, Zuglänge, Fahrzeugeignung | L |
| 8.8 | **Wettlauf um Ersatzkapazität** — mehrere EVU konkurrieren um dieselben Umleitungstrassen | M |
| 8.9 | **Vertragliche Behandlung**: Minderung statt Pönale bei fristgerechtem, plausiblem Konzept | M |
| 8.10 | **Automatisches Standardkonzept** — sicher und teuer | M |
| 8.11 | Trassenrückgabe; **SEV als Verpflichtung, Kostenposten und Bewertungsfaktor** — kein Fuhrpark | M |
| 8.12 | Realistischer Modus als Adapter — nur bei geklärter Vertragslage | M |

> **Beweis:** Eine angekündigte mehrwöchige Baustelle zwingt alle Spieler der
> Pilotregion zur Umplanung. Zwei EVU beantragen dieselbe Umleitungstrasse, nur
> eines bekommt sie — das andere weicht auf Ersatzverkehr aus und sieht genau,
> was ihn das gekostet hat. Der Netzfahrplan bleibt konfliktfrei.

---

## M9 — Onboarding, Betriebsreife, geschlossene Alpha

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 9.1 | Tutorial-Welt, beschleunigt, fünf geführte Kapitel | L |
| 9.2 | **Weltstart mit Eigenbetrieb**: das gesamte SPNV-Netz der Region fährt ab Sekunde eins | M |
| 9.3 | Onboarding in der öffentlichen Welt: Startpaket, Kapazitäts-Heatmap, Glossar-Layer | M |
| 9.4 | Admin- und Auditwerkzeuge, Vier-Augen-Prinzip bei Hochrisikoaktionen | M |
| 9.5 | **Betriebsreife**: Observability, Backup und Restore, Incident-Runbooks. Gehört vor die erste Welt mit echten Spielern, nicht in die Monetarisierungsphase | L |
| 9.6 | Rate Limits, Anti-Bot-Prüfungen, Anomalieerkennung für Trassenfenster und Märkte | M |
| 9.7 | Telemetrie, Balancing-Dashboards, Feedbackkanal | M |
| 9.8 | Geschlossene Alpha in der Pilotregion | M |

> **Beweis:** 20–50 externe Spieler betreiben die Pilotregion über mehrere
> vollständige Fahrplanperioden ohne manuellen Eingriff.

---

## M10 — SPFV

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 10.1 | Zonen- und Nachfragemodell; **ÖPNV-Anbindung je Station als statisches Attribut** | **XL** |
| 10.2 | Verkehrsmittel- und Zugwahl: Preis, Reisezeit, Umstiege, Takt, Zuverlässigkeit, Komfort | L |
| 10.3 | Tarif- und Vertriebsmodell, Auslastung, Reservierung, Komfortklassen | L |
| 10.4 | Linien-, Halte- und Taktplanung als Spielerwerkzeug | M |
| 10.5 | Kalibrierung gegen öffentliche Größenordnungen | M |

> **Beweis:** Eine neue Fernverkehrslinie verschiebt nachvollziehbar die Ströme,
> und ein Konkurrent kann darauf wirtschaftlich sinnvoll reagieren.

---

## M11 — SGV

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 11.1 | Warenstrom- und Industriemodell, Terminals, Anschlussgleise, Häfen | L |
| 11.2 | Wagen als eigene Assets, Zugbildung, Behandlungszeiten — Rangieren bleibt automatisiert (E12) | L |
| 11.3 | Verladerverträge — Spot und langfristig, Lieferqualität, Pönale | M |
| 11.4 | Wagenumläufe, Leerfahrten, Ganzzug gegenüber Einzelwagenverkehr | L |
| 11.5 | Gefahrgut, Lademaß, Streckenklassen, Bremshundertstel | M |

> **Beweis:** Ein Einzelwagenverkehr über zwei Knoten ist planbar, wirtschaftlich
> bewertbar und auf realistische Weise störungsanfällig.

---

## M12 — Kooperation, Wirtschaftstiefe, Sekundärmarkt

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 12.1 | EVU-zu-EVU-Verträge: Traktion, Vermietung, Anschluss, Ersatzverkehr | L |
| 12.2 | Fahrzeug-Sekundärmarkt mit Fristenstand und Wertverfall | M |
| 12.3 | Bietergemeinschaften, Kooperationstarife | M |
| 12.4 | Öffentliche Qualitätsrankings mit Wirkung auf Ausschreibungswertung | M |

---

## M13 — Odoo und Monetarisierung

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 13.1 | Odoo Community selbst gehostet, strikt getrennt, OCA-Module versionsgepinnt | M |
| 13.2 | Game-Outbox → Bridge → Odoo, signierter Webhook-Receiver, nächtlicher Reconciler | L |
| 13.3 | Entitlements, Zugfolge Plus, Kosmetik, Weltplätze, private Welten | M |
| 13.4 | **Planungsarbeitsplatz**: mehrere Bildfahrplanfenster, Layouts, Vergleichsansichten | M |
| 13.5 | **Sammelbearbeitung und Vorlagenverwaltung** für die Handplanung | M |
| 13.6 | **Exporte**: Bildfahrplan, Umlauf- und Dienstpläne, Geschäftsberichte, Replay-Filme | M |
| 13.7 | **Archiv- und Auswertungstiefe** jenseits des entscheidungsrelevanten Zeitraums | S |
| 13.8 | **Erweiterte Automatisierung ausschließlich in privaten Welten** (E13) | M |
| 13.9 | SLO 99,9 % nachweisen — baut auf der Betriebsreife aus M9.5 auf | M |

> **Härtetest:** Odoo abschalten. Login, Simulation, Livemap und bestehende
> Entitlements müssen unverändert weiterlaufen.

---

## M14 — Netzausweitung

| # | Teilabschnitt | Größe |
|---|---------------|-------|
| 14.1 | Pilotregion → Mitteldeutschland | L |
| 14.2 | Etappenweise Ausweitung auf Deutschland, je Etappe mit Qualitätsklassen-Report | **XL** |
| 14.3 | Lastprofile, horizontale Regionenverteilung, Kapazitätsplanung | L |
| 14.4 | Weltenstart-Kadenz und Migrationsregeln | M |

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
