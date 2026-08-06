#!/usr/bin/env bash
#
# Setup der Entwicklungsumgebung für Zugfolge.
#
# Gedacht als Setup-Skript der Claude-Code-Cloud-Umgebung; läuft ebenso auf
# einem frischen Debian- oder Ubuntu-Container und unter WSL.
#
#   bash .claude/setup.sh
#
# Es installiert nichts als Root und fasst nichts außerhalb von $HOME an. Der
# eigentliche Zweck ist nicht das Installieren, sondern das **Vorladen**: Nach
# dem Setup sind alle Abhängigkeiten geholt und übersetzt, damit die Arbeit
# auch dann läuft, wenn das Netz danach eingeschränkt ist.
#
# Das Skript ist wiederholbar. Ein zweiter Lauf installiert nichts neu.

set -euo pipefail

# --------------------------------------------------------------------------
# Versionen — bewusst grob gepinnt
# --------------------------------------------------------------------------
# Node: 24 — die **aktive LTS-Linie** („Krypton"), passend zu "engines" in
#   package.json. Node 26 ist neuer, aber bis Oktober 2026 keine LTS, und
#   docs/architektur.md legt für die Game-Services ausdrücklich LTS fest.
# pnpm: 11, passend zur CI (.github/workflows/ci.yml).
# Rust: steht in rust-toolchain.toml und wird von rustup selbst geholt.
NODE_MAJOR="24"
PNPM_MAJOR="11"

WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKAL="$HOME/.local"

# --------------------------------------------------------------------------
# Ausgabe
# --------------------------------------------------------------------------
schritt() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warnung() { printf '  \033[33mHinweis:\033[0m %s\n' "$*" >&2; }
fehler() { printf '\n\033[31mAbbruch:\033[0m %s\n' "$*" >&2; exit 1; }

# Schreibt eine Zeile dauerhaft in die Startdateien der Shell — sonst wäre
# jede PATH-Änderung mit dem Ende dieses Skripts wieder weg.
merke_pfad() {
  local zeile="$1" profil
  for profil in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.zshrc"; do
    case "$profil" in
      # Nur ergänzen, nie anlegen: Ein neu erzeugtes .bash_profile würde
      # .profile verdrängen, und ein neues .zshrc hilft niemandem.
      */.bash_profile | */.zshrc) [ -e "$profil" ] || continue ;;
      *) [ -e "$profil" ] || : > "$profil" ;;
    esac
    grep -qsF -- "$zeile" "$profil" || printf '\n%s\n' "$zeile" >> "$profil"
  done
}

# Nimmt die eigenen Installationsorte in den PATH auf, sofern vorhanden.
#
# Ohne das fände ein zweiter Lauf seine eigene Installation nicht wieder: Eine
# frische, nicht-interaktive Shell liest weder .bashrc noch .profile, und das
# Skript würde Node und pnpm jedes Mal neu herunterladen.
pfad_voranstellen() {
  local ordner="$1"
  [ -d "$ordner" ] || return 0
  case ":$PATH:" in
    *":$ordner:"*) ;;
    *) PATH="$ordner:$PATH" ;;
  esac
  export PATH
}

architektur() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) fehler "Nicht unterstützte Architektur: $(uname -m)" ;;
  esac
}

# --------------------------------------------------------------------------
schritt "Voraussetzungen prüfen"
# --------------------------------------------------------------------------
for werkzeug in curl tar git; do
  command -v "$werkzeug" >/dev/null 2>&1 || fehler "'$werkzeug' fehlt und wird gebraucht."
done
[ -f "$WURZEL/pnpm-workspace.yaml" ] || fehler "Repositoriumswurzel nicht gefunden: $WURZEL"
info "Arbeitsbaum: $WURZEL"

mkdir -p "$LOKAL/bin"
export PATH="$LOKAL/bin:$PATH"
merke_pfad 'export PATH="$HOME/.local/bin:$PATH"'

# Was ein früherer Lauf schon hingelegt hat, wieder auffindbar machen.
pfad_voranstellen "$LOKAL/node/bin"
pfad_voranstellen "$HOME/.local/share/pnpm"
pfad_voranstellen "$HOME/.cargo/bin"

# --------------------------------------------------------------------------
schritt "Rust"
# --------------------------------------------------------------------------
# rustup liest rust-toolchain.toml und holt Kanal samt rustfmt und clippy beim
# ersten cargo-Aufruf selbst. Hier muss nur rustup selbst da sein.
if [ -s "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

if command -v rustup >/dev/null 2>&1; then
  info "rustup ist vorhanden: $(rustup --version 2>/dev/null | head -1)"
elif command -v cargo >/dev/null 2>&1; then
  warnung "cargo ohne rustup gefunden — rust-toolchain.toml wird dann nicht beachtet."
else
  info "rustup wird installiert …"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none \
    || fehler "rustup ließ sich nicht installieren."
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
merke_pfad 'if [ -s "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi'

command -v cargo >/dev/null 2>&1 || fehler "cargo ist nach der Installation nicht auffindbar."

info "Werkzeugkette nach rust-toolchain.toml holen (Kanal, rustfmt, clippy) …"
(cd "$WURZEL" && cargo --version >/dev/null) || fehler "Die Rust-Werkzeugkette ließ sich nicht einrichten."
info "$(cd "$WURZEL" && cargo --version)"

# --------------------------------------------------------------------------
schritt "Node.js"
# --------------------------------------------------------------------------
node_taugt() {
  command -v node >/dev/null 2>&1 || return 1
  local gross
  gross="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$gross" -ge "$NODE_MAJOR" ] 2>/dev/null
}

if node_taugt; then
  info "Node ist vorhanden: $(node --version)"
else
  info "Node ${NODE_MAJOR} LTS wird nach $LOKAL/node installiert …"
  basis="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  arch="$(architektur)"
  paket="$(curl -fsSL "$basis/" \
    | grep -o "node-v${NODE_MAJOR}\.[0-9.]*-linux-${arch}\.tar\.xz" \
    | head -1)"
  [ -n "$paket" ] || fehler "Kein Node-Paket für linux-${arch} unter $basis gefunden."

  rm -rf "$LOKAL/node"
  mkdir -p "$LOKAL/node"
  curl -fsSL "$basis/$paket" | tar -xJ --strip-components=1 -C "$LOKAL/node" \
    || fehler "Node ließ sich nicht entpacken."

  export PATH="$LOKAL/node/bin:$PATH"
  merke_pfad 'export PATH="$HOME/.local/node/bin:$PATH"'
  info "Node installiert: $(node --version)"
fi

# --------------------------------------------------------------------------
schritt "pnpm"
# --------------------------------------------------------------------------
pnpm_taugt() {
  command -v pnpm >/dev/null 2>&1 || return 1
  [ "$(pnpm --version 2>/dev/null | cut -d. -f1)" = "$PNPM_MAJOR" ]
}

if pnpm_taugt; then
  info "pnpm ist vorhanden: $(pnpm --version)"
else
  info "pnpm ${PNPM_MAJOR} wird installiert …"
  if npm install -g "pnpm@${PNPM_MAJOR}" >/dev/null 2>&1; then
    info "über npm installiert"
  elif corepack enable --install-directory "$LOKAL/bin" >/dev/null 2>&1 \
    && corepack prepare "pnpm@${PNPM_MAJOR}" --activate >/dev/null 2>&1; then
    info "über corepack installiert"
  else
    # Letzter Weg: der eigenständige Installer, ganz ohne Schreibrecht auf die
    # Node-Installation.
    curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION="${PNPM_MAJOR}" SHELL=bash sh - \
      || fehler "pnpm ließ sich auf keinem Weg installieren."
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    merke_pfad 'export PNPM_HOME="$HOME/.local/share/pnpm"'
    merke_pfad 'export PATH="$PNPM_HOME:$PATH"'
  fi
  command -v pnpm >/dev/null 2>&1 || fehler "pnpm ist nach der Installation nicht auffindbar."
  info "pnpm installiert: $(pnpm --version)"
fi

# --------------------------------------------------------------------------
schritt "cargo-deny (Lizenz-Scan)"
# --------------------------------------------------------------------------
# Nicht kritisch: Der Lizenz-Scan läuft in jedem Fall in der CI. Lokal ist er
# angenehm, aber ein fehlgeschlagener Download darf das Setup nicht kippen.
if command -v cargo-deny >/dev/null 2>&1; then
  info "cargo-deny ist vorhanden: $(cargo-deny --version)"
else
  version="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    https://github.com/EmbarkStudios/cargo-deny/releases/latest 2>/dev/null \
    | sed 's#.*/tag/##')" || version=""
  ziel="$([ "$(architektur)" = "arm64" ] && echo aarch64 || echo x86_64)-unknown-linux-musl"
  if [ -n "$version" ] && curl -fsSL \
    "https://github.com/EmbarkStudios/cargo-deny/releases/download/${version}/cargo-deny-${version}-${ziel}.tar.gz" \
    | tar -xz --strip-components=1 -C "$LOKAL/bin" --wildcards '*/cargo-deny' 2>/dev/null; then
    info "cargo-deny ${version} installiert"
  else
    warnung "cargo-deny konnte nicht geladen werden — übersprungen."
    warnung "Nachholen mit: cargo install cargo-deny --locked"
  fi
fi

# --------------------------------------------------------------------------
schritt "Abhängigkeiten vorladen"
# --------------------------------------------------------------------------
cd "$WURZEL"

info "Rust-Abhängigkeiten holen …"
cargo fetch --locked || fehler "cargo fetch schlug fehl — stimmt die Cargo.lock?"

info "Node-Abhängigkeiten holen …"
pnpm install --frozen-lockfile || fehler "pnpm install schlug fehl — stimmt die pnpm-lock.yaml?"

info "Rust übersetzen (Bibliothek und Tests) …"
cargo build --workspace --all-targets --locked

info "TypeScript übersetzen …"
pnpm -r --stream build

# --------------------------------------------------------------------------
schritt "Rauchtest"
# --------------------------------------------------------------------------
# Warnt, statt abzubrechen: Ein rotes Testergebnis ist ein Befund, kein Grund,
# die Umgebung gar nicht erst bereitzustellen.
rauch_ok=1
cargo test --workspace --locked || rauch_ok=0
pnpm -r --stream test || rauch_ok=0
pnpm guards || rauch_ok=0

# --------------------------------------------------------------------------
schritt "Fertig"
# --------------------------------------------------------------------------
printf '  %-12s %s\n' "rustc" "$(rustc --version 2>/dev/null || echo '—')"
printf '  %-12s %s\n' "cargo" "$(cargo --version 2>/dev/null || echo '—')"
printf '  %-12s %s\n' "node" "$(node --version 2>/dev/null || echo '—')"
printf '  %-12s %s\n' "pnpm" "$(pnpm --version 2>/dev/null || echo '—')"
printf '  %-12s %s\n' "cargo-deny" "$(cargo-deny --version 2>/dev/null || echo 'nicht installiert')"

if [ "$rauch_ok" -eq 1 ]; then
  printf '\n\033[32mUmgebung steht, alle Prüfungen grün.\033[0m\n'
else
  printf '\n\033[33mUmgebung steht, aber mindestens eine Prüfung war rot.\033[0m\n'
  printf 'Das ist ein Befund im Arbeitsbaum, kein Fehler des Setups.\n'
fi

cat <<'HINWEIS'

Nächste Schritte:

  cargo test --workspace          Determinismus-Tests und Golden-Master
  pnpm guards                     die harten Invarianten prüfen
  pnpm guards -- --list           alle Wächterregeln zeigen

Was hier bewusst nicht passiert: PostgreSQL, PostGIS und Keycloak. Die
kommen mit M2 und gehören dann in eine eigene Compose-Datei, nicht in
dieses Skript.
HINWEIS
