# Kontrollübungen der lokalen Demo

Diese ausdrücklich fiktive Übungsfahrt verwendet die unveränderten ursprünglichen
M10-, Dialog-, Sitzungs-, Innenraum- und Kontrollkerne im eingebetteten WASM.
Sie ist kein zusätzlicher Produktivnachweis für die offene Deutschlandabdeckung
oder die Gesamtlast. Die fachlichen Regeln stehen im Repository unter
`docs/schaffnermodus.md`, `docs/conductor-dialogue.md` und
`docs/fare-inspection-cases.md`.

## Befund und Änderung

Der vorherige Demostand hatte 220 tatsächliche Fahrgäste und eine globale
95-Prozent-Vorgabe für gültige Fahrscheine. Die wenigen Forderungsfälle waren
ohne Kenntnis privater Daten schwer auffindbar. Die sichtbare Bedienbarkeit
dieser Fälle war durch den nativen Kontrollsmoke nicht bewiesen.

`prepare-practice.mjs` erzeugt jetzt 40 tatsächlich eingestiegene M10-Fahrgäste.
Die M5-Konfiguration bleibt bei 200 Sitzen und 20 Stehplätzen: Türlagen, Sitze,
Innenraum, Oberdeck, echte Treppen, Fahrzeug-, Welt- und Artbindungen werden
nicht verändert. Weniger Nachfrage ist keine Änderung der Fahrzeugkapazität.
Die globale fiktive Quellpopulation beträgt 48 am ersten und 8 an den beiden
anderen Orten. Der originale M10-Generator erhält den globalen Seed `0` und
die offengelegte Lernverteilung 35 Prozent gültig, 30 Prozent gültig, momentan
nicht vorzeigbar, 35 Prozent ungültig. Kein einzelner Fahrgast, Fahrschein oder
Platz wird nachträglich ersetzt.

Das globale native Prüfmodell lässt ungültige Dokumente vorzeigen; die
synthetische Identitätsverweigerung bleibt mit 15 Prozent unabhängig davon.
Für die beiden ausgewählten Forderungsübungen wurde die tatsächlich vom Kern
bestätigte Identität geprüft. Alle tatsächlich vorkommenden Teilreisen erhalten
explizite fiktive Tarifbelege über 12,50 Euro und einen verfügbaren Schalter.
Das schließt insbesondere die neue Durchreise Leipzig–Erfurt ein, deren
fehlender Beleg zunächst korrekt jede Forderung verhinderte. Diese Beträge
sind Übungsdaten und keine Aussage über wirkliche Fahrpreise.

Die drei neutral beschrifteten Übungsfahrgäste stehen auf dem Oberdeck des
ersten Wagenkastens. Der echte native Weg ab Einstieg beträgt 9,50 beziehungsweise
10,75 Meter einschließlich Treppenweg. Ihre Positionen stammen aus der normalen
M15-Projektion. Die öffentlichen Übungsdaten enthalten nur Kennung, sichtbare
Position und „Übung 1/2/3“; Ticketwahrheit, Prüfstatus und erwartete Forderung
stehen ausschließlich in der ungebündelten Datei `data/practice-qa.json`.
Weder Kleidung noch Dialogtext dienen als Beweis einer ungültigen Fahrkarte.

## Verbindliche Bedienabnahme

Die folgenden Schritte müssen an der tatsächlichen ausgelieferten HTML-Datei
über ihre sichtbaren Bedienelemente erfolgen. Direkte WASM-Aufrufe, heimliche
Positionsänderungen oder nachträglich eingefügte Forderungen ersetzen sie nicht.

1. Neu starten, Übung 1 auswählen und den sichtbaren Geh-/Kontrollschritt auslösen.
   Die Figur muss den echten Weg einschließlich Treppe zurücklegen. Nach
   „Fahrkarte prüfen“ wird ein gültiges Dokument bestätigt. Eine reguläre oder
   vorläufige Forderung darf nicht angeboten werden; Abschluss ohne Forderung.
2. Übung 2 auswählen, tatsächlich hingehen und prüfen. Erst die bestätigte
   Dokumentprüfung und Identität erlauben die angebotene reguläre Forderung.
   Der Bericht zeigt 60 Euro und später den wirklichen Zahlungseingang.
3. Übung 3 auswählen, hingehen und prüfen. Das Dokument ist nicht vorzeigbar;
   nach bestätigter Identität erscheint die vorläufige Forderungsoption. Nach
   Auswahl zeigt der Bericht zunächst 60 Euro und die Nachweisfrist. Der native
   spätere Nachweiseingang reduziert den Betrag auf 7 Euro; die Zahlung wird
   entsprechend korrigiert.
4. Den Stand über einen echten Datei-Reload fortsetzen. Bereits erfolgte
   Kontrollen, Forderungen, Zahlungs-/Nachweisstand und Spielerposition müssen
   erhalten bleiben. Neustart muss dagegen einen neuen unkontrollierten Stand
   erzeugen.

Vor der Dokumentprüfung stehen keine versteckten Fahrscheinmerkmale im HUD,
in Übungsbezeichnungen oder in der öffentlich zugänglichen Diagnose. Die
Sprechblase muss dem tatsächlich aktiven Fahrgast zugeordnet bleiben. Ein
gültiges Dokument rechtfertigt weder Forderung noch Polizei; die neutralen
Übungsnummern sind keine Kontrollbelege.

## Reproduktion und vorhandene Komponentenbelege

Aus dem Demoverzeichnis mit der bereits gebundenen Originalfixture:

```powershell
node prepare-practice.mjs 0
node practice-control-smoke.mjs
```

`prepare-practice.mjs` ändert ausschließlich globale Übungsquellen vor dem
ersten Checkpoint. Die unveränderten M5-, Infrastruktur-, Betriebswelt-,
Zuglauf-, Dialog- und Wirtschaftsobjekte werden gegen ihre vorherigen Hashes
geprüft. Nativ gehashte neue Nachfrage und Teilreisebelege erhalten einen neuen
Fixturehash; alte lokale Spielstände werden nicht in eine andere Fixture
umgedeutet.

`outputs/conductor-offline/practice-control-report.json` ist ausdrücklich ein Komponentenbeleg:
alle drei tatsächlichen Kontrollsequenzen, 20 bestätigte Gehkommandos,
ein wirklicher Treppenübergang und identisches natives Restore. Der Bericht
bestätigt 0 Euro, reguläre 60 Euro mit Zahlung und vorläufige 60 Euro mit
späterer Reduzierung und Zahlungskorrektur auf 7 Euro. Er behauptet keine
Browserabnahme, keinen gemessenen UI-Durchsatz und keine Polizeireaktion.
Die sichtbare HTML-Abnahme wird separat von der finalen Build- und
Browserprüfung belegt.

Nach dem gemeinsamen HTML-Build führt `node practice-browser-smoke.mjs` diese
Bedienabnahme im konfigurierten Chromium-/Edge-Browser mit gesperrtem Netzwerk aus. Das Skript steuert ausschließlich
sichtbare Auswahllisten und Buttons; die Diagnosefunktion wird nur gelesen.
Der Nachweis landet unter `outputs/conductor-offline/practice/practice-browser-report.json`
mit dem Hash der tatsächlich geöffneten HTML-Datei. Ein positiver Komponentenlauf
setzt dieses Browserergebnis nicht auf bestanden.

Vor der Repositoryübernahme bestand die vollständige sichtbare Prüfung für die lokale HTML-Datei mit SHA-256
`a9e48b53edf3e05eecdfa8252377e3d73199e10b54337275810393c4f7dfe2fc`
bestanden: 17 Prüfungen, sechs tatsächlich aufgenommene und gesichtete Bilder,
keine Seitenfehler und keine Netzwerkrequests. Die Ergebniskarten zeigen im Spiel
60 Euro Forderung vor Zahlung, 60 Euro nach Zahlung sowie später 7 Euro Forderung
und Zahlung. „Weitergehen“, der Originalbericht, Fortsetzen eines aktiven
Gesprächs nach Reload und eine neue aktive Sitzung ohne alte Fälle sind enthalten.
Dieser historische Hash ist keine Abnahme eines späteren Repositorybuilds.
Der portable Prüflauf erzeugt für seine neue HTML-Datei eigene Berichte und
Bildhashes; frühere lokale Berichte werden nicht übernommen. Die separate Prüfung von Animation,
Außenwelt und mobilen Geräten gehört nicht zu diesen 17 Kontrollprüfungen.

Der gemeinsame Aufruf `node tools/conductor-offline/check.mjs` aus der
Repositorywurzel führt alle Komponenten- und Browserprüfungen nacheinander
aus und bindet sie im Abschlussbericht an exakt denselben Build. Dieser
Übungsnachweis ersetzt keine produktive Weltfreigabe, Deutschlandabdeckung
oder Lastabnahme. Produktive LiveMap und Serverautorisierung bleiben getrennt.
