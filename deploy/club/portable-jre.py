#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Stage the complete pinned Adoptium Java runtime in a portable Club bundle."""

import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "apps/server/internal/runtimepkg/manifest.json"


def verified(archive, asset):
    if not archive.is_file() or archive.stat().st_size != asset["size"]:
        return False
    with archive.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == asset["sha256"]


def get_archive(asset, cache, offline):
    archive = cache / (asset["sha256"] + "." + asset["format"])
    if verified(archive, asset):
        return archive
    if offline:
        raise ValueError(f"Missing or invalid cached Java archive: {archive}")

    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=cache) as directory:
        download = Path(directory) / "download"
        with urlopen(asset["url"], timeout=60) as response, download.open("wb") as stream:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                if stream.tell() + len(block) > asset["size"]:
                    raise ValueError("Java download exceeds pinned size")
                stream.write(block)
        if not verified(download, asset):
            raise ValueError(f"Java download does not match pinned size and SHA-256: {asset['url']}")
        download.replace(archive)
    return archive


def stage(platform, output, cache, offline):
    asset = json.loads(MANIFEST.read_bytes())["java"][platform]
    archive = get_archive(asset, cache, offline)
    if output.exists():
        raise ValueError(f"Java output directory already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        extracted = Path(directory)
        # The full official tree includes the module-specific terms under legal/.
        if asset["format"] == "zip":
            with zipfile.ZipFile(archive) as zipped:
                zipped.extractall(extracted)
        else:
            with tarfile.open(archive, "r:gz") as compressed:
                compressed.extractall(extracted, filter="data")
        (runtime,) = extracted.iterdir()
        binary = "java.exe" if platform == "windows-amd64" else "java"
        for relative in ("release", "legal/java.base/LICENSE", "legal/java.base/ASSEMBLY_EXCEPTION", f"bin/{binary}"):
            if not (runtime / relative).is_file():
                raise ValueError(f"Java archive is missing {relative}")
        runtime.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True, choices=("windows-amd64", "linux-amd64"))
    parser.add_argument("--output", type=Path, required=True, help="new Java home directory to create")
    parser.add_argument("--cache", type=Path, default=ROOT / "build/club-portable/cache")
    parser.add_argument("--offline", action="store_true", help="use only verified archives already in the cache")
    args = parser.parse_args()
    try:
        print(stage(args.platform, args.output, args.cache, args.offline))
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Portable Java preparation failed: {error}\n")


if __name__ == "__main__":
    main()
