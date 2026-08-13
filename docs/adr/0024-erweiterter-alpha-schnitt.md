# ADR-0024: Der Alpha-Schnitt wird gezielt um M12.1, M12.2 und M14.1 erweitert

- **Status:** Angenommen — bindend (entspricht E24)
- **Bezug:** [../entscheidungen.md](../entscheidungen.md) · [../milestones.md](../milestones.md) · [../mitteldeutschland-alpha.md](../mitteldeutschland-alpha.md) · [GitHub-Decision-Issue #201](https://github.com/larynxberlin-rgb/Zugfolge/issues/201)
- **Betrifft Milestones:** M9.1–M9.10, vorgezogen M12.1, M12.2 und M14.1
- **Verwandte ADRs:** [ADR-0005](0005-rust-kern-typescript-plattform.md), [ADR-0007](0007-eigenbetrieb-bei-gescheiterter-ausschreibung.md), [ADR-0009](0009-vollstaendige-transparenz-livemap.md), [ADR-0018](0018-weltlaufzeit-und-skalierende-perioden.md), [ADR-0022](0022-jaehrliche-infrastrukturaktualisierung.md), [ADR-0023](0023-odoo-als-administrativer-kontrollpunkt.md)

<!-- zugfolge-alpha-scope:start
{"decision":"E24","regionVariant":"B — Mitteldeutsches Metropol-Korridornetz","pulledForward":[{"item":"M12.1","dependsOn":["M2","M5","M6","M8"]},{"item":"M12.2","dependsOn":["M2","M5","M6","M12.1"]},{"item":"M14.1","dependsOn":["M1","M2","M4","M5","M6","M8","M9.2"]}],"acceptanceDependsOn":[{"item":"M9.9","dependsOn":["M14.1"]}],"excluded":["M10","M11","M12.3","M12.4","M13","M14.2","M14.3","M14.4"]}
zugfolge-alpha-scope:end -->

## Kontext

Der bisherige Alpha-Schnitt endete mit M9 und sollte 20–50 externe Spieler in
der Pilotregion Leipzig–Halle–Erfurt prüfen. Damit wären Kooperation zwischen
Spieler-EVU, ein echter Markt für bestehende Fahrzeuge und der Betrieb über
eine größere regionale Zuständigkeit erst nach der Alpha erprobt worden. Diese
drei Fähigkeiten beeinflussen jedoch schon die Aussagekraft des Alpha-Tests:
Sie erzeugen reale gegenseitige Abhängigkeiten, Marktbindungen,
Störungshilfe, Eigentumsübergänge, mehr Netzlast und Regionsübergaben.

M12 enthält daneben Bietergemeinschaften, Kooperationstarife und öffentliche
Qualitätsrankings; M14 enthält die deutschlandweite Ausweitung, horizontale
Verteilung und die spätere Weltenstart-Kadenz. Diese Teile sind weder für den
gewünschten Alpha-Fall erforderlich noch durch die Vorziehung automatisch
fachlich oder betrieblich nachgewiesen. Eine pauschale Vorziehung von M10–M14
würde den Alpha-Schnitt unkontrolliert vergrößern und seine Abnahme verwischen.

„Mitteldeutschland“ besitzt im Projekt bislang keine bindende geometrische
Grenze. Der Begriff kann den wirtschaftlichen Kernraum, ein betriebliches
Korridornetz oder die drei Länder Sachsen, Sachsen-Anhalt und Thüringen meinen.
Die Wahl verändert Quellenumfang, erwartete Zugfahrten, Arbeitsspeicher,
Importdauer, Kartenartefakte, Eigenbetriebsbestand und Soak-/Lasttest. Sie darf
daher nicht als beiläufige Importannahme getroffen werden.

## Entscheidung

**Der geschlossene Alpha-Test umfasst zusätzlich ausschließlich M12.1,
M12.2 und M14.1; der übrige Ausbau M10–M14 bleibt außerhalb des
Alpha-Schnitts.** M12 und M14 behalten ihren Gesamtstatus, bis auch ihre
übrigen Teilabschnitte eigenständig nachgewiesen sind.

M12.1 und M12.2 bauen für die Alpha nur auf bereits abgenommenen SPNV-,
Welt-, Fleet-, Ledger-, Postfach-, Audit-, Economy- und Störungspfaden auf.
Sie führen keine SPFV- oder SGV-Abhängigkeit aus M10/M11 ein. Die
Abhängigkeiten der vorgezogenen Teilabschnitte werden deshalb einzeln geführt:

- M12.1 hängt von M2, M5, M6 und für Ersatzverkehrshilfe von M8 ab;
- M12.2 hängt von M2, M5, M6 und den Vertragsbindungen aus M12.1 ab;
- M14.1 hängt von M1, M2, M4, M5, M6 und M8 sowie von der
  releasegebundenen Weltstart- und Runtime-Validierung aus M9.2 ab.

M14.1 ist damit eine Eingabe in die nachfolgenden integrierten M9-Beweise,
nicht deren Ergebnis. Insbesondere M9.5, M9.7 und M9.9 dürfen weiterhin erst
gegen den vorgezogenen M14.1-Release abgenommen werden. Diese gerichtete Kante
verhindert den früher missverständlichen Zyklus „M14.1 hängt von M9 ab, M9
hängt für seine Abnahme von M14.1 ab“.

M9.2, M9.5, M9.7 und M9.9 werden gegen die ausgewählte größere Region und
beide neuen Marktpfade abgenommen. Der integrierte Alpha-Fall umfasst
gleichzeitige Trassen-, Ausschreibungs-, Vertrags-, Sekundärmarkt-, Störungs-
und Livemap-Aktivität, Odoo-Projektion, Backup/Restore sowie deterministischen
Replay. Gleiche Releases, Seed und Kommandofolge müssen denselben
Endzustands-Hash ergeben.

Die geografische Ausprägung von M14.1 wird vor dem großen Import aus den
messbaren Varianten in [`mitteldeutschland-alpha.md`](../mitteldeutschland-alpha.md)
ausdrücklich freigegeben. Bis dahin werden keine PBF-, GTFS-, Höhen-, Stations-
oder PMTiles-Artefakte als produktiver Mitteldeutschland-Release erzeugt. Die
Auswahl ist ein Scope-Gate innerhalb von E24, keine neue stillschweigende
Grundsatzentscheidung.

Das Gate wurde am 11.08.2026 mit **Variante B — Mitteldeutsches
Metropol-Korridornetz** geschlossen. Dessen versionierte Grenzbetriebsstellen,
Korridore und Clip-Regeln stehen in `docs/mitteldeutschland-alpha.md`; nur
dieser Umfang ist für M14.1 freigegeben.

## Begründung

Kooperation und Gebrauchtfahrzeuge sind keine isolierten Zusatzmasken: Sie
verbinden Eigentum, Verfügbarkeit, Umläufe, Personal, Trassen, Störungen,
Ledger und Kommunikation. Ihre frühe Einbeziehung deckt Integrationsfehler und
Missbrauchsmöglichkeiten auf, bevor eine öffentliche Welt eröffnet wird. Die
größere Region erzeugt zugleich repräsentativere Konflikt-, Import-, Livemap-
und Betriebsreifelast.

Die Vorziehung einzelner Teilabschnitte erhält dennoch einen endlichen
Alpha-Schnitt. M12.3/M12.4 und M14.2–M14.4 besitzen andere fachliche Beweise
und werden nicht durch einen erfolgreichen Alpha-Fall ersetzt. Das
Regions-Gate verhindert, dass ein politischer oder umgangssprachlicher Begriff
ungeprüft zu einer dauerhaften Daten- und Betriebskostenentscheidung wird.

## Konsequenzen

- **Erleichtert:** Die Alpha prüft echte EVU-Kooperation, Eigentumswechsel,
  Störungshilfe, Marktmissbrauch, Regionsübergaben und eine aussagekräftigere
  Last schon vor der öffentlichen Freigabe.
- **Kostet / schränkt ein:** Datenimport, Eigenbetriebs-Weltstart,
  Odoo-Monitoring, Backup, Restore, Replay, Lasttest und Soak müssen die
  ausgewählte Region und beide Märkte vollständig tragen. Der Alpha-Start
  wartet zusätzlich auf die Regionsfreigabe und die externen
  Betriebsnachweise aus M9.5/M9.9.
- **Daten und Rechte:** Nur im Quellenregister freigegebene, gepinnte OSM-,
  Fahrplan-, Stations- und Höhendaten dürfen in den Release. Rechte-,
  Coverage-, Abweichungs- und Signaturbericht wachsen mit der Region.
- **Last:** Die Auswahl wird anhand importierter Knoten/Kanten,
  Konfliktressourcen, GTFS-Fahrten, PMTiles-Größe, Importdauer,
  Arbeitsspeicher, Eventrate und Replay-Durchsatz gegen die bisherige
  Pilotregion gemessen. Schätzwerte sind kein Abnahmebeweis.
- **Invarianten:** Weltisolation gilt für Verträge, Angebote,
  Reservierungen, Fahrzeuge, Ledger und Events. Geld bleibt Integer-Cent;
  Markt und Verträge erhalten keine Payment-Tier-Eingabe. Regionsübergaben und
  Releases dürfen Invariante 1 nicht verletzen. Externe Daten und Odoo bleiben
  außerhalb des heißen Simulationspfads.
- **Milestones:** M9 bleibt bis zum realen Alpha-Nachweis blockiert; M12.1,
  M12.2 und M14.1 können einzeln abgenommen werden. M12 und M14 insgesamt
  bleiben offen.

## Verworfene Alternativen

1. **Gesamten Ausbau M10–M14 in die Alpha ziehen:** verworfen, weil SPFV, SGV,
   weitere Kooperationen und deutschlandweite Verteilung eigene, nicht für
   den integrierten Alpha-Fall notwendige Abhängigkeiten besitzen.
2. **M12.1/M12.2 nur als Datenmodelle vorziehen:** verworfen, weil gerade
   serverautoritative Fachprüfung, Ledger, Postfach, Audit, Störungshilfe und
   Spielererlebnis den Alpha-Wert erzeugen.
3. **„Mitteldeutschland“ ohne Freigabe als drei Länder oder als beliebige
   Bounding Box importieren:** verworfen, weil beide Varianten Kosten und
   Abnahmeumfang dauerhaft vorwegnehmen würden.
