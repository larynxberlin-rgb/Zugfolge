# Fahrzeugkatalog: Beleg, Release und Betriebsprojektion

Der Fahrzeugkatalog ist eine **Offline-Releasequelle**, kein Laufzeitdienst. Er
liefert dieselben belegten Fahrzeugdaten an die Flottenlogik und an die
autoritative Betriebsengine. Damit können Markt, individuelles Asset und
`OperationalWorld` nicht länger mit unabhängig gepflegten technischen Werten
auseinanderlaufen.

Dieses Dokument konkretisiert `betrieb.md` Abschnitt 2.1 und den
Fahrzeugpflichtdaten-Vertrag aus `betriebsengine.md`. Die allgemeinen
Rechteanforderungen in `rechte.md` bleiben unverändert maßgeblich.

## 1. Granularität eines Fahrzeugtyps

Ein Katalogtyp bezeichnet eine **exakte technisch und betrieblich homogene
Konfiguration**, nicht bloß eine Fahrzeugfamilie. Ein eigener Typ ist nötig,
wenn sich mindestens eines der folgenden Merkmale ändert:

- Länge, Masse, Höchstgeschwindigkeit, Dauerleistung oder Anfahrzugkraft;
- Antriebs- oder Stromsystem;
- Serienstand der Zugsicherung;
- Rolle als Triebzug, Lokomotive, Reisezugwagen oder Steuerwagen;
- Zahl oder Lage der Führerstände;
- eine für den Markt oder die Ausschreibung relevante Innenraumkonfiguration.

Ein im Regelbetrieb nicht trennbarer Triebzug ist genau **ein** Fahrzeugasset.
Lokomotiven, Reisezugwagen und Steuerwagen bleiben dagegen einzelne Assets und
werden erst in der Welt zu einer Formation verbunden. Dadurch wird weder eine
Lokomotive mit einer wagenparkunabhängigen Beschleunigung ausgestattet noch
ein Wagenpark ohne angetriebenes Fahrzeug fahrfähig.

Die erste redaktionelle Ausbaustufe umfasst normalspurige EBO-Fahrzeuge für
Deutschland mit Einsatzbezug 1994–2026: elektrische, Diesel-, Batterie- und
Mehrkrafttriebzüge des SPNV sowie passende Lokomotiven, Reisezugwagen und
Steuerwagen. BOStrab, ESBO, reine Stromschienen-S-Bahn und Güterwagen bleiben
außerhalb dieses Schnitts. Baureihenbezeichnungen sind faktisch;
Handelsbezeichnungen im Spiel bleiben gemäß E6 fiktiv.

## 2. Drei getrennte Datenstände

| Stand | Darf unvollständig sein? | Darf eine Welt starten? | Ablage |
|---|---:|---:|---|
| Recherchekorpus | ja | nein | privater Arbeitsbereich außerhalb des Git-Worktrees |
| Quellkatalog `zugfolge-vehicle-catalog-source/v2` | nein | nein | proprietäres Weltdatum außerhalb des öffentlichen Quellbaums |
| kompilierte Releases | nein | nur nach vollständiger Validierung und Signatur | Deployment-Artefakte außerhalb des öffentlichen Quellbaums |

Öffentlich versioniert werden ausschließlich Schema, Compiler, Prüfregeln und
rein fiktive Testdaten. Eine Recherchezeile ist noch kein spielbarer Typ. Sie
darf Lücken, Widersprüche und offene Rechtefragen sichtbar festhalten, wird
aber niemals stillschweigend mit plausiblen Laufzeitwerten aufgefüllt.

## 3. Belegmodell und Rechte-Gate

Jedes importierte Feld trägt eine Provenienzart:

| Art | Bedeutung | Quellenbezug |
|---|---|---|
| `published-fact` | von einer Quelle ausdrücklich veröffentlichter Wert | mindestens eine freigegebene Quelle |
| `deterministic-derivation` | reservierte Kennzeichnung für ein vom Compiler registriertes und erneut berechnetes Ausgabeschema | dessen belegte Eingaben und feste Algorithmusversion |
| `game-assumption` | eigene, sichtbar versionierte Spielannahme | keine Fremdquelle vortäuschen |

Daneben stehen Konfidenz in Basispunkten und eine kurze Methode. Jede externe
Quelle bindet Titel, URL, Lizenz, Abrufdatum, SHA-256 des verwendeten Inhalts
und eine datierte Rechteentscheidung mit Prüfer und Referenz. Der Compiler
akzeptiert ausschließlich `freigegeben`; `entwicklung`, `pruefung`,
`gesperrt` und `ausgeschlossen` bleiben nicht importierbar. Unbekannte,
ungenutzte oder nur teilweise belegte Quellen brechen den Lauf ebenfalls ab.

Im Quellkatalog ist `deterministic-derivation` derzeit absichtlich
**nicht deklarativ nutzbar**. Eine frei formulierte Methode wäre kein
Reproduzierbarkeitsbeweis und wird deshalb fail-closed abgewiesen. Die aktuelle
registrierte Ableitung ist das vom Compiler erzeugte Operational-Profil: Es
bindet seine ganzzahligen Eingaben und sein Algorithmusschema per SHA-256 und
wird bei jeder Ausgabevalidierung erneut berechnet. Neue Ableitungsarten
benötigen vor ihrer Verwendung eine ebenso konkrete Methodenregistrierung samt
Recompute-Test. Quellfelder verwenden bis dahin ausschließlich
`published-fact` oder `game-assumption`.

Eine Register- oder Suchoberfläche ist nicht automatisch Rechteinhaberin der
dort wiedergegebenen Originalinformationen. Insbesondere bleibt ERATV bis zu
einer quellenbezogenen Rechteentscheidung Recherchehilfe und darf nicht durch
ein pauschales `freigegeben` in den Katalog gelangen.

## 4. Quellkatalog und Welt-Seed

Der weltunabhängige Quellkatalog enthält pro exaktem Typ:

- stabile String- und numerische ID, faktische Baureihe und fiktiven
  Handelsnamen;
- Bauzeitraum, Rolle, Antrieb, Stromsysteme, Führerstände und Zugsicherung;
- Länge, Masse, Höchstgeschwindigkeit, Dauerleistung, Anfahrzugkraft und
  Bremsgewicht in ganzzahligen Einheiten;
- belegte Masse, Anfahrzugkraft und Bremsgewicht sowie sichtbare,
  versionierte Spielgrenzen für die Fahrdynamikableitung;
- belegte oder ausdrücklich angenommene Innenraum- und Betriebswerte;
- den Feld-zu-Quelle-Nachweis.

Der getrennte `zugfolge-vehicle-world-seed/v3` bindet ausgewählte Typen an eine
konkrete Welt. Er erzeugt keine anonymen Kopien, sondern nennt stabile
Fahrzeugidentitäten, Betreiber, Bau- und Beschaffungsjahr, Beschaffungskanal,
Ist-Zugsicherung, Fristen, Zustand, Einschränkungen und Lebenslauf. Außerdem
enthält er optional Formationen sowie die für deren Einsatz nötigen Personal-
und Trassenbelege. Unformierte Markt-, Abstell- und Werkstattassets sowie
lokfreie Wagenparks sind gültige Zustände. Der Seed trägt außerdem eine exakt
abdeckende `zugfolge-vehicle-economy-projection/v2`. Sie liefert das
vollständige, bereits weltgepinnte `economy-release/v1`-Dokument sowie die
fahrzeugtypspezifischen `operatingCosts`; Fahrzeugkosten stammen nie aus dem
weltunabhängigen Typkatalog. `worldId` wird weder aus einem Dateinamen noch aus
einer Umgebungseinstellung ergänzt.

Der hier geführte operative `condition`-Vektor besteht aus Mechanik, Antrieb,
Bremsen, Kilometern und Betriebsstunden seit der Wartung sowie offenen
Beobachtungen. Er wird gemeinsam mit dem reihenfolgestabilen
`history`-Lebenslauf verlustfrei in Fleet Authority und Operational
projiziert. Er ist **nicht** automatisch der anders geschnittene fünfteilige
Zustand des `PersistentVehicleMarket` (Mechanik, Traktion, Bremsen, Betrieb,
Innenraum). Ein fachlich begründeter Initialisierungsadapter zwischen beiden
Modellen liegt außerhalb des Katalogcompilers; der Compiler erfindet diese
Abbildung nicht.

`economy-release/v1` enthält selbst noch keine fahrzeugtypspezifische
Kostentabelle. Der Compiler behauptet daher nicht, dessen `checksum` decke die
zusätzlichen Kosten ab, sondern prüft zwei getrennte, verkettete Bindungen:

1. Der `checksum` des vollständig gelieferten Basis-Releases wird exakt wie in
   `packages/economy/src/release.ts` neu berechnet: SHA-256 über den Inhalt ohne
   `checksum`, Objektschlüssel nach UTF-8 sortiert, Vergabeprofile nach ID
   sortiert und BigInt-Centwerte als kanonische nichtnegative Dezimalstrings.
2. `projectionSha256` bindet Schema, Basis-Release-Schema, -Version und den
   verifizierten Basis-Checksum gemeinsam mit den nach `typeId` sortierten
   `operatingCosts`. Dafür gilt dieselbe Pretty-JSON-Darstellung mit
   abschließendem Zeilenumbruch wie für die übrigen Compiler-Hashes.

Der Compiler stellt beide Recompute-Funktionen bereit. Eine Kostenänderung bei
unverändertem `projectionSha256` bricht den Lauf; eine Änderung des gelieferten
Basis-Releases bei unverändertem `checksum` ebenso. Die Ausgabevalidierung
leitet die Kostentabelle zusätzlich aus Katalog-Typkennungen und den
Authority-Assets zurück und vergleicht ihren Projektionshash mit dem Receipt;
ein bloß neu versiegelter Authority-Hash kann den Economy-Pin daher nicht
umgehen.

### 4.1 Migration vom Welt-Seed v2

`zugfolge-vehicle-world-seed/v2`,
`zugfolge-vehicle-economy-projection/v1` und der Compile-Receipt v2 werden
fail-closed abgewiesen. Für v3 sind im Economy-Objekt die bisherigen freien
Felder `releaseId` und `releaseSha256` durch das vollständige `release`-Dokument
zu ersetzen. Zusätzlich ist `projectionSha256` über Basis-Pin und Kostentabelle
zu berechnen. Compile-Receipt v3 fuehrte die getrennte Bindung von
`economyReleaseId`, reproduziertem `economyReleaseSha256` und
`economyProjectionSha256` ein. Der aktuelle Receipt v4 behaelt diese Bindung
unveraendert bei und bindet zusaetzlich den deploybaren Authority-Katalog.

## 5. Eine Eingabe, zwei Projektionen

Der reine Rust-Compiler erzeugt deterministisch:

1. `zugfolge-vehicle-catalog/v3` — geprüfter, weltunabhängiger Typkatalog;
2. `zugfolge-fleet-authority-release/v2` — individuelle Assets für Markt,
   Flotte, Fristen und Formation;
3. `zugfolge-fleet-authority-release-catalog/v1` — atomarer Single-World-Wrapper
   aus exakt `seed.worldId`, `seed.producedAt` und der Fleet-Authority-Ausgabe
   für `ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH`;
4. `zugfolge-operational-vehicle-inventory/v2` — dieselben Typen und Assets in
   den Pflichtfeldern von Operational v2;
5. `zugfolge-vehicle-catalog-compile-receipt/v4` — SHA-256-Bindung von beiden
   Eingaben, Basis-EconomyRelease, Fahrzeugkostenprojektion und allen vier
   Ausgaben.

Der Wrapper enthaelt genau einen Eintrag; Mehrwelt-Packaging ist kein stiller
Nebeneffekt dieses Compilers. Der Game-API-Loader gibt `producedAt` gemeinsam
mit der Authority verlustfrei an Weltstart und internen Initialisierungspfad
weiter; Authority v2 ohne diesen Wert oder mit einer abweichenden Route-Zeit
scheitert. Nur Authority v1 darf fehlendes beziehungsweise explizites
`producedAt = 0` verwenden. `worldId` muss bereits im Welt-Seed eine
kleingeschriebene kanonische UUID sein, damit die CLI kein Artefakt erzeugt,
das der Game-API-Loader erst beim Start verwirft. Das einzelne
`fleet-authority-release-v2.json` bleibt als direkt pruefbare Compilerprojektion
Teil des Artefaktsatzes; deployt wird die zusaetzliche Catalog-Datei.

Die Umrechnung in die Betriebsengine ist fest:

- km/h → mm/s: ganzzahlig abwärts, damit die veröffentlichte Vmax nie
  überschritten wird;
- kW → W und kN → N: exakte Multiplikation mit 1.000;
- Beschleunigung einer konkreten Formation:
  `min(Summe wirksame Anfahrzugkraft × 1.000 / Gesamtmasse, kleinster Cap)`,
  ausschließlich ganzzahlig in mm/s²;
- Betriebsbremsung einer konkreten Formation:
  `min(Summe Bremsgewicht × 9.806 / Gesamtmasse, kleinster Cap)`,
  Schnellbremsung anschließend mit dem kleinsten ganzzahligen
  Basispunkt-Multiplikator;
- jede Ableitung trägt Algorithmusschema, exakte Eingabeparameter und deren
  SHA-256; die Ausgabevalidierung berechnet sie erneut;
- `powered`: ausschließlich aus der typisierten Rolle, nie aus einem
  Browserwert;
- Batterie-Oberleitungsfahrzeuge: Batterieantrieb plus explizite
  Oberleitungsstromsysteme, sodass elektrifizierte und nicht elektrifizierte
  Laufwegteile gemeinsam geprüft werden können;
- Traktionskompatibilität: Alle angetriebenen Assets einer Formation müssen
  exakt dieselbe Antriebsart und dieselbe vollständige Stromsystemmenge
  besitzen. Nicht angetriebene Reisezug- und Steuerwagen werden dabei
  ignoriert; auch bei Batterie-Oberleitungsfahrzeugen bleibt die Systemmenge
  Teil der Gleichheit. Eine gemischte Traktion ist kein stiller Fallback;
- Zugsicherung: sortierte, geschlossene Kennungen; LZB setzt PZB voraus. Bei
  expliziten Formationen liefert ausschließlich das Fahrzeug an der aktiven
  Zugspitze den wirksamen Führerstand und die Zugsicherung, also auch ein nicht
  angetriebener Steuerwagen.

Die so abgerundete `maximumSpeedMmps` ist auch die autoritative Planning-Vmax.
Fleet Authority v2 reicht sie im internen `planning.path-request/v4` und
`planning-coordinate/v2` unverändert bis zu Rust durch; eine Rückumrechnung in
ganzzahlige km/h ist in diesem neuen Pfad unzulässig. Nur persistierte
Planning-v3/v1-Verträge dürfen die historische km/h-Aufrundung verwenden.

Neue Operational-v2-Typen tragen Rolle, Führerstände, `traction`, die
vollständigen `electricSystems` und `rawFormationDynamics` gemeinsam. Der
Rohblock enthält `brakeWeightKg`, `maximumAccelerationCapMmps2`,
`serviceBrakeCapMmps2` und `emergencyBrakeMultiplierBasisPoints`; Masse und
Anfahrzugkraft bleiben die bereits gebundenen technischen Typwerte. Nur der
geschlossene Legacy-Pfad darf den gesamten expliziten Metadatenblock
auslassen; teilweise Metadaten, ein partieller Rohblock oder eine Mischung aus
Legacy- und expliziten Typen scheitern. Operational prüft die typbezogenen
Referenzwerte durch dieselbe Rohableitung und kontrolliert die exakte
Traktions- und Systemgleichheit aller physisch angetriebenen Assets sowohl beim
Weltstart als auch bei jeder späteren Formationsänderung erneut.
Immobilisierte Antriebe bleiben für diese physische Kompatibilitätsprüfung
sichtbar, auch wenn sie keine nutzbare Leistung beitragen.

Fleet Authority v2 verlangt für jedes Asset `condition` und `history` ebenso
wie Operational v2. Die Runtime bindet beide in den initialen
`AssetHolding.historyHash`; spätere Eigentums- und Halterwechsel setzen diese
Kette fort, statt den Seed-Lebenslauf still zu ersetzen. Authority v1 bleibt
ohne diese beiden Felder rückwärtskompatibel ladbar, darf die v2-Felder aber
nicht vorwegnehmen.

Eine Formation wird aus ihren konkreten Fahrzeugen erneut abgeleitet. Der
Compiler legt die erwartete Leistung nur als Prüfbeleg bei; Fleet und
Operational berechnen sie jeweils mit dem gemeinsamen ganzzahligen
Ableitungsvertrag selbst. Abweichungen sind ein Releasefehler und kein Anlass
für einen Fallback. `Fleet Authority v2` benötigt deshalb für Lokomotiven kein
vom Aufrufer geliefertes `dynamics`: Fehlt es, leitet Fleet es
serverautoritativ ab; ist es vorhanden, muss es exakt übereinstimmen. Vor der
Persistenz normalisiert Fleet Initialisierungs- und spätere
`FormationCommand`-Intents auf den abgeleiteten Wert, damit Snapshot, Replay
und Planning denselben Verbandswert sehen. Ein beliebiger Client kann kein
Fahrprofil autorisieren oder signieren. Bei einem lokfreien Wagenpark bleibt
`dynamics` vollständig ausgelassen: Nullwerte wären kein gültiges
Fleet-Fahrprofil, obwohl der Wagenpark als nicht mobiler Bestand gültig ist.

Einschränkungen wirken zuerst auf das einzelne Asset und werden erst danach
aggregiert. `Immobilized` und eine auf null gerasterte Leistung entfernen die
Anfahrzugkraft dieses Antriebs; Betriebs- und Schnellbremsgrenzen werden als
konservative Minima auf das abgeleitete Formationsprofil angewandt. Ein
positiver Rest nach `PowerBasisPoints` wird auf ganze kW abgerundet, verändert
aber die belegte Anfahrzugkraft am Stillstand nicht. Diese Entscheidung gilt
identisch in Compiler, Operational und Fleet. `vehicleIds` ist autoritativ von
Zugspitze nach Zugschluss geordnet, die Einbaurichtung entscheidet, welcher
physische Führerstand außen liegt.

Vor der Ausgabe prüft der Compiler außerdem dieselben ganzzahligen
Formationssummen wie Fleet für Gesamt- und Erste-Klasse-Sitze, Fahrrad- und
Rollstuhlplätze sowie Betriebskosten.

Für das produktive Authority-v2-Deployment bindet
`zugfolge-vehicle-catalog-deployment-binding/v1` die echte Compile-Receipt-v4
und das bytegeprüfte Operational-v2-Inventar an Welt, `producedAt`,
EconomyRelease, Fleet-Authority, Blueprint-Fleet-Hash und beide initialen
Formationsprojektionen. Die Bindung ist Teil des signierten
`AlphaWorldDeployment`; sie macht weder den Offline-Compiler noch einen Client
zu einem Signierer. Der Alpha-v2-Weltstart akzeptiert keine
Legacy-Authority-v1 und besitzt keine V1-Kompatibilitätsprojektion.

Der reale Alpha-Buildpfad `tools/region-import/build-alpha-world.mjs` verlangt
für Authority v2 den Wrapper sowie Receipt v4, Operational Inventory v2,
Source Catalog v2, World Seed v3 und Compiled Catalog v3 als gemeinsame
Eingaben. Er führt den Rust-Compiler aus exakt Source und Seed in einem frischen
temporären Verzeichnis erneut aus und verlangt Bytegleichheit aller fünf
Ausgaben. Erst danach prüft er Output-Set, EconomyRelease,
Blueprint-Fleet-Hash und beide Formationsprojektionen und nimmt die Bindung samt
Hashes der drei tatsächlich gelesenen Eingabedateien in das unsignierte
Deployment auf. Die Compiler-Hashes
sind absichtlich bytegenau auf Rust-Pretty-JSON plus abschließendem LF; eine
Umordnung von JSON-Schlüsseln ist deshalb kein äquivalentes Releaseartefakt und
scheitert fail-closed. Der manifestierte `generationScriptSha256` bindet sowohl
`build-alpha-world.mjs`, den sicherheitskritischen Binder-Helper und den
Fleet-v2-Migrationscompiler jeweils mit Pfad und Einzelhash; eine Änderung
dieser Buildquellen bleibt damit nicht außerhalb der signierten
Buildprovenienz.

Der einmalige, explizite Offline-Cutover des freigegebenen 490-Fahrzeuge-
Bestands läuft über `migrate-alpha-fleet-v1-to-v2.mjs`. Eingecheckt wird eine
hashfreie Jahresspezifikation. Erst `build-alpha-fleet-migration-contract.mjs`
erzeugt daraus anhand der real gelesenen Bytes einen Migrationsvertrag, der
Legacy-Datei, Authority-Inhalt, Buildkonfiguration, GTFS-Envelope,
Economy-Spezifikation, InfraRelease-Wrapper, Bestandszahl, Rechteentscheidung,
Zielwelt und den exakten signierten GTFS-Release-Namespace bindet.
Los- und Linienkennungen enthalten einen SHA-256-Anteil aus den unverkürzten
GTFS-Fachwerten; lesbare Slugs sind niemals Identitaetsquelle. Der Compiler
weist eine mehrdeutige historische Slug-Linienzuordnung vor der
Fahrzeugallokation fail-closed ab. Er erhält daraus einen echten
`zugfolge-vehicle-catalog-source/v2` und einen
`zugfolge-vehicle-world-seed/v3`; er benennt keinen JSON-Wurzelknoten um.
Konkrete Fahrzeug- und numerische Kennungen bleiben erhalten, weltbezogene
Fahrplanbelege werden aus Operational-v2-Zustand und Timetable-Routen neu
abgeleitet, und nicht benötigte Fahrzeuge werden sichtbar `reserve-pool`
zugeordnet. Technische Übernahmen bleiben als freigegebene Fakten markiert;
neu ergänztes Bremsgewicht und Dynamikgrenzen sind ausdrücklich
`game-assumption`.

Die vollständige Buildkonfiguration wird nicht mit handberechneten Hashes
gefüllt. `build-alpha-world-configuration.mjs` übernimmt Weltidentität,
Operational-v2-Datei-/Zustandsbindung und Timetable-Routenbeleg direkt aus dem
kanonischen InfraRelease-Wrapper und schreibt ausschließlich create-new:

```powershell
node tools/region-import/build-alpha-world-configuration.mjs `
  ALPHA-WORLD-IDENTITY.json INFRA-RELEASE-WRAPPER.json BUILD-CONFIG.json
```

```powershell
node tools/region-import/build-alpha-fleet-migration-contract.mjs `
  MIGRATION-SPECIFICATION.json BUILD-CONFIG.json GTFS.json `
  LEGACY-ALPHA-DEPLOYMENT.json ECONOMY.json INFRA-RELEASE-WRAPPER.json `
  MIGRATION-CONTRACT.json

node tools/region-import/migrate-alpha-fleet-v1-to-v2.mjs `
  MIGRATION-CONTRACT.json BUILD-CONFIG.json GTFS.json `
  LEGACY-ALPHA-DEPLOYMENT.json ECONOMY.json INFRA-RELEASE-WRAPPER.json `
  TIMETABLE-ROUTES-V2.jsonseq MIGRATION-OUTPUT-DIRECTORY
```

Buildkonfiguration und gebundener Vertrag werden in dieser Reihenfolge nach dem
kanonischen InfraRelease-Wrapper erzeugt; beide Ausgabepfade müssen fehlen. Der
Vertragscompiler berechnet Byte- und kanonische SHA-256-Pins und prüft
SnapshotHash, GTFS-Quellbeleg sowie Operational-v2-Release-, Byte- und
Zustandsbindung. Das Migrationszielverzeichnis muss ebenfalls fehlen. Source,
Seed, Rust-Compiler-Ausgaben und
Migrationsbeleg entstehen gemeinsam in einem eindeutigen Staging-Verzeichnis
und werden erst nach vollständiger Prüfung atomar create-new veröffentlicht.
Ein fehlgeschlagener Versuch hinterlässt keinen Teilsatz und kann wiederholt
werden. Der Pfad quittiert den Compiler-Output-Set-Hash; er erzeugt weiterhin
weder Signatur noch Produktionsfreigabe.

Der Dateicompiler wird ausschließlich offline ausgeführt:

```powershell
cargo run -p zugfolge-fleet --bin zugfolge-vehicle-catalog -- `
  SOURCE-CATALOG.json WORLD-SEED.json OUTPUT-DIRECTORY
```

`OUTPUT-DIRECTORY` darf noch nicht existieren. Der Prozess serialisiert erst
alle fünf Dateien, schreibt sie in ein neues Staging-Verzeichnis und
veröffentlicht anschließend den vollständigen Satz. Ein Fehler oder ein
bereits vorhandenes Ziel überschreibt kein früheres Release.

Die CLI erzeugt einen reproduzierbaren, hashgebundenen **Release-Kandidaten**,
aber keine Signatur und keine produktive Alpha-Freigabe. Der Receipt beweist
Integrität und deterministische Zusammengehörigkeit, nicht die Identität eines
Freigebenden. Produktiv initialisiert wird ausschließlich ein vollständig
hashgeprüfter Ausgabesatz, dessen Receipt zuvor mit Quellkatalog und Welt-Seed
erneut validiert und anschließend durch den bestehenden signierten
Alpha-Deployment-Vertrag gemeinsam mit Infra-, Fahrplan- und EconomyRelease
gebunden wurde. Solange diese getrennte Signatur- und Deployment-Freigabe
fehlt, bleibt auch eine loaderfähige Catalog-Datei ein Kandidat. Dieser
Compiler erzeugt weder den signierten `AlphaWorldDeployment` noch den dort
gebundenen Fleet-Release-Hash und behauptet deshalb keinen produktiven
Signaturbeweis. Ein direkter Import beliebiger Fleet- oder Operational-JSON
umgeht die Economy- und Laufwegprüfungen des Compilers und ist kein
unterstützter Releasepfad.

## 6. Fail-closed-Prüfungen

Der Compile-Lauf verwirft mindestens:

- unbekannte JSON-Felder oder Schemafassungen;
- eine `worldId`, die keine kleingeschriebene kanonische UUID ist;
- leere, doppelte oder nicht kanonisch sortierbare Kennungen;
- fehlende, unbekannte, gesperrte oder ungenutzte Belege;
- bloß behauptete, nicht compilerregistrierte deterministische Ableitungen;
- ungültige SHA-256-, Datums-, Rechteentscheidungs- oder Konfidenzangaben;
- Null- oder Überlaufwerte in Pflichtfeldern;
- angetriebene Typen ohne Leistung, Anfahrzugkraft oder vollständigen
  Rohdynamikblock;
- nicht angetriebene Typen mit Antriebsleistung;
- partielle Rohdynamikblöcke, nicht reproduzierbare Referenzprofile oder
  unplausible Obergrenzen für Leistung, Anfahrzugkraft, Beschleunigung und
  Bremsung;
- LZB ohne PZB sowie führende Fahrzeuge ohne PZB oder ETCS;
- Formationen mit unterschiedlichen Antriebsarten oder Stromsystemmengen ihrer
  angetriebenen Assets, auch bei einer späteren Operational-Formationsänderung;
- Überläufe der von Fleet gebildeten Sitz-, Fahrrad-, Rollstuhl- oder
  Betriebskostensummen;
- Zustands- oder Einschränkungswerte über 10.000 Basispunkten;
- numerische Kennungen, Zeitwerte, Bahnsteiglängen oder Zähler außerhalb des
  sicheren JSON-Ganzzahlbereichs;
- in Fleet Authority v2 fehlende, ungültige oder zwischen Fleet und
  Operational abweichende Assetzustände und Lebensläufe;
- fehlende, unbekannte, doppelte oder nicht exakt assettypdeckende
  EconomyRelease-Kostensätze;
- einen Basis-EconomyRelease-Checksum oder Economy-Projektionshash, der vom
  erneut berechneten Wert abweicht;
- Bau- und Beschaffungsjahre außerhalb der belegten beziehungsweise
  ausdrücklich erlaubten Zeitfenster;
- Welt-, Typ-, Asset-, Formations-, Betreiber- oder Trassenbezüge, die nicht
  geschlossen auflösbar sind.

Gleiche kanonische Eingaben müssen bytegleiche Projektionen und denselben
Ausgabesatz-Hash erzeugen. Dieser Hash umfasst Schema- und Compilerversion,
Kennungen und SHA-256 beider Eingaben, den EconomyRelease-Pin, den verketteten
Projektionshash sowie alle vier Ausgabehashes einschließlich des
Single-World-Wrappers. Tests initialisieren mit einer einzigen Compiler-Ausgabe
sowohl die Fleet-Runtime als auch Operational v2 und prüfen
zusätzlich Manipulation, Reihenfolge, Rechte-Gate, unformierte Assets,
Wagenparks ohne Fahrdynamik, Führerstände, kompatible BEMU-Doppeltraktion,
inkompatible Mischtraktion und unvollständige Typen.

## 7. Redaktioneller Freigabeablauf

1. Kandidat anhand offizieller Primärquellen recherchieren und Lücken sichtbar
   lassen.
2. Exakte Konfiguration und Feldbelege fachlich gegenlesen.
3. Lizenz, Inhalts-Hash und datierte Rechteentscheidung dokumentieren.
4. Erst danach den Kandidaten in den Quellkatalog übernehmen.
5. Welt-Seed mit konkreten Assets erstellen und offline kompilieren.
6. beide Runtime-Initialisierungen, Hash-Reproduzierbarkeit und negative Gates
   ausführen.
7. den vollständigen Artefaktsatz signieren und gemeinsam mit Infra-, Fahrplan-
   und EconomyRelease an die Welt binden.

Eine große Kandidatenzahl ist daher kein Abnahmebeweis. Abgenommen ist nur der
Teilbestand, dessen Pflichtfelder, Rechte und beide Laufzeitprojektionen
gemeinsam grün sind.
