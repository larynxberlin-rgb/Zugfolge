# Produkt

## 1. Produktdefinition

Zugfolge ist ein persistentes, serverautoritäres Browsergame: eine
Eisenbahn-Unternehmenssimulation mit hohem betrieblichem, infrastrukturellem und
wirtschaftlichem Realismus.

- Öffentliche Welten laufen dauerhaft und ohne Wipes in 1:1-Echtzeit.
- Alle Züge **im Wettbewerb** gehören Spielern. Einzige Ausnahme ist der
  Eigenbetrieb des Aufgabenträgers als Ausfallsicherung (→ `wirtschaft.md`) —
  kein Wettbewerber, sondern eine sichtbare Rückfallebene.
- Reale Fahrplandaten dienen nur zur Kalibrierung und Qualitätssicherung, nicht
  als Verkehr der Spielwelt.
- Spieler bauen keine Gleise, Bahnhöfe oder Infrastruktur. Sie nutzen das
  vorhandene, versionierte Netz.
- Spieler führen ihr EVU strategisch und operativ, fahren Züge aber nicht selbst
  und stellen keine Signale.
- Erste geschlossene Pilotregion ist **Leipzig–Halle–Erfurt** mit Infrastruktur-
  und Wirtschaftsstand 2026.
- Tutorial- und private Welten dürfen beschleunigt laufen; öffentliche
  Wettbewerbswelten bleiben bei 1:1.

## 2. Zentrale Benutzeroberflächen

- **Live-Lage** — dunkle Deutschlandkarte mit allen fahrenden Zügen,
  Verspätungen, Sperrungen und Belegungen. **Hauptseite.**
- **Fahrplan und Trassen** — Laufwegsuche, Bildfahrplan, Sperrzeitentreppe,
  Konflikterklärung, Alternativangebote.
- **Betriebszentrale** — laufende Zugfahrten, Anschlüsse, Umläufe, Störungen,
  Dispositionsregeln.
- **Märkte** — SPFV-Nachfrage, SGV-Aufträge, SPNV-Ausschreibungen.
- **Fahrzeuge und Personal** — Flotte, Formationen, Kompatibilität, Wartung,
  Versorgung, Abstellung, Qualifikationspools.
- **Unternehmen und Finanzen** — Liquidität, Ledger, Kostenstellen, Kredite,
  Verträge, Ergebnisrechnung.
- **Postfach** — Trassenangebote, Fristen, Ausschreibungen, Störungen,
  administrative Nachrichten.

Desktop erhält die vollständige Leitstellenansicht. Die PWA für Smartphone und
Tablet unterstützt Livemap, Meldungen, Freigaben und begrenzte Disposition;
komplexe Fahrplanarbeit bleibt desktop-first. Oberflächensprache ist zunächst
ausschließlich Deutsch.

## 3. Onboarding

Zugfolge ist komplex. Ohne bewusstes Onboarding verliert es Spieler in den
ersten zehn Minuten.

- **Tutorial-Welt**, beschleunigt, fünf geführte Kapitel: erste Ausschreibung →
  Fahrzeug leasen → Trasse beantragen → Betriebsprogramm bauen → erste Störung
  überstehen.
- **Startpaket in der öffentlichen Welt:** ein kleiner, bereits notvergebener
  Verkehrsvertrag plus Leasingfahrzeug. Kein Startkapital-Cliff.
- **Glossar-Layer** über der gesamten Oberfläche: jeder Fachbegriff — Sperrzeit,
  Durchrutschweg, Wendezeit, Zugsicherung, Bremshundertstel — ist anklickbar
  erklärt. Kein Wiki-Zwang.
- **Betriebsleiter-Assistent:** kontextuelle Warnungen statt Handbuch. Für alle
  kostenlos.

## 4. Netzabgrenzung (E14)

**Zwei Regeln, in dieser Reihenfolge:**

1. **Nur EBO.** Das Spiel bildet ausschließlich Strukturen der
   Eisenbahn-Bau- und Betriebsordnung ab. BOStrab (Straßenbahn, Stadtbahn,
   U-Bahn) und ESBO (Schmalspur) sind eigene Netze und kommen nicht vor.
   **Ein Übergang zwischen EBO und BOStrab wird nicht umgesetzt** —
   Zweisystem-Stadtbahnen existieren im Spiel nicht, weder als Fahrzeug noch als
   Fremdbelegung.
2. **Innerhalb der EBO: betrieblich abgetrennte Netze bleiben draußen.** Das
   betrifft die S-Bahn-Netze mit eigener Stromschiene — Berlin mit 750 V,
   Hamburg mit 1200 V.

| Verkehrsart | Status | Grund |
|-------------|--------|-------|
| Normalspuriges Eisenbahnnetz (EBO, 1435 mm) | **im Spiel** | gemeinsame Kapazität, gemeinsame Konflikte |
| Straßenbahn, Stadtbahn, U-Bahn (BOStrab) | draußen | anderes Regelwerk, kein Übergang |
| Schmalspurbahnen (ESBO) | draußen | anderes Regelwerk, eigenes Netz |
| Bus | draußen | keine Schieneninfrastruktur |
| S-Bahn auf dem allgemeinen Netz (15 kV Oberleitung) | **im Spiel** | vollwertiger SPNV |
| S-Bahn mit eigenem Stromschienennetz | draußen | betrieblich abgetrennt |

Die Regelwerksgrenze ist der Test, weil sie eindeutig und im Import prüfbar ist.
Das betriebliche Argument — geteilte Kapazität — trägt sie inhaltlich, ist aber
nicht der Test.

Im Import ist der Stromschienenfall fast mechanisch erkennbar: allgemeines Netz
`electrified=contact_line` bei 15 kV / 16,7 Hz, abgetrennte S-Bahn-Netze
`electrified=rail` bei 750 bzw. 1200 V. Für unscharfe Abschnitte entscheidet
eine explizite Netzausschlussliste.

**Für die Pilotregion:** Die S-Bahn Mitteldeutschland läuft vollständig auf dem
allgemeinen Netz und ist vollwertiger SPNV — inklusive Leipziger City-Tunnel,
einem der interessantesten Kapazitätsengpässe der Region.

**Zwei Dinge bleiben modelliert, ohne simuliert zu werden:**

- **Schienenersatzverkehr** als vertragliche Pflicht, Kostenposten und
  Bewertungsfaktor — kein Fuhrpark, kein Bus auf der Karte.
- **ÖPNV-Anbindung einer Station** als statisches Attribut für das
  Nachfragemodell.

Ausgeschlossene Netze dürfen als blasse Kontextlinien gezeichnet werden, damit
Städte richtig aussehen. Nicht auswählbar, keine Kapazität, kein Betrieb.

## 5. Zwei Spielertypen, ein System

Detailverliebte und Kurzzeitspieler spielen dasselbe System, ohne dass einer
verliert. Kein vereinfachter Modus, sondern **drei Eingriffstiefen auf
identischer Mechanik** — für Versorgung wie für Disposition (→ `betrieb.md`).

| Stufe | Was der Spieler tut | Zeitbedarf |
|-------|---------------------|------------|
| **Automatik** | Wählt je Umlauf ein Profil, etwa „Standard SPNV“. Das System plant Zusatzfahrten, bucht Trassen und Anlagenslots selbst und weist die Kosten aus. | Minuten je Periode |
| **Vorgaben** | Setzt Regeln und Präferenzen: „tanken bevorzugt in Halle“, „Innenreinigung nur nachts“, „eigene Werkstatt vor Fremdwerkstatt“. | eine halbe Stunde je Periode |
| **Handplanung** | Plant jede Zuführung, jeden Behandlungsschritt und jedes Abstellgleis selbst. | beliebig tief |

**Balanceregel:** Die Automatik ist *gut, aber nicht optimal* — Zielgröße rund
85 bis 90 Prozent der Güte einer sorgfältigen Handplanung. Wäre sie optimal,
hätten Detailverliebte nichts zu gewinnen; wäre sie schlecht, wären
Kurzzeitspieler chancenlos. Die Lücke wird offen ausgewiesen:

> Versorgungsplanung dieser Periode: 4.200 €. Geschätztes Optimum: rund 3.700 €.
> Größter Hebel: sechs Zuführungsfahrten Erfurt–Leipzig ohne Nutzlast.

Einladung, keine Rüge. Wer sie ignoriert, spielt weiterhin erfolgreich, nur mit
etwas dünnerer Marge.

**Sitzungsdauer** folgt dem Periodenrhythmus:

| Anlass | Realistischer Zeitbedarf |
|--------|--------------------------|
| Ruhiger Betriebstag | 5–10 min |
| Normaler Betriebstag | 15–25 min |
| Störungstag | 20–45 min |
| Anmelde- und Koordinierungswoche | mehrere Stunden über die Woche |
| Ausschreibung im Zuschnitt | ein bis zwei Stunden am Stück |

Entscheidend ist nicht, dass ein Tag in Minuten erledigt sein *soll*, sondern
dass ein **verpasster Tag nicht bestraft**.

## 6. Gestaltungsprinzipien gegen Strategie-Monokultur (E11)

Die verbreitetste Schwäche wirtschaftlicher Verkehrssimulationen: Der Erfolg
einer Linie kollabiert auf eine einzige Kennzahl. Sobald das passiert, ist die
optimale Strategie berechenbar und alle spielen identisch.

**Ziele müssen einander widersprechen.** Pünktlichkeit, Kosten,
Kapazitätsnutzung, Vertragsqualität und Fahrzeugverfügbarkeit dürfen nicht in
eine Zahl zusammenfallen. Ein hoher Qualitätsbonus wird durch Reservefahrzeuge
und Pufferzeiten erkauft, die Trassen- und Kapitalkosten erhöhen. Wer maximal
dicht plant, verliert bei der ersten Störung genau diesen Bonus.

**Das Optimum hängt von den anderen ab.** Kapazität ist keine individuelle
Ressource, sondern eine sekundengenau umkämpfte gemeinsame. Die beste Zeitlage
existiert nur relativ zu den Anträgen der Konkurrenz in derselben
Koordinierungsrunde. Eine berechenbare Einheitsstrategie ist damit strukturell
ausgeschlossen — durch die Domäne, nicht durch Balancing.

**Zeitverfügbarkeit ist kein Wettbewerbsvorteil.** Ein persistentes, nicht
pausierbares Echtzeitspiel bestraft sonst automatisch jeden, der nicht täglich
einloggt. Das Betriebsprogramm ist deshalb kein Komfortfeature, sondern eine
Fairnessbedingung.
