# Bahn-Anzeigen in der Spieleroberfläche

Dieses Dokument beschreibt die **Darstellung** der bereits in
[`ux-spieler-shell.md`](ux-spieler-shell.md) festgelegten Abläufe. Es ändert
weder Navigation noch Datenverträge. FIS, Bahnhofstafel und Icons sind
Präsentationskomponenten der Live-Lage; Auswahl, Aktualisierung und fachliche
Wahrheit bleiben Teil der UX- und Read-Model-Verträge.

Die Gestaltung übernimmt vertraute Informationshierarchien des deutschen
Schienenverkehrs, aber keine Marke: kein DB-Logo, keine DB-Hausschrift, keine
exakten Gehäuse oder geschützten Zuggattungszeichen. Die drei FIS-Profile und
die Fallblattanzeige bleiben als Zugfolge-Komponenten erkennbar.

## 1. Gemeinsame Regeln

- Die Oberfläche bleibt dunkel. Die Karte ist die dunkelste Fläche, Displays
  liegen als klar begrenzte, leicht erhöhte Geräteflächen darüber.
- Tabellenziffern sind für Zeiten, Zugnummern und Gleise Pflicht.
- Struktur ist achromatisch. Bernstein und Rot erscheinen nur bei einer echten
  Abweichung, Störung oder einem Ausfall und immer zusammen mit Text oder Icon.
- Nicht gelieferte Angaben werden als „nicht verfügbar“ kenntlich gemacht;
  Ankunftszeit, Ausstiegsseite, Anschlüsse oder Ausstattung werden nicht
  erfunden.
- Die zugängliche Bezeichnung enthält immer den vollständigen Endzustand. Rein
  visuelle Zwischenzustände einer Animation bleiben für assistive Technik
  verborgen.

## 2. FIS-Profile

Die Variante wird ausschließlich aus der vorhandenen Zuggattung abgeleitet.
Unbekannte Gattungen fallen auf das robuste Regionalprofil zurück.

| Profil | Stabile Hauptinformation | Ergänzung | Bewegungscharakter |
|---|---|---|---|
| S-Bahn | Linie/Zug, Ziel, nächster Halt | kompakte horizontale Perlschnur | direkt und kompakt |
| Regionalverkehr | Fahrtziel, nächster Halt | folgende Halte und Fahrgastmeldung | informationsdicht, klar zoniert |
| Fernverkehr | nächster Halt und Fahrtziel | ruhiger Fahrtverlauf | großzügig, zurückhaltend |

Alle Profile verwenden denselben `PassengerInformationDisplayV1`-Vertrag.
Spätere Ankunfts-, Anschluss-, Türseiten- oder Ausstattungselemente dürfen erst
erscheinen, wenn ein versionierter Vertrag diese Werte liefert. Der vorhandene
Betriebsstatus wird dagegen unmittelbar verwendet: Ein Ausfall erscheint mit
Störungsicon und dem Wort „Fällt aus“, nie nur als rote Fläche.

## 3. Fallblattanzeige

Die Bahnhofstafel ist semantisch in fünf Felder gegliedert:

`Zeit | Zug | Von/Nach | Gleis | Hinweis`

Jedes sichtbare Feld besteht aus einzelnen graphitfarbenen Segmenten mit
Mittelachse. Warmweiße Schrift und kleine Helligkeitsunterschiede vermitteln
den mechanischen Charakter; Statusfarben bleiben der fachlichen Bedeutung
vorbehalten.

Ankunft und Abfahrt teilen sich im schmalen Inspector denselben Tafelplatz.
Der Umschalter bleibt bei Aktualisierungen je Welt und Bahnhof erhalten; jede
Ansicht enthält weiterhin alle Fahrten ihres aktuellen Zeitfensters.

### 3.1 Bewegungsvertrag

- Nur geänderte Zeichen klappen.
- Der Zeichenkranz läuft ausschließlich vorwärts vom alten zum neuen Wert.
  Lange Wege werden auf höchstens zwei sichtbare Zwischenzeichen plus Ziel
  komprimiert; auch das Leerzeichen ist eine echte Klappe. Zufall und dadurch
  flackernde Tests sind ausgeschlossen.
- Zeichen und Zeilen starten leicht versetzt. Ein kompletter Wechsel bleibt
  kurz und endet innerhalb ungefähr einer Sekunde im stabil lesbaren Zustand.
- Zwischenzeichen sind `aria-hidden`; eine getrennte semantische Tabelle enthält
  ausschließlich die endgültigen Fahrplandaten.
- Es gibt keinen automatischen Ton.
- Die sichtbare Wahl **Normal / Reduziert / Aus** gilt lokal für die geöffnete
  Sitzung. `prefers-reduced-motion: reduce` startet mindestens im reduzierten
  Modus.

## 4. Bahn-Iconset

Das gemeinsame, strichbasierte Iconset wird um folgende Domänenbegriffe
ergänzt:

| Bereich | Icons |
|---|---|
| Ort und Betrieb | `station`, `platform`, `workshop`, `connection`, `disruption` |
| Zugprofile | `train-suburban`, `train-regional`, `train-long-distance` |
| Fahrgastinformation | `information`, `accessible`, `bicycle`, `dining` |

Icons verwenden ausschließlich `currentColor`. Dekorative Icons sind für
Screenreader verborgen; inhaltliche Icons erhalten einen escapten Titel und
eine zugängliche Beschriftung. Ein Icon behauptet nie eine nicht gelieferte
Ausstattung oder einen Signalzustand. Das Werkstatticon bereitet den eigenen
autoritativen Werkstatt-Layer vor; generische Konfliktressourcen werden nicht
als Werkstatt umgedeutet.

## 5. Qualitäts- und Abnahmematrix

| Prüffall | Erwartung |
|---|---|
| S-, Regional- und Fernverkehrsgattung | jeweils korrektes FIS-Profil ohne erfundene Werte |
| unbekannte Gattung | Regionalprofil als lesbarer Fallback |
| pünktlich / verspätet / Ausfall | Text oder Zahlenwert zusätzlich zur Farbe |
| lange deutsche Ziele und Halte | begrenztes Segmentfeld, vollständiger Wert in semantischer Tabelle |
| Aktualisierung einer einzelnen Fahrt | nur geänderte Segmente animieren |
| reduzierte Bewegung / Animation aus | unmittelbarer beziehungsweise stark verkürzter Wechsel |
| Tastatur und Screenreader | Bewegungswahl bedienbar, endgültige Tabelle vollständig lesbar |
| 1440×900, 1024×768, 390×844 | kein Dokument-Scroll; lokale Tafelfläche darf horizontal scrollen |

## 6. Referenzen und Übertragungsgrenze

Die funktionale Hierarchie folgt öffentlich dokumentierten Mustern, nicht einer
pixelgenauen Kopie:

- [S-Bahn Berlin: Informationsmonitore der Baureihen 483/484](https://sbahn.berlin/das-unternehmen/fahrzeugpark/die-neue-s-bahn/)
- [VDV/DB/BSN: Grundaufbau der Fahrgastinformations-Screens](https://www.standarddesign-fahrgastinformation.de/fahrgastinformation/Designsystem/Grundaufbau-der-Screens-13376218)
- [VDV/DB/BSN: Fahrtverlauf und Perlschnur](https://www.standarddesign-fahrgastinformation.de/fahrgastinformation/Highlights/Der-Fahrtverlauf-Perlschnur--13365950)
- [VDV/DB/BSN: Basisfahrt im Regionalverkehr](https://www.standarddesign-fahrgastinformation.de/fahrgastinformation/Musterstrecke/Basisfahrt-mit-Beispielen-fuer-alle-Verkehrsmittel)
- [Deutsche Bahn: Fahrgastinformation im ICE 4](https://www.deutschebahn.com/de/kundenkomfort-6876730)
- [Solari: Geschichte mechanischer Fallblattanzeigen](https://www.solari.it/en/history/)
- [W3C: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html)
- [W3C: Reduced Motion](https://www.w3.org/WAI/WCAG22/Techniques/css/C39)
