# Spielhinweise im laufenden Spiel

Die Einführung besteht ausschließlich aus Tooltipps an vorhandenen Bedienelementen.
Alle Texte, Anker und die Darstellung sind neu erstellt. Karte, Unternehmensansicht,
Märkte, Fahrplan und Betriebszentrale verwenden denselben kleinen UI-Controller.

## Verhalten

- Ein Fragezeichen neben einem erklärten Element öffnet dessen Hinweis per Maus,
  Tastaturfokus oder Berührung. Escape, ein Klick außerhalb oder das Entfernen
  des zugehörigen Elements schließt ihn. Die übrige Oberfläche bleibt bedienbar.
- Pro Seitenaufruf darf höchstens ein bisher ungelesener sichtbarer Hinweis
  automatisch erscheinen. Es gibt keine Kapitel, Pflichtreihenfolge oder Abschlussprüfung.
- „Spielhinweise“ schaltet die Fragezeichen und automatischen Hinweise gemeinsam
  aus oder wieder ein. Bereits gelesene Hinweise bleiben manuell aufrufbar.
- Die Einstellung und gelesene Hinweis-IDs liegen ausschließlich im Browserspeicher
  unter `zugfolge:game-hints:v1`. Gesperrter oder beschädigter Speicher verhindert
  weder Hinweise noch das Spiel. Es gibt keine Telemetrie oder Odoo-Projektion dafür.
- Ein Hinweis erklärt Funktion und Konsequenz einer echten Entscheidung. Er führt
  keine Aktion aus, vergibt kein Geld und erstellt keine Spielobjekte.

## Darstellung und Zugänglichkeit

Tooltipps verwenden die Farben und Typografie des Designsystems. Fragezeichen
besitzen beschreibende zugängliche Namen; der geöffnete Text ist mit
`aria-describedby` verbunden. Der Fokus wird nicht verschoben. Die Position
bleibt innerhalb des sichtbaren Fensters und folgt Größenänderungen und Scrollen.
Es gibt keine Avatare, Dialogfenster, Szenarien oder künstliche Wartezeiten.

## Technische Grenze

`packages/design-system/src/game-hints.ts` verwaltet allein DOM und lokale
Einstellungen. Die drei Oberflächen besitzen eigene, deklarative Hinweiskataloge.
Neue Hinweise brauchen stabile IDs, einen vorhandenen Anker und einen fachlich
zutreffenden Text. Ein erneutes Rendern darf keine doppelten Fragezeichen erzeugen.
Keine API, Datenbanktabelle oder Simulationskomponente ist an den Hinweisen beteiligt.

## Abnahme

Verhaltenstests prüfen Tastatur und Berührung, Abschalten und Wiederaufnahme,
Neurendern, kleine Viewports sowie ausbleibende Netzwerk- und Spielaktionen.
Die Verständlichkeit für neue Spieler wird in der geschlossenen Alpha geprüft.
Ein automatisierter Browserlauf ersetzt diese Nutzerbeobachtung nicht.
