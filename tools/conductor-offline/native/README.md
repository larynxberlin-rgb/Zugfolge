# Nativer Kern der lokalen Demo

`kernel.wasm` ist der Rust-Kern der fiktiven Offline-Demo. Für die gemeinsame
Integration von Schaffnermodus und Fahrzeugregister wurde er aus den
zusammengeführten Quellen neu gebaut: 11.704.528 Bytes,
SHA-256 `9910573d395697bac3f75e25ee3cf2dfd802bb0c0b0f442549559494b987d505`.
Die Originalcrates stammen aus Repositorystand
`0b0c03804c6229685610babf593abf54321ea904`. Es handelt sich um ein lokales
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

Der Neubau verwendet Rust 1.94.1 auf `x86_64-pc-windows-gnu`, das Ziel
`wasm32-unknown-unknown` und das unveränderte eigene Cargo-Lockfile. Das
Manifest bindet alle 133 Quelldateien und die tatsächlich erzeugten Bytes.
Ein Build auf anderen Hosts oder Pfaden muss nicht byteidentisch sein.

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

Der aktuelle Neubau bestand das Quell- und ABI-Gate, den echten Worker mit
Restore und Fehlerbehandlung, die Uhr-/Pausenregression und alle drei nativen
Kontrollübungen einschließlich Zahlung, Nachweis und Treppenwechsel. Diese
Komponentenbelege binden den neuen SHA-256-Wert; Browserbelege entstehen im
vollständigen `check.mjs`-Lauf und werden separat an dessen HTML gebunden.

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
