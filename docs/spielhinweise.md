# Spielhinweise im laufenden Spiel

Die Einführung besteht ausschließlich aus Tooltipps an vorhandenen Bedienelementen.
LiveMap, Unternehmen, Markt, Fahrplan und Betrieb verwenden denselben kleinen
UI-Controller. Die Hinweise aus PR #530 sind an die neue
[Spieleroberfläche](ux-spieler-shell.md) und ihre tatsächlichen Bedienelemente
angepasst; ihre Darstellung folgt [Design](design.md) und
[ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md).

## Verhalten

- Ein Fragezeichen neben einem erklärten Element öffnet dessen Hinweis per Maus,
  Tastaturfokus oder Berührung. Escape, ein Klick außerhalb oder das Entfernen
  des zugehörigen Elements schließt ihn. Die übrige Oberfläche bleibt bedienbar.
- Hinweise erscheinen nur an sichtbaren Bedienelementen. Ein geschlossenes
  Register oder ein zugeklapptes Formular erzeugt keine frei schwebenden
  Fragezeichen; beim Öffnen werden die zugehörigen Anker neu berücksichtigt.
- Pro Seitenaufruf darf höchstens ein bisher ungelesener sichtbarer Hinweis
  automatisch erscheinen. Es gibt keine Kapitel, Pflichtreihenfolge oder Abschlussprüfung.
- „Spielhinweise“ schaltet die Fragezeichen und automatischen Hinweise gemeinsam
  aus oder wieder ein. Bereits gelesene Hinweise bleiben manuell aufrufbar.
- Die Einstellung und gelesene Hinweis-IDs liegen ausschließlich im Browserspeicher
  unter `zugfolge:game-hints:v1`. Gesperrter oder beschädigter Speicher verhindert
  weder Hinweise noch das Spiel. Es gibt keine Telemetrie oder Odoo-Projektion dafür.
- Ein Hinweis erklärt Funktion und Konsequenz einer echten Entscheidung. Er führt
  keine Aktion aus, vergibt kein Geld und erstellt keine Spielobjekte.

## Spielertexte und Orientierung

Hinweise sprechen den Spieler mit **du** an. Sie erklären eine Handlung und
deren Folgen: „Unternehmen gründen“, „Fahrt planen“, „Angebot abgeben“ oder
„Regeln aktivieren“. Die erste Erklärung setzt keine Kenntnis von „Weltvertrag“,
„EVU“ oder technischen Revisionskennungen voraus. Solche Fachdetails bleiben
dort zugänglich, wo sie zum Prüfen einer Entscheidung gebraucht werden.

Die LiveMap beginnt mit Deutschland im Blick. Hinweise zu Suche, eigenen Zügen
und Zugdetails erläutern die angezeigten Daten; sie versprechen keine Fahrten,
Netzfreigaben oder Kennzahlen außerhalb des empfangenen Weltzustands. In Markt,
Unternehmen und Betrieb beziehen sie sich auf das jeweils sichtbare Register.

## Darstellung und Zugänglichkeit

Tooltipps verwenden die Farben und Typografie des Designsystems. Fragezeichen
besitzen beschreibende zugängliche Namen; der geöffnete Text ist mit
`aria-describedby` verbunden. Der Fokus wird nicht verschoben. Die Position
bleibt innerhalb des sichtbaren Fensters und folgt Größenänderungen und Scrollen.
Es gibt keine Avatare, Dialogfenster, Szenarien oder künstliche Wartezeiten.
Der dunkle gemeinsame Rahmen, die sichtbare Hauptnavigation und die kompakten
Arbeitsbereiche bleiben auch bei eingeblendeten Hinweisen bedienbar.

## Technische Grenze

`packages/design-system/src/game-hints.ts` verwaltet allein DOM und lokale
Einstellungen. Die drei Oberflächen besitzen eigene, deklarative Hinweiskataloge.
Neue Hinweise brauchen stabile IDs, einen vorhandenen Anker und einen fachlich
zutreffenden Text. Ein erneutes Rendern darf keine doppelten Fragezeichen erzeugen.
Keine API, Datenbanktabelle oder Simulationskomponente ist an den Hinweisen beteiligt.

## Abnahme

**M9.1 ist abgeschlossen.** Der Projektverantwortliche hat das neue Tutorial
am 2026-09-05 ausdrücklich fachlich abgenommen und den vollständigen Abschluss
freigegeben. Diese Produktabnahme bildet zusammen mit den ausgeführten
Verhaltenstests den Abschlussnachweis.

Abgenommen sind 20 vollständig neue Tooltipps in Unternehmensansicht (10),
Livemap (4) und Betriebszentrale (6), ihre Bedienung per Maus, Tastatur und Touch
sowie Abschalten und Wiederaufnahme über lokale Browserpräferenzen. Die
Hinweise lösen keine Netzwerk- oder Spielaktionen aus. Die Umsetzung entfernt
das alte Tutorial samt Laufzeit, Inhalten und Welten; Datenbank- und
Odoo-Migrationen bereinigen dessen Bestände. Jeder Game-Server betreibt genau
seine konfigurierte Welt und Subdomain. Odoo verwaltet weiterhin die getrennten
Weltserver.

Die Umsetzung und ihre Nachweise sind in
[PR #530](https://github.com/larynxberlin-rgb/Zugfolge/pull/530) verknüpft.
Für den Implementierungsstand
`db0a0ce13587f2b061a801de5c72c7688b8bc270` sind beide CI-Läufe vollständig
erfolgreich:

- [Reguläre CI](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/33984164374):
  Build, Typprüfung, Pakettests, Rust und Determinismus, echte NAPI-,
  PostgreSQL- und Browserintegration sowie Repository-Wächter. Die Browserfälle
  prüfen Tastatur und Berührung, Abschalten und Wiederaufnahme, Neurendern,
  kleine Viewports sowie ausbleibende Netzwerk- und Spielaktionen.
- [Erweiterte Prüfungen](https://github.com/larynxberlin-rgb/Zugfolge/actions/runs/33984162571):
  Odoo 19 einschließlich Bereinigung, Werkzeuge und Datenimporte,
  Produktionsimage, PostgreSQL-/Keycloak-/Wiederherstellungsdrills,
  Lastziel und 48-Stunden-Offlineszenario.

Der Abschluss wird in
[#159](https://github.com/larynxberlin-rgb/Zugfolge/issues/159) geführt.
Die spätere Nutzerbeobachtung gehört zur geschlossenen Alpha M9.9. Ein Lauf
mit externen Spielern wird durch diese Produktabnahme nicht behauptet.

Die [UI-Vorschau](ui-redesign/README.md) ergänzt diesen Nachweis für die neue
Navigation, Registerwechsel und sichtbare Hinweise bei 320 Pixeln Breite.
Sie zeigt gekennzeichnete Beispieldaten und ersetzt keine externe Alpha-Abnahme.
