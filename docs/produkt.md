# Produkt

## 1. Produktdefinition

Zugfolge ist ein persistentes, serverautoritäres Browsergame: eine
Eisenbahn-Unternehmenssimulation mit hohem betrieblichem, infrastrukturellem und
wirtschaftlichem Realismus.

- Öffentliche Welten laufen in 1:1-Echtzeit und werden **niemals
  zurückgesetzt**. Sie laufen ihre von Beginn an angekündigte Laufzeit und enden
  mit einer Schlusswertung — oder laufen unbefristet weiter. Kein Wipe, aber ein
  definiertes Ende (siehe 6.).
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
- Eine Tutorialwelt ist eine ausdrückliche Ausnahme vom No-Wipe-Vertrag: Sie
  wird beim Spielerstart privat erzeugt, läuft beschleunigt und ungewertet und
  wird nach Abschluss, Abbruch oder TTL automatisch archiviert. Öffentliche
  Wettbewerbswelten bleiben dauerhaft bei 1:1 und werden nie zurückgesetzt.

## 2. Zentrale Benutzeroberflächen

- **Live-Lage** — selbst gehostete, dunkle Weltkarte mit vollständigem
  Deutschland-Infrastruktur-Layer, allen fahrenden Zügen, Verspätungen,
  Sperrungen und Belegungen. **Hauptseite und räumliches Spielzentrum.**
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

Die Welt bleibt überall navigierbar; der eigene Deutschland-Korpus liegt als
semantischer Layer darüber. Aktive Infrastruktur ist hervorgehoben, während
nur die weltgebundene `playable`-Maske Bestellung und Disposition freigibt.
Mit steigendem Zoom erscheinen Korridore, Betriebsstellen, Einzelgleise,
Bahnsteige, Blöcke, Weichen, Signale und Anlagen. Alle sichtbaren Fachobjekte
sind anklickbar und besitzen releasegebundene Details. Bahnhöfe öffnen eine
aktuelle, generische Fallblattanzeige; Züge eine öffentliche Betriebssicht und
einen FIS-Monitor. Das eigene EVU erhält zusätzlich autorisierte interne
Zugdaten. → [ADR-0026](adr/0026-karte-als-spielzentrum.md)

## 3. Onboarding

Zugfolge ist komplex. Ohne bewusstes Onboarding verliert es Spieler in den
ersten zehn Minuten.

- **Persönliche Tutorialwelt**, etwa zwölf Minuten Sollzeit: Beim Start erzeugt
  das Game aus einem versionierten, gehashten Minimaltemplate genau eine
  private Welt für dieses öffentliche Weltkonto. Fünf geführte Kapitel lauten
  erste Ausschreibung → Fahrzeug selbst leasen → Trasse selbst bestätigen →
  Betriebsprogramm verändern und aktivieren → erste Störung disponieren. Ein
  Reload setzt dieselbe Sitzung fort; ein Neustart archiviert die alte Welt und
  erzeugt eine neue UUID. Die Abnahmegrenze bleibt 90 Prozent externer
  Testspieler unter 15 Minuten.
- **Keine öffentliche Startausstattung.** Wettbewerbswelten vergeben weder
  Verkehrsvertrag noch Fahrzeug, Trasse, Personal oder Betriebsprogramm
  automatisch. Ihr Geldbestand folgt ausschließlich der im signierten
  Weltentwurf freigegebenen `StartingCapitalPolicy`; Tutorialkapital und
  Tutorialhandlungen werden niemals übertragen.
- Das Tutorial besitzt nur vorbereitetes, noch nicht kapitelabschließendes
  Inventar: EVU und Präqualifikation, endliches Kapital, Personalpool, offene
  Leasingangebote, unbestätigte Trassenalternativen, inaktive
  Betriebsprogrammvorlagen, offene Ausschreibung und eine spätere
  deterministische Störung.
- **Lutz**, Mitarbeiter eines vollständig fiktiven Infrastrukturbetreibers,
  führt mit kurzen, reproduzierbaren Dialogen durch jeweils eine Hauptaufgabe.
  Sein Sarkasmus richtet sich gegen Bürokratie und Chaos; Sicherheits-, Geld-
  und Handlungsinformationen bleiben eindeutig. Seine Texte werden nie zur
  Laufzeit generiert.
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

**Durchgehende Linien am Gebietsrand (E25):** Eine reale Linie wird nicht am
Kartenrand umbenannt oder mit einer erfundenen Wende verkürzt. Im
Bildfahrplan plant der Spieler ausschließlich den Abschnitt im freigegebenen
Netz. Benanntes Grenzportal, Sollzeit und zulässiges Zeitband sind als feste,
serverseitig aus dem Release geladene Randbedingung sichtbar. Der Außenlauf
bleibt derselbe Zug, hält Fahrzeug und gegebenenfalls Personal gebunden und
erscheint in der Livemap als eigener Status ohne erfundene Kartenposition.
Beim Wiedereintritt wartet er nötigenfalls außerhalb auf freie Kapazität.
Nicht qualifizierte Übergänge sind sichtbar, aber nicht bestellbar. Details:
[ADR-0025](adr/0025-gebietsueberschreitende-fahrtketten.md).

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

## 6. Weltlaufzeit und Weltende (E18)

Eine Welt läuft **6 bis 18 Monate**; daneben gibt es **unbefristete Welten**.
Die Laufzeit steht ab Weltstart fest und ist öffentlich sichtbar.

### 6.1 Alles skaliert mit — sonst passt nichts zusammen

Eine feste Fahrplanperiode von acht Wochen ergäbe in einer Sechsmonatswelt
gerade drei Perioden. Damit wäre der Saison-Rhythmus nicht spürbar und eine
Ausschreibung nicht einmal vollständig durchlaufbar. **Die Periodenlänge ist
deshalb ein Weltparameter, keine Konstante.**

Zwei Zielgrößen halten das Spielgefühl über alle Weltlängen gleich:

- **rund 8 bis 11 Fahrplanperioden je Welt** — der Saison-Rhythmus wird
  mehrfach erlebt;
- **rund 3 bis 4 Vergabezyklen je Welt** — Ausschreibungen sind ein wiederholtes
  Ereignis, aber Verträge fühlen sich stabil an.

| Weltlaufzeit | Fahrplanperiode | Vertragslaufzeit | Perioden gesamt | Vergabezyklen |
|--------------|-----------------|------------------|-----------------|---------------|
| 6 Monate | 3 Wochen | 2 Perioden (6 Wochen) | ~8 | ~4 |
| 12 Monate | 5 Wochen | 3 Perioden (15 Wochen) | ~10 | ~3,5 |
| 18 Monate | 7 Wochen | 3 Perioden (21 Wochen) | ~11 | ~3,7 |
| unbefristet | 8 Wochen | 4–6 Perioden (8–11 Monate) | fortlaufend | fortlaufend |

```text
WorldProfile
  weltlaufzeit          6–18 Monate | unbefristet
  fahrplanperiode       Wochen, abgeleitet (3–8)
  vertragslaufzeit      Perioden, abgeleitet (min. 2)
  ausschreibungsvorlauf Perioden, abgeleitet (min. 1)
  vertragsstaffelung    Verteilung der Vertragsenden über die Laufzeit
```

Abgeleitete Werte sind je Welt einsehbar und ändern sich während der Laufzeit
nicht. Die unbefristete Welt behält die acht Wochen — den Rhythmus, für den das
Konzept ursprünglich entworfen wurde.

### 6.2 Durchgehend offener Markt

Zwei Mechanismen sorgen dafür, dass zu **jedem** Zeitpunkt einer Welt irgendwo
eine Ausschreibung läuft — sonst gäbe es tote Wochen, in denen Neueinsteiger
keinen Einstieg finden:

- **Erstvergabe nach veröffentlichtem Vergabekalender.** Beim Weltstart hält der
  Eigenbetrieb alle Lose; sie werden über die erste Welthälfte in gleichmäßigen
  Fenstern freigegeben, die Zuordnung geschichtet zufällig. Details:
  `wirtschaft.md` 3.3.
- **Gestaffelte Vertragsenden.** Liefen alle Verträge gleichzeitig aus, gäbe es
  ein riesiges Vergabeereignis und danach monatelang nichts.

Beide Ströme überlappen sich: Während die letzten Lose erstmals vergeben werden,
kommen die frühesten schon zur Wiedervergabe. Das ist eine Prüfbedingung beim
Weltentwurf, keine Hoffnung.

### 6.3 Weltende

- Die letzte Fahrplanperiode wird nicht mehr ausgeschrieben; laufende Verträge
  laufen regulär aus. Ein Vertragsende durch Weltende ist **keine** Insolvenz.
- Es gibt eine **Schlusswertung**, aber bewusst keinen einzigen Sieger (E11):
  mehrere Ranglisten für Betriebsleistung, Pünktlichkeit, Ergebnis und
  Marktanteil.
- Die Betriebshistorie bleibt als Archiv einsehbar; ein Replay-Export der
  eigenen Welt ist möglich.
- **Die Präqualifikation stirbt mit der Welt.** Jede neue Welt startet für alle
  bei null — auch für den, der in der letzten insolvent ging.

## 7. Gestaltungsprinzipien gegen Strategie-Monokultur (E11)

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

**Und die Nachfrage selbst variiert (E21).** Die beiden Hebel oben wirken
*innerhalb* einer Ausschreibung und auf der Trassenseite. Auf der Vergabeseite
kommt ein dritter dazu: Jede SPNV-Ausschreibung trägt ein deterministisch aus
dem Weltseed gezogenes, vorab veröffentlichtes **Vergabeprofil** — verschobene
Wertungsgewichte, ein anderer Anforderungs- und Pönaleschwerpunkt, wechselnde
Sonderauflagen. Dadurch ist eine einmal gewinnende Angebotsschablone beim
nächsten Los nicht mehr die beste Antwort, und wiederkehrende Ausschreibungen
bleiben eine Entscheidung statt einer Formularwiederholung. Details:
`wirtschaft.md` 3.7.

**Zeitverfügbarkeit ist kein Wettbewerbsvorteil.** Ein persistentes, nicht
pausierbares Echtzeitspiel bestraft sonst automatisch jeden, der nicht täglich
einloggt. Das Betriebsprogramm ist deshalb kein Komfortfeature, sondern eine
Fairnessbedingung.

## 8. Realismus dient dem Spiel, nicht umgekehrt (E19)

Die Spieler sind interessierte Laien, keine Betriebsplaner. Realismus ist das
Mittel, mit dem interessante Entscheidungen entstehen — nicht der Zweck.

> **Der Test:** Erzeugt dieser Schritt eine Entscheidung, die der Spieler
> interessant findet? Wenn nein, wird er abstrahiert oder weggelassen.

Das Grundprinzip muss stimmen; die Verwaltung drumherum nicht. Ein Verfahren
originalgetreu nachzubauen, das im Spiel nur aus Bestätigungsklicks besteht,
macht das Spiel nicht realistischer, sondern nur zäher.

**Was daraus schon folgt:** Rangieren ist automatisiert (E12) — der Zeitbedarf
ist betrieblich relevant, die Ausführung erzeugt keine Entscheidung.
Schienenersatzverkehr ist Kostenposten und Bewertungsfaktor, kein Fuhrpark
(1.4). Personal ist ein Qualifikationspool, keine Sammlung von Biografien (→
`betrieb.md`).

**Wo es am wichtigsten ist: die Ausschreibung.** Ein reales Vergabeverfahren
besteht zu weiten Teilen aus Formalia — Teilnahmewettbewerb, Eignungsnachweise,
Formblätter, Aufklärungsgespräche, Nachprüfungsverfahren. Nichts davon erzeugt
eine interessante Entscheidung. Die Entscheidung ist: *Was verlangt der
Aufgabenträger, was biete ich, kann ich es leisten, und zu welchem Preis?* Nur
das wird modelliert. Details: `wirtschaft.md` 3.6.

**Die Gegenprobe** gehört mit dazu, damit das Prinzip nicht zur Ausrede wird:
Sperrzeiten, Konfliktprüfung, Fahrdynamik, Umlaufbindung und Fristen werden
**nicht** abstrahiert. Sie sind der Grund, warum das Spiel existiert. Abstrahiert
wird Verwaltung, nicht Betrieb.
