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
python3 - "$cache" "$output" "$overlay" "${CLUB_FORGE_ARCHIVES:-}" <<'PY'
import importlib.util
import json
from pathlib import Path
import subprocess
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
source_manifest = json.loads((base.HERE / "overlay-base.json").read_text())
cache, output, overlay = map(Path, sys.argv[1:4])
archive_dir = Path(sys.argv[4]).resolve() if sys.argv[4] else None

def find_supplied(pin):
    if archive_dir is not None:
        path = archive_dir / (pin["sha256"] + ".tar.gz")
        if path.is_file():
            return path
    return None

supplied_base = find_supplied(manifest["forge"])
supplied_source = find_supplied(source_manifest["source"])
command = [sys.executable, str(base.HERE / "build-overlay.py"), "--output", str(overlay), "--cache", str(cache)]
if supplied_base is not None:
    command.extend(["--base-archive", str(supplied_base)])
if supplied_source is not None:
    command.extend(["--source-archive", str(supplied_source)])
subprocess.run(command, check=True)

archive = base.pinned_file(manifest["forge"], cache, supplied_base)
packager.extract_archive(archive, output, "hexproof-forge-runtime")
PY
install -m 644 "$overlay/forge-overlay.jar" "$output/forge-overlay.jar"
