#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Build the optional offline Club search catalog using the bundled Forge data."""

import argparse
import json
from pathlib import Path
import re

from forge_card_data import card_scripts, normalize

# The sections CardEdition.Reader reads as numbered printings. Other named
# sections describe booster collation or token sheets, not collectible versions.
PRINT_SECTIONS = {
    "cards", "special slot", "precon product", "borderless", "etched", "showcase", "full art",
    "extended art", "alternate art", "retro frame", "buy a box", "promo", "prerelease promo",
    "bundle", "box topper", "jumpstart", "rebalanced", "eternal", "conjured", "scheme", "printsheets",
}
PRINTING = re.compile(r"(\S+)\s+[SCURML]\s+([^@$]+?)(?:\s+[@$].*)?$")
NATIVE_INDEX = (Path(__file__).resolve().parents[2] / "third_party/forge-runtime/native-host/"
                "src/main/resources/org/hexproof/forge")


def edition(path):
    metadata = {}
    cards = []
    section = ""
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].lower()
        elif section == "metadata" and "=" in line:
            key, value = line.split("=", 1)
            metadata[key.lower().strip()] = value.strip()
        elif section in PRINT_SECTIONS and (entry := PRINTING.fullmatch(line)):
            cards.append((entry[2].strip(), entry[1]))
    return metadata, cards


def tsv_rows(path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            yield line.split("\t")


def collector_order(printing):
    code, number = printing
    natural = re.sub(r"[0-9]+", lambda match: match[0].zfill(7), number)
    return code, natural, number


def face_display(face):
    cost = face.get("ManaCost", "")
    display = {
        "name": face["Name"],
        "manaCost": "" if cost == "no cost" else cost,
        "typeLine": face.get("Types", ""),
        "oracle": face.get("Oracle", "").replace("\\n", "\n"),
    }
    power, separator, toughness = face.get("PT", "").partition("/")
    if separator and power.strip() and toughness.strip():
        display.update(power=power.strip(), toughness=toughness.strip())
    return display


def generate(res, native_index):
    cards = []
    names = {}
    for mode, faces in card_scripts(res / "cardsfolder"):
        front = faces[0]["Name"]
        # Specialize and meld decks register the front card. Other two-face
        # cards, adventures and splits also accept the full printed name.
        name = front if mode in ("Specialize", "Meld") else " // ".join(face["Name"] for face in faces)
        displays = [face_display(face) for face in faces]
        card = {**displays[0], "name": name, "printings": set()}
        if len(displays) > 1:
            card["faces"] = displays
            card["manaCost"] = " // ".join(face["manaCost"] for face in displays if face["manaCost"])
            card["oracle"] = "\n\n".join(f"{face['name']}\n{face['oracle']}" for face in displays)
        cards.append(card)
        for key in (front, name):
            names[normalize(key)] = card

    sets = {}
    dates = {}
    for path in sorted((res / "editions").glob("*.txt")):
        metadata, printings = edition(path)
        code = metadata.get("code", "").upper()
        if not code:
            continue
        dates[code] = metadata.get("date", "")
        sets[code] = metadata.get("name") or code
        for name, number in printings:
            card = names.get(normalize(name))
            if card:
                card["printings"].add((code, number))

    # The Club overlay also explicitly maps real promo and alternate printings
    # onto edition entries with the identical rules, and rejects known mismatches.
    for name, code, number, _ in tsv_rows(native_index / "printing-unavailable.tsv"):
        card = names.get(normalize(name))
        if card:
            card["printings"].discard((code, number))
    for name, code, number, parent_code, parent_number in tsv_rows(native_index / "printing-aliases.tsv"):
        card = names.get(normalize(name))
        if card and (parent_code, parent_number) in card["printings"]:
            card["printings"].add((code, number))
            sets.setdefault(code, code)
            dates.setdefault(code, dates[parent_code])

    if not cards or not sets or not any(card["printings"] for card in cards):
        raise ValueError(f"Incomplete Forge card scripts or editions under {res}")
    for card in cards:
        # Keep edition and collector order stable within a release date.
        printings = sorted(card["printings"], key=collector_order)
        printings.sort(key=lambda item: dates[item[0]], reverse=True)
        card["printings"] = [{"setCode": code, "collectorNumber": number} for code, number in printings]
    return {"version": 1, "sets": sets, "cards": sorted(cards, key=lambda card: normalize(card["name"]))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("forge_res", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    catalog = generate(args.forge_res, NATIVE_INDEX)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
