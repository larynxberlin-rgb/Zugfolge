# Design: Deine Bahn. Deine Welt.

Stand: 5. September 2026. Die Produktvorgabe für den vollständigen UI-Neuaufbau
ersetzt die bisherigen Einschränkungen von E17 / ADR-0017. Maßgeblich sind
[ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md) und die
[bebilderte Umsetzung](ui-redesign/README.md).

Das [Gleiszeichen und die Symbolübersicht](brand/README.md) dokumentieren
die verwendeten Vektoren. Die [Issue-Zuordnung](ui-redesign/issue-abgleich.md)
verbindet diese Gestaltung mit den noch offenen Spielerabnahmen.

## Spielwelt und Orientierung

Zugfolge ist eine deutschlandweite Eisenbahn-Unternehmenssimulation. Die
LiveMap bildet das räumliche Zentrum. Sie startet mit ganz Deutschland im
Blick; ein einzelner Planungsabschnitt begrenzt nicht die Spielwelt.

Die fünf Hauptziele heißen **LiveMap, Fahrplan, Betrieb, Markt, Unternehmen**.
Postfach und Kontostand bleiben im Kopf erreichbar. Das eigene rote
Gleiszeichen führt überall zurück zur LiveMap. Auf dem Handy wandert die
Navigation an den unteren Bildschirmrand; Beschriftungen bleiben sichtbar.

## Bahnflair

Graphitfarbene Flächen, rote Akzente, eine klare Wegeleitung, Fahrgastanzeigen
und präzise Zugdaten vermitteln die Atmosphäre der deutschen Bahn. Zugfolge
hat ein eigenes Zeichen und eigene Unternehmensnamen. Das DB-Flair entsteht
durch diese Gestaltung; DB-Logo oder fremde Produktgrafiken werden nicht benötigt.

Die Eröffnungsansicht verwendet eine eigens generierte Zugaufnahme. Betriebliche
Ansichten erhalten ihre Bildwirkung durch die Karte, Zugpositionen und Fahrpläne.

## Gemeinsame Gestaltung

`packages/design-system/src/railway.css` und `railway.ts` definieren die
gemeinsame Identität. Die drei Anwendungen bauen darauf auf.

| Zweck | Farbe |
| --- | --- |
| Hintergrund | `#101419` |
| Fläche | `#181e25` |
| erhöhte Fläche | `#202830` |
| Trennlinie | `#303b46` |
| Text | `#f5f7fa` |
| sekundärer Text | `#b5c0cc` |
| weitere Beschriftungen | `#93a2b1` |
| Marke und Hauptaktion | `#e5233d` |
| normale Live-Position | `#7cddba` |
| Aufmerksamkeit | `#f5bf65` |
| Ausfall / starke Abweichung | `#ff7d87` |

Rot darf die Marke und Hauptaktionen kennzeichnen. Betriebszustände erhalten
zusätzlich Klartext, Minutenwerte oder Muster. Farbe allein erklärt keinen
Zustand. Fehlende Verspätungsdaten werden nicht als Pünktlichkeit dargestellt.
Eine veraltete Verbindung wird als letzter bekannter Stand gekennzeichnet.

Systemnahe serifenlose Schrift (`Inter`, `Segoe UI`, Systemschrift), gut
unterscheidbare Zahlen und wenige Schriftgrößen schaffen eine ruhige Hierarchie.
Flächen haben zurückhaltende Rundungen. Diagramme behalten die fachlich
verständliche Weg-Zeit-Darstellung.

## Wenig Scrollen, klare Aufgaben

Der äußere Rahmen passt in den Bildschirm. Lange Listen, Tabellen und
Detailansichten scrollen innerhalb ihres Arbeitsbereichs. Auf kleinen Geräten
werden Inhalte nacheinander angezeigt, ohne die Navigation aus dem Blick zu verlieren.

- LiveMap: große Karte, eigener Zugfilter, Suche, vier priorisierte Fahrten,
  Postfachhinweise und eine aufklappbare Zugübersicht.
- Markt: Register für Aufträge, Fahrzeuge und Zusammenarbeit. Erstellformulare
  und ausführliche Vergleiche öffnen sich bei Bedarf.
- Unternehmen: Geld und Bestand, mit Registern für Finanzen und Flotte.
- Betrieb: Betriebslage, Automatik und Tagesberichte als getrennte Aufgaben.
- Fahrplan: Diagramm und Detailansicht; auf schmalen Displays untereinander.
- Einstieg: Spielername und Spielregeln, anschließend Unternehmen gründen.

Ein Registerwechsel erhält Formularfelder. Datenaktualisierungen erhalten
Eingaben, geöffnete Angebotsformulare, Fokus und Scrollposition. Fragmentlinks
öffnen das passende Register auch bei Navigation innerhalb derselben Seite.

## Sprache

Die Oberfläche spricht den Spieler mit **du** an. Sie beschreibt seine nächste
Entscheidung. Technische Verträge behalten ihre Namen im Code; die Oberfläche
zeigt verständliche Handlungen.

| Bisher | Spieleroberfläche |
| --- | --- |
| Weltvertrag | Dein Einstieg / Spielregeln & Laufzeit |
| EVU gründen | Unternehmen gründen |
| Formation auswählen | Zugverband auswählen |
| Öffentlicher Anschubvertrag / Wet-Lease | Startpaket aus Zug, Personal und Trasse |
| Fachrevision und Hash im Überblick | Technische Details zum Aufklappen |
| Bestätigen einer Postfachnachricht | Als gelesen markieren |
| Betriebsprogramm | Automatik / Deine Regeln |
| Kosten in Cent | Eurobetrag |

Bestätigungen nennen Betrag, Frist und Folgen. Eine gelesene Nachricht löst
keinen Kauf oder Vertrag aus. Nicht verfügbare Daten erscheinen als fehlend,
nicht als Null oder erfundene Kennzahl.

## Zugänglichkeit

Semantische Navigation, sichtbarer Tastaturfokus und eine Zugliste ergänzen
die Karte. Register unterstützen Pfeiltasten sowie Home und End. Details
lassen sich mit Escape schließen; der Fokus kehrt zum Ausgangspunkt zurück.
`prefers-reduced-motion` reduziert Bewegungen. Spielhinweise aus PR #530
bleiben abschaltbare Erklärungen an den tatsächlichen Bedienelementen.

Kontrastziele: 4,5:1 für normalen Text und 3:1 für grafische Bedienelemente.
Browserprüfungen decken Desktop, Notebook, Tablet und 320/390 Pixel breite
Mobilansichten ab. Sie ersetzen keinen vollständigen manuellen WCAG-Audit.
