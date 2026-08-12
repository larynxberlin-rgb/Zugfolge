# Infrastruktur, Trassen und Simulation

## 1. Konfliktressourcen

Die Infrastruktur wird als betrieblicher Graph modelliert. Woraus dieser Graph
besteht — Betriebsstellen, Kanten, Gleise, Bahnsteige und ihre Attribute —
steht seit M1.1 im eigenen Dokument: [`betriebsgraph.md`](betriebsgraph.md).
Hier geht es um das, was auf ihm stattfindet.

Konfliktressourcen:

- reale und konservativ erzeugte Blockabschnitte;
- Fahrstraßen, Weichen und kreuzende Bewegungen;
- eingleisige Gegenfahrten;
- Bahnsteig- und Bahnhofskopfbelegungen;
- Abstell- und Servicegleise sowie Behandlungsanlagen (→ `betrieb.md`);
- Durchrutschwege, Räumzeiten und Mindestzugfolgen;
- Zuglänge, Fahrdynamik und infrastrukturelle Kompatibilität.

> **Harte Invariante:** Keine zwei Züge dürfen zur gleichen Zeit inkompatible
> Belegungen derselben Konfliktressource besitzen.

Mehrere Züge dürfen auf derselben Strecke fahren, wenn unterschiedliche
freigegebene Blöcke belegt werden. Ein pauschales Verbot für einen gesamten
Streckenabschnitt wäre nicht realistisch.

**Die Sperrzeit besteht aus sechs Anteilen** — Fahrstraßenbildezeit,
Signalsichtzeit, Annäherungsfahrzeit, Fahrzeit, Räumfahrzeit,
Fahrstraßenauflösezeit. Sie beginnt, bevor der Zug den Abschnitt erreicht, und
endet, nachdem er ihn geräumt hat; aufeinanderfolgende Abschnitte ergeben
dadurch die **Sperrzeitentreppe**. Die Mindestzugfolgezeit folgt daraus und ist
kein eigener Parameter. Zwei Sperrzeiten derselben Ressource dürfen sich
berühren, aber nicht überschneiden.

Der Wegwerf-Spike aus M0.3 hat dieses Modell an drei Betriebsstellen geprüft
und ist mit M3.1 verfallen und gelöscht. Sein Ergebnis steht seither als Code
in `crates/zugfolge-conflict` (Abschnitt 6 bis 8): **Ein Ressourcenmodell trägt
beide Konfliktarten.** Ob aus einer Überschneidung ein Zugfolgefall oder eine
Gegenfahrt wird, entscheidet die Infrastruktur — auf der zweigleisigen Strecke
ist jedes Richtungsgleis eine eigene Ressource, auf dem eingleisigen Abschnitt
teilen beide Richtungen sich eine. Der Prüfer braucht dafür keine zweite Regel.

Was der Spike offengelassen hatte, gehört zum Bahnhofskopf: Weichen,
Fahrstraßen und kreuzende Bewegungen brauchen **Ausschlussmengen** statt
einzelner Ressourcen. Sie kommen aus der Fahrstraßenableitung (M1.7) und wirken
seit M3.3 im Prüfer (Abschnitt 8).

**Anlagen sind Konfliktressourcen wie Gleise.** Werkstätten, Waschanlagen,
Tankstellen, Entsorgungsanlagen und Abstellgleise laufen durch dieselbe
Konfliktengine wie der Fahrweg — kein zweites System.

## 2. Trassenvergabe

1. Ein `PathRequest` enthält Zugcharakteristik, Verkehrstage, Halte,
   Wunschzeiten und zulässige Abweichungen.
2. Der Planner erzeugt Laufweg- und Zeitkandidaten mit relativen
   Belegungsprofilen.
3. Reguläre Anträge eines Planungsfensters werden gemeinsam in einem
   deterministischen `PlanningRun` behandelt.
4. Reihenfolge innerhalb des Fensters und Bezahlstatus beeinflussen das Ergebnis
   nicht.
5. Exakte Gleichstände werden über einen veröffentlichten, je Planungsperiode
   rotierenden Seed aufgelöst.
6. Ad-hoc-Anträge verwenden ausschließlich verbleibende Kapazität.
7. Annahme, Alternativtrasse und Ablehnung enthalten eine maschinenlesbare und
   verständliche Begründung.

**Zugcharakteristik statt Fahrzeugliste.** Der Planner rechnet mit Masse, Länge,
Vmax, Anfahr- und Bremsvermögen, Antriebsart und Zugsicherung — nicht mit
konkreten Fahrzeugen. Echte Formationen werden darauf abgebildet
(→ `betrieb.md`). So arbeiten reale Fahrplanrechner auch, und es entkoppelt die
Trassenplanung vom Fahrzeugkatalog.

## 3. Fahrplanperiode als Saison (E3)

**Die Periodenlänge ist ein Weltparameter, keine Konstante** — sie skaliert mit
der Weltlaufzeit, damit der Saison-Rhythmus in einer Sechsmonatswelt genauso
mehrfach erlebbar ist wie in einer unbefristeten. Werte und Herleitung:
`produkt.md` 6.1. Spanne 3 bis 8 Wochen; **8 Wochen ist der Wert der
unbefristeten Welt** und der Rhythmus, für den das Konzept entworfen wurde.

Der Ablauf ist in jeder Welt derselbe, nur gestaucht. Anteile am Beispiel der
Achtwochenperiode:

| Anteil | Phase |
|--------|-------|
| erstes Viertel | Anmeldefenster — `PathRequest` für die kommende Periode |
| zweites Achtel | Koordinierung — deterministischer `PlanningRun`, Alternativangebote, Einspruchsfenster |
| drittes Achtel | Veröffentlichung Netzfahrplan, Annahmefrist, Rahmenvertragsabgleich |
| zweite Hälfte | Betrieb; parallel Ad-hoc-Trassen aus Restkapazität |

Der Periodenwechsel ist ein Ereignis mit Fahrplanwechsel-Bericht.
Infrastruktur- und Wirtschafts-Releases treten ausschließlich hier in Kraft.

**Der Fahrplanstichtag ist zugleich der einzige zulässige Zeitpunkt für einen
Betriebsübergang** bei Betreiberwechsel im SPNV (→ `wirtschaft.md`). Das ist
real so und technisch sauber, weil Trassen ohnehin periodenweise vergeben
werden.

## 4. Kapazitätsschutz und Markteintritt (E4)

Das größte soziale Risiko einer Welt ohne Wipes: Früheinsteiger binden die
Korridore, Neulinge kommen nie hinein. Alle Gegenmittel sind real begründbar:

- **Rahmenvertragsdeckel** — Rahmenverträge binden nur einen begrenzten Anteil
  der Kapazität eines Korridors.
- **Use it or lose it** — unter einem Nutzungsschwellwert liegende Trassen
  verfallen und lösen Stornoentgelt aus.
- **Markteintrittskontingent** — neue EVU haben in ihrer ersten Periode bei
  kleinen Verkehren Vorrang im exakten Gleichstand.
- **Notvergabe nach Insolvenz** — die natürliche Wiedereinstiegsrampe.
- **Kapazitäts-Heatmap** — die Welt weist niemandem ein Gebiet zu, zeigt aber
  offen, wo noch etwas geht.

## 5. Simulation und Livemap

- Die Simulation ist ereignisgesteuert; Positionen werden zwischen
  Betriebspunkten analytisch berechnet.
- Nur die nächsten 48–72 Stunden werden als vollständige `TrainRun`-Instanzen
  materialisiert.
- Wiederkehrender Verkehr wird als `ServicePattern` plus relativem
  `OccupationProfile` gespeichert.
- Regionale Single-Writer-Prozesse besitzen die jeweiligen Konfliktressourcen.
- Eine Regionsgrenze wird erst übergeben, wenn die Folgeregion die Belegung
  bestätigt.
- Verspätungen, Fahrzeugstörungen und Infrastrukturrestriktionen propagieren
  regelbasiert. Die *Entstehung* von Störungsursachen ist davon getrennt
  (→ `betrieb.md`).
- Der Browser erhält einen Initialsnapshot und anschließend Sequenz-Deltas;
  Positionen werden entlang der Gleisgeometrie interpoliert.
- **Dispositionsschnittstelle:** Der Kern besitzt einen definierten
  Entscheidungspunkt je Ereignis. Zunächst greift ein konservatives
  Standardverhalten; später hängt dort die Regel-Engine des Betriebsprogramms.
- **Zeitumstellung** ist ein Pflichtfall, kein Detail: Verhalten von
  Fahrplanperiode und laufenden Zugfahrten beim Sommerzeitwechsel muss definiert
  sein.

**Sichtbarkeit (E9):** EVU, Zugart, Zugnummer, Position, Geschwindigkeit,
Verspätung, nächster Betriebspunkt und Betriebsstatus sind öffentlich.
Vertrags- und Ladungsdetails bleiben geschützt.

### 5.1 Kartenprojektion und Fahrdienstleitergrenze (E26)

Die Live-Lage kombiniert drei getrennte Wahrheiten: unveränderliche Geometrie
und Objektdetails aus dem gepinnten `InfraRelease`, sparsame Abweichungen des
Betriebszustands aus Snapshot/SSE und private Owner-Details aus einer eigenen,
serverseitig autorisierten Projektion. Statische Infrastruktur wird nicht in
jede Sequenz kopiert. Der Stream trägt nur Züge sowie geänderte Sperrungs-,
Baustellen- und Einschränkungszustände.

`positionMm` allein ist keine Kartenkoordinate. Eine Fahrt erscheint erst auf
dem Gleis, wenn der bestätigte Fahrweg sie auf `trackId`, Offset und eine aus
der Releasegeometrie abgeleitete E7-Koordinate projiziert. Andernfalls bleibt
sie in einer erklärten Liste sichtbar. Derselbe Grundsatz gilt für die
virtuelle Fahrdienstleitung: Sie verwendet ausschließlich releasegebundene
Konfliktressourcen und versionierte Regeln. Eine hundertprozentige
Nachbildung jedes realen Stellwerks ist kein Freigabekriterium; eine solide,
regelkonforme konservative B-Logik ist spielbar. Unbelegte Weichenlagen,
Signalbilder und Fahrstraßen werden aber weder angezeigt noch als Möglichkeit
erfunden.

Der ausführbare Datenvertrag, die reale Abdeckung 2026.1 und die konservative
Ableitung von Gleiszuständen aus Störungen stehen in
[`zugkartenprojektion.md`](zugkartenprojektion.md).

---

## 6. Das Sperrzeitenmodell (M3.1)

`crates/zugfolge-conflict` löst den Wegwerf-Spike aus M0.3 ab. Die sechs Anteile
aus Abschnitt 1 stehen dort als `RelativeOccupation`, ihre Grenzen als
**halboffenes Intervall** `[start, end)`: Zwei Sperrzeiten dürfen sich berühren,
nicht überschneiden. Genau an dieser Grenze liegt die Mindestzugfolgezeit — sie
fällt dadurch aus dem Modell heraus, statt darin als Parameter zu stehen.

### 6.1 Die Konfliktressource ist eine Aufzählung

`ConflictResource` fasst zusammen, was Abschnitt 1 aufzählt: Blockabschnitt,
Bahnhofsgleis, Fahrstraße, Anlage. Ein Bahnhofsgleis wird **nicht** in Blöcke
zerlegt — auf ihm steht ein Zug, und zwei stehen dort nie gleichzeitig. Ist für
ein Streckengleis keine Blockteilung hinterlegt, gilt das ganze Gleis als ein
Block: konservativ, sichtbar, und niemals eine Datenlücke, die als freie Fahrt
durchgeht.

Zwei Fahrstraßen desselben Bahnhofskopfs sind **verschiedene** Ressourcen und
schließen einander trotzdem aus. Deshalb steht die Ausschlussmenge aus M1.7
(`ResourceExclusions`) neben der Ressource und nicht in ihr: Die Ressource ist
eine Kennung, die Verträglichkeit eine Eigenschaft des Stellwerks.

### 6.2 Die Parameter hängen an der Betriebsstelle

Der Spike rechnete mit netzweiten Konstanten. Das ist die Stelle, an der M3.1
ihn ablöst: Fahrstraßenbilde- und Fahrstraßenauflösezeit hängen an der
**Stellwerksbauart** (`InterlockingKind`, vom mechanischen bis zum digitalen
Stellwerk), Signalsichtzeit, Vorsignalabstand und Durchrutschweg an der
**Betriebsstelle**. `SignallingModel` hält einen Vorgabewert und die Ausnahmen —
Netze haben Tausende Betriebsstellen und eine Handvoll Stellwerksbauarten.

Eine sichtbare Folge: Die Sperrzeitentreppe steigt in der **Fahrt**, nicht
zwingend im Beginn der Sperrzeit. Ein mechanisches Stellwerk stellt seinen
Fahrweg eine Minute vorher; seine Stufe beginnt dadurch früher als die des
elektronisch gestellten Blocks davor.

### 6.3 Zwei bewusste Vereinfachungen

**Der Halt liegt am Ende des Bahnhofsgleises.** Das Gleis ist über die ganze
Haltezeit eine einzige Konfliktressource; die genaue Halteposition am Bahnsteig
ändert daran nichts, sondern nur die Ankunftszeit um wenige Sekunden. Sie kommt
mit der Formation in M5.

**Die Fahrstraße wird für die Dauer des Bahnhofsgleises belegt.** Genauer wäre:
von der Fahrstraßenbildung bis zum Räumen des Kopfs. Solange die Zuordnung von
Fahrstraße zu Bahnsteiggleis aus keiner freigegebenen Quelle kommt
(`rechte.md`), wäre jede feinere Angabe erfunden. Die Ausschlussmenge wirkt
trotzdem vollständig.

M3.1 hat dafür `derive_running_time_table_with_exit` in M1.10 ergänzt: die
Bremskurve in einen Halt hinein. M1.10 hatte sie ausdrücklich offengelassen,
weil sie zur Sperrzeit gehört und nicht zur reinen Fahrzeit.

---

## 7. Verkehrsangebot und Belegungsprofil (M3.2)

Abschnitt 5 verlangt, wiederkehrenden Verkehr als `ServicePattern` plus
relativem `OccupationProfile` zu speichern. Der Grund ist Rechenlast: Ein
Angebot fährt in einer Fahrplanperiode dutzende Male, und seine Sperrzeiten sind
an jedem dieser Tage dieselben — nur um eine Zeitlage verschoben. **Einmal
rechnen, oft verschieben.** Das ist die Eigenschaft, die den Planner aus M3.4
bezahlbar macht: Er probiert Zeitlagen aus, und jede kostet ihn eine Addition
statt einer Fahrdynamikrechnung.

### 7.1 Die Zugnummernsystematik

Eine Zugnummer ist keine laufende Nummer, sondern eine Aussage — Zuggattung und
Richtung:

| Zuggattung | Nummernbereich | Kürzel |
|------------|----------------|--------|
| Fernverkehr | 1–9 999 | FV |
| S-Bahn | 10 000–19 999 | S |
| Regionalverkehr | 20 000–39 999 | RV |
| Güterverkehr | 40 000–79 999 | GZ |
| Dienstzug, Zusatzfahrt | 80 000–99 999 | DZ |

**Gerade Nummern fahren mit der Kilometrierung, ungerade gegen sie** — im
deutschen Netz üblich und hier eine geprüfte Zusicherung. Die Kürzel sind
generische Betriebsbegriffe, keine Produktmarken (E6).

### 7.2 Die Weltepoche ist ein Montag

Verkehrstage sind Wochentage, und Wochentage brauchen einen Nullpunkt.
`SimTime::EPOCH` ist **Montag, 00:00 Uhr**. Das ist eine Festlegung, keine
Ableitung — sie steht an einer Stelle, damit sie nicht an dreien verschieden
getroffen wird.

---

## 8. Der Konfliktprüfer (M3.3)

Die Regel ist **eine**: Zwei Sperrzeiten, die dieselbe Konfliktressource oder
zwei einander ausschließende Ressourcen betreffen, dürfen sich zeitlich nicht
überschneiden. Daraus werden vier betriebliche Fälle — Zugfolge, Gegenfahrt,
Fahrstraßenausschluss, Anlagenbelegung —, ohne dass der Prüfer sie
unterscheiden müsste.

**Erklärbar heißt: ohne zweite Abfrage.** Abschnitt 2.7 verlangt eine
maschinenlesbare *und* verständliche Begründung. Ressource, Fenster, Gegenzug
und Konfliktart fallen bei der Prüfung ohnehin an; es braucht dafür keinen
zweiten Mechanismus, nur eine Ausgabeform.

Das Belegungsbuch (`OccupationLedger`) ist nach Ressource gruppiert — die
einzige Struktur, die die Prüfung braucht. Sein `try_insert` nimmt eine Fahrt
nur auf, wenn sie die Prüfung besteht: **Invariante 1 gilt darin durch
Konstruktion.** Nachgewiesen ist sie über einen Property-Test mit 400
gestreuten Lagen, verglichen gegen eine zweite, unabhängig geschriebene
Prüfung; eine Prüfung, die sich selbst prüft, prüft nichts.

Die **Mindestzugfolgezeit** ist ein Ergebnis, kein Parameter: `minimum_headway`
rechnet aus zwei Sperrzeitentreppen den kleinsten Abstand aus, bei dem sich
keine zwei Sperrzeiten mehr überschneiden.

---

## 9. Der Trassen-Planner (M3.4)

Der Prüfer sagt, ob eine Trasse **zulässig** ist. Der Planner sagt, welche
**gut** ist. Das ist ein eigenes Verfahren, kein erweiterter Prüfer — der Spike
aus M0.3 hat genau diesen Punkt hinterlassen: Für eine Gegenfahrt auf
eingleisiger Strecke lautete seine Auskunft „6:57 min später"; betrieblich
richtig war „früher fahren und in einer Betriebsstelle kreuzen".

Der Unterschied entsteht aus drei Freiheitsgraden, die eine Prüfung nicht hat:

| Freiheitsgrad | Was er bedeutet |
|---------------|-----------------|
| **Laufweg** | welches Streckengleis, welches Bahnsteiggleis (`enumerate_itineraries`) |
| **Zeitlage** | früher oder später innerhalb der beantragten Abweichung |
| **Betriebshalt** | in einer kreuzungsfähigen Betriebsstelle warten, bis der Gegenzug durch ist |

Der Betriebshalt ist die Kreuzung, und **seine Dauer wird ausgerechnet, nicht
geraten**: Der Prüfbericht nennt die fremde Sperrzeit, das Verfahren wartet
genau bis zu ihrem Ende, auf volle Minuten aufgerundet. Ein Konflikt *vor* dem
Betriebshalt löst sich dadurch nie — dann gibt das Verfahren auf, statt sinnlos
weiterzuwarten. Ein Haltepunkt ohne Weichen kommt nie in Frage: Ein dort
wartender Zug stünde dem Gegenzug im Weg.

Ein beantragter Halt ist ein **Fahrgastwechsel** und verlangt einen Bahnsteig,
der die Zuglänge aufnimmt. Ein Halt ohne Bahnsteig ist kein Halt.

### 9.1 Kein einzelner Optimierungswert (E11)

Die naheliegende Lösung wäre eine Zielfunktion: Abweichung mal Gewicht plus
Fahrzeitverlängerung mal Gewicht, kleinster Wert gewinnt. E11 verbietet das, und
aus gutem Grund — ein solcher Wert behauptet eine Umrechnung zwischen Minuten
Verspätung und Minuten Fahrzeit, die es betrieblich nicht gibt, und verbirgt sie
hinter einer Zahl.

Stattdessen gilt eine **veröffentlichte Rangfolge**. Die Kriterien werden der
Reihe nach verglichen, und erst bei Gleichstand entscheidet das nächste:

| Rang | Kriterium | Warum es dort steht |
|------|-----------|---------------------|
| 1 | Betrag der Zeitlagenabweichung | die Zeitlage ist das, was beantragt wurde |
| 2 | Fahrzeitverlängerung | sie kostet Umlauf, Personal und Anschluss |
| 3 | Zahl der Betriebshalte | jeder ist ein zusätzlicher Betriebsvorgang |
| 4 | Umweg | Zugkilometer kosten Trassen- und Energieentgelt |
| 5 | frühere vor späterer Lage | Puffer am Zielort |
| 6 | Gleisfolge des Laufwegs | damit die Rangfolge vollständig bestimmt ist |

Und der Planner liefert **alle** zulässigen Kandidaten, nicht nur den ersten.
Wer die Rangfolge anders sieht, sieht die Alternativen daneben — genau das kann
eine Zielfunktion nicht.

Aus Rang 1 folgt unmittelbar das Verhalten, das der Spike vermisst hat: Eine
Kreuzung zur Wunschzeit schlägt jede Verschiebung, weil ihre
Zeitlagenabweichung null ist.

### 9.2 Die drei Ausgänge

`Annahme` (die Wunschlage ist frei), `Alternativtrasse` (sie ist es nicht, aber
etwas innerhalb der zulässigen Abweichungen), `Ablehnung` (auch das nicht). Alle
drei tragen ihre Begründung; die einer Ablehnung ist immer der Prüfbericht der
Wunschlage. Das ist Abschnitt 2.7, ausbuchstabiert.

### 9.3 Was M3.4 bewusst nicht ist

Der Planner behandelt **einen** Antrag gegen ein bestehendes Belegungsbuch. Wie
mehrere konkurrierende Anträge eines Planungsfensters gemeinsam und
reihenfolgeunabhängig behandelt werden — Abschnitt 2.3 bis 2.5 —, ist der
deterministische `PlanningRun` aus M3.5, mit Seed-Tiebreak und Einspruchsfenster.
Der Planner ist dessen Baustein, nicht sein Ersatz.

---

## 10. Der deterministische Planungslauf (M3.5)

`crates/zugfolge-planner::run` beantwortet die Frage, die Abschnitt 9.3
offengelassen hat: Wie werden mehrere konkurrierende Anträge eines
Planungsfensters **gemeinsam** und **reihenfolgeunabhängig** behandelt?
`NetworkTimetable` (M3.2, `crates/zugfolge-conflict`) sagt es selbst offen: Es
ist „kein Vergabeverfahren" — wer zuerst eingereicht wird, bekommt die Trasse.
Genau das verbietet Abschnitt 2.4: „Reihenfolge innerhalb des Fensters und
Bezahlstatus beeinflussen das Ergebnis nicht."

### 10.1 Der gesamte Antragsbestand ist ein einziger Gleichstand

Der Kern kennt kein drittes Merkmal, das eine Bevorzugung rechtfertigen
könnte: Bezahlstatus ist verboten (Invariante 5), Ankunftsreihenfolge ist
verboten (Abschnitt 2.4). Das Markteintrittskontingent für neue EVU (E4,
Abschnitt 4) ist eine Entscheidung der Game-Services — der Kern weiß nichts
von EVU. Ohne ein zulässiges Unterscheidungsmerkmal ist die gesamte Menge der
Anträge eines Fensters deshalb ein einziger `Tie`: Ihre Kennungen werden
kanonisch sortiert — unabhängig davon, in welcher Reihenfolge sie dem Lauf
übergeben wurden — und dann über den Substream `Tiebreak` des `WorldSeed`
dieser Fahrplanperiode gemischt (Abschnitt 2.5). Das Ergebnis hängt damit
ausschließlich von der **Menge** der teilnehmenden Anträge und vom Seed ab,
nie von der Übergabereihenfolge — mit einem Gegenbeweis belegt: Derselbe
Antragsbestand liefert über zwanzig Perioden hinweg beiden Seiten eines
Widerstreits mindestens einmal den Zuschlag, nicht immer derselben Kennung.

### 10.2 Koordinierung, Alternativangebote, Einspruchsfenster

Ein Lauf verarbeitet jeden Antrag in dieser Reihenfolge gegen den
`TrainPathPlanner` aus M3.4 und trägt jedes angenommene Angebot sofort in ein
mitgeführtes Belegungsbuch ein, bevor der nächste Antrag geprüft wird — genau
der Tagesbereich, den der Planner selbst schon als konfliktfrei geprüft hat,
kein zweiter Durchlauf. Ein Antrag, den das Netz unabhängig von jeder
Konkurrenz nicht tragen kann — kein Laufweg, keine passende Zugsicherung —,
bricht den Lauf nicht ab; er zählt als eigener Ausgang (`unroutable`), nicht
als Ablehnung im Wettbewerb.

Das Ergebnis eines Laufs ist zunächst ein **Entwurf**: Wer eine
Alternativtrasse oder eine Ablehnung erhalten hat, kann binnen des
`ObjectionWindow` einen geänderten Antrag einreichen — etwa mit einer
weiteren zulässigen Abweichung. Die Kennung bleibt dabei dieselbe: Ein
Einspruch ändert einen bestehenden Antrag, er meldet keinen neuen an, und die
Menge der teilnehmenden Kennungen — und damit die Bearbeitungsreihenfolge aus
10.1 — bleibt über alle Runden eines Laufs unverändert. Der Lauf wird dann mit
demselben Seed erneut gerechnet: vollständig deterministisch, weil Seed und
Anträge zusammen den Ausgang bestimmen. Erst der Abschluss macht den letzten
Entwurf endgültig; danach nimmt der Lauf weder neue Einsprüche noch weitere
Koordinierungsrunden an.

### 10.3 Produktive Planning-Grenze und Bildfahrplanprojektion

Die produktive Koordinierung besteht aus drei strikt getrennten Verträgen:

1. `POST /worlds/:worldId/planning/path-requests` bindet jeden versionierten
   Trassenantrag serverseitig an die URL-Welt und das authentifizierte Konto.
   Zwei konkurrierende Antragsteller bleiben deshalb zwei getrennte,
   idempotente Command-Log-Einträge.
2. Der geschützte Authority-Aufruf `planning.coordinate/v1` enthält nur die
   beiden Request-IDs, Seed, erwartete Projektionsrevision und die ID eines
   serverseitig eingefrorenen Infrastruktur-Releases. Request- oder
   Infrastrukturfakten können nicht im Kommando unterschoben werden.
3. `packages/planning-worker` sperrt die Weltzeile, lädt beide Anträge und das
   konfigurierte Release, ruft den echten Rust-`PlanningRun` in
   `zugfolge-planning-runtime` auf und schreibt Commandstatus,
   `planning.runtime-state` und `planning.diagram` in derselben Transaktion.

Der generische Event-/Commandadapter weist diese Single-Writer-Typen ab. Eine
angebotene Alternative trägt eine stabile, an die Projektionsrevision
gebundene ID; `planning.apply-alternative/v1` wird erneut durch Rust angewandt.
Die Game-API liefert die Projektion als `{ sequence, data }`, und der Client
lädt nach `202 Accepted` so lange neu, bis eine höhere fachliche Revision
sichtbar ist. Bildfahrplan, alle sechs Sperrzeitphasen, Ressource, Zeitfenster,
beteiligte Zugfahrten, Konfliktart, Erklärung und Alternative entstehen aus
dieser Projektion. Feste Beispieldaten werden nur hinter dem ausdrücklich
gewählten Demo-Modus geladen und sind kein Normalpfad.

Das Planning-Addon wird fail-closed über einen absoluten Pfad geladen; es gibt
keinen JavaScript-Entscheider als Ersatz. Der Linux-NAPI-Job komponiert
PlanningRun, PGlite-Worker, Projektion, Apply und Replay gegen dasselbe gebaute
Addon.

### 10.4 Gebietsüberschreitende Fahrten und logische Spielerplanung (E25)

Ein GTFS-Zuglauf endet nicht künstlich am Kartenrand. Der jährliche
Releasebau kompiliert ihn als `JourneyChain`: bestellbare `PlayableLeg`
innerhalb des freigegebenen Betriebsgraphen wechseln an benannten
`BoundaryPortal` mit nicht disponierbaren `ExternalLeg`. Der Außenlauf besitzt
keine Kartenposition und keine scheinbare Außentrasse. Fahrzeug,
Personaldienst, Verspätung und Fahrtkennung bleiben bis zur Rückkehr oder bis
zum echten Außenende gebunden.

Für den Spieler bleibt der Antrag bewusst klein und verständlich. Er wählt
Laufweg, Halte und Zeitlage im Spielgebiet sowie höchstens die Kennung eines
angebotenen Grenzfensters. `packages/planning-worker` löst diese opaque Kennung
serverseitig im gepinnten InfraRelease auf. Erst danach erhält Rust die
unveränderlichen Ein- und Ausfahrfenster. Der Bildfahrplan zeigt Portal,
Sollzeit und zulässiges Band, kennzeichnet sie aber als feste Randbedingung.
Kandidaten außerhalb dieses Bands werden mit einer konkreten Erklärung
abgelehnt; der Client kann weder die Grenzzeit noch Außenkosten unterschieben.

Die `ExternalZone` ist während des Außenlaufs der deterministische Writer. Die
Quellregion entfernt den Zug erst nach bestätigter Annahme. Vor einer
Wiedereinfahrt prüft die Zielregion die ersten realen Konfliktressourcen. Sind
sie belegt, bleibt der Zug sichtbar am Portal außerhalb und wartet, statt eine
Belegung zu erzwingen. Nur vollständig qualifizierte Ketten mit benannten
Portalen sind bestellbar; ein bloß erkannter Schnitt ist Klasse C und bleibt
sichtbar, aber nicht bestellbar. Der vollständige Vertrag und seine
Konsequenzen stehen in [ADR-0025](adr/0025-gebietsueberschreitende-fahrtketten.md).

---

## 11. Die Fahrplanperiode als Ablauf (M3.6)

`crates/zugfolge-planner::period` bildet Abschnitt 3 als Wert statt als
Beschreibung ab: `SchedulePeriod` errechnet aus einem Startzeitpunkt und einer
Periodenlänge (E3: drei bis acht Wochen) die Grenzen ihrer vier Anteile —
Anmeldefenster, Koordinierung, Veröffentlichung, Betrieb — und die Phase, in
der ein gegebener Zeitpunkt liegt.

**Die Grenzen liegen in Achteln, ganzzahlig.** Ein Viertel und zwei Achtel und
eine Hälfte ergeben zusammen genau ein Ganzes (`2/8 + 1/8 + 1/8 + 4/8 = 8/8`).
Jede Grenze wird deshalb unabhängig als `Periodenlänge · Zähler / 8` in
Sekunden berechnet (Invariante 3: keine Gleitkommazahl) — bei einer
Periodenlänge, die nicht durch acht teilbar ist, rundet jede Grenze für sich
ab, statt einen Rest ungleichmäßig zu verteilen. Das ist keine Ungenauigkeit,
sondern die einzige Rundung, die nicht driftet: Eine Grenze, ein zweites Mal
berechnet, bleibt dieselbe. Alle Grenzen sind **halboffen**, wie jedes
Zeitintervall in diesem Kern — die Grenze selbst gehört bereits zur nächsten
Phase.

Jede Phase erlaubt genau eine Handlung: Das Anmeldefenster nimmt
`PathRequest`, die Koordinierung lässt einen `PlanningRun` laufen, die
Veröffentlichung ist das Fenster für den Rahmenvertragsabgleich (M3.8), und
der Betrieb öffnet die Ad-hoc-Vergabe (M3.7). Die Folgeperiode schließt
lückenlos an: Ihr Start ist exakt das Ende der vorigen — der
Fahrplanstichtag, ohne Lücke und ohne Überlappung.

---

## 12. Ad-hoc-Trassen aus Restkapazität (M3.7)

`crates/zugfolge-planner::adhoc` setzt Abschnitt 2.6 um: „Ad-hoc-Anträge
verwenden ausschließlich verbleibende Kapazität." Anders als der
`PlanningRun` verdrängt ein Ad-hoc-Antrag nie eine bereits liegende Trasse —
`AdHocLedger` prüft jeden Antrag gegen das laufend fortgeschriebene
Belegungsbuch der Periode, genau wie ein einzelner `TrainPathPlanner::plan`-Aufruf
es täte, und bucht ein angenommenes Angebot sofort, damit der nächste
Ad-hoc-Antrag dieselbe Kapazität nicht ein zweites Mal bekommt.

### 12.1 Stornierung

Eine stornierte Ad-hoc-Trasse gibt ihre Kapazität sofort frei. Das
Belegungsbuch wird dafür — wie `NetworkTimetable::withdraw` (M3.2) — aus dem
veröffentlichten Netzfahrplan und den verbleibenden Ad-hoc-Trassen neu
aufgebaut, statt einzelne Einträge herauszulösen: linear in der Zahl der
Trassen und ohne einen verwaisten Eintrag zurückzulassen.

### 12.2 Verfall bei Nichtnutzung

Abschnitt 4 (Kapazitätsschutz, E4): „**Use it or lose it** — unter einem
Nutzungsschwellwert liegende Trassen verfallen und lösen Stornoentgelt aus."
Das Stornoentgelt selbst ist eine wirtschaftliche Folge (`wirtschaft.md`) und
liegt außerhalb des Kerns; `AdHocLedger` liefert die technische Seite. Die
tatsächliche Nutzung beobachtet erst der Simulationskern (M4) — bis dahin
nimmt `report_usage` sie als gegebenen Wert entgegen, je Verkehrstag, ob
gefahren wurde oder nicht. `is_underused` vergleicht den Anteil in
Basispunkten (1 % = 100) gegen einen Schwellwert; eine Trasse ohne eine
einzige gemeldete Fahrt gilt **nicht** als unternutzt — sie hatte noch keine
Gelegenheit, genutzt zu werden. `sweep_underused` storniert alles, was
darunterbleibt, in einem Zug.

---

## 13. Rahmenverträge mit Kapazitätsdeckel (M3.8)

`crates/zugfolge-conflict::framework` setzt den Rahmenvertragsdeckel aus
Abschnitt 4 um: Ein `FrameworkAgreement` ist eine **mehrperiodige**
Kapazitätszusage — anders als eine einzelne Trasse (`ServicePattern`) bindet
er keine konkrete Zeitlage, sondern einen Anteil an einer Menge von
Konfliktressourcen, dem Korridor. Ohne diesen Deckel bänden Früheinsteiger
einen Korridor mehrperiodig vollständig, und kein Neuling käme je hinein —
das größte soziale Risiko einer Welt ohne Wipes.

**Die Kapazität eines Korridors ist ein vorgegebener Wert, keine Ableitung
dieses Moduls.** Wie viele Trassen ein Korridor trägt, hängt von Sperrzeiten,
Zugcharakteristik und Verkehrsmischung ab — das Ergebnis von M3.1 bis M3.4.
`FrameworkCapacityLedger::with_capacity` übernimmt diesen Wert je Ressource,
und der Deckel selbst rechnet in Basispunkten (1 % = 100), damit er
ganzzahlig bleibt (Invariante 3) — und **rundet ab**: Ein Deckel, der
aufrundet, wäre keiner.

Eine Bindung (`try_commit`) ist **alles oder nichts**: Nur Ressourcen, die
zum Korridor des Rahmenvertrags gehören, verbrauchen Kapazität, aber sprengt
eine einzige davon ihren Deckel, bindet die Trasse keine einzige — dieselbe
betriebliche Regel wie bei `NetworkTimetable::schedule` (M3.2): halb
angenommen gibt es nicht. `release` gibt zuvor gebundene Kapazität zurück,
etwa bei einer Trassenrückgabe.

Der Rahmenvertragsabgleich selbst — welcher `PathRequest` einem
`FrameworkAgreement` zugeordnet wird und wann das Kapazitätsbuch gegen den
`PlanningRun` geprüft wird — gehört zur Veröffentlichungsphase der
Fahrplanperiode (Abschnitt 11) und zu den Game-Services, die Rahmenverträge
als Vertragsobjekt führen (`wirtschaft.md`); der Kern liefert mit diesem
Modul nur den Deckel und seine Durchsetzung.
