# Trassenfinder-Routenimport — Fahrwegwunsch v1

Stand: 07.09.2026. Der ausdrückliche Nutzerauftrag erweitert
[E10](adr/0010-trassenfinder-nur-kalibrierwerkzeug.md) um einen optionalen,
nutzergeführten Routenentwurf außerhalb des Spiels. Die Trassenvergabe und
sämtliche Betriebsberechnungen bleiben in Zugfolge.

## Ablauf

1. Der Spieler öffnet über die Planungsoberfläche den
   [Trassenfinder](https://trassenfinder.de/) und plant dort selbst eine Route.
2. Im Ergebnis wählt er unter „Exporte zur gefundenen Route“ den
   **„CSV-Export des Laufwegs“**. Andere Exportarten, insbesondere der Export
   für DB-Transport, gehören nicht zu diesem Vertrag.
3. In Zugfolge wählt er die heruntergeladene CSV-Datei lokal aus. Der Browser
   liest deren Betriebsstellenfolge und ordnet sie dem aktuellen Stationskatalog
   der gewählten Spielwelt zu. Die Datei wird nicht an den Server übertragen.
4. Die vollständig erkannte Reihenfolge füllt Start, Durchfahrtpunkte und Ziel
   des Fahrwegentwurfs. Der Spieler prüft den Entwurf und legt gewünschte Halte,
   Zeitlage und Zugverband in Zugfolge fest.
5. Erst die normale Planungsprüfung und Einreichung verarbeiten den Entwurf.
   Die Übernahme einer Datei erzeugt keinen Trassenantrag und keine Zuteilung.

Der externe Link ist optional. Es gibt keinen API-Schlüssel, Hintergrundabruf,
automatisierten Browserlauf oder Dienstaufruf aus der Simulation. Über diese
Funktion wird keine reale Trasse bei der DB bestellt.

## Belegtes Eingabeformat

Die öffentliche [Trassenfinder-Beispielroute](https://trassenfinder.de/route/e7f792a1d49bae2)
wurde am 07.09.2026 in der Browseroberfläche geprüft. Der angebotene
„CSV-Export des Laufwegs“ verwendet Semikolon als Trennzeichen, doppelte
Anführungszeichen zur Feldbegrenzung und im geprüften Export Windows-1252 als
Zeichencodierung. Importtests verwenden selbst erzeugte synthetische Daten;
die fremde Rohdatei wird nicht im Repository abgelegt.

| Spalte | Bedeutung für Zugfolge |
| --- | --- |
| `Betriebsstelle (kurz)` | Geordnete Betriebsstellenkürzel; Grundlage der Zuordnung zu nativen Stationskennungen |
| `Betriebsstelle` | Lesbarer Ortsname als Eingabekontext; keine ungeprüfte Ersetzung einer nicht passenden Kennung |
| `Lfd. km` | Wird nicht als spielinterne Entfernung übernommen |
| `Bundesland`, `Nachfolgende Streckennr.` | Werden nicht als Infrastruktur oder exakte Kantenbindung übernommen |
| `Ankunftszeit`, `Abfahrtszeit`, `Haltart`, `Haltedauer (in min)` | Werden nicht als Fahrplan oder Haltanforderung übernommen |
| Weitere Kosten- und Energiefelder | Werden nicht als Spielwerte übernommen |

Der Parser verarbeitet CSV-Feldbegrenzungen einschließlich maskierter
Anführungszeichen. Die geordnete Zeilenfolge bleibt erhalten; Kilometerstände
oder Namen bestimmen keine neue Sortierung. Ein unpassendes Schema, leere
Kennungen oder fehlerhaft begrenzte Felder führen zu einer verständlichen
Fehlermeldung. Ein anderer Export wird nicht durch Erraten von Spalten als
Laufweg ausgegeben.

## Zuordnung zum gepinnten Spielnetz

Der Server stellt einen welt- und releasegebundenen Katalog nativer Stationen
mit ihren verfügbaren Betriebsstellenkürzeln bereit. Jede Betriebsstelle der
CSV muss vollständig und eindeutig zu genau einer Station dieses Katalogs
passen. Namensähnlichkeit, geografische Nähe und externe IDs ersetzen diesen
Beleg nicht.

Unbekannte oder mehrdeutige Kürzel sowie nicht im freigegebenen Spielnetz
enthaltene Punkte verhindern die gesamte Übernahme. Die Oberfläche benennt
die betroffenen Punkte. Sie lässt sie nicht aus, verkürzt keine Route und
bestellt keinen automatisch vereinfachten Ersatzlaufweg. Die übrigen
Formularwerte bleiben sichtbar. Ein neuer Dateiversuch verwirft jedoch einen
zuvor übernommenen Importfahrweg. Bei einem Importfehler bleibt die Einreichung
gesperrt, bis der Spieler einen gültigen Fahrweg übernimmt oder den Import
ausdrücklich zurücksetzt. Der Fehler löst keine automatische Ersatzroute aus.

Der erste Punkt ist der Start, der letzte das Ziel. Die übrigen Punkte werden
als `viaStationIds` in gleicher Reihenfolge übergeben. Ein Laufweg enthält
höchstens 512 Punkte, davon höchstens 510 Durchfahrtpunkte. Punkte müssen
eindeutig sein; eine erneute Durchfahrt durch denselben Punkt, Schleifen und
Start/Ziel als Zwischenpunkt sind in v1 nicht darstellbar und werden abgelehnt.

Die Datei beschreibt einen Wunsch nach einer Stationsfolge. Die ignorierte
Spalte `Nachfolgende Streckennr.` ist keine Auswahl einer konkreten Kante;
mehrere Verbindungen zwischen denselben Punkten können im eigenen Netz weiter
unterschiedliche Spielrouten bilden. Die tatsächliche Kantenfolge wird aus dem
freigegebenen Weltrelease bestimmt und erneut geprüft. Der Import behauptet
keine identische DB-Trasse, keine bundesweit vollständige Abdeckung und keine
Befahrbarkeit einer Strecke allein aufgrund der externen Routensuche.

## Durchfahrtpunkte und Halte

`viaStationIds` sind geordnete, optionale Durchfahrtvorgaben. Sie erzeugen
keinen Aufenthalt, keinen Bahnsteigbedarf, keinen Fahrgasthalt und keinen
zusätzlichen betrieblichen Halt. Gewünschte Halte bleiben als eigener
Halteplan erhalten. Ist an einem Durchfahrtpunkt ausdrücklich ein Halt
eingetragen, gilt dessen vorhandene Haltesemantik weiterhin.

Bei allgemeinen Fahrtanträgen ergänzt `viaStationIds` Start und Ziel. In der
SPFV-Planung stehen Fahrweg und geordnete Fahrgasthalte getrennt. Eine aus der
CSV übernommene „Haltart“ oder „Haltedauer“ kann diese Spielereingaben nicht
verändern. Bestehende Entwürfe ohne Via-Punkte behalten ihre bisherige
Serialisierung und Planung; eine leere Via-Liste bedeutet dieselbe fehlende
Zusatzvorgabe.

Alle Punkte müssen im eigenen Netz in der gewünschten Reihenfolge befahrbar
sein. Eine unmögliche Reihenfolge wird abgelehnt. Die native Trassenautorität
prüft unverändert Fahrzeugkompatibilität, Fahrdynamik, Verfügbarkeit,
Sperrzeiten und Konflikte. Die importierte Folge ersetzt keinen dieser
Nachweise und kann keinen Konflikt überstimmen.

## Zeitliche Anpassung und nachvollziehbare Ergebnisse

Der Fahrwegwunsch legt die Reihenfolge fest. Innerhalb der vom Spieler
gewählten Spielräume sucht die native Trassenplanung eine betriebsfähige
Zeitlage. Sie darf zusätzliche Betriebshalte vorschlagen, vorhandene
Aufenthalte verlängern und die Abfahrt verschieben. Diese Änderungen stammen
aus dem eigenen Fahrprofil und der Konfliktprüfung. Eine Lösung ist nicht
garantiert; außerhalb der zulässigen Spielräume bleibt der Antrag abgelehnt.

SPFV-Entwürfe erhalten zwei optionale Ganzzahlfelder:

| Feld | Bereich | Wirkung |
| --- | --- | --- |
| `departureFlexibilityS` | 0–7.200 Sekunden | Höchstens erlaubte spätere Abfahrt; frühere Abfahrten sind nicht vorgesehen |
| `extraRunningTimeS` | 0–3.600 Sekunden | Höchstens zusätzliche Gesamtfahrtdauer einschließlich betrieblicher Aufenthalte |

Neue Linienentwürfe schlagen in der Oberfläche 30 Minuten Abfahrtsspielraum
und 15 Minuten zusätzliche Fahrzeit vor; der Spieler kann beide Werte ändern.
Bei historischen Entwürfen ohne die Felder gilt jeweils 0. Die effektive
späteste Abfahrt liegt außerdem spätestens eine Sekunde vor der nächsten
gewünschten Taktabfahrt und vor dem Ende des Gültigkeitsfensters. Diese
Begrenzung wird in der Oberfläche erklärt. Bei zusätzlichem Fahrzeitspielraum
darf die Suche bis zu vier zusätzliche Betriebshalte berücksichtigen.

Der Bildfahrplan zeigt ausschließlich autoritative Vergleiche: gewünschte und
vorgeschlagene beziehungsweise zugeteilte Abfahrt, zusätzliche Betriebshalte,
verlängerte Aufenthalte und die Verlängerung der gesamten Fahrtdauer. Die
Gesamtfahrtdauer umfasst die gesondert erklärten Aufenthalte; die
Einzelpositionen werden nicht erneut zur Gesamtänderung addiert. Die
gewünschte Abfahrt stammt aus dem Spielantrag. Die Ausgangsfahrtdauer ist das
native Vergleichsprofil, keine aus der CSV übernommene Fahrzeit.

Ein räumlicher Umweg bei gleicher Zeitlage bleibt als eigener `routeChange`
mit zusätzlicher Entfernung in Millimetern und nativer Begründung erkennbar.
Er wird als Fahrweganpassung markiert, ohne eine Zeitdifferenz zu erfinden;
die gewünschte Reihenfolge der Durchfahrtpunkte bleibt bindend.

Anpassungen erscheinen in Bernstein mit Klartext, Vorher-/Nachherwerten,
Zeitdifferenz und serverseitiger Begründung; die betroffene zugeteilte Zuglinie
erhält zusätzlich ein Dreieck. Eine Ablehnung erscheint rot mit Ausrufezeichen
und „nicht zugeteilt“. Farbe ist nie der einzige Informationsträger.

Der optionale Projektionsblock `planning` unterscheidet `requested`,
`proposed`, `allocated` und `rejected`. Ein noch nicht übernommener Vorschlag
steht an der Konfliktalternative und bleibt als solcher gekennzeichnet. Erst
nach Gewährung oder ausdrücklicher Übernahme steht die Anpassung als
`allocated` an der Zugtrasse. Alte Projektionen ohne belegten Vergleich
erhalten keine nachträglich erfundene Wunschzeit und keine Behauptung einer
unveränderten Planung. Der bestehende Freigabeweg bleibt erhalten; eine
Vorschau oder ein CSV-Import nimmt eine Alternative nicht automatisch an.

## Daten- und Rechtegrenze

Die Datei dient der unmittelbaren Übernahme eines einzelnen, vom Nutzer
gewählten Fahrwegwunschs. Sie wird nur lokal im Browser gelesen und weder
hochgeladen noch als Rohdatei, Anhang, Screenshot, Referenzkorpus oder
Infrastrukturdatenbestand gespeichert. Der reguläre Spielantrag speichert nur
seine nativen Stationskennungen und die ausdrücklich gewählten Planungsdaten.

Die Erweiterung dokumentiert den Nutzerauftrag und die Projektgrenze. Sie
behauptet keine neue Betreiberlizenz für fremde Datenbestände. Der
Trassenfinder bleibt im Quellenregister als Entwicklungsquelle eingeordnet;
Infrastrukturimport, automatischer Abruf, systematische Sammlung und
Weiterveröffentlichung bleiben außerhalb dieser Funktion. Einzelheiten und
die unveränderte Grenze der Infrastruktur-API stehen im
[Rechte-Gate](rechte.md#4-trassenfinder-nutzungsbedingungen-e10).

## Verhaltenstests

Gezielte Tests prüfen das synthetisch nachgebildete CSV-Format, Zeichencodierung
und Feldbegrenzung, vollständige Zuordnung, unbekannte und mehrdeutige Kürzel,
Schleifen und Eingabegrenzen. Die Fahrtplanung weist nach, dass Via-Punkte die
Route in Reihenfolge binden und keinen Aufenthalt erzeugen, unmögliche
Reihenfolgen scheitern und vorhandene Anträge ohne Via-Punkte unverändert
bleiben. Fehler dürfen weder einen Teilentwurf übernehmen noch einen
Trassenantrag absenden.
