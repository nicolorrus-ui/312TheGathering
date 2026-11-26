#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:?Provide an output directory for the Forge runtime}"
cache="${CLUB_FORGE_CACHE:-$root/build/forge-overlay/downloads}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cache="$(realpath -m "$cache")"
overlay="$(mktemp -d "$output/.overlay.XXXXXX")"
trap 'rm -rf -- "$overlay"' EXIT

cd "$root"
python3 third_party/forge-runtime/build-overlay.py --output "$overlay" --cache "$cache"
python3 - "$cache" "$output" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

base = load("club_overlay", "third_party/forge-runtime/build-overlay.py")
packager = load("club_packager", "third_party/forge-runtime/source-package.py")
manifest = json.loads(base.BASE_MANIFEST.read_text())
archive = base.pinned_file(manifest["forge"], Path(sys.argv[1]), None)
packager.extract_archive(archive, Path(sys.argv[2]), "hexproof-forge-runtime")
PY
install -m 644 "$overlay/forge-overlay.jar" "$output/forge-overlay.jar"
