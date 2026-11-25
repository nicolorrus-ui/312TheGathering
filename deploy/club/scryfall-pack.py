#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Download a deck-sized pack of Scryfall images for the Club web client."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unicodedata
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import UUID

COLLECTION = "https://api.scryfall.com/cards/collection"
API_HEADERS = {
    "User-Agent": "Hexproof-Club-ImagePack/1.0",
    "Accept": "application/json;q=0.9,*/*;q=0.8",
    "Content-Type": "application/json",
}
CARD_LINE = re.compile(r"(?:SB:\s*)?(\d+)x?\s+(.+?)(?:\s+\(([a-z0-9]+)\)\s+(\S+))?", re.IGNORECASE)
SECTION = re.compile(r"(?:deck|mainboard|main deck|sideboard|sb):?", re.IGNORECASE)


def deck_identifiers(paths):
    identifiers = {}
    for path in paths:
        for line_no, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith(("//", "#")) or SECTION.fullmatch(line):
                continue
            match = CARD_LINE.fullmatch(line)
            if not match or not 1 <= int(match[1]) <= 1000:
                raise ValueError(f"{path}:{line_no}: expected a quantity followed by a card name")
            _, name, set_code, number = match.groups()
            if set_code:
                key = (set_code.lower(), number.lower())
                identifiers[key] = {"set": key[0], "collector_number": number}
            else:
                identifiers[(normalize(name),)] = {"name": name}
    return list(identifiers.values())


def normalize(name):
    return unicodedata.normalize("NFC", name.strip()).lower()


def write_atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as staged:
        temporary = Path(staged.name)
        try:
            staged.write(data)
            staged.close()
            temporary.chmod(0o644)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def read_index(path):
    if not path.exists():
        return {"version": 1, "printings": {}, "names": {}}
    index = json.loads(path.read_text(encoding="utf-8"))
    if (index.get("version") != 1 or not isinstance(index.get("printings"), dict)
            or not isinstance(index.get("names"), dict)):
        raise ValueError(f"{path}: unsupported Hexproof image pack")
    return index


def collection(identifiers):
    for start in range(0, len(identifiers), 75):
        chunk = identifiers[start:start + 75]
        request = Request(COLLECTION, data=json.dumps({"identifiers": chunk}).encode(), headers=API_HEADERS)
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
        yield result
        time.sleep(0.12)


def image_filename(directory, stem, url):
    path = directory / f"{stem}.jpg"
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "cards.scryfall.io":
        raise ValueError(f"Unexpected Scryfall image host: {parsed.hostname}")
    if not path.exists():
        headers = {"User-Agent": API_HEADERS["User-Agent"], "Accept": "image/jpeg"}
        with urlopen(Request(url, headers=headers), timeout=30) as response:
            jpeg = response.read(2 * 1024 * 1024 + 1)
        if len(jpeg) > 2 * 1024 * 1024 or not jpeg.startswith(b"\xff\xd8\xff") or not jpeg.endswith(b"\xff\xd9"):
            raise ValueError(f"Unexpected JPEG response for {path.name}")
        write_atomic(path, jpeg)
    return path.name


def import_card(directory, index, card):
    stem = str(UUID(card["id"]))
    namespace = "token:" if card.get("layout") in {"token", "double_faced_token", "emblem"} else ""
    key = f'{namespace}{card["set"]}/{card["collector_number"].lower()}'
    front_url = card.get("image_uris", {}).get("normal")
    variants = {}
    if front_url:
        front = image_filename(directory, stem, front_url)
        variants = {normalize(face["name"]): front for face in card.get("card_faces", [])}
    else:
        for face_no, face in enumerate(card.get("card_faces", [])[:2]):
            url = face.get("image_uris", {}).get("normal")
            if url:
                suffix = "-b" if face_no else ""
                variants[normalize(face["name"])] = image_filename(directory, stem + suffix, url)
        front = next(iter(variants.values()), None)
    if not front:
        return False
    variants[normalize(card["name"])] = front
    index["printings"][key] = {"front": front, "faces": variants}
    for name, file in variants.items():
        index["names"].setdefault(namespace + name, file)
    return True


def import_decks(directory, identifiers):
    manifest = directory / "index.json"
    index = read_index(manifest)
    printed = 0
    issues = 0
    for result in collection(identifiers):
        for entry in result["not_found"]:
            print(f"No Scryfall match: {entry}", file=sys.stderr)
            issues += 1
        for card in result["data"]:
            if import_card(directory, index, card):
                printed += 1
            else:
                print(f'No image: {card["name"]} ({card["set"]}) {card["collector_number"]}', file=sys.stderr)
                issues += 1
    if printed:
        write_atomic(manifest, (json.dumps(index, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
    print(f"Imported {printed} Scryfall printings into {directory} ({issues} missing)")
    return int(issues > 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("decks", nargs="+", type=Path, help="UTF-8 MTGA or MTGO decklist files")
    parser.add_argument("--output", required=True, type=Path, help="the deployment's web/assets/cards directory")
    args = parser.parse_args()
    try:
        identifiers = deck_identifiers(args.decks)
        if not identifiers:
            raise ValueError("The decklists contain no card entries")
        if len(identifiers) > 150:
            raise ValueError("Use this tool for deck-sized packs of up to 150 distinct cards per import")
        args.output.mkdir(parents=True, exist_ok=True)
        lock = os.open(args.output, os.O_RDONLY)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return import_decks(args.output, identifiers)
        finally:
            os.close(lock)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        print(f"Scryfall import stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
