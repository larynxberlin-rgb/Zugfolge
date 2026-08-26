# Deutschland-Kartenrelease 2026.4 v2

Diese Anleitung ist der autoritative create-new Lauf für
'infra-deutschland-2026.4' und Paketversion '2026.4'. Der statische
Kartenvertrag und der integrierte Operational-v2-Vertrag bleiben getrennt:

- statisch: 'zugfolge-static-map-package/v2', nicht aktivierbar;
- integriert: 'zugfolge-map-package/v2' mit 'zugfolge-map-runtime/v2', erst
  nach Signatur und allen Gates aktivierbar.

Beide Pfade verbieten 'train-map-projection.sqlite', Waypoint-Fallbacks,
geschätzte Zugpositionen und JavaScript-Operational-Fallbacks. Die sichtbare
Kartenqualität darf niemals als real beobachtete Stellwerksqualität ausgegeben
werden.

## Identität und Immutable-Grenze

Der aktuelle Kandidat bindet:

- InfraRelease-ID 'infra-deutschland-2026.4';
- Static-Map-ID 'karte-deutschland-2026.4-v2';
- Paketversion '2026.4';
- neuen Map-Key-ID 'zugfolge-map-deutschland-2026.4';
- formalen Vorgänger 'infra-deutschland-2026.2'.

Der lokal signierte Kandidat 'infra-deutschland-2026.3' ist unveränderlich
verworfen, wurde nie vertrauensregistriert, importiert oder aktiviert und darf
nicht als Vorgänger oder Ergebnis dieses Laufs verwendet werden. Sein
Map-Key-ID 'zugfolge-map-deutschland-2026.3' bleibt aus
'ops/keys/trusted-delivery-keys.json' ausgeschlossen.
Die historischen Paketmanifest-Hashes
'91d13afbe78715a9a55758aaf549e4df777a69df15f87d4b430c2089e8451010'
(unsigned) und
'19eca1460912dcc004936e787041ae633e53cf9c1126dd7bbddace4ba636d4b8'
(signed) kombinierten Paket-v2 mit 'zugfolge-map-runtime/v1'. Beide sind
ausdrücklich verworfen und dürfen weder Preflight noch Trust-Registrierung,
Rollback oder Produktion erreichen.

Zwei Dateinamensfamilien mit dem Suffix '2026.3' sind keine Releaseausgaben:
'tools/tiles/map-asset-notices.annual-2026.3.json' ist der ausdrücklich
wiederverwendete, release-neutrale Asset-/Lizenzbeleg. Drei weitere
Zwischenspezifikationen und das Copernicus-Capture bleiben im
Build-Evidence-Vertrag bytegenau als wiederverwendete Eingaben gekennzeichnet.
Alle erzeugten Dateien und alle Map-/Infra-Identitäten liegen dagegen
ausschließlich unter 'germany-2026.4' beziehungsweise tragen '2026.4'.

## Aktueller lokaler Abnahmestand

| Beleg | Lokaler .4-Wert |
|---|---|
| Operational-v2 | 983.736.272 Bytes; SHA-256 '64260fb3aca24d6ed8784c2a6891e1269b8f390c7b7db185bbee3001565f47e6'; State-Hash 'deb038434d53963ba6436d4b6811ffc096374ffd1c75887b4945b4a46ea3c788' |
| ReadModel | 1.224.380.416 Bytes; SHA-256 '946df17902ac979b3d9e1c2b5aee12f810057287221e4a1fb1a44a720ef8a41e'; 1.470.998 Kartenobjekte |
| Static-Map-Quality-v2 | 3.097 Bytes; SHA-256 '888f4887e60d142ccf014704613d5213b64005e606f9e69b0f09b266395198e5' |
| Infrastruktur-PMTiles | 1.502.999.402 Bytes; SHA-256 '83eaf2437b5ead10632228e92ccf84b6c1468f7f0317d0e1713571331a9d5ef5' |
| Style | 268.406 Bytes; SHA-256 'de19cd5ca7378be5424855f17bfb3c042224a3ec05242ada39b0b6d0eaa9d64a'; 71 Layer |
| InfraRelease-v2 | 8.023 Bytes; SHA-256 '88ac8bbcfdc83736d2a76bfaee2b0748aed45dc9aa59d7b0e792ea785ecfdc67'; Release-Hash '5f9e96249d7525a4fdc52519f08a962619c75571411899e3b182cb2d55237fd9' |
| MapRelease-v1 | 11.454 Bytes; SHA-256 '7b8ba42a1b6a2a3b2953cb18ce6b9a722bb630e31ff5120a812e77745fea5d8f'; Release-Hash '068ff0cbc05240a64317f8bbbfb291fb302262b60f62720e20ad7a9580c22255' |
| unsigned Delivery-v2 | 268.685 Bytes; SHA-256 '08c15a206f643d904151f50b6697c8e691329839a97baf0582c3d07586c60da7'; Sources-SHA-256 'f732c2083f470f0f3f15a98c93dca4f516d71612f101540686c0f95076b24c52'; 1.034 Artefakte und 7 Quellen |
| signierte Delivery-v2 | 268.909 Bytes; SHA-256 'd181d47a6ee09e9e462e440f4fba7e732130854d34fabdc19f910c66f70cb709'; Release-Hash 'bccd17622424579eb9607aa39451d5639cbfc6a2d4bb5648771ce7039f281d40'; Key 'zugfolge-map-deutschland-2026.4' |
| Signed-Plan | 447.999 Bytes; SHA-256 '104cca8f7caf7ec55314ad38f53455af846d354d4852c72477d6718ff365b4db'; 1.036 vollständig gepinnte Dateien |
| statisches Paket unsigned | 14.291.197.408 Bytes in 1.172 Dateien; Manifest 606.519 Bytes; SHA-256 '8c7a4a06fde040e808a649487af15e9c75690ee384a511788abf66a8e2b2412f'; Pack/Verify/Install grün |
| integriertes Paket signed | 15.274.595.052 Nutzbytes in 1.036 Dateien und 1.180 Teilen; Manifest 608.741 Bytes; SHA-256 'b773792afbe1bc4d487e3465f02f415d2e1fe9137559d4560ff785c3f6f74d1b'; Pack/Verify/Erstinstallation mit 'installed' grün |
| Signed-Game-Staging | alle 1.180 Teile angenommen; Signaturvertrauen und nativer Operational-State-Hash verifiziert; kein Skip |
| Buildcache-Inventar | 226.468 Bytes; SHA-256 '920d904222e7f31729ab7113d8ac11a1f77dbd68cdd364c7c02500c5f5d6537e'; 1.133 Dateien |

Der sichtbare Korpus enthält 1.470.998 Features in zehn Layern: A=0,
B=1.439.038 und C=31.960. Diese C-Objekte bleiben sichtbar, aber nicht
operativ bestellbar. Der getrennte Operational-Graph ist
'unresolvedRequired=0', operativ B=1/C=0 und
'realInterlockingFactsClaimed=false'.

Die signierte `.4`-Delivery, das signed Paket und der `.4`-Game-Staging-Beleg
sind lokal create-new nachgewiesen. Ein Clean-Commit-E2E, STRATO-/Odoo-Import,
Produktionsaktivierung oder `.4`-Browserbeleg werden an diesem Stand nicht
behauptet.

## Voraussetzungen

Alle Befehle laufen von der Repositorywurzel. Die Eingaben unter
'var/source-cache/annual-2026-pinned' und 'var/derived/germany-2026.4' müssen
die im Jahresvertrag gepinnten Bytes besitzen. Ziele werden nicht
überschrieben.

Für integrierte Operational-v2-Pakete ist vor Pack, Verify und Install der
native Dateiverifier Pflicht:

~~~powershell
$env:ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH = (Resolve-Path target/release/zugfolge-infra-release.exe).Path
~~~

## 1. Öffentliche Quality-, Infra- und Map-Wrapper

Die Reihenfolge ist bindend. Das öffentliche InfraRelease-Manifest entsteht
vor dem Map-Capture; Sources-v3 entsteht aus genau diesem Capture.

~~~powershell
node tools/tiles/static-map-quality-cli.mjs materialize tools/tiles/static-map-quality.annual-2026.4.json var/derived/germany-2026.4/map-release-free-v2/public/quality.json var/derived/germany-2026.4/map-release-free-v2/public/static-map-quality-v2.json

node tools/region-import/germany/build-germany-release.mjs manifest tools/region-import/germany/release.annual-2026.4.config.json tools/region-import/germany/source-catalog.json tools/guards/quellenregister.json var/derived/germany-2026.4/source-capture.2026.4.json var/derived/germany-2026.4/release-artifacts.v2.json var/derived/germany-2026.4/map-release-free-v2/public/static-map-quality-v2.json var/derived/germany-2026.4/operational-infrastructure-quality.json var/derived/germany-2026.4/map-release-free-v2/public/infra-release.json

node tools/tiles/build-map-source-capture.mjs var/source-cache/annual-2026-pinned/protomaps-dark-upstream-2026-08-12-08a5067f9cc54b1068e0e3cb830d9c51a6c8375be03ebea6acc7108d8d61d2df.json var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-8a5a34b8586ef55313370a8dfc7143f80e9c5e85fb1af5c5dfc2eb68e22c658b.metadata.json var/source-cache/annual-2026-pinned/welt-mit-deutschland-detail-2026-08-12-c766073e55b99b213276328e504cbb7a69b0b65db0546adf484539c3bd319aed.pmtiles var/derived/germany-2026.4/map-release-free-v2/infra-deutschland-2026.4.pmtiles var/derived/germany-2026.4/map-release-free-v2/public/infra-release.json tools/tiles/map-asset-notices.annual-2026.3.json . tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json . var/derived/germany-2026.4/map-release-free-v2/public/map-source-capture.json

node tools/tiles/static-map-sources-cli.mjs materialize tools/tiles/static-map-sources.annual-2026.4.json tools/region-import/germany/source-catalog.json var/derived/germany-2026.4/source-capture.2026.4.json tools/tiles/map-source-catalog.json var/derived/germany-2026.4/map-release-free-v2/public/map-source-capture.json tools/guards/quellenregister.json tools/tiles/map-asset-notices.annual-2026.3.json . var/derived/germany-2026.4/map-release-free-v2/public/static-map-sources-v2.json

node tools/tiles/build-map-release.mjs tools/tiles/map-release.annual-2026.4.spec.json . tools/tiles/map-source-catalog.json var/derived/germany-2026.4/map-release-free-v2/public/map-source-capture.json tools/guards/quellenregister.json var/derived/germany-2026.4/map-release-free-v2/public/map-release.json
~~~

## 2. Statisches Paket

~~~powershell
node tools/tiles/static-map-release-cli.mjs materialize tools/tiles/static-map-release.annual-2026.4.json . var/derived/germany-2026.4/static-map-release-free-2026.4-v2
node tools/tiles/map-package-cli.mjs pack-plan var/derived/germany-2026.4/static-map-release-free-2026.4-v2/package-plan.json . var/map-package/zugfolge-static-map-deutschland-2026.4-v2-unsigned
node tools/tiles/map-package-cli.mjs verify var/map-package/zugfolge-static-map-deutschland-2026.4-v2-unsigned
node tools/tiles/map-package-cli.mjs install var/map-package/zugfolge-static-map-deutschland-2026.4-v2-unsigned var/map-package-installed/zugfolge-static-map-deutschland-2026.4-v2-unsigned
~~~

Der statische Paketplan bindet 'operationalInfraRelease=false',
'productionActivationEligible=false' und 'signatureStatus=unsigned'.

## 3. Unsigned Delivery ohne integriertes Paket

~~~powershell
node tools/tiles/build-map-delivery-release.mjs tools/tiles/map-package.annual-2026.4.plan.json . var/derived/germany-2026.4/map-release-free-v2/public/infra-release.json var/derived/germany-2026.4/map-release-free-v2/public/map-release.json var/derived/germany-2026.4/map-release-free-v2/public/read-model.sqlite.report.json var/derived/germany-2026.4/map-release-free-v2/delivery-unsigned
~~~

Der unsigned Release muss 'releaseHash=null' und 'signature=null' tragen und
endet an dieser Stelle als Pre-Sign-Eingabe. Der ungepinnte Jahresplan darf
weder mit 'pack-plan' noch mit 'pack' als integriertes Operational-v2-Paket
verarbeitet werden. Integriertes Pack, Verify und Install beginnen erst nach
der freigegebenen Signatur aus dem vollständig expandierten und bytegenau
gepinnten 'signed-package-plan.json'; alle drei Schritte führen die native
Operational-v2-Dateiprüfung erneut aus.

## 4. Buildcache-Inventar

Erst nachdem alle Quellen und unsigned Ausgaben existieren, wird das
vollständige Inventar erzeugt. Die zweite Wurzel ist ausschließlich der
unveränderte Evidence-Overlaybestand für wiederverwendete Eingaben.

~~~powershell
node tools/tiles/map-build-cache-inventory-cli.mjs build-overlay infra-deutschland-2026.4 tools/tiles/map-build-cache-inventory.annual-2026.4.plan.json var/build-cache/infra-deutschland-2026.4/inventory.json . var/evidence-source-overlay-2026.3
~~~

Das Inventar ist create-new, streamt große Dateien und bindet jede reguläre
Datei mit Bytezahl und SHA-256. Symbolische Links, Pfadausbruch, Zusatzdateien
oder fehlende Eingaben brechen ab.

## 5. Signaturpfad nach ausdrücklichem Greenlight

Vor dem Greenlight werden weder produktiver privater Schlüssel noch
Map-Signatur erzeugt und der Trust-Keyring wird nicht verändert. Danach gilt:

1. neues Ed25519-Keypair mit Key-ID 'zugfolge-map-deutschland-2026.4'
   erzeugen;
2. privaten Schlüssel außerhalb des Repositorys halten;
3. alten Map-Key 'zugfolge-map-deutschland-2026.3' aus dem kanonischen
   Keyring entfernen, neuen öffentlichen .4-Key additiv zu den bestehenden
   Alpha-Keys eintragen und diese unverändert erhalten;
4. Delivery create-new signieren;
5. Signed-Plan ausschließlich ableiten, nie manuell editieren;
6. signed Paket packen, prüfen und frisch installieren.

~~~powershell
node tools/tiles/sign-map-delivery-release.mjs tools/tiles/map-package.annual-2026.4.plan.json . <PRIVATE_KEY_OUTSIDE_REPOSITORY> zugfolge-map-deutschland-2026.4 var/derived/germany-2026.4/map-release-free-v2/public/release.json

node tools/tiles/signed-map-package-plan-cli.mjs tools/tiles/map-package.annual-2026.4.plan.json . ops/keys/trusted-delivery-keys.json ops/keys/trusted-delivery-key-scopes.json var/derived/germany-2026.4/map-release-free-v2/signed-package-plan.json

$env:ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH = (Resolve-Path target/release/zugfolge-infra-release.exe).Path
node tools/tiles/map-package-cli.mjs pack var/derived/germany-2026.4/map-release-free-v2/signed-package-plan.json var/map-package/zugfolge-map-deutschland-2026.4-v2-signed .
node tools/tiles/map-package-cli.mjs verify var/map-package/zugfolge-map-deutschland-2026.4-v2-signed
node tools/tiles/map-package-cli.mjs install var/map-package/zugfolge-map-deutschland-2026.4-v2-signed var/map-package-installed/zugfolge-map-deutschland-2026.4-v2-signed
~~~

Der Signed-Generator expandiert den Jahresplan deterministisch zu einer
`zugfolge-map-package-spec/v2` und pinnt jede expandierte Paketdatei auf die
aktuell inventarisierten Bytes und SHA-256. Gegenüber dieser vollständig
gepinnten unsigned Spezifikation darf er fachlich nur die Releaseeingabe von
'delivery-unsigned/release.json' auf 'public/release.json' umstellen und deren
Bindung auf die echten signierten Bytes aktualisieren. Runtime, Paketidentität,
Rollen, Installationspfade und alle übrigen Inhalte bleiben gleich. Ein
integriertes V2-Paket aus einer manuell ungepinnten Spezifikation ist verboten
und wird vor dem Packen abgelehnt. Signaturerzeugung allein aktiviert keinen
Release und ersetzt nicht die Alpha-Weltdeployment-Signatur.
Der Signierbefehl inventarisiert den aktuellen expandierten Paketplan und prüft
Delivery-, Infra-, Karten-, Quality- und Sources-Bindungen vollständig, bevor
er den privaten Schlüssel liest. Ein veralteter unsigned Deliveryvertrag wird
daher ohne Schlüsselzugriff und ohne signierte Ausgabedatei verworfen.

## 6. Evidence und Real-Audits

Die deterministischen .4-Hashes werden vor dem gemeinsamen Commit in den
getrackten Readiness-Dokumenten fixiert. Danach muss der Checkout für den
Real-E2E vor und nach dem Lauf frei von getrackten und nicht ignorierten
ungetrackten Abweichungen sein; Evidence darf nur in ignorierte create-new
Ziele geschrieben werden.

~~~powershell
node tools/tiles/map-release-build-evidence-cli.mjs build tools/tiles/map-release-build-evidence.annual-2026.4.spec.json . var/derived/germany-2026.4/map-release-build-evidence.json <SEMANTIC_EXPORT_COMMIT> <MAP_BUILD_COMMIT>
node tools/tiles/map-release-build-evidence-cli.mjs verify var/derived/germany-2026.4/map-release-build-evidence.json .

$env:ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_ROOT = (Resolve-Path var/map-package/zugfolge-map-deutschland-2026.4-v2-signed).Path
$env:ZUGFOLGE_REAL_SIGNED_MAP_STAGING_ROOT = [IO.Path]::GetFullPath("var/game-staging/germany-2026.4-v2-signed")
$env:ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_VERIFIER = (Resolve-Path tools/tiles/map-package.mjs).Path
$env:INFRA_OPERATIONAL_V2_VALIDATOR_PATH = (Resolve-Path target/release/zugfolge-infra-release.exe).Path
$env:ZUGFOLGE_REAL_TRUSTED_DELIVERY_KEYS = (Resolve-Path ops/keys/trusted-delivery-keys.json).Path
$env:ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_BYTES = <ACTUAL_SIGNED_MANIFEST_BYTES>
$env:ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_SHA256 = "<ACTUAL_SIGNED_MANIFEST_SHA256>"
node --test tools/audits/germany-2026.4-signed-game-staging.real.test.mjs
~~~

Der akzeptanzfähige Worker-/NAPI-Lauf wird dagegen aus dem sauberen Checkout
unter Linux/cgroup-v2 gestartet:

~~~bash
set -euo pipefail
mkdir -p test-results/germany-2026.4
export NODE_OPTIONS=--max-old-space-size=384
export ZUGFOLGE_RUN_GERMANY_ALPHA_E2E=1
export ZUGFOLGE_REAL_GERMANY_REQUIRE_CGROUP_LIMIT=1
export ZUGFOLGE_REAL_GERMANY_2026_4_ROOT="$(realpath var/derived/germany-2026.4)"
export ZUGFOLGE_REAL_GERMANY_ALPHA_E2E_EVIDENCE="$(realpath -m test-results/germany-2026.4/alpha-world-e2e.json)"
export ZUGFOLGE_RUNTIME_NATIVE_PATH="<ABSOLUTE_FRESH_COMMIT_BOUND_LINUX_NAPI_ADDON>"
export ZUGFOLGE_REAL_GERMANY_EXPECTED_NAPI_SHA256="<SHA256_OF_THAT_NAPI_ADDON>"
export ZUGFOLGE_REAL_GERMANY_POSTGRES_URL="postgres://<USER>:<PASSWORD>@127.0.0.1:<PORT>/zugfolge_germany_e2e_<RUN>"
export ZUGFOLGE_REAL_GERMANY_POSTGRES_BOUNDARY=external-postgresql-process-outside-measured-app-cgroup
export ZUGFOLGE_REAL_GERMANY_REUSE_DEPLOYMENTS=1
export ZUGFOLGE_REAL_GERMANY_ALPHA_UNSIGNED_DEPLOYMENT="$(realpath var/derived/germany-2026.4/alpha-world-deployment.2026.4.json)"
export ZUGFOLGE_REAL_GERMANY_ALPHA_SIGNED_DEPLOYMENT="$(realpath var/derived/germany-2026.4/alpha-world-deployment.2026.4.signed.json)"
export ZUGFOLGE_REAL_GERMANY_EXPECTED_UNSIGNED_DEPLOYMENT_SHA256=7400d56e2109db29050577c42a53f8e223325c4414c39b96cfcc9453f65eefba
export ZUGFOLGE_REAL_GERMANY_EXPECTED_SIGNED_DEPLOYMENT_SHA256=228d7c7cef743536f3b2621db200da898b4a1d30ec2cfe3b19d57fdea55c00c0
export ZUGFOLGE_REAL_GERMANY_EXPECTED_DEPLOYMENT_HASH=4d9627d85ceab1c893a0fe3366e4d5f14f6173c58e164728d92825b81eb87098
systemd-run --user --scope --quiet \
  --property MemoryMax=536870912 \
  --property MemorySwapMax=0 \
  node --test tools/audits/germany-2026.4-alpha-world-runtime.real.test.mjs
~~~

Beide Realtests überspringen ohne ihre vollständige Umgebung absichtlich. Ein
solcher Skip ist kein Beleg. Der Worker-/NAPI-Lauf verlangt eine neue, leere und
namentlich als `zugfolge_germany_e2e_*` abgegrenzte PostgreSQL-16-Datenbank. Der
PostgreSQL-Prozess bleibt wie im Produktionsaufbau außerhalb der gemessenen
App-cgroup; der Test selbst führt innerhalb des gemessenen App-Prozesses alle
33 Migrationen aus, gleicht Erstellungszeiten und SQL-SHA-256 exakt gegen das
Repository-Journal ab und lehnt ein vorinitialisiertes Zugfolge-Schema oder
vorhandene Welten ab. Der 512-MiB-CI-Schritt
`germany-2026-4-real-acceptance` setzt für die App-cgroup
`memory.swap.max=0` und verlangt zusätzlich `oom=0` sowie `oom_kill=0` vor und
nach dem Lauf. Die harte cgroup-Grenze wird ausschließlich unter Linux
abgenommen. Nur wenn exakter Signed-/Unsigned-Kandidat, sauberer Commit,
explizit erwarteter NAPI-SHA-256, Linux-cgroup-v2 mit exakt 512 MiB, No-Swap,
Peak und beide OOM-Zähler gemeinsam grün sind, trägt die Top-level-Evidence
`acceptanceEligible=true`. Ein ephemer neu signierter Debuglauf bleibt rot.
Wegen des privilegierten Self-hosted/Docker-Runners läuft dieser
Schritt niemals aus einem Pull Request. Er wird nur per bewusstem
`workflow_dispatch` auf einem vom Repository-Betreiber ausgewählten Ref mit
`run_germany_2026_4_real_acceptance=true` gestartet.

Der getrennte Operational-Streaming-RSS-Test verlangt einen realen Korpus von
mindestens 900 MiB. Der Kandidat bleibt darüber hinaus auf exakt 983.736.272
Bytes, Datei-SHA-256 und State-Hash gebunden; die Größenschwelle ersetzt keine
dieser Identitätsprüfungen. Damit bleibt der kompaktere Vollrouten-Kandidat ein
echter Großkorpus unter der unveränderten 512-MiB-Grenze, ohne fälschlich mehr
als 1 GiB zu behaupten.

Der echte >1-GiB-Robustheitspfad ist bewusst separat: Der ignorierte Test
`archivierter_2026_3_korpus_ueber_1_gib_bleibt_unter_fester_rss_grenze`
bindet nach einer einmaligen, create-new Build-Migration die archivierte,
nicht aktivierbare `.3`-Arbeitskopie. Die unveränderte Legacy-Quelle besitzt
exakt
1.455.920.792 Bytes, SHA-256
`64bcc5a750c0667526baf95a5ae8f9fa9c6ff64e63b24462090cc1c36c6abb4c`
und State-Hash
`5972ef9d4897e5dc225ff463620745913846a6b16dba813f5fd12598c768399f`.
Sie enthält noch `requiredProtectionSystems` und ist kein gültiger Eingang für
den aktuellen Loader. Das Build-Werkzeug migriert dieses Feld streaming in
`availableProtectionSystems` plus leeres
`simultaneouslyRequiredProtectionSystems`; Runtime und Loader erhalten keine
Legacy-Kompatibilität. Der generische Legacy-Wert `etcs` wird nicht auf ein
erfundenes ETCS-Level erweitert: Von 644.900 Feldern verwerfen 25.321 diese
mehrdeutige Angabe; nur die 368 dadurch leeren Mengen erhalten den bereits in
der historischen synthetischen `.3`-Policy gepinnten PZB-Fallback. Explizite
Legacy-Byte-/SHA-Pins und CLI-Zähler sowie die native Prüfung der vollständig
migrierten Bytes laufen vor dem create-new Link. Migration und native
Validierung sind bestanden: Die Arbeitskopie unter
`var/derived/germany-2026.3/protection-fields-v2/operational-infrastructure-v2.json`
hat 1.485.411.153 Bytes, den Quell-/Output-SHA-256
`89a2584b9eec170b7b12797611f72d77008f839453fac64969d8744345c0ec3e`,
den nativen kanonischen SHA-256
`9e378f65b528699609312e792965d9deb52276c12198609bb005b3356fe7d1bb`
und den State-Hash
`6f8a0c2368e732a4decdf4d2b61d4bca58eb91530b92f36ce8e9c777c691b5ed`.
Nur der separate Linux-cgroup-v2-RSS-Lauf ist noch ausstehend. Er teilt
denselben nativen Streaming-/RSS-Runner, verlangt aber strikt mehr als 1 GiB
und hat einen eigenen create-new Evidence-Pfad. Dieser Robustheitsbeleg macht
`.3` weder vertrauenswürdig noch aktivierbar. Migration und vollständiger
Aufruf stehen im
[`2026.4-Readiness-Bericht`](infrarelease-deutschland-2026.4-readiness.md).

Der Alpha-Real-E2E muss Build, Signaturprüfung, nativen Start, mindestens eine
committete Regionsrevision, Restore und Scheduler-Readiness beweisen. Für den
kalten Start von der Weltepoche 2026-08-10 ist zusätzlich der echte
Worker-/Batch-Catch-up über sämtliche fälligen Schritte unter einem harten
512-MiB-cgroup-v2-Limit ohne Swap Pflicht. Scheduler-Readiness muss die
signiert erwartete Echtzeitregion an die tatsächlich restaurierte Region
binden, und LiveMap-Readiness muss den erwarteten Feed als `livemap_fresh`
sehen; ein leerer Health-Pfad ist kein Beleg. Ein einzelnes
'advance-to atMs=1' oder ein Initialisierungs-Preflight allein erfüllt dieses
Gate nicht. Der lokale Restore verwendet absichtlich einen zweiten Worker im
selben App-Prozess. Ein kompletter Game-API-Prozessneustart und der echte
HTTP-Readinesspfad bleiben dem getrennten Live-/Canary-Gate vorbehalten.

Die finale #392/#393-Abnahme bleibt trotz des lokalen echten PostgreSQL-Belegs
bis zu einem getrennten STRATO-Lauf offen: gleicher Kandidat, dortiger externer
PostgreSQL-Dienst, harte 512-MiB-App-cgroup ohne Swap, gemessene
`/ready`-HTTP-Latenz und mindestens zehn aufeinanderfolgende
Scheduler-/LiveMap-Intervalle.

## Aktivierungsgrenze

Aktivierung bleibt gesperrt, bis alle folgenden Belege denselben .4-Kandidaten
binden:

- Delivery-Signatur gegen den kanonischen Keyring;
- signed Paket Pack/Verify/Install;
- Signed-Game-Staging mit echter Manifest-SHA-256;
- signiertes Alpha-Weltdeployment;
- kalter Worker-Catch-up, Revision, Restore und Readiness unter 512 MiB;
- Clean-Commit-E2E und CI;
- STRATO/cgroup mit echtem PostgreSQL, `/ready`-HTTP-Latenz und zehn Intervallen;
- getrennte Odoo-, Recovery-, Produktions- und Browserabnahme.

Keiner dieser Belege darf aus einem verworfenen .3-Ergebnis übernommen werden.
Private Schlüssel sind weder Paket- noch Evidence-Eingaben und werden nicht
committed.
