# Art- und Dialogsignaturen für die bestehende Alpha-Welt

Vertrag der initialen Bereitstellung, Version 1. Der Eigentümer hat den
Abschluss der verbleibenden M15-Arbeit und die dafür erforderliche Signierung
erneut autorisiert. Dies umfasst die erstmalige dauerhafte Bereitstellung
eigener Art- und Dialogschlüssel. Es wird nicht behauptet, dass er die erst
danach erzeugten Fingerprints zuvor einzeln geprüft hätte.

Die Zielkennung stammt unverändert aus der vorhandenen
[Alpha-Weltidentität](../tools/region-import/specifications/alpha-world-germany-2026.3.identity.json):
`0db56535-a466-44a8-a991-38a8a1f7566c`. Es wird keine neue Welt erzeugt. Der
vorhandene Weltentwurf und seine historische Betriebsabnahme sind in
[mitteldeutschland-alpha.md](mitteldeutschland-alpha.md) dokumentiert. Diese
Identitätsquelle belegt allein keinen heute laufenden Zielstack.

## Schlüssel und unabhängige Vertrauenskonfiguration

Zwei getrennte Ed25519-Schlüssel besitzen ausschließlich die Rollen
`conductor-art` und `conductor-dialogue`. Bestehende Alpha-Welt- und
Map-/Infra-Schlüssel bleiben in ihren bisherigen Rollen. Die privaten
PKCS8-Dateien liegen dauerhaft außerhalb jedes Git-Arbeitsbaums unter
`LocalApplicationData/Zugfolge/release-signing/conductor-v1`. Der Windows-
Verzeichnisschutz erlaubt ausschließlich dem ausführenden Eigentümerkonto
und `SYSTEM` Zugriff. Schutz und tatsächlich geerbte Datei-ACLs werden vor
dem Signieren geprüft; vorhandene passende Schlüssel werden wiederverwendet,
niemals still ersetzt. Private Bytes erscheinen weder in Logs noch in
öffentlichen Belegen.

Die öffentlichen Rollenverzeichnisse liegen getrennt unter
`ops/keys/trusted-conductor-art-keys.json` und
`ops/keys/trusted-conductor-dialogue-keys.json`. Sie sind vom Betreiber
bereitgestellte Serverkonfiguration; weder ein heruntergeladenes Manifest
noch eine mitgelieferte Signatur kann sie ergänzen. Der Initialtrust beruht
auf dem autorisierten Bereitstellungsvorgang. Eine weitere unabhängige
Prüfung kann ausschließlich diese öffentlichen Dateien und Fingerprints
verwenden und benötigt keinen Zugang zu den privaten Schlüsseln.

## Weltpins, Signierung und Prüfung

Unter `ops/conductor/worlds/0db56535-a466-44a8-a991-38a8a1f7566c/` stehen
die getrennten Art-/Dialogweltpins und Signaturhüllen. Sie binden die exakten
unveränderten freigegebenen Korpora; der Dialogpin bindet außerdem die
unveränderten Bytes der redaktionellen Stichprobe. Die initiale Registrierung
verwendet die genannte bestehende Weltidentität und ersetzt keine laufenden
Perioden- oder Sitzungspins.

Die bestehenden Signier-CLIs aus [art-atlas.md](art-atlas.md) und
[conductor-dialogue.md](conductor-dialogue.md) bleiben unverändert streng.
Erst nach der getrennten Bereitstellung von Schlüssel, öffentlichem Trust und
Weltpin erhalten sie diese expliziten Eingaben. Beide signieren den UTF-8-Text
des SHA-256-Hexhashes ihrer exakten Releasebytes mit Ed25519. Die anschließend
ausgeführte Prüfung lädt die Originalkorpora erneut, prüft Signaturen gegen
die separaten öffentlichen Rollenverzeichnisse und benutzt die produktiven
Loader; der Dialogkorpus durchläuft den tatsächlichen Rust-Validator.

Der öffentliche Nachweis enthält ausschließlich Welt-/Releasekennungen,
Datei- und SPKI-Fingerprints, Signaturen, Prüfergebnisse und die konkrete
Herkunft der Zielidentität. Er enthält keine privaten Schlüssel. Die
Registrierung macht die Releases für diese Zielwelt verifizierbar; sie
behauptet weder eine laufende produktive Sitzung noch eine ausgeführte
Serveraktivierung. Diese benötigen weiterhin den tatsächlichen Zielstack,
seine bestehenden Perioden und die vollständige serverseitige M15-Konfiguration.

Die öffentliche `release-binding.json` hat Schema
`conductor-release-binding/v1`. Sie enthält die Weltkennung, den Pfad der
bestehenden Identitätsquelle, deren `worldIdentityCanonicalSha256`, die beiden
Schlüsselkennungen mit SPKI-Fingerprints, die Autorisierungsgrundlage und
`deploymentStatus: registered_not_activated`. Der Identitätshash wird über
`JSON.stringify(JSON.parse(originale UTF-8-Datei))` berechnet; unterschiedliche
Checkout-Zeilenenden ändern diese Identitätsbindung nicht. Art- und Dialoghashes
beziehen sich weiterhin auf ihre exakten Bytes ohne Neu-Serialisierung.

## Tatsächlich registrierter Stand

Am 07.09.2026 wurden die beiden getrennten dauerhaften Schlüssel erstmals
bereitgestellt. Das zuvor geschützte Verzeichnis und beide tatsächlich
geerbten Datei-ACLs wurden erneut gelesen und geprüft. Die bestehenden
Signier-CLIs signierten anschließend die unveränderten Originalkorpora.

| Rolle | Schlüsselkennung | SHA-256 des öffentlichen Ed25519-SPKI-DER |
|---|---|---|
| Art | `zugfolge-conductor-art-2026.1` | `5e3463fc466301ab359b435f9d7330312c0f7f2ea8ef0405de949eea976709d9` |
| Dialog | `zugfolge-conductor-dialogue-2026.1` | `69edb323b81860fbe500227f06fe8180cdf864b89244984f31758b0dc50e1dce` |

Der [Bereitstellungsbeleg](../ops/conductor/worlds/0db56535-a466-44a8-a991-38a8a1f7566c/key-provisioning-evidence.json)
dokumentiert die tatsächlich geprüften Zugriffsrechte ohne private Bytes.
Die getrennten [Art-](../ops/conductor/worlds/0db56535-a466-44a8-a991-38a8a1f7566c/art-signature.json)
und [Dialogsignaturen](../ops/conductor/worlds/0db56535-a466-44a8-a991-38a8a1f7566c/dialogue-signature.json)
binden den freigegebenen Atlas mit 186 Motiven, sieben PNG-Dateien und
60 Animationen beziehungsweise 156 Originalbäume mit 624 Äußerungen in
zwölf Familien. Ihr [öffentlicher Prüfbericht](../ops/conductor/worlds/0db56535-a466-44a8-a991-38a8a1f7566c/verification.json)
ist mit beiden produktiven Loadern und dem echten Rust-Dialogvalidator positiv.
Eine zweite Agentenprüfung führte den öffentlichen Verifikationsweg und alle
vier Tests unabhängig erneut erfolgreich aus. Sie benötigte keine privaten
Schlüssel und ist keine nachträglich behauptete menschliche Fingerprintabnahme.

## Reproduktion ohne private Schlüssel

Der Befehl liest ausschließlich die registrierten öffentlichen Rollenverzeichnisse,
Weltpins, Signaturen und Originalkorpora. Er erzeugt weder Schlüssel noch
Signaturen und verändert keinen Weltzustand:

```sh
node tools/conductor-release/verify.mjs --validator-addon /absoluter/pfad/runtime.node
```

Alternativ wird `--validator-binary` mit dem tatsächlichen `dialogue_json`-
Programm verwendet. Ohne explizites Argument gilt zuerst
`ZUGFOLGE_RUNTIME_NATIVE_PATH`, danach `ZUGFOLGE_DIALOGUE_TEST_BINARY`.
Die tatsächlichen öffentlichen Inputs sind außerdem durch vier Integrationstests
abgesichert: erfolgreicher Originalkorpus, fremde Welt beziehungsweise vertauschter
Rollentrust und je eine manipulierte Art-/Dialogsignatur.

```sh
node --test tools/conductor-release/verify.test.mjs
```

Der positive Test benötigt denselben nativen Validator. Die CI erhält keinen
privaten Schlüssel. Die lokalen Windows-ACLs sind ein gesonderter tatsächlicher
Hostbeleg; der öffentliche CI-Lauf behauptet keine erneute ACL-Inspektion dieses
Hosts. Die erfolgreiche Releaseprüfung ersetzt weiterhin keine Aktivierung im
noch separat bereitzustellenden Zielstack.
