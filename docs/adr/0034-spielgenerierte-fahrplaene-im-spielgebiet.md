# ADR-0034: Spielgenerierte Fahrpläne innerhalb des Spielgebiets

- **Status:** Angenommen — bindend (entspricht E33); ersetzt E25 / ADR-0025 für neue Spielangebote.
- **Anlass:** Produktvorgabe vom 5. September 2026.
- **Bezug:** `gtfs-angebotsplanung.md`, `wirtschaft.md` 3.3, `infrastruktur.md` 10.4.

## Entscheidung

GTFS liefert Referenzen für Linienbezeichnung, Haltefolge, Laufweg, Fahrzeiten,
Bedienungszeitraum und Frequenz. Verbindlich ist der daraus vom Spiel erzeugte,
versionierte Fahrplan. Reale Trip-IDs und einzelne Abfahrten sind Herkunftsbelege,
keine Identität oder unveränderliche Vorgabe einer Spielzugfahrt.

Jede neue Spielzugfahrt beginnt und endet an einem betrieblich geeigneten Bahnhof im festgelegten
Spielgebiet. Alle Halte und der gesamte tatsächlich befahrene Gleisweg liegen
darin. Maßgeblich ist das gepinnte Spielgebiet, unabhängig von Zoom oder
Kartenausschnitt des Browsers. Der vollständige Deutschlandkorpus darf weiterhin
als Referenz und Kartenhintergrund vorhanden sein.

Der Angebotscompiler zerlegt eine Referenz an Außenhalten und nachgewiesenen
Außenwegen in zusammenhängende Innenabschnitte. Jeder Abschnitt wird auf das
am weitesten auseinanderliegende Paar nachweislich geeigneter Bahnhöfe gekürzt
(größte Zahl erhaltener Halteabschnitte; bei Gleichstand früherer Beginn). Die beiden Enden
müssen unterschiedliche Betriebspunkte sein und eine belegte Wendemöglichkeit
besitzen. Haltepunkte bleiben als Zwischenhalte zulässig. Fehlende oder unbekannte
Betriebspunkte sind keine zulässigen Enden; ohne geeignetes Paar entfällt der
Abschnitt. Weder ein GTFS-Stationseintrag noch der Name „Hbf“ belegt die Eignung.
Ein Wiedereintritt bildet eine getrennte Linie und keine unsichtbare Durchbindung.
Das Ziel lautet auf den tatsächlichen inneren Endbahnhof. Ausschreibungen zeigen
die Linienbezeichnung und tatsächlichen Endpunkte des bestellten Spielangebots.
GTFS-Vorlagen und Kürzungshinweise gehören nicht in die Spieleroberfläche.
Der Routengraph schließt Gleisgeometrien aus, die die Spielgebietsgrenze verlassen;
innere Endpunkte allein reichen nicht. Ein nicht vollständig nachgewiesener Weg
darf niemals als scheinbar befahrbarer Außenweg freigegeben werden.
Die Netzprüfung erfolgt vor der endgültigen Fahrplangenerierung, auch ohne
GTFS-Shapes. Gleisbestand, Richtungsfreigaben, Korridore und der geprüfte
Endpunktkatalog sind mit dem Erzeugungsnachweis verbunden. Verworfene und
gekürzte Abschnitte erhalten in den internen Importberichten einen
nachvollziehbaren Entscheidungsgrund.

Aus den Referenzfahrten entstehen ein reproduzierbarer Takt und ganzzahlige
Abschnittsfahr- und Haltezeiten. Seed und versionierte Erzeugungsregel sind im
Snapshot gebunden. Fahrzeugbedarf, Mindestwendezeit, Energie und Leistungsmenge
werden für den gekürzten Spielbetrieb berechnet. Die bestehende Trassen- und
Konfliktprüfung bleibt maßgeblich für die betriebliche Freigabe.

Neue Angebote enthalten keine `ExternalLeg`, keine Außenbindung von Fahrzeugen
oder Personal und keine Ein-/Ausfahrfenster am Kartenrand. Historische Typen und
Leser können alte Nachweise und Replays weiter lesen; sie legitimieren keinen
neuen Außenbetrieb. Bestehende signierte Releases werden nicht heimlich umgedeutet:
Die neue Planung benötigt einen neu gebauten, geprüften und signierten Artefaktsatz.

## Ausschreibungen beim Start

Öffentliche Weltstarts binden den vollständigen Spiel-Angebotsplan an die
Wirtschaft. Aus dem Vergabekalender entstehen vollständige Ausschreibungen. Die
erste Gruppe öffnet bei Weltzeit null, weitere Gruppen bleiben gestaffelt.
Der Eigenbetrieb bedient die Lose bis zum regulären Zuschlag und Betriebsübergang;
eine EVU-Gründung erhält weiterhin keinen Vertrag automatisch (E28).

Start und Scheduler verwenden dieselbe deterministische, idempotente Erzeugung.
Neustarts dürfen keine Duplikate erzeugen. Ein verpasstes Zeitfenster wird aus den
festgelegten Weltzeitpunkten nachgeholt. Auch kleine Karten mit nur einem Los sind
zulässig. Fehlende Angebotsgrundlagen sind ein Startfehler; ein Fehler beim Laden
des Marktes wird in der Oberfläche nicht als leerer Markt ausgegeben.

## Konsequenzen und Nachweise

Der reale Außenfahrplan bestimmt weder Ressourcenbindung noch Zielanzeige oder
Bestellentgelt. Die neue Spielrealität ist überprüfbar und vollständig auf der
Spielkarte. Herkunftsnachweise bleiben erhalten, ohne reale Fahrten nachzuspielen.

Verhaltenstests prüfen Außen–Innen–Außen, Wiedereintritt, reine Außenfahrten,
Innenhalte mit außen verlaufendem Gleis, Takt und Determinismus, Mengenberechnung,
Weltbindung sowie Start, Wiederholung und Nachholen der Ausschreibungserzeugung.
