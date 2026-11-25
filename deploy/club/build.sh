#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:-$root/build/club-deploy}"
cache="${CLUB_FORGE_CACHE:-$root/build/forge-overlay/downloads}"
architecture="${CLUB_GOARCH:-$(go env GOARCH)}"
offline="${CLUB_OFFLINE_TARGET:-}"
system=linux
server=hexproof-server
if [[ -n "$offline" ]]; then
  case "$offline" in
    windows-amd64) system=windows; architecture=amd64; server=hexproof-server.exe ;;
    linux-amd64) architecture=amd64 ;;
    *) printf 'Unsupported offline target: %s\n' "$offline" >&2; exit 2 ;;
  esac
fi
case "$architecture" in
  amd64|arm64) ;;
  *) printf 'Unsupported Linux architecture: %s\n' "$architecture" >&2; exit 2 ;;
esac

mkdir -p "$output"
output="$(cd "$output" && pwd)"
stage="$(mktemp -d "$output/.build.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT

cd "$root"
npm --prefix apps/web ci --no-audit --no-fund
if [[ -n "$offline" ]]; then
  npm --prefix apps/web run build -- --mode club-debug --sourcemap
else
  npm --prefix apps/web run build
fi
python3 third_party/forge-runtime/build-overlay.py --output "$stage/overlay" --cache "$cache"
(
  cd apps/server
  CGO_ENABLED=0 GOOS="$system" GOARCH="$architecture" go build -trimpath -o "$stage/$server" ./cmd/hexproof-server
)

python3 - "$cache" "$stage" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, Path(path).resolve())
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

base = load("club_overlay", "third_party/forge-runtime/build-overlay.py")
packager = load("club_packager", "third_party/forge-runtime/source-package.py")
manifest = json.loads(base.BASE_MANIFEST.read_text())
archive = base.pinned_file(manifest["forge"], Path(sys.argv[1]).resolve(), None)
packager.extract_archive(archive, Path(sys.argv[2]), "hexproof-forge-runtime")
PY

cp -a apps/web/dist "$stage/web"
python3 deploy/club/deck-card-index.py "$stage/hexproof-forge-runtime/forge-gui/res/cardsfolder" "$stage/web/assets/deck-cards.json"
install -m 644 LICENSE THIRD-PARTY-NOTICES.md "$stage/"
cp "$stage/overlay/forge-overlay.jar" "$stage/"
commit="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'source')"
if [[ -n "$offline" ]]; then
  portable="$stage/Hexproof-Club"
  mkdir -p "$portable"
  mv "$stage/$server" "$stage"/{hexproof-forge-runtime,forge-overlay.jar,web,LICENSE,THIRD-PARTY-NOTICES.md} "$portable/"
  python3 deploy/club/offline-card-catalog.py "$portable/hexproof-forge-runtime/forge-gui/res" "$portable/web/assets/offline-cards.json"
  python3 deploy/club/portable-jre.py --platform "$offline" --output "$portable/jre"
  install -m 644 deploy/club/offline-demo.txt deploy/club/offline/README.txt "$portable/"
  printf 'Source: %s\nTarget: %s\n' "$(git rev-parse HEAD)" "$offline" > "$portable/BUILD.txt"
  name="Hexproof-Club-debug-$offline-$commit"
  if [[ "$system" == windows ]]; then
    sed 's/\r$//;s/$/\r/' deploy/club/offline/Start-Club.cmd > "$portable/Start-Club.cmd"
    archive="$name.zip"
    (cd "$stage" && zip -q -r "$archive" Hexproof-Club)
  else
    install -m 755 deploy/club/offline/start-club.sh "$portable/"
    archive="$name.tar.gz"
    tar -czf "$stage/$archive" -C "$stage" Hexproof-Club
  fi
  (cd "$stage" && sha256sum "$archive" > "$archive.sha256")
  mv "$stage/$archive" "$stage/$archive.sha256" "$output/"
  printf 'Built %s\n' "$output/$archive"
  exit 0
fi
bundle="$(mktemp -d "$output/$architecture-$commit.XXXXXX")"
mv "$stage"/{hexproof-server,hexproof-forge-runtime,forge-overlay.jar,web,LICENSE,THIRD-PARTY-NOTICES.md} "$bundle/"
install -m 755 deploy/club/run.sh "$bundle/run.sh"
chmod 755 "$bundle"
printf 'Built %s\n' "$bundle"
