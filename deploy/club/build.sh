#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:-$root/build/club-deploy}"
cache="${CLUB_FORGE_CACHE:-$root/build/forge-overlay/downloads}"
architecture="${CLUB_GOARCH:-$(go env GOARCH)}"
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
npm --prefix apps/web run build
python3 third_party/forge-runtime/build-overlay.py --output "$stage/overlay" --cache "$cache"
(
  cd apps/server
  CGO_ENABLED=0 GOOS=linux GOARCH="$architecture" go build -trimpath -o "$stage/hexproof-server" ./cmd/hexproof-server
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
install -m 644 LICENSE THIRD-PARTY-NOTICES.md "$stage/"
cp "$stage/overlay/forge-overlay.jar" "$stage/"
commit="$(git rev-parse --short=12 HEAD 2>/dev/null || printf 'source')"
bundle="$(mktemp -d "$output/$architecture-$commit.XXXXXX")"
mv "$stage"/{hexproof-server,hexproof-forge-runtime,forge-overlay.jar,web,LICENSE,THIRD-PARTY-NOTICES.md} "$bundle/"
install -m 755 deploy/club/run.sh "$bundle/run.sh"
chmod 755 "$bundle"
printf 'Built %s\n' "$bundle"
