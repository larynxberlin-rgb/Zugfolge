# M15 — Schaffnermodus

Vertragsversion: `zugfolge-conductor/v1`. Dies ist die bindende Spezifikation;
sie ist kein Nachweis bereits implementierter Sitzungen, Assets oder Betriebshalte.
Der Lieferumfang von M15.1/M15.2 und offene Gates stehen in der
[Teilabnahme](m15-abnahme.md).

Der Schaffnermodus ist eine optionale, serverautoritative Vertiefung des
regulären SPNV-Betriebs. Der Spieler betritt einen eigenen aktiven Zug in einer
orthogonalen Top-down-Pixelart-Ansicht, bewegt sich durch dessen Innenraum und
kontrolliert die tatsächlich aus dem Personenverkehrsmodell stammenden
Fahrgäste. Der Modus ist Teil des Hauptspiels und keine getrennte Spielwelt.

Diese Datei ist der kanonische Fachvertrag für M15. Die Querschnittsdokumente
verweisen hierher und wiederholen die Regeln nicht. Grundsatzentscheidung:
[ADR-0029](adr/0029-schaffnermodus-als-serverautoritative-betriebsvertiefung.md).
M15 bleibt geplanter Ausbau nach dem Alpha-Schnitt; der UI-Neuaufbau setzt
diesen Modus noch nicht um. Für seine spätere Oberfläche gelten
[Design](design.md) und [ADR-0035](adr/0035-deutschlandweite-spieleroberflaeche.md).

## 1. Produktziel und Grenzen

Der Modus soll Betrieb erlebbar machen und Entscheidungen mit sichtbaren
Folgen erzeugen. Er ist weder ein Fahrsimulator noch eine wirtschaftliche
Pflichtschleife.

- Einstieg erfolgt aus der privaten Zugdetailansicht eines eigenen, aktiven
  SPNV-Zuges. Geleaste Fahrzeuge zählen als eigene Betriebsleistung.
  Weltzugang und eigenes EVU müssen aktiv sein; ausgeschiedene oder gelöschte
  Unternehmen erhalten auch über die interne Projektionsgrenze keinen Zugriff.
- Die LiveMap bleibt der Ausgangspunkt der deutschlandweiten Spielwelt.
  Der spätere Modus öffnet den ausgewählten Zug und bietet einen klaren
  Rückweg zur Karte; eine zusätzliche regionale Welt oder ein sechster
  Hauptnavigationsbereich ist dafür nicht nötig.
- Fremdverkehre, Eigenbetrieb, Leerfahrten, Güterverkehr, SPFV und Außenläufe
  sind in M15 nicht betretbar.
- Der Spieler fährt den Zug nicht, stellt keine Signale und kann ihn nicht
  physisch verlassen.
- Die Weltzeit pausiert nicht. Fahrt, Halte, Verspätungen und Störungen laufen
  serverautoritativ weiter.
- Normale Gespräche und Kontrollen halten den Zug nicht auf. Nur eine
  serverseitig bindend angenommene Polizeianforderung kann am nächsten
  planmäßigen Fahrgasthalt
  einen zusätzlichen Betriebshalt auslösen.
- Nichtteilnahme erzeugt keinen Malus und keinen versteckten
  Wettbewerbsnachteil. Die positive Belohnung bleibt klein und gedeckelt.
- M15 ist Ausbau nach dem Alpha-Schnitt. Die erste Fassung gilt nur für SPNV;
  ein späterer SPFV-Schaffnermodus braucht einen eigenen Milestone-Schnitt.

## 2. Autoritäts- und Datenfluss

```text
M10 Personenverkehrsnachfrage
  -> PassengerManifestV1
  -> M15 sichtbare 1:1-Innenraumprojektion und Fahrgastdialog
  -> typisierte Spielerkommandos
  -> FareInspectionCaseV1 / FareControlHoldV1
  -> M8 Konfliktengine und virtuelle Fahrdienstleitung
  -> M4 Verspätungsfortpflanzung und Replay
  -> M10 neue Reise- und Anschlusslage
  -> M6 EconomyRelease und Ledger
```

Der Browser erhält nur eine Projektion. Er entscheidet weder über Fahrgastzahl
und Fahrberechtigung noch über Dialogausgang, EBE-Höhe, Betriebshalt,
Ressourcenbelegung, Abfahrtsrecht, Polizeireaktion oder Buchung.

Jeder zustandsführende Vertrag, jedes Kommando und jedes Event trägt Weltbindung
(`world_id` in Persistenz/Rust, `worldId` an der JSON-Grenze), explizite
Simulationszeit in ganzzahligen Millisekunden, Schema- beziehungsweise
Releaseversion und eine stabile Kausalitätskennung. Unterobjekte erben diese
Bindung ausschließlich aus ihrem validierten Container; sie dürfen nicht
weltlos einzeln übernommen werden. Geld ist Integer-Cent, Innenraumpositionen
sind Integer-Millimeter. JSON-Werte müssen sichere Ganzzahlen sein. Im
Simulationskern gibt es kein `now()`, keine Gleitkommazahl im zustandsrelevanten
Pfad und keinen Datenbankzugriff. Unbekannte Schemas, Felder, Referenzen und
Releasebindungen werden abgelehnt.

Eine reine Ableitung besitzt keinen eigenen Geschäftsübergang. Ihre
`demandStateHash`-/`operationalReceiptId`-Bindung verweist auf den verursachenden
M10-/Betriebsbeleg; sie erzeugt kein zusätzliches Domain-Event nur für einen
Leseaufruf. Assetdefinitionen erhalten ihre Weltbindung erst beim Pin der Welt.

### 2.1 Nachvollziehbare Aktions- und Autoritätsgrenzen

Die folgende Matrix definiert die erforderlichen Domainübergänge. Die
Ereignisnamen sind der M15-Vertrag für die folgenden Arbeitspakete, keine
Behauptung einer bereits vorhandenen produktiven Ereigniskette.

| Sichtbarer Vorgang | Source of Truth und Eingang | Domain-Event / Ergebnis | Ressourcenwirkung | Buchung |
|---|---|---|---|---|
| Eigenen Zug betreten | M2-Zugang, M4-Zuglauf, M5-Nutzungsrecht, M10-Manifest; Sitzungsanlage | `ConductorSessionStarted` | Keine neue Betriebsbelegung | Keine |
| Fahrgäste erscheinen, steigen ein oder aus | M10 und bestätigter M4-Betriebsfortschritt; Projektion ohne Spielerkommando | `demand.evaluated` → `PassengerProjectionV1` | Übernimmt den belegten Zug, ändert keine Zugkapazität | Keine |
| Im Zug bewegen | M15-Sitzungszustand und M5-abgeleitetes Layout; `move` | `ConductorPositionChanged` | Nur Innenraumkollision, keine Gleis- oder Signalentscheidung | Keine |
| Fahrkarte prüfen | M10-Sachverhalt, M15-Kontrollzustand; `start_inspection` | `FareInspectionStarted` | Keine zusätzliche Haltezeit | Keine |
| Nachfragen oder Kontrolle ohne Maßnahme beenden | Gepinnter Dialog, verdeckter Fall; `choose_dialogue_option` | `PassengerEncounterAdvanced` / `FareInspectionClosed` | Die Weltzeit läuft weiter; kein Abfahrtsverbot | Keine |
| Reguläre oder vorläufige EBE ausstellen | M15-Feststellung und M6-Tarif-/Wirtschaftsregeln; zulässige `choose_dialogue_option` | `FareClaimOpened` | Kein Betriebshalt | Einmalige offene Forderung durch M6 |
| Polizei anfordern | M15-Fall, M4-Zielhalt und Weltpolicy; `request_police` | `FareControlHoldRequested` | Bindende künftige Warteentscheidung; noch kein Anhalten auf Strecke | Keine sofortige Zahlung oder Prämie |
| Zusätzlicher Aufenthalt am Zielhalt | M8-Abfahrtsprüfung und M4-Istlage; expliziter Simulationsfortschritt | `FareControlHoldActivated`, `DepartureAuthorityWithheld` | Tatsächliche Ressourcen bleiben belegt | Kosten-/Verspätungsbelege für spätere M6-Abrechnung |
| Polizeivorgang oder Höchstwartezeit endet | Gepinnte M15-Reaktion und explizite Zeit | `PoliceResponseResolved`, `FareControlHoldReleased` | Wartegrund entfällt; M8 muss erneut Abfahrt erlauben | Fallabschluss ist Eingabe der M6-Abrechnung |
| Folgezüge warten, Anschlüsse ändern sich | Gemeinsame M8/M4-Ressourcenautorität, danach M10 | Bestehende Belegungs-/Verspätungsereignisse, revidiertes `demand.evaluated` | Normale Priorisierung aller EVU und Zugarten | M6 bewertet nachgewiesene Vertragsfolgen und Pönalen |
| Späterer Nachweis, Zahlung oder Ausfall | Gepinnter Fall und `EconomyRelease`; fälliger Weltzeitpunkt | `FareClaimReduced`, `FarePaymentReceived`, `FareClaimWrittenOff`, `FareControlRewardSettled` | Keine | Ausgeglichene, idempotente M6-Buchung nach Abschnitt 10 |
| Zur Karte zurückkehren, Lease ablaufen oder Fahrt beenden | M15-Sitzung; `end_session` oder expliziter Ablauf | `ConductorSessionEnded` | Bindender Halt und bestehende Ressourcen bleiben bestehen | Bereits entstandene Forderungen bleiben bestehen |

Abgelehnte Kommandos erzeugen weder Fachzustand noch Buchung. Die
autorisierende Stelle darf ihren Erfolg erst nach atomarem Zustands-/Eventcommit
quittieren. M15 kann keine Abfahrtsfreigabe, Nachfragekorrektur oder Ledgerzeile
direkt setzen. Die technische Ausführung der M8/M4-Regeln folgt der gemeinsamen
[Operational-v2-Betriebsengine](betriebsengine.md); eine zweite M15-Engine ist
ausgeschlossen.

## 3. Erweiterung des Personenverkehrsmodells M10

M10 liefert das gemeinsame Personenverkehrsnachfragemodell für SPNV und SPFV.
Der versionierte Eingang steht in [Personenverkehr](personenverkehr.md). Es bleibt die
einzige fachliche Quelle für Reisen, Zugwahl, Ein- und Aussteiger, Auslastung
und objektiven Fahrberechtigungsstatus. M15 darf keine zusätzlichen Fahrgäste
oder Fälle ohne Fahrberechtigung erfinden.

### 3.1 PassengerManifestV1

M10 erzeugt pro Zuglaufabschnitt ein unveränderliches `PassengerManifestV1`:

| Feld | Bedeutung |
|---|---|
| `worldId` | Weltbindung |
| `demandReleaseId` | gepinnter M10-Release |
| `trainRunId` / `segmentId` | konkreter Zuglaufabschnitt |
| `revision` | monotone Revision nach Betriebsänderungen |
| `passengerKey` | stabile, pseudonyme Identität innerhalb der Reisekette |
| `boardingStopId` / `alightingStopId` | Ein- und Ausstieg |
| `journeyChainId` | Verbindung über mögliche Umstiege |
| `demandSegment` | Reiseanlass und Nachfragekohorte ohne Realpersonenbezug |
| `comfortClass` | gebuchte Komfortklasse |
| `spaceNeeds` | Rollstuhl-, Kinderwagen-, Fahrrad- oder sonstiger Platzbedarf |
| `fareFact` | gültig, gültig aber momentan nicht vorzeigbar oder ungültig |
| `farePolicyProvenance` | `observed` oder `balanced` |

Die Tabelle beschreibt Container und Fahrgasteinträge zusammen. Die konkreten
Feldnamen, Schachtelung und Fahrberechtigungswerte folgen dem M10-Vertrag;
M15 definiert keinen zweiten Manifesttyp. Eine Revision ersetzt den aktuellen
Snapshot atomar, verändert jedoch keine vorherige Revision im Journal.

`projectionMode = forecast` ist ausschließlich Prognose. Selbst nach Ablauf
der Planabfahrt ist sie kein Beweis eingestiegener Personen. Eine tatsächliche
Innenraumprojektion verlangt ein `progress_bound`-Ergebnis mit passenden
`DemandOperationalProgressV1`-Haltquittungen. Fehlende oder widersprüchliche
Quittungen sperren die Tatsachendarstellung; weder Browserzeit noch ein
planmäßiger Streckenabschnitt ersetzen sie.

M10 darf die Gesamtnachfrage als Kohorten berechnen. Einzelne
`passengerKey`-Werte werden für einen konkreten Zuglauf deterministisch aus
Kohorte und laufender Nummer materialisiert; Millionen dauerhafte
Personendatensätze sind nicht erforderlich. Sobald eine Kontrolle beginnt,
entsteht ein persistenter `FareInspectionCaseV1`.

Ausfälle, geänderte Halte, Kapazitätsgrenzen und verpasste Anschlüsse werden
zuerst im Betrieb und danach in M10 verarbeitet. M15 erhält eine revidierte
Manifestprojektion. Ein bereits begonnener Fall bleibt über den
`passengerKey` konsistent.

### 3.2 FareCompliancePolicyV1

Eine `FareCompliancePolicyV1` ist Teil des gepinnten `DemandRelease`. Sie legt
die Verteilung der Fahrberechtigungszustände deterministisch gemäß dem
M10-Vertrag fest. Tarif- und Vertriebsfakten beeinflussen die Reise- und
Erwerbslage, erzeugen aber keine zweite Kontrollverteilung.
Belastbare, rechtlich freigegebene Daten werden als
`observed` ausgewiesen; ersatzweise verwendete Spielwerte heißen sichtbar
`balanced` und dürfen nicht als reale Schwarzfahrerstatistik bezeichnet
werden. Erscheinungsbild, Alter, Geschlecht, Herkunft, Behinderung oder andere
geschützte Merkmale beeinflussen den Status nie.

### 3.3 PassengerProjectionV1: Übergabe an den Innenraum

`ProjectConductorPassengersInputV1` enthält die serverseitige
`ConductorPassengerBindingV1`, das vollständige `DemandEvaluationV1`, den
zugehörigen `TrainServiceV1`, `InteriorPassengerPlacesV1` und optional die
bisherige `PassengerProjectionV1`. Die Bindung pinnt Welt, Periode, M10-Release
und -Seedhash, Zuglauf, EVU, Revision, Nachfragezustand und Betriebsquittung.
Ein selbst angegebener Hash ist kein Herkunftsnachweis. Nur der autorisierte
Plattformdienst darf diese Eingänge aus committed Weltzuständen zusammenstellen;
Clientparameter dürfen weder Manifest noch Layout oder Vorprojektion ersetzen.

Der reine Rust-Projektor ermittelt den aktuellen Zugabschnitt aus den
tatsächlichen Haltquittungen. Er prüft die M10-Erhaltung und übernimmt genau
dessen Personen, Komfortklasse, Platzbedarf und Sitz-/Stehplatzzuteilung. Er
erzeugt keine Nachfrage, Tarifverteilung, Betriebsquittung oder Geometrie.
Fehlende Plätze, doppelte Kennungen, falsche Bindungen und widersprüchliche
Abschnittsbelegung führen zum Fehler, niemals zur Kürzung des Manifests.

`InteriorPassengerPlacesV1` ist die schmale M15.2-Eingangsgrenze für das in
M15.4 zu erzeugende Layout: stabile Platz- und Fahrzeugkennungen, ganzzahlige
Millimeterposition, Sitz/Stehplatz, Komfortklasse und zulässiger Sonderbedarf.
Der Kapazitätsnachweis muss den verwendeten M10-Angebotsfakten entsprechen.
Ein technisch gültiges Platzinventar ersetzt keinen Nachweis seiner Herkunft
aus der wirklichen Fahrzeugkonfiguration.

M15.4 ergänzt mit `InteriorPassengerPlacesV2` und `PassengerProjectionV2`
ausdrückliche Wagenkasten- und Deckkennungen. V1 und dessen Hashvertrag bleiben
unverändert. Der formationsbezogene Layoutbau und die erst anschließend
zulässige, serververtrauenswürdig belegte Zuglaufbindung stehen in
[`conductor-interior.md`](conductor-interior.md) 3 und 7.

`PassengerProjectionV1` enthält ausschließlich sichtbare Fahrgastdaten:
`passengerKey`, `placeId`, `vehicleId`, `xMm`, `yMm`, `comfortClass`,
`spaceNeeds`, `posture`, `appearanceVariant` und `activity`, außerdem die
gemeinsame Zustandsbindung, Abschnitt, Phase, expliziten Zeitstand und
Integritätshash. Personenzahlen werden exakt aus dieser Liste gelesen.
`fareFact`, `journeyChainId`, Reiseanlass,
Tarifgewichte, Seed und zukünftige Dialoge gehören nicht in den Clientzustand.
Die synthetischen Fahrgastkennungen sind nur über die private, autorisierte
Zugansicht zugänglich; öffentliche Belegungsansichten bleiben aggregiert.

Verbleibende Fahrgäste behalten bei Abschnitts- oder Nachfragewechsel ihren
passenden Platz aus der vorherigen Projektion, soweit die vollständige neue
Belegung damit zulässig ist. Neue Fahrgäste erhalten freie, passende Plätze
deterministisch; Eingabereihenfolge darf die Zuteilung nicht beeinflussen.
Blockiert ein Fahrgast ohne Sonderbedarf den einzig passenden Sonderplatz,
darf eine deterministische Umplatzierung einen freien kompatiblen Platz für
ihn nutzen. Kein Fahrgast verschwindet dabei; unveränderte Belegungen bleiben
stabil, erforderliche Ortsänderungen erscheinen in der neuen Projektion.
Die bisherige Projektion und ihre Bindung sind Teil des Restores.
Ein Integritätshash erkennt beschädigte Snapshots, authentifiziert
aber keine vom Browser eingesandten Daten. Geschütztes Erscheinungsbild und
Fahrberechtigung besitzen keine kausale Kopplung; die Darstellung verwendet
einen getrennten, ausschließlich visuellen Hash-Teilstrom.

Die Revision ersetzt die vollständige logische Personenmenge atomar. Eine
spätere Renderansicht darf Figuren außerhalb des Ausschnitts ausblenden oder
Animation vereinfachen; sie muss jede Person weiter adressieren und erreichen
können. Kollisionsfreie Wege und Interaktionsreichweite sind der nachgelagerte
M15.4-/M15.8-Nachweis, kein Resultat des Platzprojektors allein.

Die Transportschemas heißen `conductor-passenger-projection-input/v1`,
`interior-passenger-places/v1` und `passenger-projection/v1`. Vor der ersten
bestätigten Abfahrt ist kein belegter Abschnitt verfügbar. Bei bestätigter
Ankunft vor der nächsten Abfahrt bleibt die ankommende Personenmenge erhalten;
`phase = at_stop` und `activity = alighting` kennzeichnen beginnende Ausstiege.
Diese Personen dürfen nicht erneut kontrolliert werden. Die bestätigte
Weiterfahrt wechselt atomar auf den folgenden Abschnitt und dessen
Ein-/Aussteiger. Nach bestätigter Endankunft liefert der Projektor
`train_completed`; der spätere Sitzungsdienst beendet die Sitzung kontrolliert.
M15.2 behauptet keine zusätzliche Tür- oder Boardingquittung.

Die V1-Grenze akzeptiert höchstens 128 MiB JSON, 100 Halte je Zug,
300.000 Innenraumplätze und insgesamt eine Million Manifesteinträge.
Die M10-Kapazitätsfelder sind jeweils auf 100.000 begrenzt; Sitz-, Steh-
und Premiumplätze müssen dem Platzinventar exakt entsprechen. Jeder Platz
besitzt ein bis vier eindeutige zugelassene Bedarfe. Diese technischen
Obergrenzen sind keine Freigabe einer entsprechenden realen Formation.
Der bestehende Plattform-Checkpoint behält seine engere 16-MiB-Grenze.
Kennungen umfassen höchstens 128 UTF-8-Bytes ohne Steuerzeichen, Hashes
64 kleingeschriebene Hexadezimalzeichen. Zeiten und nichtnegative
Millimeterkoordinaten bleiben sichere JSON-Ganzzahlen bis 2^53−1.

Der Layouthash ist SHA-256 über den vollständigen V1-Datensatz in der
Feldreihenfolge seines Rust-Vertrags, mit leerem `layoutHash`, nach `placeId`
sortierten Plätzen und sortierter Bedarfsliste. Der Projektionshash verwendet
entsprechend den vollständigen Datensatz mit leerem `stateHash`; die Ausgabe
sortiert Fahrgäste nach `passengerKey`. Die Darstellung zieht aus dem
getrennten Teilstrom `conductor_appearance_v1` eine Variante von 0 bis 255.
Diese Kennung bezeichnet noch kein freigegebenes Grafikasset. Platzwahl
verwendet den eigenen Teilstrom `conductor_places_v1`. Identische Eingänge
erzeugen identische Ergebnisse ohne Systemzeit oder Zufallsquelle.

## 4. Zug, Sitzung und Fahrgastprojektion

### 4.1 Berechtigung und Exklusivität

- Je Zug existiert höchstens eine aktive `ConductorSessionV1`.
- Je Spieler ist höchstens eine Schaffnersitzung gleichzeitig zulässig.
- Zuschauer und Koop sind nicht Teil von M15.
- Der Server prüft bei jedem Kommando Weltzugang, EVU, Zuglauf und fortbestehende
  Nutzungsberechtigung erneut.
- Reconnect und Seitenneuladen stellen Spielerposition, Zugzustand,
  Manifestrevision und aktiven Dialog wieder her.
- Fahrtende oder entfallende Nutzungsberechtigung beendet die Sitzung
  kontrolliert. Ein bereits bindender Betriebshalt bleibt bestehen.
- Neue Spielangebote besitzen nach E33 keine Außenläufe. Nur ein historischer
  Replay mit `ExternalLeg` verwendet den alten kontrollierten Sitzungsabschluss;
  M15 führt keinen neuen Außenlaufpfad ein.

Die Sitzung führt `sessionId`, `worldId`, `operatorId`, `accountId`,
`trainRunId`, Revision, expliziten Zeitstand, Spielerposition, Manifest- und
Projektionsbindung, aktiven Fall, Releasepins, Lease-Ende und SSE-Sequenz.
`active` kann durch Verbindungsverlust zu `detached` werden; nur derselbe
berechtigte Spieler darf innerhalb der Lease dieselbe Sitzung fortsetzen.
`ended` ist endgültig. Eine getrennte Sitzung reserviert bis zum expliziten
Lease-Ende weiterhin Zug und Spieler. Ein zweiter Browser erhält keine zweite
Sitzung und keinen zweiten Dialogfortschritt. Lease-Dauer und Kommandogrenzen
sind versionierte Weltparameter; eine Clientuhr verlängert sie nicht.

Erneuter Einstieg und jedes Kommando prüfen die Berechtigung im selben
serialisierten Weltübergang wie die Mutation. Gleicher Idempotenzschlüssel
und gleicher Inhalt liefern das ursprüngliche Ergebnis; anderer Inhalt unter
derselben Kennung wird abgelehnt. Eine veraltete Revision erfordert einen neuen
Snapshot. Fehlende SSE-Sequenzen werden aus dem Journal nachgeliefert oder
durch einen vollständigen Snapshot ersetzt. Offline-Kommandos werden nicht
nachträglich gegen einen inzwischen anderen Fahrgastzustand ausgeführt.

### 4.2 1:1-Darstellung

Jeder im Manifest enthaltene Fahrgast ist logisch vorhanden, besitzt einen
deterministischen Innenraumplatz und bleibt kontrollierbar. Bei hoher Belegung
dürfen Renderanimationen, Überlagerung und Detailstufe vereinfacht werden; die
Personenzahl und fachlichen Fälle werden nie reduziert. Sichtbare Merkmale und
Spritevarianten werden unabhängig vom `fareFact` erzeugt.

Beginnt ein Fahrgast seinen Ausstieg, kann keine neue Kontrolle gestartet
werden. Verlässt ein noch nicht abgeschlossener Fahrgast den Zug ohne bindenden
Polizeifall, endet die Kontrolle ohne Forderung. Das erzeugt den Zeitdruck des
Minigames, ohne den Betrieb künstlich anzuhalten.

## 5. Bildsprache, Asset-Korpus und Innenräume

### 5.1 Eigene Pixelart

Der vollständige Motivekatalog, der `ArtAtlasManifestV1`-Vertrag und die
getrennten Raster-, Bild-, Herkunfts- und Freigabegates stehen kanonisch in
[Pixelart-Korpus und Atlas](art-atlas.md). Die folgenden Punkte benennen die
grundsätzliche Gestaltung und Autoritätsgrenze.

- orthogonale Draufsicht mit 32 Pixeln pro Meter;
- ganzzahlige Zoomstufen und Nearest-Neighbor-Skalierung;
- dunkle Graphitflächen und eigene rote Bahnmarke gemäß dem gemeinsamen Design;
- eigenständige Zug- und Innenraummotive mit gut lesbaren Konturen;
- Betriebszustände zusätzlich durch Symbole, Text oder Muster erklären;
- keine Übernahme fremder Figuren, Karten, Fahrzeuge, Gebäude, Logos oder
  Marken.

Die externe historische Top-down-Referenz dient nur der Kamera- und
Lesbarkeitsidee. Produktionsdokumente, Assetnamen und Generierungsanweisungen
beschreiben ausschließlich die eigenständige Zugfolge-Gestaltung.

Alle sichtbaren Motive werden als finale Grafiken erzeugt: Fahrgäste und
Bewegungsphasen, Innenraummodule, Türen, Sitze, Mehrzweckbereiche, WCs,
Führerstände, Bahnsteige, Dächer, Hallen, Treppen, Unterführungen, Vegetation,
Straßen, Gebäude, Signale und Umgebungsobjekte. Zur Laufzeit findet keine
Bildgenerierung statt.

`ArtAtlasManifestV1` pinnt je Asset Generierungsanweisung, erlaubte Referenzen,
Modellversion, Prüfsumme, Abmessungen und Freigabestatus. Zulässige technische
Nachbearbeitung beschränkt sich auf Freistellung, Rasterausrichtung,
Palettenquantisierung, Größenprüfung, Pivot- und Kollisionspunkte,
Atlasbildung und Kompression. Ein inhaltlich ungeeignetes Motiv wird neu
erzeugt statt manuell umgezeichnet.

### 5.2 InteriorLayoutV1

`InteriorLayoutV1` beschreibt die begehbare Geometrie in Millimetern und wird
deterministisch aus der tatsächlichen Formation und Fahrzeugkonfiguration
abgeleitet:

- Wagenkästen, Übergänge und Türen;
- Sitz-, Steh-, WC-, Fahrrad-, Mehrzweck- und Barrierefreiheitsbereiche;
- Begehbarkeitsnetz, Kollisionen und Interaktionspunkte;
- Kapazitätsnachweis gegen das Manifest.

Die Innenräume sind konfigurationsgetreu, aber keine exakte Nachbildung realer
Baureihen. Ein Fahrzeug mit unvollständiger Konfiguration ist nicht betretbar
und nennt den fehlenden Konfigurationsnachweis.

Der vollständige versionierte Vertrag für M5-Konfigurationsbelege, generische
Geometrieprofile, lokale Kasten-/Deckkoordinaten, Treppen, Kollisions- und
Kapazitätsprüfungen steht in [`conductor-interior.md`](conductor-interior.md).
Das Layout bindet eine wirkliche Formation; eine konkrete Zuglaufzuordnung
kommt erst aus einer gesondert geprüften serverseitigen Bindung. Getrennte
Passagierbereiche werden ohne belegten Gangübergang nicht durch Teleportieren
verbunden, sondern für diesen Innenraumvertrag abgelehnt.

## 6. Fahrt, Umgebung und Stationen

Ein releasegebundener ganzzahliger `urbanityBasisPoints`-Wert mischt Umland,
Vorstadt und Stadt kontinuierlich. Die Umgebung bewegt sich relativ zur
tatsächlichen Geschwindigkeit. Tageszeit beeinflusst Beleuchtung und Fenster;
Wetter ist nicht Teil von M15. Planmäßige Halte, Signalhalte und zusätzliche
Betriebshalte stoppen die Bewegung entsprechend dem Simulationszustand.
Signalbilder sind reine Darstellung und nicht bedienbar.

`StationSceneV1` kennt drei Klassen:

| Bahnhofskategorie | Szene |
|---|---|
| 1–2 | groß |
| 3–5 | mittel |
| 6–7 | klein beziehungsweise Haltepunkt |

Fehlt eine freigegebene Kategorie, wird die Klasse aus Betriebsstellenart,
Bahnsteigzahl und Bedienumfang abgeleitet und als `derived` gekennzeichnet.
Stationen werden aus generierten Modulen zusammengesetzt; die Betriebsstellen-ID
wählt stabile Varianten. Es wird keine reale Architektur behauptet. Der
Stationsname ist die einzige ortsspezifische grafische Identität. Eine
Bahnsteigbezeichnung darf als betrieblicher Text erscheinen. Lange Namen,
Umlaute und mehrzeilige Beschriftungen müssen vollständig lesbar bleiben.

## 7. Dialoge und Sprechblasen

### 7.1 Bedienung

- Die aktive Fahrgastäußerung erscheint als Sprechblase oberhalb der Figur.
- Antwortmöglichkeiten erscheinen als sprechblasenförmige Schaltflächen nahe
  der Spielerfigur.
- Die ausgewählte Antwort wird kurz als eigene Blase gezeigt, danach folgt die
  Reaktion des Fahrgasts.
- Es gibt höchstens ein aktives Gespräch. Andere Fahrgäste zeigen nur ein
  Interaktionssymbol und erzeugen kein Ambient-Blasenrauschen.
- Es gibt keinen Freitext, keine Spracheingabe und kein Laufzeit-Sprachmodell.
- Ein Gespräch umfasst normalerweise zwei bis drei Blasenwechsel.
- Bei `prefers-reduced-motion` erscheint Text sofort. Screenreader erhalten
  denselben Dialog über Live-Region und reguläre Auswahlschaltflächen.

Die geplante Ansicht nutzt den verfügbaren Bildschirm für Innenraum und
Gespräch; längere Falldetails öffnen sich bei Bedarf. Rückweg, nächster Halt
und laufende Betriebsabweichungen bleiben erreichbar. Spieleraktionen heißen
beispielsweise „Fahrkarte prüfen“ oder „Kontrolle beenden“; Vertragskennungen
und technische Revisionsdaten gehören nicht in die erste Dialogebene.

### 7.2 Verdeckter Sachverhalt

Der Server hält vier voneinander getrennte Merkmale:

| Merkmal | Beispiele |
|---|---|
| `FareFact` | gültig, gültig aber nicht vorzeigbar, ungültig |
| `Presentation` | leeres Handy, technische Störung, Zugeben, Ausrede, Schweigen, Verweigerung, Betrunkenheit |
| `Tone` | freundlich, neutral, ungeduldig, unfreundlich |
| `Cooperation` | kooperativ, ausweichend, Identitätsverweigerung, konkrete Gefahr |

Betrunkenheit beeinflusst Sprache, Reaktionszeit und Kooperation, ist aber
weder Beweis für eine fehlende Fahrberechtigung noch alleiniger Grund für eine
Polizeianforderung. Nachfragen verbrauchen Zeit und liefern Hinweise, decken
den objektiven Sachverhalt aber nicht automatisch auf.

Kontextabhängige Spielerentscheidungen sind erneutes Nachfragen oder ein
technischer Wiederholungsversuch, Beenden ohne Maßnahme, reguläre oder
vorläufige EBE und — ausschließlich bei Identitätsverweigerung oder konkreter
Gefahr — eine Polizeianforderung.

### 7.3 DialogueReleaseV1

Der erste signierte `DialogueReleaseV1` enthält mindestens 150 vollständige
Dialogbäume und 600 unterschiedliche Fahrgastäußerungen in mindestens zwölf
Situationsfamilien. Dazu gehören unter anderem leeres oder defektes Handy,
technisches Problem, freundliches Zugeben, Missverständnis, Ausrede,
Geldmangel, Schweigen, unfreundliche Reaktion, vollständige Verweigerung,
kooperative Betrunkenheit und sicherheitsrelevante Eskalation.

Die Texte werden offline erzeugt, strukturell vollständig validiert und
redaktionell stichprobenartig abgenommen. Gates verhindern diskriminierende
Zuschreibungen, reale Personen oder Marken, Kopplung geschützter Merkmale an
den Ticketstatus, grundlose Polizeieskalation, ungültige Platzhalter,
überlange Blasen und unerreichbare Dialogenden.

Die Auswahl erfolgt über den Seed-Teilstrom `fare_dialogue` aus Welt, Periode,
Zuglauf und `passengerKey`. Reload und Replay liefern denselben Dialog. Eine
laufende Begegnung behält ihren gepinnten Release über einen Periodenwechsel.

## 8. Kontrolle, EBE und Fallabschluss

Das erhöhte Beförderungsentgelt wird als EBE beziehungsweise Forderung
bezeichnet, nicht als Bußgeld. Die Grundforderung beträgt das Doppelte des
gewöhnlichen Fahrpreises der belegten Strecke, mindestens 60 Euro. Wird ein
bei der Kontrolle gültiger Fahrausweis innerhalb einer Woche nachgewiesen, wird die Forderung
automatisiert auf 7 Euro reduziert. Grundlage ist
[§ 6 EVO](https://www.gesetze-im-internet.de/evo_2023/__6.html).

Der Fall trennt `open`, `closed_without_claim`, `claim_open` und
`settled`. `claim_open` kann regulär oder vorläufig sein. Der gespeicherte
Kontrollbeginn pinnt Fahrgast, Zugteilreise, Manifestrevision, objektiven
Sachverhalt, offenbare Hinweise, Dialogrelease, Tarifbasis, Nachweisfrist und
Kausalitätskennung. Ein späterer Nachfrage- oder Periodenwechsel darf diese
Fakten nicht rückwirkend verändern. M15 erfasst keine echten Namen,
Ausweisnummern oder Adressen; eine Identitätsfeststellung ist ein synthetisches
Ergebnis des Falls.

Ein reiner Vertriebsausfall oder eine technische Präsentationsstörung beweist
keine fehlende Fahrberechtigung. Die Erwerbsausnahme aus § 6 Absatz 4 EVO wird
als eigener, aus den gepinnten Vertriebsfakten belegter Befund berücksichtigt;
sie darf nicht aus Aussehen, Dialogton oder einer bloßen Behauptung abgeleitet
werden. Fehlt die notwendige Tarif-/Erwerbslage, wird keine reguläre Forderung
behauptet. Die Nachweisfrist verwendet explizite Weltzeit und die gepinnte
Tagesdefinition. Ein Nachweis des bei der Kontrolle gültigen Fahrausweises
innerhalb dieser Frist reduziert auch bei späterer automatisierter Verarbeitung.

Eine EBE wird zunächst als offene Forderung gebucht. Zahlung, Reduzierung,
Bearbeitungskosten und Zahlungsausfall folgen später deterministisch aus dem
gepinnten `EconomyRelease`. Eine vorschnell ausgestellte oder nicht feststellbare
Forderung kann reduziert, abgeschrieben oder mit Bearbeitungskosten belastet
werden.

## 9. FareControlHoldV1 und betriebliche Wirkung

### 9.0 FareControlPolicyV1

Die Welt pinnt vor Aktivierung einen unveränderlichen Vertrag mit folgenden
Pflichtfeldern. Es gibt keinen stillen Standard bei fehlender Policy.

| Feld | Verbindliche Bedeutung |
|---|---|
| `schema`, `policyId`, `revision` | `zugfolge-fare-control-policy/v1`, stabile Kennung und positive Revision |
| `worldId`, `schedulePeriodId`, `contentHash` | Welt-/Periodenpin und Prüfsumme der freigegebenen Policybytes |
| `maxPoliceHoldsPerTrainRun` | In V1 genau `1`, unabhängig von Spieler- oder Sitzungswechsel |
| `eligibleReasons` | Genau `identity_refusal` und `concrete_danger`; Betrunkenheit oder ungültiges Ticket allein reichen nicht |
| `targetRule` | `next_unreached_scheduled_passenger_stop`; kein Streckenhalt oder erfundener Ersatzbahnhof |
| `providerByStopId` | Freigegebene Zuständigkeit für den konkreten Zielhalt; fehlender Eintrag sperrt die Anforderung |
| `maxWaitMs` | Positive sichere Ganzzahl; maximale zusätzliche Wartezeit ab betrieblicher Aktivierung |
| `policeResponseModelId`, `policeResponseModelHash` | Gepinntes lokales Modell für Verfügbarkeit, Reaktionszeit und Ergebnis; Auswahl aus benanntem Seed-Teilstrom |
| `publicCause` | Genau `authority.police.fare-control`; öffentliche Texte bleiben datensparsam |

Eine laufende Anforderung behält ihre Policy und ihr Reaktionsmodell auch
über den Periodenwechsel. Die neue Periode darf weder einen zweiten Halt für
denselben Zuglauf erlauben noch die alte Höchstwartezeit verlängern. Ein
Polizeimodell definiert ganzzahlige Wahrscheinlichkeiten in Basispunkten und
Weltzeitdauern, keine externen Dienstaufrufe oder Echtzeitverfügbarkeitsabfrage.
Tarifbeträge und Belohnungssätze bleiben ausschließlich im `EconomyRelease`.

### 9.1 Anforderung und Bündelung

`request_police` erzeugt keinen Halt auf freier Strecke. Der Server bestimmt
als Ziel den nächsten planmäßigen Fahrgasthalt, den der Zug noch nicht erreicht
hat. Die Aktion ist nur verfügbar, wenn ein offener Fall eine konkrete
Identitätsverweigerung oder Gefahr trägt, der Zielhalt innerhalb des
spielbaren Laufabschnitts liegt und die Welt einen zuständigen Anbieter sowie
eine maximale Wartezeit definiert.

Der erste Release erlaubt höchstens einen Polizeihalt je Zuglauf. Mehrere bis
zum Zielhalt offene, geeignete Fälle werden in diesem Halt gebündelt. Diese
Grenze schützt das gemeinsame Netz vor absichtlicher Kettenblockade und liegt
versioniert in `FareControlPolicyV1`.

Nach Bestätigung entsteht ein bindendes `FareControlHoldV1` mit `worldId`,
Zuglauf, Fallkennungen, Zielhalt, Anforderungszeit, Ursache
`authority.police.fare-control`, maximaler Wartefrist, deterministischem
Polizeiergebnis, Zustandsrevision und Kausalitätskennung. Sitzungsende,
Reconnect oder Browserabbruch heben ihn nicht auf.

Der Haltzustand ist `requested` → `active` → `released`; ein vor Aktivierung
entfallener Zielhalt oder Fahrtabbruch beendet die Anforderung mit erklärtem
Ergebnis `target_unavailable`. Das verbraucht die einmalige Anforderung des
Zuglaufes; M15 sucht nicht eigenmächtig einen anderen Zielhalt. Der autoritative
Betrieb entscheidet weiterhin über eine sichere Räumung oder Ersatzplanung.
Ein aktiver Halt wird durch UI-Abbruch niemals freigegeben. Aktivierung und
Höchstwartefrist beziehen sich auf explizite Ist-Betriebsbereitschaft; normale
Haltezeit zählt nicht zusätzlich als kontrollbedingte Wartezeit.

### 9.2 Aktivierung und Ressourcen

Der Zug fährt regulär bis zum Zielhalt. Der zusätzliche Halt beginnt erst,
wenn der Zug nach Mindesthaltezeit und Fahrgastwechsel normalerweise
abfahrbereit wäre. Während des Halts:

- bleibt das tatsächlich belegte Bahnsteig- oder Bahnhofsgleis belegt;
- bleiben Fahrstraßen- und Ausschlussressourcen belegt, deren Freigabe das
  Räumen durch den Zug voraussetzt;
- werden bereits sicher geräumte Ressourcen nicht erneut belegt;
- erhält der Zug wegen der autorisierten Warteentscheidung kein
  Abfahrtsrecht;
- wird keine Infrastrukturstörung oder Streckensperrung erfunden.

Der Halt endet nach abgeschlossenem Polizeivorgang oder beim Erreichen der
weltvertraglichen Höchstwartezeit. Eine nicht erfolgreiche Feststellung macht
die betroffenen Forderungen nicht werthaltig. Die zuständige Stelle wird in
der Oberfläche allgemein als Polizeiaktion bezeichnet; wo sachlich passend,
kann die Bundespolizei als vorgesehener Leistungsträger erscheinen. Deren
Bahnaufgaben sind unter
[Bundespolizei — Bahnpolizei](https://bundespolizei.de/unsere-aufgaben/bahnpolizei)
dokumentiert.

### 9.3 Virtuelle Fahrdienstleitung und andere Züge

Nach Freigabe fährt der Zug nicht automatisch los. Er stellt eine neue normale
Abfahrtsanfrage; erst ein neu erteiltes Abfahrtsrecht erlaubt die Weiterfahrt.
Der virtuelle Fahrdienstleiter prüft Welt und Zeitfenster,
Mindesthaltezeit, Betriebsbereitschaft, Fahrstraße, Fahrweg, Durchrutschweg,
Flankenschutz, individuelle Zustimmung und sämtliche Konfliktressourcen.

Hat der Zug seine ursprüngliche Fahrplanlage verloren, besitzt er keinen
Sondervorrang. Die vorhandene lexikographische M8-Regel entscheidet gemeinsam
mit allen anderen Fahrten. Eine inzwischen gesicherte Fahrstraße, ein belegter
Folgeblock oder eine kreuzende Bewegung kann deshalb nach Ende des
Polizeihalts weitere Wartezeit erzeugen.

Die verlängerte Ist-Belegung läuft durch denselben regionalen `CapacityLedger`
und dieselbe Konfliktengine wie der übrige Betrieb. Mögliche Folgen sind:

- wartende Folge- oder Einfahrzüge;
- neu geordnete Kreuzungen, Wenden und Rangierbewegungen;
- Auswirkungen auf alle Zugarten, darunter Personen-, Güter-, Leer- und
  Zusatzfahrten aller EVU;
- gebrochene oder neu bewertete Anschlüsse;
- verschobene Fahrzeug- und Personalumläufe;
- revidierte M10-Reiseketten und Auslastungen;
- verursachungsgerechte Verspätungen, Vertragsfolgen und Pönalen.

M15 verspätet keine fremde Fahrt direkt. Es erzeugt ausschließlich den
autorisierten Halt des eigenen Zuges; alle Netzfolgen entstehen aus den
bestehenden Ressourcen- und Dispositionsregeln.

### 9.4 Ereignisse und Sichtbarkeit

Mindestens folgende typisierte Ereignisse werden benötigt:

- `FareControlHoldRequested`
- `FareControlHoldActivated`
- `DepartureAuthorityWithheld`
- `PoliceResponseResolved`
- `FareControlHoldReleased`

Bestehende Abfahrts-, Ressourcen- und Verspätungsereignisse tragen dieselbe
Kausalitätskennung. Das eigene EVU sieht in der Betriebszentrale den vollen
Grund. Öffentliche Livemap und fremde EVU sehen nur den datensparsamen
Betriebsgrund „behördliche Maßnahme“ und die resultierende Verspätung, niemals
Dialog- oder Falldaten.

## 10. Wirtschaft

Für abgeschlossene Fälle gilt:

```text
nettoEBE = Zahlungseingänge - Bearbeitungskosten - Abschreibungen
Kontrollprämie <= 4 * positive nettoEBE
```

Der gesamte positive Tagesbeitrag aus Netto-EBE und Kontrollprämie ist auf
0,5 Prozent der relevanten täglichen SPNV-Vertragserlöse begrenzt.
Bearbeitungskosten, Polizeihaltfolgen und Pönalen bleiben vollständig wirksam.
Alle Werte liegen als Integer-Cent im `EconomyRelease`; es gibt keinen externen
Dienst im heißen Pfad.

Der Tagesdeckel gilt gemeinsam für alle Zugläufe, Spieler und Sitzungen eines
EVU in derselben Welt. Bezugsgröße sind die belegten SPNV-Vertragserlöse des
expliziten Welttages vor Kontrollfolgen; Forderungen, Nachfrageprognosen,
Kontrollprämien und andere Geschäftsfelder erhöhen diese Grundlage nicht.
Der Deckel in Cent ist `floor(max(0, VertragserlöseCent) * 50 / 10000)`;
bei null Erlösen entsteht kein positiver Kontrollbeitrag. Fehlende
Vertragsabrechnungsbelege erlauben keine vorgezogene Prämienfreigabe.
Ganzzahlige Rechnung prüft Überläufe und rundet erst am Ergebnis ab.

Der gepinnte M6-Abrechnungsvertrag weist offene Forderung, Zahlung, Reduzierung,
Kosten, Abschreibung, Prämie und einen gegebenenfalls erforderlichen
Deckelausgleich getrennt aus. Der Ausgleich begrenzt ausschließlich einen
positiven Kontrollbeitrag; er erstattet keine negativen Folgen. Tagesabschluss
und spätere Korrektur referenzieren Welt, EVU, Welttag, Fallbelege und
Releaseversion. Wiederholung erzeugt keine zweite Prämie; Korrekturen erfolgen
als zusätzliche ausgeglichene Ledgertransaktion, niemals durch Umschreiben
eines früheren Belegs. Diese Ledgerwirkung bleibt M15.11-Abnahme.

## 11. Öffentliche Verträge und API

M15 führt mindestens folgende versionierte Verträge ein:

- `PassengerManifestV1`
- `PassengerProjectionV1`
- `PassengerProjectionV2`
- `FareCompliancePolicyV1`
- `FareInspectionCaseV1`
- `FareControlPolicyV1`
- `FareControlHoldV1`
- `ArtAtlasManifestV1`
- `InteriorLayoutV1`
- `InteriorGeometryPolicyV1`
- `InteriorPassengerPlacesV1`
- `InteriorPassengerPlacesV2`
- `StationSceneV1`
- `DialogueReleaseV1`
- `PassengerEncounterV1`
- `ConductorSessionSnapshotV1`
- `ConductorCommandV1`

Die autorisierte API liegt unter
`/worlds/{worldId}/operators/{operatorId}/trains/{trainRunId}/conductor-sessions`.
Snapshots und sequenzierte SSE-Deltas enthalten Zugzustand, Spielerposition,
Manifestrevision, sichtbare Fahrgäste, aktive Begegnung, Umgebung,
Bahnhofsszene und gegebenenfalls den Betriebshalt.

`ConductorCommandV1` kennt `move`, `start_inspection`,
`choose_dialogue_option`, `request_police` und `end_session`. Jedes Kommando
trägt Sitzungs-ID, erwartete Revision und Idempotenzschlüssel.

`PassengerEncounterV1` enthält nur bereits sichtbare Äußerungen, zulässige
Antworten und offenbarte Hinweise. Verdeckter Ticketstatus, Gewichte und
zukünftige Dialogknoten verlassen den Server nicht.

Die API ist der Zielvertrag für M15.7/M15.8. Eine interne M15.2-Projektionsfunktion
oder ein Test-CLI darf nicht als bereits betretbarer Modus angeboten werden.
Die Vertragsgrenzen sind:

| Vertragsfamilie | Autorität | Freigabe zur Darstellung |
|---|---|---|
| `PassengerManifestV1`, `FareCompliancePolicyV1` | M10 | Nur validierte Ableitungen; kein rohes Manifest |
| `PassengerProjectionV1`, `PassengerProjectionV2` | M15.2 aus M10 und M5-Fakten | Private autorisierte Ansicht; Abschnitt 3.3; V2 bindet Kasten und Deck ausdrücklich |
| `InteriorLayoutV1`, `InteriorPassengerPlacesV1`, `InteriorPassengerPlacesV2` | M15.4 aus M5 | Geprüfte Formationsgeometrie; Platzinventar erst nach unabhängiger Zuglaufbindung, keine Kapazitätserfindung |
| `ArtAtlasManifestV1`, `StationSceneV1` | M15.3/M15.5 aus freigegebenen Releases | Nur freigegebene Assets und betriebliche Fakten |
| `DialogueReleaseV1`, `FareInspectionCaseV1`, `FareControlPolicyV1` | M15-Server | Nur offenbarte Hinweise und zulässige Optionen |
| `PassengerEncounterV1`, `ConductorSessionSnapshotV1`, `ConductorCommandV1` | M15-Sitzung | Eigener Spieler und Zug; Revision, Lease und Sequenz |
| `FareControlHoldV1` | M15-Anforderung, M8/M4-Betriebsübergänge | Öffentlich nur betriebliche Ursache und Auswirkung |

### 11.1 Datenschutz, Protokollierung und Aufbewahrung

Synthetische Fahrgäste werden nicht mit realen Menschen verknüpft. Die
kontobezogene Sitzungszuordnung ist dagegen personenbezogener Plattformzustand.
Sie gehört zur Auskunfts-/Löschgrenze aus [Weltgerüst](weltgeruest.md) 10 und
darf nicht untrennbar in einen unveränderlichen Betriebs- oder Ledgerbeleg
eingebettet werden. Rechte werden auch für Wiederaufnahme, Export und
Nachlieferung alter Deltas erneut geprüft. Zugwechsel oder Berechtigungsverlust
räumt den privaten Clientcache.

Allgemeine Logs und Metriken enthalten keine Fahrgastschlüssel, Kontokennungen,
Dialogtexte, Rohmanifeste, Nachweisdaten oder SQL-Parameter. Geeignete Metriken
sind aggregierte Anzahl projizierter Personen, Projektionsdauer,
Ablehnungsgrund, Reconnect-/Snapshotbedarf und Kontrollhaltdauer. Labels sind
begrenzte Kategorien; Welt-/Zug-/Fallkennungen sind keine Metriklabels.
Private Diagnose darf nur über die vorhandene autorisierte Auditgrenze laufen.

Manifest- und Fallsnapshots bleiben für bitgleiches Replay an ihre Releases
gebunden. Die Kontozuordnung wird getrennt nach der veröffentlichten
Aufbewahrungsregel entfernt; verbindliche Betriebs-, Ressourcen- und
Buchungsbelege bleiben fachlich nachvollziehbar. Die noch offene
Archiv-Purge-Grenze [#520](https://github.com/larynxberlin-rgb/Zugfolge/issues/520)
wird durch diesen Vertrag nicht umgangen und bleibt ein Produktionsgate.

## 12. Nichtfunktionale Anforderungen

- Der vollständig ausgelastete längste zugelassene SPNV-Verband muss im
  bestehenden Browser- und Serverbudget bleiben, ohne logische Fahrgäste zu
  entfernen.
- Rendering darf degradiert werden, fachlicher Zustand und Eingaben nicht.
- Der Server begrenzt Bewegungs- und Dialogkommandos, lehnt veraltete
  Revisionen ab und verarbeitet Wiederholungen idempotent.
- Gespräch, Betriebshalt, Fall und Ledger müssen nach Restore bitgleich
  fortgesetzt werden.
- Asset- und Dialogrelease sind signiert, gehasht und zur Laufzeit lokal
  verfügbar. Externe KI-, Bild- oder Textdienste sind im Laufzeitpfad verboten.
- Datenschutzmetriken sind niedrig-kardinal; Fahrgastschlüssel und Dialogtexte
  erscheinen nicht in allgemeinen Logs oder Metriklabels.

## 13. Tests und Abnahme

### 13.1 Automatisierte Nachweise

- Gleicher Seed und gleiche Kommandofolge erzeugen identische Manifeste,
  Innenraumplätze, Dialoge, Polizeireaktionen, Belegungen, Buchungen und
  Zustands-Hashes.
- Die Summe individueller Fahrgäste entspricht an jedem Halt exakt M10-
  Auslastung, Ein- und Aussteigern.
- Verdeckte Sachverhalte erscheinen vor ihrer Offenlegung nicht in API,
  Browserzustand, Log oder Telemetrie.
- Mindestens 150 Dialogbäume und 600 Fahrgastäußerungen sind vorhanden; jeder
  Pfad ist erreichbar und terminiert.
- Defektes-Handy-Fälle decken sowohl späteren gültigen Nachweis mit
  7-Euro-Reduzierung als auch eine falsche Ausrede mit regulärer EBE ab.
- Betrunkenheit wird unabhängig vom `fareFact` getestet; Polizei ist ohne
  Verweigerung oder Gefahr nicht anforderbar.
- Property-Tests beweisen Invariante 1 für zufällige Polizeihaltdauern,
  Bahnhofslagen und konkurrierende Fahrten.
- Ein Mehrzug-Golden-Master enthält den kontrollierten SPNV-Zug, einen
  Folgepersonenzug, einen kreuzenden Zug sowie eine Güter-, Leer- oder
  Rangierfahrt. Er beweist Weiterbelegung, Neuordnung, Höchstwartezeit, erneute
  Abfahrtsprüfung und vollständige Kausalitätskette.
- Sprechblasen funktionieren bei dichter Belegung, langen Texten, Touch,
  Tastatur, Screenreader und reduzierter Bewegung.
- Forderung, Zahlung, Abschreibung, Kontrollprämie, Tagesdeckel, Verspätung und
  Pönalen werden ledgergenau geprüft.

### 13.2 Spielbarer Gesamtbeweis

Eine zusammenhängende Fahrt zeigt:

1. aus M10 entstandene SPNV-Auslastung und exakte 1:1-Projektion;
2. Bewegung durch den konfigurationsgetreuen Innenraum;
3. fließenden Wechsel von Umland über Vorstadt zu Stadt;
4. Signalhalt, kleinen Haltepunkt und großen Bahnhof mit Namen;
5. freundliches Zugeben und reguläre EBE;
6. defektes Handy mit vorläufiger EBE und späterer Reduzierung;
7. einen unfreundlichen oder betrunkenen, aber gültig reisenden Fahrgast ohne
   Sanktion;
8. Identitätsverweigerung und Polizeianforderung für den nächsten Halt;
9. verlängerte Bahnsteigbelegung und Reaktion virtueller Fahrdienstleiter auf
   mehrere andere Zugfahrten;
10. Verspätungs-, Anschluss-, M10-, Umlauf- und Pönalenfolgen;
11. Freigabe, neue Abfahrtsprüfung und gegebenenfalls weiteres Warten wegen
    verlorener Fahrplanlage;
12. Forderungsbuchung und gedeckelte Kontrollprämie;
13. Reload und Replay mit identischem Ergebnis auf Desktop und Touchgerät.

## 14. Ausdrücklich nicht Teil von M15

SPFV- und Güterkontrollen, manuelles Fahren, Signalbedienung, Verlassen des
Zuges, direkte Disposition anderer Züge, Gewaltmechaniken, Verfolgungen,
Freitext, Spracheingabe, Laufzeit-KI, lange Rollenspieldialoge, Wetter, reale
Bahnhofsarchitektur, exakte reale Fahrzeuginnenräume, Mehrspieler im selben Zug
und ein allgemeines Einspruchsportal außerhalb des automatisierten späteren
Fahrausweisnachweises.
