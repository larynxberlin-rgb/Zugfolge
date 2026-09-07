# Nativer Kern der lokalen Demo

`kernel.wasm` ist der tatsächlich im Browser geprüfte Rust-Kern der fiktiven
Offline-Demo. Seine Bytes wurden unverändert übernommen: 11.718.022 Bytes,
SHA-256 `1b154c352e57bfadd57750327f5e81f26c95090c60902c1dcf64ba7a9b98b593`.
Die Originalcrates stammen aus Repositorystand
`74a9dafa90f9c685cab9916523b98506c35c004a`. Es handelt sich um ein lokales
Übungsartefakt, keine produktive Weltfreigabe oder Serverautorisierung.

Der Wrapper benutzt die Originalkerne für Betrieb, Nachfrage, Innenräume,
Fahrgastprojektion, Sitzung, Dialog und Kontrollfälle. Er orchestriert deren
Ergebnisse in einem lokalen Single-Writer; keine Geld-, Bewegungs- oder
Dialogregel wird in JavaScript nachgebaut. `src/infrastructure.rs` bietet die
vorhandene validierte InfraRelease als reine Speicherabfragen an. Der Browser
benötigt keine Dateidatenbank. Seine Spielansicht erhält öffentliche
Projektionen; der private Checkpoint verbleibt im eingebetteten Worker.

Die Übungsquelle hat 40 tatsächliche Fahrgäste und eine unveränderte fiktive
Doppelstockkonfiguration mit 200 Sitz- und 20 Stehplätzen. Ihre globalen
Nachfrage- und Kontrollparameter werden vor den nativen Pins festgelegt.
Quelle und fachliche Grenzen erklärt das [Werkzeug-README](../README.md).

## Herkunft und tägliches Prüfgate

[source-manifest.json](source-manifest.json) bindet das vorhandene Binärartefakt,
die Wrapperdateien, das eigene Cargo-Lockfile, den Workspacevertrag und die
transitiven Originalcrates aus diesem Lockfile. Die konservative Dateiliste
umfasst sämtliche `src`-Dateien dieser Crates, auch testbedingte Module; es wird
keine Behauptung aufgestellt, jede solche Datei sei im WASM enthalten.

Bei der Übernahme wurden ausschließlich die Cargo-Pfadabhängigkeiten auf
`../../../crates` umgestellt und Textdateien auf Repository-LF normalisiert.
Der Binärkern wurde nicht neu gebaut. Die ursprünglichen Wrapper-Quellhashes
stehen gesondert im Manifest. Herkunft des vorhandenen Artefakts und
Buildfähigkeit im neuen Pfad sind verschiedene Nachweise. Ein Build auf
anderen Hosts oder Pfaden muss nicht byteidentisch sein.

```sh
node tools/conductor-offline/native/verify-native.mjs
```

Diese Prüfung baut nichts. Sie prüft exakte Artefakt- und Quellbytes, die
vollständige Dateimenge sowie importfreie WASM-ABI. Änderungen am Wrapper,
Lockfile oder den beteiligten Originalquellen weisen den alten Kernel ab.
Pins dürfen erst mit einem tatsächlich neu gebauten und geprüften Kernel
aktualisiert werden. Die normale Demo-CI kann damit das bereits geprüfte
Artefakt verwenden, ohne bei jedem Lauf sämtliche Rust-Crates neu zu bauen.

## Expliziter Neubau

Voraussetzungen: Rust 1.94.1, Ziel `wasm32-unknown-unknown` und für die
Host-Prozedurmakros ein funktionierender nativer Rust-Linker. Das eigenständige
Cargo-Workspace benutzt das eingecheckte `Cargo.lock`, kein `wasm-bindgen`.
Die Befehle laufen von der Repositorywurzel:

```sh
rustup target add --toolchain 1.94.1 wasm32-unknown-unknown
cargo +1.94.1 build --manifest-path tools/conductor-offline/native/Cargo.toml --target wasm32-unknown-unknown --release --locked -j1 --target-dir target/conductor-offline
```

Mit bereits vorhandenen Registry-Abhängigkeiten kann zusätzlich `--offline`
verwendet werden. Die Ausgabe liegt unter
`target/conductor-offline/wasm32-unknown-unknown/release/zugfolge_offline_demo.wasm`.
Sie wird erst nach den nativen Worker-/Übungs-/Restore-Prüfungen als neuer
`native/kernel.wasm` übernommen und mit neuem Herkunftsmanifest geprüft.
Das Releaseprofil verwendet `opt-level=1`, `debug=0`, `incremental=false` und
`panic=abort`. Hostbezogene Linkerpfade oder lokale Toolchainverzeichnisse
gehören nicht in dieses portable Manifest.

Der Neubau wurde für diese Repositoryübernahme bewusst nicht lokal ausgeführt.
Der hier enthaltene Kernel ist der vorher tatsächlich getestete Build.

## ABI und Nutzung

`alloc(length)` reserviert Eingabebytes; `invoke(pointer,length)` verarbeitet
UTF-8-JSON `{command,input}`. `result_len()` liefert die Ergebnisgröße. Vor
dem nächsten Aufruf werden Ergebnisbytes kopiert; `dealloc(pointer,length)`
gibt nur den ursprünglichen Eingabepuffer frei. Das Ergebnis ist
`{ok:true,value}` oder `{ok:false,error}`. Eingaben sind auf 32 MiB begrenzt;
die Browsergrenze begrenzt ebenfalls die Ergebnismenge. Es gibt keine
WASM-Imports, Netzwerkzugriffe oder privaten Produktionsschlüssel.

Die Highlevelmethoden heißen `offline.initialize`, `offline.restore`,
`offline.command`, `offline.tick`, `offline.path` und `offline.report`.
Zeit ist immer explizit, pro Aufruf höchstens 60 Sekunden. Speichern erfindet
keine Weltzeit. Bewusste Manipulation der eigenen Offline-Datei wird dadurch
nicht zu einer zulässigen Aktion in einer öffentlichen Welt.

Der eigene Quelltext unterliegt der [Repositorylizenz](../../../LICENSE),
PolyForm Shield 1.0.0. Er ist Source Available. Fremde Rust-Abhängigkeiten
behalten ihre jeweiligen Lizenzbedingungen und Cargo-Herkunft; das Lockfile
enthält ihre Registry-Prüfsummen. Es wurden keine geheimen Schlüssel,
Produktivzustände oder Build-Caches übernommen.
