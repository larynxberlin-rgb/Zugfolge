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

### 2.1 Fahrzeugkatalog, Weltepochen und Markt (M5.1)

Der `VehicleCatalogRelease` ist ein unveränderliches, versioniertes Artefakt.
Er trennt die **faktische Baureihenbezeichnung** vom **fiktiven Handelsnamen**
(E6), nennt den beidseitig eingeschlossenen Bauzeitraum und führt Neubau,
Leasing und Gebrauchtmarkt als drei getrennte Zeitfenster. Jedes Marktfenster
kennzeichnet, ob es dokumentiert oder eine ausdrückliche Spielannahme ist.
Gerade Leasing- und Gebrauchtendjahre dürfen für das Balancing geschätzt werden;
sie werden dadurch nicht als historische Tatsache ausgegeben.

Die Welteinstellung führt zwei unabhängige Epochen:

| Einstellung | Prüft | Beispiel |
|-------------|-------|----------|
| **Bau-Epoche** | tatsächliches Baujahr des einzelnen Fahrzeugs | Eine Gegenwartswelt kann auch Fahrzeuge aus der Bahnreformzeit zulassen |
| **Beschaffungs-Epoche** | Jahr, in dem das EVU das Fahrzeug übernimmt | Dasselbe ältere Fahrzeug erscheint 2026 nur noch im belegten Leasing-/Gebrauchtfenster |

Beide Epochen können auch auf **alle Jahre** gestellt werden. Ein alter Typ wird
davon nicht neu produzierbar: Der Neubau bleibt zusätzlich auf seinen
dokumentierten Bau- und Marktzeitraum begrenzt. Leasing und Gebrauchtmarkt
liefern ein bereits gebautes, bereits konfiguriertes Fahrzeug. Das
`VehicleAsset` hält deshalb je Einzelfahrzeug Welt, Typ, Bau- und
Beschaffungsjahr, Marktkanal, Eigentum oder Leasing, Zulassungen,
Wartungsfristen und die tatsächlich eingebaute Zugsicherung.

Der redaktionelle Arbeitsstand vom 8. August 2026 umfasst 48 Fahrzeugtypen und
63 Quellen. Wikipedia dient als breiter Index; Bauzeiträume und kritische
Technik werden, soweit verfügbar, mit Betreiber-, Aufgabenträger-, Hersteller-
oder Fachunterlagen gegengeprüft. Die reale Katalogdatei bleibt als
proprietäres Weltdatum außerhalb des öffentlichen Baums (E16). Öffentlich sind
das Schema, die Prüfregeln und rein fiktive Testdaten.

### 2.2 Funktionsentscheidung: optionale Zugsicherung

Eine Zugsicherung ist nur dann wähl- oder nachrüstbar, wenn sie für die
**genaue Baureihe oder Unterbaureihe** zumindest an einem Teilbestand real
belegt ist. Eine Beobachtung an einem einzelnen Fahrzeug oder Teilbestand
reicht als Positivbeleg, weil genau daraus die optionale statt serienmäßige
Einordnung folgt. Eine verwandte Baureihe, eine allgemeine Produktbroschüre oder
eine bloß geplante Ausrüstung reicht nicht. Das Release erzwingt hierzu
Quellenbezüge, die den exakten Fahrzeugtyp abdecken.

| Katalogangabe | Spielerentscheidung | Regel |
|---------------|----------------------|-------|
| **Serienausrüstung** | keine | ist immer eingebaut und kann nicht abgewählt oder entfernt werden |
| **Werksoption** (`FactoryOption`) | beim Neukauf | im belegten Optionszeitraum frei wählbar; außerhalb des Zeitraums und auf dem Sekundärmarkt keine kostenlose Umkonfiguration |
| **Nachrüstung** (`Retrofit`) | ausdrücklicher Werkstattumbau | nur am belegten exakten Typ und nur im Freigabezeitraum; bereits eingebaute Systeme bleiben erhalten |

Damit bedeutet „teilweise mit LZB/ETCS ausgerüstet“ weder „alle Fahrzeuge haben
es“ noch „die Baureihe hat es nie“. Beim Neukauf entscheidet der Spieler über
eine belegte Werksoption. Bei Leasing und Gebrauchtkauf wird dagegen die
konkrete Ist-Ausrüstung des angebotenen Fahrzeugs übernommen. Eine spätere
Nachrüstung ist nur zulässig, wenn der Katalog sie für diesen Typ ausdrücklich
belegt; eine Werksoption allein begründet noch keinen Werkstattumbau.

Das offene Endjahr `9999` bedeutet nach dem frühesten belegten Einbau nur eine
**spielerische Fortschreibung der technischen Einbaubarkeit**, keine
Marktprognose. M5.1 entscheidet über Zulässigkeit und hält den eingebauten
Zustand deterministisch fest. Kosten, Dauer, Werkstattkompetenz und
Anlagenbelegung werden erst mit M5.7 und M5.14 an den Umbau gebunden.

## 3. Fahrzeugkonfiguration (E20)

Fahrzeuge werden beim Hersteller **konfiguriert bestellt**, nicht aus einem
Katalog gekauft. Die Konfiguration ist eine der interessantesten Entscheidungen
des Spiels, weil sie in drei Richtungen gleichzeitig wirkt: Kapazität,
Fahrgastbewertung und **Betrieb**.

### 3.1 Was konfiguriert wird

| Merkmal | Wirkung |
|---------|---------|
| Sitzplätze 1. und 2. Klasse | Kapazität je Klasse; im SPNV oft klein oder ganz entfallend |
| Bestuhlungsdichte | eng = mehr Sitze, schlechtere Bewertung; weit = weniger Sitze, bessere |
| Sitzart und Anordnung | Reihe, Vis-à-vis, Klapp- und Stehplätze — Komfort gegen Kapazität |
| Mehrzweckbereich | Fahrrad-, Kinderwagen- und Rollstuhlplätze; kostet Sitze, wird häufig ausgeschrieben |
| **Türanzahl und -breite** | kürzere Haltezeit, dafür weniger Sitzplätze |
| Toiletten, barrierefrei | Pflichtmerkmal auf längeren Laufwegen |
| Klimatisierung, WLAN, Steckdosen, Fahrgastinformation | Ausstattungsstufen, Bewertungswirkung |

### 3.2 Der Zielkonflikt ist der Kern

Türen sind der wichtigste Zusammenhang und der am wenigsten offensichtliche:
**mehr und breitere Türen verkürzen die Haltezeit**, das verbessert Fahrzeit und
Pünktlichkeit — und kostet Sitzplätze. Damit greift die Fahrzeugkonfiguration
direkt in die Simulation ein und ist keine Zahlenkosmetik.

Daraus folgt, dass es **keine allgemein beste Konfiguration** gibt (E11): Eine
dichte S-Bahn-Linie mit kurzen Abständen will viele Türen und Stehplätze; ein
Regional-Express über neunzig Minuten will Sitze und Komfort. Dieselbe Baureihe
unterschiedlich konfiguriert passt auf unterschiedliche Lose — die Flotte wird
dadurch zum strategischen Vermögenswert statt zur Handelsware.

### 3.3 Ausschreibungen geben Rahmen vor

Eine Ausschreibung kann Mindestsitzplätze je Zug, einen Anteil oder Ausschluss
der 1. Klasse, Barrierefreiheit, Rollstuhl- und Fahrradstellplätze,
Klimatisierung oder Fahrgastinformation fordern. Wer darüber hinausgeht,
sammelt Wertungspunkte — und zahlt dafür.

### 3.4 Umbau in der Werkstatt

Fahrzeuge sind **nicht** auf ihre Erstkonfiguration festgelegt. Ein Umbau kostet
Geld und Werkstattzeit und belegt dabei eine Anlage — er läuft also durch
dieselbe Konfliktengine wie alles andere.

| Umbaubar | Baulich fest |
|----------|--------------|
| Bestuhlung, Dichte, Sitzart | Türanzahl und -position |
| Klassenaufteilung | Wagenkastenlänge, Achsfolge |
| Mehrzweckbereiche | Antrieb, Höchstgeschwindigkeit |
| Ausstattung: WLAN, Steckdosen, Information | serienmäßige Zugsicherungsgrundausrüstung |

Nicht serienmäßige Zugsicherung ist der einzige bewusst enger geregelte
Sonderfall: Sie ist nicht frei umbaubar, sondern folgt der typgenauen
Werksoptions-/Nachrüstungsentscheidung aus Abschnitt 2.2.

Die Trennung gibt der Erstbestellung bleibendes Gewicht: Wer die Türen falsch
wählt, korrigiert das nie. Sie erzeugt zugleich einen echten Sekundärmarkt —
ein Gebrauchtfahrzeug mit passender Grundauslegung ist deutlich mehr wert.

**Umsetzung M5.1a/M5.1b:** `crates/zugfolge-fleet` bildet feste
`StructuralConfiguration` und umbaubare `InteriorConfiguration` als getrennte
Typen ab. Die Mindesthaltezeit teilt den Fahrgastwechsel ganzzahlig und
aufrundend durch die gesamte lichte Türbreite einer Fahrzeugseite. Ein
`WorkshopSchedule` nimmt Umbauten nur in passenden Werkstätten innerhalb der
Öffnungszeit und freien Kapazität an. Bei Fertigstellung belastet der
`ConversionLedger` die Kosten, bevor der Innenraum übernommen wird; ein
fehlgeschlagener Ledger-Aufruf lässt Fahrzeug und Auftrag unverändert. Die
Belegung ist ein spezialisierter Vorgriff für Umbauten; die gemeinsame
Konfliktengine für alle Anlagenbelegungen folgt weiterhin mit M5.7.

### 3.5 Beschaffungswege und Tempo

| Weg | Lieferzeit | Rolle |
|-----|-----------|-------|
| **Leasing** | sofort | Standardkonfiguration von Leasinggesellschaften. Der Weg für kurzfristigen Bedarf und für Einsteiger |
| **Gebrauchtmarkt** | kurz | vorhandene Konfiguration und vorhandener Fristenstand — passt oder passt nicht |
| **Neubestellung** | mehrere Perioden | frei konfigurierbar, günstigste Vollkosten, aber nicht für eine gerade gewonnene Ausschreibung |

Dass Neubestellungen lange dauern, ist real und spielerisch wichtig: Es macht
Leasing zum Einstiegsweg und langfristige Flottenplanung zu einer eigenen
Disziplin. Ein Einsteiger wartet dadurch nie auf Fahrzeuge.

## 4. Versorgung, Instandhaltung und Zusatzfahrten

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

**Umsetzung M5.2–M5.14:** `crates/zugfolge-fleet/src/operations.rs` bildet
diese Kette ohne Nebenpfade ab. Formation, Umlauf, Wartungszustand,
Personalpool und Fahrzeugbedarfe speisen eine gemeinsame Planung; Anlagen und
Rangierbedarf verwenden die Konfliktressourcen des Fahrwegs. Zusatzfahrten
sind nur mit Trassen-, Dienst-, Kosten- und Sichtbarkeitsnachweis gültig. Die
Versorgungsautomatik berücksichtigt die drei Vorgaben Ort, Zeitfenster und
Anlage und veröffentlicht Score, obere Schranke, Lücke in Promille und den
größten Hebel. Erst ein leerer, bereichsübergreifender Verletzungsbericht gibt
den Fahrplan frei. Beschaffungsangebote bilden Leasing ohne Vorlauf,
kurzfristige Gebrauchtübernahme mit bestehendem Innenraum und frei
konfigurierbaren Neubau nach mehreren Perioden ab.

## 5. Baustellen und Störungen

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

## 6. Baustellenfahrplan und Ersatzkonzept (E15)

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
