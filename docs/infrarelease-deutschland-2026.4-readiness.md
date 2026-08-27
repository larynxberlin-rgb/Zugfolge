# Deutschland-InfraRelease 2026.4: Readiness-Bericht

Stand: 2026-08-26

## Ergebnis

`infra-deutschland-2026.4` ist der einzige aktuelle Deutschland-Kandidat. Der
lokale create-new Lauf hat Fahrwegrouten-v2, Operational-v2, synthetische
Closure, Operational-Qualität, öffentliches ReadModel, InfraRelease-v2,
MapRelease-v1, Delivery-v2 und das getrennte statische Paket aus den gepinnten
realen Deutschland-Eingaben neu erzeugt. Delivery-v2, Signed-Plan und das
integrierte Operational-v2-Paket sind mit dem neuen `.4`-Key signiert,
vollständig verifiziert, frisch lokal installiert und im Game-Staging
qualifiziert. Die operative Ableitung ist
`activationEligible=true`, `unresolvedRequired=0` und
`operationalQualityEligible=true`; sie behauptet keine real beobachteten
Stellwerksfakten (`realInterlockingFactsClaimed=false`).

Das ist noch keine Produktionsfreigabe. Clean-Commit-E2E, CI, Build-Evidence,
STRATO-/Odoo-/Recovery-Abnahme, kontrollierter Cutover, Dauerbetrieb und
Browsertest sind getrennte Gates. Solange eines davon fehlt, darf `.4` nicht
aktiviert werden.

## Release-Identität und verworfener Vorgänger

Die kanonische Identität lautet:

- InfraRelease: `infra-deutschland-2026.4`
- Paketversion: `2026.4`
- neuer Map-Key-ID: `zugfolge-map-deutschland-2026.4`
- formaler Rollback-Vorgänger: `infra-deutschland-2026.2`

Der zuvor lokal signierte Kandidat `infra-deutschland-2026.3` ist
unveränderlich verworfen. Er wurde weder in Odoo noch im Game oder auf einem
Server importiert oder aktiviert. Sein Map-Key `zugfolge-map-deutschland-2026.3`
darf nicht im kanonischen Trust-Keyring stehen. Seine Delivery-Datei
(268.910 Bytes, SHA-256
`cdb3151cbba17b3434f840a6648181f8ff56716e7aa3e523e15128a879890891`,
Release-Hash
`c1e3800f5aa028aa50d71fab61cf08985f5f84e39fee09fe549b8d57826d86d8`)
ist ausschließlich forensischer Altbestand und kein Ergebnis oder
Akzeptanzbeleg für `.4`.

Insbesondere sind die beiden historischen Operational-v2-Paketmarker mit dem
unzulässigen `zugfolge-map-runtime/v1`-Vertrag ausdrücklich verworfen und
dürfen weder Trust-Registrierung noch Preflight oder Aktivierung erreichen:

| historischer Paketmarker | SHA-256 | Status |
|---|---|---|
| `zugfolge-map-deutschland-2026.3-v2-unsigned/.zugfolge-map-package.json` | `91d13afbe78715a9a55758aaf549e4df777a69df15f87d4b430c2089e8451010` | verworfen; Runtime-v1 unter Paket-v2 |
| `zugfolge-map-deutschland-2026.3-v2-signed/.zugfolge-map-package.json` | `19eca1460912dcc004936e787041ae633e53cf9c1126dd7bbddace4ba636d4b8` | verworfen; Runtime-v1 unter Paket-v2 |

Neu abgeleitete Paketmarker besitzen andere Bytes und müssen den harten
`zugfolge-map-runtime/v2`-Vertrag erneut vollständig bestehen; keiner der
beiden Alt-Hashes ist ein zulässiger Rollback- oder Produktionsbeleg.

Der Alpha-Key `zugfolge-alpha-2026.3` gehört zu einer getrennten
Weltdeployment-Schlüsselfamilie. Seine weitere Verwendung sagt nichts über die
Map-Release-Identität aus. Ebenso bleibt
`tools/tiles/map-asset-notices.annual-2026.3.json` ein explizit
wiederverwendeter, release-neutraler Quellen-/Lizenzbeleg, kein `.4`-Ergebnis.

## Gepinnte Quellen

Das Infrastruktur-Capture
`var/derived/germany-2026.4/source-capture.2026.4.json` wurde create-new am
`2026-08-26T03:09:00.000Z` erzeugt. Es umfasst 1.508 Bytes und hat den SHA-256
`7d0e0bd493a19ed569b733d8e2c46217027a9934d3b74b4940bed67b743a2e67`.
Es bindet genau die fünf verwendeten Quellen:

| Quelle | Version | Bytes | SHA-256 |
|---|---|---:|---|
| Deutschland-OSM-PBF | `germany-260811` | 4.816.726.656 | `5f7bfb9800c74b236b28405453b2e45337ae225c88be2078a7bdc49bd3e945b0` |
| DB InfraGO Open Data | `2026-05` | 54.587.392 | `79f8227e889769d87dcc77301f58adbc93a31839febb0cd1bdb16679e25453fe` |
| GTFS Schienenregionalverkehr | `2026-08-10` | 11.246.155 | `c0cba1cfdbf6179b18e529b13613644e861f1ea6159fa5788c2045de82bea738` |
| Copernicus DEM GLO-30 | `COP-DEM-GLO-30-DGED-2021` | 2.204.833.309 | `8a7d5784f47ce9e775f474858ed8948ac969920d84a795452f6b29add13857cd` |
| OpenStation NeTEx | `1.2.4-2026-08-12T02:38:37.532Z` | 303.425.534 | `04f489a1cb7bb9513e10c90d5d613e0f21265c8ed6b8f3f342f85f7fab7623b3` |

Das getrennte Map-Capture umfasst 8.643 Bytes und hat SHA-256
`8662e9b4fa5ba30a937c234f77ddcab56ad50825e9d40bc7b58be0ea63fa973f`.
Es bindet die fertigen Infrastruktur-PMTiles (1.502.999.402 Bytes, SHA-256
`83eaf2437b5ead10632228e92ccf84b6c1468f7f0317d0e1713571331a9d5ef5`)
und die unveränderte Welt-Basemap. Sources-v3 umfasst 11.827 Bytes, SHA-256
`55f3a417d16f8a0e48325fa1e1fe25f6fa7a6d03d1bab940fcd6b287b9db1681`
und genau sechs öffentliche Quellen.

## Verifizierte Fachartefakte

| Artefakt | Verifizierter lokaler `.4`-Wert |
|---|---|
| GTFS-Region-v2 | 14.797.184 Bytes; SHA-256 `cbebbcb73e1807df793c26411873b2df442e6ce38d28fd0593a78e5ae93912c5`; Snapshot-Hash `811fcafe581e73409b373ec5e2568dbb44048d604be834d1aa998abe4a35a8a7` |
| Fahrwegrouten-v2 | 135.924.871 Bytes; SHA-256/Route-Set `a7ec19f3e413b742b75d6733721c41d63ea78e7341376f30efc450841bcba3d8`; 1.679/1.679 Routen; 644.297 Fahrwegbeine; Bericht 3.264 Bytes, SHA-256 `7475d2b6cd616ccc8a5d6057b4d3a3c9a57b1301fa9d92e989adb128cd97b91c` |
| Operational-v2 | 983.736.272 Bytes; SHA-256 `64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6`; State-Hash `deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788` |
| Ableitungsbericht | 3.735 Bytes; SHA-256 `77b0e8e0bbc7990e7b1c055b227fd3f9c3bb9e235f99f45101b6309afb5f6cc4`; `activationEligible=true` |
| Closure-Receipt-v2 | 7.539 Bytes; Datei-SHA-256 `dda29637956648001023161f9cf9abfcae283c359eea25b9fa62f313ad993166`; Receipt-SHA-256 `4644c2529033ae0e30d828c09fdadce1273238d136788ae10595292179a1080e` |
| Operational-Qualität | 4.336 Bytes; SHA-256 `759517c999906eb2958ff62741ac132da8565766beaf684e7adc442c679e3279`; operativ B=1/C=0 |
| Artefaktinventar-v2 | 1.199 Bytes; SHA-256 `87dbeadb0a814701a72a536d9057a0d5a3d0264edf761444e9563497ccd23624` |

Der operative Graph umfasst 609.258 gerichtete Kanten, 1.491.216
Blockressourcen, 1.679 vollständige Interlocking-Routen, 644.297 synthetische
Grenzsignale, 11.952 Bahnsteigintervalle, 829.865 Signale und 101.212 Weichen.
OSM-Zugsicherung wird kanonisch auf
`pzb`, `lzb`, `etcs-level1` und `etcs-level2` abgebildet. Mehrdeutige
Werte werden nicht behauptet; der konservative PZB-Fallback bleibt fail-closed.
Der Operational-v2-Vertrag trennt `availableProtectionSystems` als
streckenseitige Alternativenmenge von
`simultaneouslyRequiredProtectionSystems` als echter kumulativer Pflicht.
Beide Listen sind eindeutig, bekannt und kanonisch sortiert; jede gleichzeitige
Pflicht muss auch als verfügbar ausgewiesen sein. PZB darf deshalb eine
PZB/LZB-Überlagerung unter der signalgeführten Rückfallebene befahren; reine
LZB- und ETCS-Mengen bleiben für disjunkt ausgerüstete Fahrzeuge fail-closed.

Der aktuelle `zugfolge-germany-timetable-route-compiler/v4` bindet diese
Kompatibilitätsgrenze bereits bei der simulierten GTFS-Fahrwegwahl explizit an
`selection.permittedProtectionModes=["pzb"]`. Eine kürzere reine ETCS- oder
LZB-Kante darf daher keinen PZB-kompatiblen Regionalfahrweg verdrängen; eine
PZB/ETCS- oder PZB/LZB-Überlagerung bleibt wählbar. Gibt es zwischen zwei
Halteankern keinen kompatiblen Weg, bleibt der Routenbericht gesperrt und es
wird kein Routenartefakt veröffentlicht. Der vollständige Programmvorlagen-
Preflight prüft anschließend jede Formation gegen jedes Fahrwegbein erneut.
Zusätzlich bindet v4 den reproduzierbaren Daily-Circulation-Plan sowie alle
erforderlichen Überführungswege als eigenständiges
`zugfolge-timetable-transfer-demands/v1`-Artefakt. Routenbericht,
Transfermenge und Movement-v2-Vorlagen müssen dabei dieselben Plan- und
Set-Hashes ausweisen; eine fehlende physische Tagesfortsetzung sperrt den
Release.

## Sichtbare Kartenqualität und ReadModel

Die sichtbare Kartenqualität bleibt getrennt von der operativen Qualifikation:

- 1.470.998 Features in zehn Layern;
- Klasse A = 0, B = 1.439.038, C = 31.960;
- sichtbare C-Objekte bleiben nicht betrieblich bestellbar und werden nicht
  umklassifiziert.

`static-map-quality-v2.json` umfasst 3.097 Bytes und hat SHA-256
`888f4887e60d142ccf014704613d5213b64005e606f9e69b0f09b266395198e5`.
Der interne Detailbericht umfasst 12.669 Bytes und hat SHA-256
`819a1b48583c0e8dc801104fb25761e034e5f688122cb443e0ba7a691fd81426`.

Das ReadModel umfasst 1.224.380.416 Bytes und hat SHA-256
`946df17902ac979b3d9e1c2b5aee12f810057287221e4a1fb1a44a720ef8a41e`.
Sein Bericht umfasst 1.980 Bytes und hat SHA-256
`fa9e1593cf9a84adcd6bf02c30994e29de4f7be49e22eef0d3d4c4b14d715d8c`.
Er belegt 1.470.998 Kartenobjekte, 42.359 aktive Bahnfahrten, 190.370
Fahrplanhalte und 42.359 Passenger-Pläne für `20260810`.

## Release-, Signatur- und Paketnachweise

| Vertrag | Datei / Release-Hash |
|---|---|
| InfraRelease-v2 | 8.023 Bytes; SHA-256 `88ac8bbcfdc83736d2a76bfaee2b0748aed45dc9aa59d7b0e792ea785ecfdc67`; Release-Hash `5f9e96249d7525a4fdc52519f08a962619c75571411899e3b182cb2d55237fd9` |
| MapRelease-v1 | 11.454 Bytes; SHA-256 `7b8ba42a1b6a2a3b2953cb18ce6b9a722bb630e31ff5120a812e77745fea5d8f`; Release-Hash `068ff0cbc05240a64317f8bbbfb291fb302262b60f62720e20ad7a9580c22255` |
| unsigned Delivery-v2 | 268.685 Bytes; SHA-256 `08c15a206f643d904151f50b6697c8e691329839a97baf0582c3d07586c60da7`; Sources-SHA-256 `f732c2083f470f0f3f15a98c93dca4f516d71612f101540686c0f95076b24c52`; 1.034 Artefakte und 7 Quellen; `releaseHash=null`, `signature=null` |
| signierte Delivery-v2 | 268.909 Bytes; SHA-256 `d181d47a6ee09e9e462e440f4fba7e732130854d34fabdc19f910c66f70cb709`; Release-Hash `bccd17622424579eb9607aa39451d5639cbfc6a2d4bb5648771ce7039f281d40`; Ed25519-Key `zugfolge-map-deutschland-2026.4` |
| vollständig gepinnter Signed-Plan | 447.999 Bytes; SHA-256 `104cca8f7caf7ec55314ad38f53455af846d354d4852c72477d6718ff365b4db`; 1.036 Dateien |

| Lokales Paket | Manifest und Laufstatus |
|---|---|
| statische Karte v2 unsigned | `zugfolge-static-map-package/v2`; 606.519 Manifestbytes; Manifest-SHA-256 `8c7a4a06fde040e808a649487af15e9c75690ee384a511788abf66a8e2b2412f`; 1.172 Dateien; 14.291.197.408 Paketbytes; Pack, Verify und frische Installation bestanden |
| integriertes Operational-v2 signed | `zugfolge-map-package/v2`; 608.741 Manifestbytes; Manifest-SHA-256 `b773792afbe1bc4d487e3465f02f415d2e1fe9137559d4560ff785c3f6f74d1b`; 1.036 Dateien, 1.180 Teile und 15.274.595.052 Nutzbytes; Pack, vollständiges Verify und Erstinstallation mit Status `installed` bestanden |
| Signed-Game-Staging | alle 1.180 Teile bytegenau angenommen; Delivery-Signatur gegen den kanonischen Keyring und Operational-State-Hash nativ verifiziert; kein Skip |

Das aktuelle Buildcache-Inventar umfasst 226.468 Bytes und 1.133 Dateien; sein
SHA-256 lautet
`920d904222e7f31729ab7113d8ac11a1f77dbd68cdd364c7c02500c5f5d6537e`.

Der kanonische Keyring enthält die unveränderten Alpha-Keys
`zugfolge-alpha-2026` und `zugfolge-alpha-2026.3` sowie ausschließlich den
aktuellen Map-Key `zugfolge-map-deutschland-2026.4`. Der verworfene `.3`-Map-Key
ist entfernt. Beide privaten Schlüssel liegen außerhalb von Git und außerhalb
des Repositorys.

## Alpha-Migration und Real-E2E

Die `.4`-Buildkonfiguration umfasst 902 Bytes, SHA-256
`ef32c2db446c2245655a9c950313b357739ca453ec6bdb4a6226b9554f18f42e`.
Der v2-Migrationsvertrag umfasst 3.383 Bytes, SHA-256
`e50218be5799c2cbca3d3a185fe04d9197b46113e4d0486ac2fc16f6b794d327`.
Das create-new rematerialisierte Fleet-v2-Bundle überführt exakt 490
Legacy-Assets in 467 aktive und 23 Reserve-Assets; sein Rust-Compiler bestätigt
Output-Set
`99c5e5195d778c375c369567a918144b34aaaa3e5034e05277d1b43bba460671`.
Das daraus create-new gebaute Alpha-Weltdeployment umfasst 7.057.730 Bytes,
SHA-256
`7400d56e2109db29050577c42a53f8e223325c4414c39b96cfcc9453f65eefba`.
Es bindet 1.677 Züge und Pfadreservierungen, 467 Umläufe und Personaldienste
sowie 490 Fahrzeuge. Seine native Operational-Initialisierung bindet Hash
`bfe87a16fe41d18a7b128b161d675051535f86d44d8f4cf87a1de636e3428347`
und initialen State-Hash
`aab320e9e028b0e79451a73dd9aa0fef1fa682ee4e4bf42d9a484766d7cd55fb`.
Das getrennte signierte Deployment umfasst 7.058.016 Bytes, SHA-256
`228d7c7cef743536f3b2621db200da898b4a1d30ec2cfe3b19d57fdea55c00c0`
und bindet Deployment-Hash
`4d9627d85ceab1c893a0fe3366e4d5f14f6173c58e164728d92825b81eb87098`
mit Ed25519-Key `zugfolge-alpha-2026.3`; die Signaturprüfung gegen den
kanonischen Public Key ist bestanden.

Der verpflichtende lokale Integrations-E2E verwendet den exakt gepinnten
unsigned/signed Kandidaten, verlangt in beiden Dateien denselben Weltvertrag,
prüft dessen kanonischen Deployment-Hash und die echte Ed25519-Signatur und startet die native
Operational-v2-Runtime gegen eine dedizierte, leere PostgreSQL-16-Datenbank,
committet mindestens Revision 1 und restauriert denselben State-Hash. Der
PostgreSQL-Prozess läuft entsprechend der Produktionsarchitektur außerhalb der
gemessenen App-cgroup; Node, NAPI, Worker, Scheduler und sämtliche
Operational-v2-Seitenzugriffe bleiben innerhalb ihrer festen 512-MiB-Grenze.
Der Test führt die 33 Repository-Migrationen selbst aus, vergleicht anschließend
für jede Migration Erstellungszeit und SQL-SHA-256 exakt mit dem
Drizzle-Journal und verlangt `schema_current` sowie eine weltleere Datenbank vor
der ersten Mutation. Eine außerhalb des gemessenen App-Prozesses vorbereitete
Zugfolge-Schema- oder Weltdatenbank wird fail-closed abgelehnt.

Die Readiness-Prüfung bindet die signiert
erwartete Echtzeitregion an die tatsächlich restaurierte Worker-Region und den
erwarteten LiveMap-Feed; verlangt werden
`{status:"ok", code:"scheduler_current"}` und
`{status:"ok", code:"livemap_fresh"}`. Ein leerer optionaler Health-Pfad kann
diesen Beleg nicht erfüllen.
Vor jeder Datenbankmutation rendert der E2E das Fleet-Authority-Format mit
`loadOperatingRuntime().initializeFleet(...)` und das Planning-Authority-Format
mit `parsePlanningInfrastructureRelease(...)`. Der daraus erzeugte
`zugfolge-germany-rendered-authority-proof/v1` bindet beide Produktionsparser,
ihre Release-/State-Hashes und Zählwerte an den bereits verifizierten signierten
Deployment-Hash. Damit ist das lokale Schließungsevidence für #297 Bestandteil
desselben Weltartefaktpfads und keine synthetische Ersatzfixture.
Er bindet vor und nach dem Lauf denselben echten Git-HEAD und verlangt
`git status --porcelain --untracked-files=all` leer; ignorierte Build- und
Evidence-Ziele bleiben davon unberührt. Der
`zugfolge-germany-runtime-build-proof/v1` erfasst zusätzlich Bytezahl und
SHA-256 des explizit erwarteten NAPI-Addons sowie der tatsächlich geladenen
TypeScript-Runtimemodule. Der harte Lauf verifiziert zusätzlich deren
kanonischen Gesamt-Hash
`2540fcc5eedf7f6a76283d2922ff31d3d244d3bfb5dd15da9af92f05fa78628d`;
ein lediglich vorhandener, aber nicht exakt gepinnter Build bleibt rot. Unter Linux muss cgroup-v2
exakt 512 MiB `memory.max`, `memory.swap.max=0` und einen Peak innerhalb der
Grenze belegen. Zusätzlich müssen `oom` und `oom_kill` in `memory.events` vor
und nach dem Lauf null bleiben. Debug-Läufe aus einem dirty Checkout sind
ausdrücklich nicht akzeptanzfähig. Dasselbe gilt für ephemer signierte
Debug-Deployments oder einen Lauf ohne expliziten NAPI-Expected-SHA und
TypeScript-Build-Set-Expected-SHA. Nur die
gemeinsame Top-level-Entscheidung darf `acceptanceEligible=true` setzen.
Der separate Operational-Streaming-RSS-Test bindet den 983.736.272-Byte-Korpus
exakt per Datei-SHA-256 und State-Hash und verlangt zusätzlich mindestens
900 MiB Eingabegröße. Die Schwelle kennzeichnet den realen Großkorpus, ohne für
den kompakteren Vollrouten-Kandidaten eine unzutreffende Größe über 1 GiB zu
behaupten; die harte 512-MiB-cgroup-Grenze bleibt unverändert.

Davon getrennt existiert der eindeutig benannte Robustheitspfad
`archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze`.
Seine archivierte, nicht aktivierbare Quellfassung liegt unter
`var/derived/germany-2026.3/operational-infrastructure-v2.json`: exakt
1.455.920.792 Bytes, Datei-SHA-256
`64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c`
und State-Hash
`5972ef9d4897e5dc225ff463620745913846a6b16dba813f5fd12598c768399f`.
Diese Quellfassung verwendet im Route-Leg noch den abgelösten Build-Feldnamen
`requiredProtectionSystems` und darf deshalb nicht direkt in den heutigen
Loader gelangen. Das ist keine Laufzeitkompatibilität: Vor dem Robustheitstest
erzeugt das einmalige Build-Werkzeug ausschließlich create-new eine getrennte
Arbeitskopie mit `availableProtectionSystems` und leerem
`simultaneouslyRequiredProtectionSystems`. Der Legacy-Korpus enthält exakt
644.900 betroffene Fahrwegbeine: 569.133 mit `pzb`, 50.446 mit `lzb,pzb`,
24.953 mit dem mehrdeutigen `etcs,pzb` und 368 nur mit `etcs`. Insgesamt werden
25.321 generische ETCS-Werte entfernt; davon benötigen genau die genannten 368
Fälle den Fallback. Der generische ETCS-Wert wird niemals als Level 1 oder 2
behauptet. Neben einer kanonischen
Beobachtung wird er verworfen; bleibt danach kein System übrig, greift exakt
der bereits in der `.3`-Policy `synthetic-operational-b/v2` gepinnte
`defaultProtectionSystem=pzb`-Fallback. Der Korpusdrift wird über alle drei
expliziten Zähler geschlossen. Vor dem atomaren Link prüft außerdem der
aktuelle native Loader die vollständig migrierten Bytes:

```bash
cargo build --release --locked -p zugfolge-infra --bin zugfolge-infra-release
export ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH="$(realpath target/release/zugfolge-infra-release)"
mkdir -p var/derived/germany-2026.3/protection-fields-v2
node tools/region-import/migrate-operational-v2-protection-fields.mjs \
  var/derived/germany-2026.3/operational-infrastructure-v2.json \
  var/derived/germany-2026.3/protection-fields-v2/operational-infrastructure-v2.json \
  --expected-release-id infra-deutschland-2026.3 \
  --expected-source-bytes 1455920792 \
  --expected-source-sha256 64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c \
  --expected-replacements 644900 \
  --expected-generic-etcs-dropped 25321 \
  --expected-pzb-fallback-applied 368
```

Das Werkzeug prüft die beiden historischen Quell-Pins vor dem Anlegen seiner
temporären Ausgabe. Migration und native Validierung sind bestanden. Die
create-new Arbeitskopie unter
`var/derived/germany-2026.3/protection-fields-v2/operational-infrastructure-v2.json`
besitzt exakt 1.485.411.153 Bytes; ihr Quell-/Output-SHA-256 ist
`89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e`.
Der native Receipt bindet dazu den kanonischen SHA-256
`9e378f65b528699609312e792965d9deb52276c12198609bb005b3356fe7d1bb`
und den State-Hash
`6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed`.
Alle drei Korpuszähler entsprachen 644.900 / 25.321 / 368. Der getrennte Test
teilt sich Validator, RSS-Messung, cgroup-v2-/No-Swap-Prüfung und create-new
Evidence-Writer mit dem aktuellen `.4`-Test, verlangt aber strikt mehr als
1 GiB und schreibt ein eigenes Profil und einen eigenen Belegpfad.

Der >1-GiB-RSS-Realtest ist auf Linux für Commit
`3105d452beb1b56eeca8b220794dc7d3b50e169a` bestanden. Die frische cgroup-v2
band `memory.max` an 536.870.912 Bytes und `memory.swap.max` an 0; der native
Streaming-/redb-Lauf validierte 1.485.411.153 Quellbytes in 546,92 Sekunden bei
49.147.904 Bytes Prozess-Peak-RSS. Der cgroup-Peak erreichte die harte Grenze,
ohne Swap oder OOM. Der create-new Beleg
`test-results/germany-2026.4/20260826T1828Z-3105d45/archived-2026.3-over-1gib-streaming-rss-proof.json`
hat 784 Bytes und SHA-256
`f7990fc4317f170cfe79618842b45bd504f3b08311e3497c928aff7387de3fb2`.
Damit ist der lokale Robustheitsbeleg für #398 grün; die `.3`-Arbeitskopie
bleibt ausdrücklich nicht aktivierbar. Der reproduzierbare Aufruf lautet:

```bash
export ZUGFOLGE_RUN_OPERATIONAL_V2_REAL_RSS=1
export ZUGFOLGE_OPERATIONAL_V2_REAL_REQUIRE_CGROUP_LIMIT=1
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_INPUT="$(realpath var/derived/germany-2026.3/protection-fields-v2/operational-infrastructure-v2.json)"
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_RELEASE_ID=infra-deutschland-2026.3
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_BYTES=1485411153
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_SOURCE_SHA256=89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_EXPECTED_STATE_HASH=6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed
export ZUGFOLGE_OPERATIONAL_V2_ARCHIVED_2026_3_RSS_PROOF_OUTPUT="$(realpath -m test-results/operational-v2/archived-2026.3-over-one-gib-rss-proof.json)"
cargo test --release --locked -p zugfolge-infra --test operational_streaming_real -- --ignored --exact archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze --nocapture
```

Der `.3`-Korpus darf durch diesen Robustheitsbeleg weder zum aktuellen
Releasevorgänger noch aktivierungsfähig werden. Der aktuelle Karten- und
Weltkandidat bleibt ausschließlich `.4`.

Der lokale Restore erzeugt einen zweiten Worker und lädt den persistierten
State-Hash in demselben Node-Prozess. Er behauptet weder einen vollständigen
Game-API-Prozessneustart noch HTTP-Readiness. Diese beiden Grenzen sowie zehn
aufeinanderfolgende Echtzeitintervalle bleiben ausdrücklich dem kontrollierten
Live-/Canary-Lauf vorbehalten.

## Verbleibende Gates

1. Alle deterministischen Hashes und Schlüsseldateien gemeinsam committen und
   danach keine getrackten Dateien mehr ändern.
2. Build-Evidence an genau diesen Commit binden und verifizieren.
3. NAPI und TypeScript-Ausgaben aus dem sauberen Commit neu bauen; danach den
   kalten Worker-Catch-up gegen die signierte Alpha-Welt unter 512 MiB bis zum
   echten Exitcode ausführen und seine create-new Evidence sichern.
4. Clean-Commit-E2E, mindestens 60.000 echte Kommandos, Restore, Scheduler- und
   LiveMap-Readiness sowie separaten NAPI-/RSS-Beweis abnehmen.
5. Frische CI sowie die getrennten Odoo-/Game-/Recovery-/Produktions- und
   Browsergates abnehmen.
6. Auf STRATO in einer isolierten 512-MiB-App-cgroup mit
   `memory.swap.max=0` den kalten Start gegen den dortigen externen
   PostgreSQL-Dienst beweisen; damit kann #393 vor Aktivierung geschlossen
   werden.
7. Im kontrollierten Live-/Canary-Schritt zusätzlich die echte
   `/ready`-HTTP-Latenz und mindestens zehn aufeinanderfolgende
   Scheduler-/LiveMap-Intervalle messen. Bis zu diesem Lauf bleibt #392 offen.

Erst nach allen sieben Punkten ist der bereits signierte Kandidat
aktivierungsfähig. Der vorliegende Bericht behauptet weder Odoo-Import noch
Produktionsaktivierung.
