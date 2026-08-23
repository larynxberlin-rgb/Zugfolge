# Fester Arbeits-Prompt: Deutschland-InfraRelease zum Fahrplanwechsel

Diesen Prompt einmal jährlich in einem neuen, protokollierten Codex-Task
verwenden. `<FAHRPLANJAHR>`, `<STICHTAG_UTC>`, `<QUELLWURZEL>`,
`<ARTEFAKTWURZEL>`, `<INFRARELEASE_ID>`, `<OPERATIONAL_CANDIDATE>`,
`<ANNUAL_ARTIFACT_SPEC>`, `<OPERATIONAL_ARTIFACT_ID>` und
`<RELEASE_ARTIFACT_INVENTORY>` müssen vor dem Start konkret ersetzt werden;
kein Platzhalter darf in einem Kandidaten verbleiben.
`<OPERATIONAL_CANDIDATE>` ist der Pfad zu einem fachlich aus den gepinnten
Deutschlanddaten abgeleiteten, weltfreien `OperationalInfraRelease`, nicht zu
einer Deploymenthülle. Führe alle Befehle aus dem Repository-Wurzelverzeichnis
aus; `<ARTEFAKTWURZEL>` und die `sourceFile`-Pfade der Jahresspezifikation
müssen darunter liegen.

---

Du baust den vollständigen Deutschland-`InfraCorpus` für das Fahrplanjahr
`<FAHRPLANJAHR>` und daraus einen signierbaren `InfraRelease`. Lies zuerst
`AGENTS.md`, `docs/daten.md`, `docs/rechte.md`,
`docs/deutschland-infracorpus.md`, `docs/infrastruktur.md`,
`docs/betriebsgraph.md`, `docs/betriebsengine.md`, ADR-0014, ADR-0022,
ADR-0025 und ADR-0032 sowie
`tools/region-import/germany/release.config.json` und
`source-catalog.json`. Ändere keine Rechteentscheidung stillschweigend.

Ziel und Grenzen:

- Importiere das deutschlandweite EBO-Regelspurnetz vollständig. Lade den
  gesamten Korpus in den Serverrelease; die aktuell spielbare Region bleibt
  eine separate `WorldRelease`-Maske.
- Stelle Klasse A her, wo jede Pflichtdimension belastbar validiert ist.
  Schließe jede verbleibende Lücke als vollständiges, konservatives
  Klasse-B-Modell. Jeder EBO-Abschnitt des Release muss A oder B sein; eine
  ungelöste Pflichtdimension blockiert den Kandidaten. Außerhalb des
  EBO-Regelspurnetzes liegende Infrastruktur darf nur als unklassifizierter,
  nicht interaktiver Basiskartenkontext erscheinen.
- Reale Genauigkeit ist wünschenswert, aber die intern widerspruchsfreie,
  regelkonforme Betriebswahrheit ist zwingend. Erfinde keine vermeintlich
  beobachteten Fakten. Jede Annahme nennt eine versionierte Regel.
- Erzeuge genau ein unveränderliches, weltübergreifend wiederverwendbares
  `operational-infrastructure-v2.json`. Es enthält ausschließlich das statische
  `OperationalInfraRelease`: Kanten, Geometrien, Laufwege, Stellwerksobjekte,
  Konfliktressourcen, Bahnsteige, Regionsgrenzen und RZÜ-Layout. Weltkennung,
  Weltepoche, Fahrzeuge, Formationen, Züge, Befehle, Ereignisse und dynamischer
  Betriebszustand gehören ausdrücklich nicht in den `InfraRelease`.
- E31/ADR-0032 ist ein harter Cutover: keine Waypoint-/v1-Initialisierung,
  kein Dual-Write, kein JavaScript-Fallback, kein `AddDelay` oder
  `delay_seconds`, keine TypeScript-Positionswahrheit und kein Rückfall auf
  `mapEstimate`. LiveMap und RZÜ projizieren ausschließlich denselben
  committed v2-Zustand mit exakter releasegebundener Geometrie. Diese Ablösung
  betrifft den operativen Laufzeit- und Positionspfad; bestehende unabhängige
  statische oder administrative `/v1`-Verträge werden nicht ohne eigene
  Schemaentscheidung umbenannt.
- Kein externer Dienst liegt im heißen Pfad. Alle Quellen werden einmalig
  erfasst, gehasht und offline verarbeitet.

Quellenlauf:

1. Prüfe jede Quelle gegen `tools/guards/quellenregister.json`. Stoppe vor dem
   Import, wenn Kennung, Lizenz, Bereitstellungsweg oder datierte Freigabe fehlt.
2. Erfasse die im Quellkatalog freigegebenen Jahresstände: Deutschland-OSM-PBF,
   Infrastruktur-Stammdaten, den offiziellen DB-InfraGO-Open-Data-Stand,
   GTFS-Schienenregionalverkehr, Copernicus-DEM sowie StaDa und OpenStation.
   Schreibe für jede Eingabe Version,
   Abrufzeit `<STICHTAG_UTC>`, Bytezahl und SHA-256 in das Capture-Manifest.
3. Nutze APN-Skizzen nur als **internen Validierungsbestand**. Erzeuge die
   RL100-Liste ausschließlich aus bereits freigegebenen Stammdaten. Für eine
   bekannte RL100 startet
   `https://trassenfinder.de/apn/RL100` den direkten Abruf. Ersetze `RL100`
   exakt, arbeite sequentiell und schonend, begrenze die Rate, unterstütze
   Wiederaufnahme, protokolliere Status und Hash und wiederhole dauerhaft
   fehlende Pläne nicht. Prüfe vor jedem Jahreslauf erneut Erreichbarkeit und
   Rechtefreigabe.
4. Lege APN-PDFs, Seitenbilder, OCR und Layoutkoordinaten ausschließlich unter
   `<QUELLWURZEL>/internal-evidence/apn/` ab. Nichts davon wird committed oder
   ausgeliefert.

APN-Auswertung:

- Extrahiere Betriebsstellenkennung, Gleisbezeichnungen, Bahnsteigkanten,
  Weichen, Kreuzungen, Hauptsignale, Fahrtrichtungen und eindeutig erkennbare
  topologische Verbindungen mit Seiten- und Koordinatenbezug.
- Trenne sichere Beobachtung, mehrdeutigen Vorschlag und nicht erkennbaren Wert.
  Automatisch akzeptiert werden nur widerspruchsfreie, geometrisch und
  topologisch eindeutig zuordenbare Befunde. Alles andere kommt in eine
  Reviewliste.
- APN deckt die freie Strecke nicht vollständig ab. Ergänze Blocksignale,
  Überleitstellen und Abzweige aus dem deutschlandweiten OSM/ORM-Tagbestand und
  validiere beziehungsweise modelliere fehlende Streckenlogik konservativ.
- Ein akzeptierter Beleg nennt Abschnitt, validierte Qualitätsdimensionen,
  Extraktionsversion, Prüfergebnis und interne Evidenzhashes. Er darf Klasse A
  nur für tatsächlich belegte Dimensionen vergeben. Ein APN-Beleg ist
  `classAEligible=false`: Er verbessert oder bestätigt Klasse B, darf aber ohne
  eine unabhängige freigegebene Evidenz keine Dimension auf A heben.
- Behandle OSM, den offiziellen InfraGO-Datensatz, den jährlichen
  Infrastruktur-Stammdatensnapshot, StaDa, OpenStation, DEM und APN als
  getrennte Evidenzen. Bei Widersprüchen gewinnt keine Quelle allein aufgrund
  ihres Namens; erzeuge einen Reviewfall mit Feld, Abschnitt und beiden
  Belegständen.
- In ausgelieferten Daten dürfen weder `APN`, die Abrufadresse, PDF-Name,
  OCR-Text noch eine darauf bezogene Quellenattribution vorkommen. Der
  öffentliche Release enthält auch keinen Hash, Namen oder Bezeichner des
  internen Evidenzledgers. Alle anderen Lizenzattributionen bleiben erhalten.

Deterministischer Build und Prüfung:

1. Filtere EBO-Regelspur. Behalte außerhalb liegende Infrastruktur allenfalls
   als unklassifizierten, gedimmten Basiskartenkontext; sie wird weder Teil des
   operativen Release noch bestellbar oder interaktiv.
2. Erzeuge stabile IDs, Graph, einzelne Gleise, Betriebsstellen, Weichen,
   Signale, Blöcke, Fahrstraßen- und Konfliktmodelle. Der operative Anteil
   enthält insbesondere gerichtete Gleiskanten mit ganzzahliger Länge und
   exakter E7-Polylinie, Freimelde-/Freigabegrenzen, Fahrstraßenvorlagen samt
   Fahrweg, Durchrutschweg, Flankenschutz und zugschlussbezogener Auflösung,
   Profile, Bahnsteigintervalle, sichere Übergabepunkte, Regionsgrenzen und das
   statische RZÜ-Layout aus `docs/betriebsengine.md`. Sortiere alle Eingaben vor
   dem Hashen stabil; Zeiten und Längen bleiben ganzzahlig. Fehlende
   betriebliche Elemente dürfen nur durch den Offline-Releasecompiler mit
   versionierter deterministischer Regel konservativ erzeugt werden; es gibt
   keinen Laufzeit-Fallback.
3. Kennzeichne diesen reinen Build-Zwischenschritt mit
   `ZUGFOLGE_NON_AUTHORITATIVE_CORPUS_BUILD=1` und führe
   `build-germany-release.mjs compile` aus. Erzeuge den Qualitätsbericht je
   Dimension, Ursache und Länge. Prüfe ausdrücklich, dass jeder operative
   Abschnitt A oder konservativ geschlossenes B ist. Eine ungelöste
   Pflichtdimension muss den Kandidaten blockieren. Dieser Schritt darf selbst
   keinen Release freigeben.
4. Erzeuge getrennte, selbst gehostete PMTiles für weltweite Dark-Basemap und
   semantische Deutschland-Infrastruktur. Prüfe stabile Feature-IDs, Zoomvertrag,
   Attribution, Dateihash und HTTP-Range-Auslieferung.
5. Erzeuge mit einem fachlichen Deutschland-Ableiter zunächst
   `<OPERATIONAL_CANDIDATE>`. Jede Laufwegversion besteht aus lückenloser
   gerichteter Kantenfolge mit exakter E7-Geometrie. Jede
   Fahrstraßenvorlage verweist auf eine vorhandene Laufwegvorlage und
   ausschließlich vorhandene, nichtleere Fahrweg-, Durchrutschweg- und
   Flankenschutzressourcen. Erzeuge weder Geraden noch Schätzpositionen oder
   Ersatzressourcen. Der aktuelle Repo-Stand besitzt noch keinen vollständigen
   fachlichen Ableiter aus dem Deutschland-Korpus; das ist ein Release-Blocker,
   bis er implementiert und gegen reale Jahresdaten nachgewiesen ist. Übergib
   erst danach den weltfreien Kandidaten an den fail-closed Materialisierer:

   ```sh
   node tools/region-import/materialize-operational-infrastructure-v2.mjs <OPERATIONAL_CANDIDATE> <INFRARELEASE_ID> <ARTEFAKTWURZEL>/operational-infrastructure-v2.json
   ```

   Der Materialisierer ist kein fachlicher Ableiter: Er prüft den strikten
   JavaScript-Vertrag und den nativen Rust-Vertrag, gleicht beide kanonischen
   Hashes ab, prüft unveränderte Eingabebytes und materialisiert ohne
   Überschreiben. Sein Ausgabedokument enthält exakt den statischen
   `OperationalInfraRelease` und keine Deploymenthülle.
6. Validiere das statische v2-Artefakt vor dem Manifestbau mit demselben
   nativen Rust-Vertrag, den die Operational-v2-Runtime beim Weltstart nutzt.
   Releasekennung, Kanten, Ressourcen, Fahrstraßen, Laufwege, Geometrien,
   Bahnsteige, Regionsgrenzen und RZÜ-Layout müssen vollständig und
   referenziell geschlossen sein; unbekannte Felder oder weltbezogene Inhalte
   blockieren den Kandidaten.
7. Aktualisiere und prüfe `<ANNUAL_ARTIFACT_SPEC>` als bindenden Jahresvertrag
   mit `schema=zugfolge-infra-release-artifact-spec/v2`. Er muss genau einen
   Operational-Descriptor mit ausschließlich `id`, `kind`, `infraReleaseId`,
   `sourceFile` und `file` enthalten. Dabei gelten exakt:

   - `id=<OPERATIONAL_ARTIFACT_ID>`;
   - `kind=operational-infrastructure-v2`;
   - `infraReleaseId=<INFRARELEASE_ID>`;
   - `sourceFile` löst unter der Repository-Wurzel exakt zu
     `<ARTEFAKTWURZEL>/operational-infrastructure-v2.json` auf;
   - `file=operational-infrastructure-v2.json`.

   `bytes`, `sha256` oder `stateHash` dürfen niemals manuell in den Descriptor
   geschrieben werden. Erzeuge sie ausschließlich über die typisierte
   Inventarpipeline:

   ```sh
   node tools/region-import/germany/run-release-artifacts.mjs <ANNUAL_ARTIFACT_SPEC> . <RELEASE_ARTIFACT_INVENTORY>
   ```

   Das erzeugte v2-Inventar muss für `<OPERATIONAL_ARTIFACT_ID>` unverändert
   `id`, `kind`, `file`, `infraReleaseId`, `bytes`, `sha256` und `stateHash`
   transportieren. `sha256` hasht die materialisierten kanonischen Dateibytes,
   niemals die Candidate-Bytes oder die vollständige weltgebundene
   Initialisierung. `stateHash` ist exakt
   `alphaHash("operational-infrastructure-v2", OperationalInfraRelease)`.
   Falls die Pipeline diese Bindung nicht erzeugt, stoppe den Lauf, erweitere
   Pipeline und Positiv-/Negativtests und baue neu. Patche weder Spezifikation
   noch erzeugtes Inventar oder Manifest mit manuell berechneten Hashes.
8. Baue das öffentliche Manifest mit `build-germany-release.mjs manifest` im
   autoritativen Rust-Compiler. Übergib dabei
   `<RELEASE_ARTIFACT_INVENTORY>` unverändert als dessen `ARTIFACTS`-Argument;
   eine manuell nachgebaute Artefaktliste ist unzulässig. Suche anschließend
   rekursiv nach verbotenen internen
   Evidenzkennungen. Jeder Treffer, ein fehlendes oder mehrfaches
   `operational-infrastructure-v2`-Artefakt und jede Abweichung von dessen
   erwarteter Byte- oder kanonischer Zustandsbindung blockieren den Release.
9. Führe Unit-, Golden-Master-, Determinismus-, Rechte-, Lizenz-,
   Konfliktinvarianten-, Karten- und unabhängige Holdout-Tests aus. Vergleiche
   Qualitätslängen und Laufzeit/RAM/PMTiles-Größe mit dem Vorjahresrelease und
   erkläre jede wesentliche Abweichung.
10. Führe zusätzlich die Operational-v2-, LiveMap- und RZÜ-Abnahme aus dem
    folgenden Abschnitt vollständig aus. Historische v1-Waypoint-,
    Kartenestimate-, 24-Stunden-Wiederholungs- und synthetische Lastbelege sind
    kein v2-Nachweis.
11. Lege Kandidat, Hashes, Berichte und Reviewliste zur Freigabe vor. Signiere
    erst nach namentlicher Releasefreigabe und wenn sämtliche v2-Cutover-Gates
    grün sind. Ein bereits signierter InfraRelease ohne statische
    Operational-v2-Infrastrukturbindung wird nicht nachträglich erweitert,
    sondern bleibt unverändert; der v2-qualifizierte Kandidat erhält einen neuen
    Releasebezeichner und eine neue Signatur. Markiere M14.2 nur dann erledigt,
    wenn der vollständige Deutschlandlauf und nicht lediglich eine Fixture
    bestanden hat und alle verbleibenden Abnahmebelege erfüllt sind.
12. Erzeuge nach den öffentlichen Infra-, Karten- und Deliverymanifesten das
   transportneutrale Paket mit dem Jahresplan. Prüfe es vollständig, installiere
   es in ein neues versioniertes Testziel und protokolliere Manifest-Hash,
   Teilezahl, Gesamtbytezahl und Installationspfad. Übergib anschließend
   Manifest und alle Teile über den vorgesehenen Odoo-Jahresimport in das
   getrennte Game-Staging, sofern die Zielumgebung verfügbar ist. Ein
   unsignierter Kandidat darf gepackt, geprüft und gestaged werden, muss aber
   `activationEligible=false` bleiben und darf keinen Übernahmeantrag erzeugen.

Operational-v2-, LiveMap- und RZÜ-Abnahme:

1. Erzeuge nach dem statischen Release eine getrennte, signierte
   Test-Deploymenthülle mit einem vollständigen
   `zugfolge-operational-simulation-initialize/v2`. Sie bindet eine konkrete
   Testwelt, Region, Weltepoche, Fahrzeugtypen, weltgebundene Fahrzeuge,
   Formationen, Züge und das unveränderte statische
   `OperationalInfraRelease`; sie wird weder Bestandteil noch Artefakt des
   `InfraRelease`. Starte diese Testwelt ausschließlich über die native
   Operational-v2-ABI. Der Start muss ein `operational-world/v2` mit Revision
   und Publishersequenz `0`, reproduzierbarem vollständigem Zustandshash sowie
   je einer LiveMap- und RZÜ-Projektion desselben Commitstands erzeugen. Eine
   fehlende native ABI oder ein JavaScript-Ersatz ist ein Abbruch, kein Skip.
2. Beweise an realen Klasse-A-/B-Ausschnitten, soweit Klasse A im Jahresrelease
   vorhanden ist, dass Zugspitze, Zugschluss, belegte Kantenintervalle und
   Blöcke, Fahrberechtigungsende, analytischer Bewegungsabschnitt,
   Fahrstraßenlocks und Signalzustände aus demselben Zustand stammen. Abgesehen
   vom Sichttyp `live-map`/`rzue` müssen Welt, Region, InfraRelease, Commit,
   Simulationszeit, Züge, Locks und Signale beider Projektionen gleich sein.
   RZÜ darf keine zweite Simulation oder erfundene Stellwerkslage besitzen.
3. Prüfe den produktiven Workerpfad: welt-/regionsgebundener Single-Writer,
   idempotente Befehle, optimistische Prüfung von Revision, State-Hash und
   Publishersequenz, atomarer Batch-Rollback und Persistenz-Commit vor Fanout.
   Ein Fanoutfehler darf den committed Zustand nicht zurückrollen und muss
   durch Restore/Neuprojektion ohne Doppelanwendung aufholbar sein.
4. Publiziere je Commit einen atomaren Regionsframe mit sämtlichen v2-Zügen.
   Snapshot und lückenlose Deltas tragen dieselbe Welt, Region, InfraRelease-ID,
   Commitsequenz und Simulationszeit; die nächste Publishersequenz ist exakt
   `+1`. Eine Lücke, ein fremder Commit oder ein gemischtes Teilbild erzwingt
   Freeze und vollständigen Snapshot-Reset.
5. Prüfe den gemeinsamen Clientvertrag: Der Heartbeat beträgt fünf Sekunden;
   beim produktiven 60-Sekunden-Scheduler wird ein Regionszustand nach 75
   Sekunden stale. Bis `validUntilMs` darf ausschließlich der vom Server
   autorisierte analytische Abschnitt ausgewertet werden; danach frieren
   LiveMap und RZÜ ohne Extrapolation oder Geometriesprung ein.
6. Führe negative Tests für fehlende, doppelte, manipulierte, weltbezogene oder
   nicht releasegebundene statische v2-Artefakte, eine nicht zum Release
   passende Deploymenthülle, falsche Welt/Region/Weltepoche, fremde
   Laufwege/Ressourcen/Fahrzeuge/Formationen/Züge, operative v1-Schemas und
   -Befehle, `AddDelay`, partielle Regionsframes, Sequenzlücken, Stale-Grenzen
   und getrennte LiveMap-/RZÜ-Zustände aus. Jeder Fall muss geschlossen
   scheitern.
7. Qualifiziere Fahrplanwiederholung, mehrtägige Materialisierung,
   Periodenwechsel und deterministische Bereinigung/Retirement vollständig
   unter v2. Replay und Restore müssen denselben `operational-world/v2`-Hash
   ergeben. Ein früherer v1-Tageslauf darf dieses Gate nicht ersetzen.
8. Erbringe außerdem sämtliche Invarianten-, Rangier-, Störungs-, Plattform-,
   Regions-, Last-, Restore-, Fail-safe- und Aktivierungs-/Rollbacknachweise
   aus Abschnitt 10 von `docs/betriebsengine.md`. Ein Rollback betrifft nur
   einen noch nicht endgültig aktivierten statischen Kandidaten oder das
   vollständige v2-Deployment. Nach dem harten Cutover gibt es keinen
   produktiven v1-Fallback und niemals eine Übersetzung dynamischer Zustände.

Liefere am Ende eine knappe Tabelle mit Quelle/Version/Hash, A-/B-Länge,
offenen Ursachen, Teststatus, Artefaktgrößen, Änderungen zum Vorjahr und
Signaturstatus. Weise `operational-infrastructure-v2.json` mit
`infraReleaseId`, Byte-SHA-256 und kanonischem `stateHash` gesondert aus.
Dokumentiere die getrennte signierte Test-Deploymenthülle mit Welt, Region,
Weltepoche, Zugzahl und nativer Initialisierung daneben, aber niemals als
InfraRelease-Artefakt. Ergänze LiveMap-/RZÜ-Commitgleichheit,
Sequenz-/Stale-/Freeze-, Replay-/Restore-, Wiederholungs-/Retirement- und
operativen v1-Negativstatus sowie Paketmanifest-Hash, Teilezahl,
Verify-/Installstatus,
Odoo-/Game-Stagingstatus und den ausdrücklich getrennten Aktivierungsstatus.
Verlinke alle internen Laufbelege, aber keine APN-Rohdateien.

---
