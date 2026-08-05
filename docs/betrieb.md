# Betrieb: Disposition, Flotte, Versorgung, Störungen

## 1. Betriebsprogramm — das Dispo-Regelwerk (E2)

Der Kern des Spiels und die Antwort darauf, was ein Spieler an einem
gewöhnlichen Abend tut. Jedes EVU besitzt ein Betriebsprogramm: eine
priorisierte Regelmenge, die der Simulationskern ausführt — unabhängig davon, ob
der Spieler online ist.

```text
Regel := Auslöser + Bedingungen + Maßnahme + Grenzen + Priorität
```

**Auslöser:** Verspätungsschwelle, Anschlussgefährdung, Fahrzeugstörung,
Personaldienstüberschreitung, Streckensperrung, Bahnsteigwechsel,
Wendezeitunterschreitung, Trassenkonflikt in der Ad-hoc-Vergabe.

**Maßnahmen:** Anschluss halten oder brechen, Halt auslassen, Zug vorzeitig
wenden, Zug kürzen oder verstärken, Fahrt ausfallen lassen, Reserveumlauf
aktivieren, Ersatzfahrzeug zuführen, Umleitung beantragen, Trasse zurückgeben,
Ersatzverkehr auslösen.

**Grenzen — das ist der Realismus.** Jede Maßnahme muss betrieblich zulässig
sein. Eine Umleitung braucht freie Kapazität *und* Streckenkenntnis des Personals
*und* passende Zugsicherung. Eine Verstärkung braucht ein verfügbares,
fristgerechtes Fahrzeug *und* Personal in Reichweite. Regeln, die das verletzen,
greifen nicht — und sagen im Bericht, warum.

**Fairness-Invariante:** Manueller Eingriff überschreibt eine konkrete
Einzelentscheidung, gewährt aber niemals einen mechanischen Bonus.

**Oberfläche:** Bedingungsbaum, kein Freitext-Code. Dazu zwei Dinge, die den
Loop tragen:

- **Backtesting** — „Was hätte dieses Regelwerk an meinen letzten sieben
  Betriebstagen getan?“ Läuft gegen das Event-Log, kostet keine
  Simulationszeit.
- **Vorlagen** — „konservativ pünktlich“, „anschlussorientiert“,
  „umlaufschützend“. Neulinge sind ab Minute eins betriebsfähig und lernen durch
  Anpassen statt durch Lesen.

Die Regel-Engine hängt an der Dispositionsschnittstelle des Simulationskerns
(→ `infrastruktur.md`).

## 2. Fahrzeuge und Personal

- Fahrzeuge sind individuelle Assets mit Baureihe, Antrieb, Länge, Masse,
  Leistung, Höchstgeschwindigkeit, Zugsicherung, Zulassung, Wartungsfristen und
  Eigentumsstatus.
- Formationen werden aus Fahrzeugen gebildet, auf eine **Zugcharakteristik**
  abgebildet (→ `infrastruktur.md`) und gegen Strecke, Bahnsteig,
  Elektrifizierung und Zugsicherung geprüft.
- Personal wird als regionaler Qualifikations- und Dienstkapazitätspool
  modelliert; einzelne Mitarbeiterbiografien sind nicht Teil der ersten Version.
- Dienst-, Wartungs-, Abstell- und Fahrzeugumlaufkonflikte verhindern die
  Freigabe eines nicht durchführbaren Fahrplans.
- Sicherheits- und Offline-Disposition bleibt für alle Spieler kostenlos.

## 3. Versorgung, Instandhaltung und Zusatzfahrten

Ein Fahrzeug ist nicht verfügbar, wenn es fahrbereit ist, sondern wenn es
versorgt, entsorgt, gereinigt, fristgerecht **und am richtigen Ort** ist.

**Bedarfe je Fahrzeug**, laufen kontinuierlich mit und sind sichtbar:

| Bedarf | Treiber | Folge bei Vernachlässigung |
|--------|---------|----------------------------|
| Energie und Kraftstoff | Zugkm, Fahrprofil, Masse | Fahrt nicht durchführbar |
| Sand | Bremsungen, Witterung | Geschwindigkeitseinschränkung |
| Frischwasser | Betriebsstunden, Fahrgastzahl | Qualitätsmangel |
| Fäkalienentsorgung | Betriebsstunden, Fahrgastzahl | Toiletten gesperrt, Pönale |
| Innenreinigung | Betriebsstunden, Fahrgastzahl | Sauberkeitsbewertung, Pönale |
| Außenreinigung | Zeit, Witterung | Erscheinungsbild, weicher Faktor |
| Instandhaltungsfristen | Laufleistung und Zeit, gestuft | **harte Sperre** |

**Anlagen sind Konfliktressourcen wie Gleise.** Werkstätten, Behandlungs- und
Waschanlagen, Tankstellen, Entsorgungsanlagen und Abstellgleise haben Kapazität,
Öffnungszeiten, Nutzlänge und Baureihenkompetenz. Zwei EVU konkurrieren dadurch
tatsächlich um dieselbe Abstellanlage in derselben Nacht — und Abstellkapazität
wird zur strategischen Größe, die mitentscheidet, welche Linien fahrbar sind.

**Zusatzfahrten sind echte Züge.** Zuführungs-, Werkstatt-, Versorgungs- und
Abstellfahrten brauchen Trasse, Personal und Zeit, kosten Geld, erscheinen auf
der Livemap und können verspätet sein oder ausfallen. Sie füllen die
Nachtstunden, in denen sonst nichts auf der Karte passiert.

**Rangieren ist vollständig automatisiert (E12).** Der Spieler plant das
*Ergebnis* — Formation, Gleis, Reihenfolge —, niemals die Bewegung dorthin.
Rangierbewegungen belegen Bahnhofsköpfe und Anlagen nur kurz und werden
vereinfacht als Zeitbedarf plus kurzzeitige Belegung verrechnet. Das gilt auch
im Güterverkehr: Zugbildung ist Spielerentscheidung, der Rangieraufwand eine
berechnete Konsequenz. Einzeln steuerbare Rangierbewegungen wären die Ebene, auf
der Detailtiefe in reine Klickarbeit umschlägt, ohne dass eine interessante
Entscheidung entsteht.

Die drei Eingriffstiefen für die Versorgungsplanung stehen in `produkt.md`.

## 4. Baustellen und Störungen

Jede Welt konfiguriert Baustellen und ungeplante Störungen unabhängig:

```text
DisruptionPolicy
  plannedWorksMode: REALISTIC | SIMULATED | MANUAL
  operationalIncidentMode: REALISTIC | SIMULATED | MANUAL
  providerSetId
  simulationProfile
  rulesetVersion
```

**Realistisch** — autorisierte externe Feeds werden in 1:1-Zeit importiert und
auf Konfliktressourcen gemappt. Quelle, Abrufzeit, Gültigkeit und Confidence
bleiben sichtbar. Bei Providerausfall gilt der letzte sichere Stand; kein
stiller Wechsel auf Simulation. Falschzuordnungen nur durch auditierte
Admin-Korrekturen.

**Simuliert** — ein deterministischer Generator erzeugt Ereignisse anhand von
Häufigkeit, Schwere, Dauer, Vorlauf, Region, Infrastrukturart und Belastung.
Alle Parameter je Welt einstellbar. Gleicher Seed, gleiche Weltversion, gleiche
Ereignisse ⇒ dasselbe Ergebnis. **Standard für Pilot- und erste Großwelt.**

**Manuell** — keine automatischen Ereignisse. Autorisierte Spielleiter legen
Beginn, Ende, Ursache, betroffene Ressourcen und Wirkung händisch an. Beginn und
Ende sind Pflichtfelder; jede Änderung wird protokolliert.

Modi dürfen während einer laufenden Fahrplanperiode nicht unangekündigt
gewechselt werden. Änderungen treten erst an einem veröffentlichten
Fahrplanstichtag in Kraft.

## 5. Baustellenfahrplan und Ersatzkonzept (E15)

Eine angekündigte Sperrung ist die interessanteste Planungsaufgabe des Spiels —
und die, bei der Automatik und Handplanung am weitesten auseinandergehen.

**Vorlauf ist Pflicht.** Geplante Baumaßnahmen werden mit Vorlauf
veröffentlicht: Beginn, Ende, betroffene Konfliktressourcen, verbleibende
Kapazität. Der Spieler bekommt ein Planungsfenster statt einer Überraschung.
Ungeplante Störungen trifft dagegen das Betriebsprogramm in Echtzeit.

| Maßnahme | Voraussetzung | Wirkung |
|----------|---------------|---------|
| Umleitung über andere Strecke | freie Kapazität, Streckenkenntnis, Zugsicherung, Elektrifizierung, zulässige Zuglänge | Fahrzeitverlängerung und Mehrkosten, aber der Zug fährt |
| Vorzeitige Wende | Wendemöglichkeit und Gleiskapazität am Ersatzendpunkt | Teilstrecke entfällt, Umlauf verkürzt sich |
| Taktausdünnung | vertragliche Zulässigkeit | weniger Leistung, Minderung statt Pönale |
| Linienzusammenlegung | Fahrzeug- und Personalverfügbarkeit | spart Umläufe, kostet Direktverbindungen |
| Schienenersatzverkehr | Vertragspflicht | teuer, spürbarer Qualitätsabzug |

**Ein Ersatzkonzept ist ein eigener kleiner `PlanningRun`** gegen die
verbleibende Kapazität, mit denselben Konfliktregeln und derselben
Begründungspflicht wie der Regelfahrplan.

**Der soziale Kern:** Eine Sperrung verlagert Verkehr, die Umleitungsstrecke
wird selbst zum Engpass, und **mehrere EVU konkurrieren um dieselbe
Ersatzkapazität**. Wer früher und besser plant, bekommt die Umleitungstrasse;
wer spät kommt, fährt Ersatzverkehr. Eine Baustelle ist damit kein Schaden, den
man erleidet, sondern ein Wettlauf, den man gewinnen kann.

**Vertragliche Behandlung** — gut geplant und fristgerecht eingereicht → geringe
Minderung, kaum Qualitätsverlust; spät oder unplausibel → volle Pönale, als
hätte man gar nicht geplant; gar nicht befasst → die Automatik legt ein
sicheres, teures Standardkonzept auf, meist Taktausdünnung plus Ersatzverkehr.

Dasselbe Prinzip wie bei der Versorgung: Wer nichts tut, spielt weiter — nur
teurer. Wer sich hineinkniet, gewinnt spürbar.
