#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Build the Club spectator decklist's compact mana and frame index from Forge."""

import json
from pathlib import Path
import sys
import unicodedata


COLOR_NAMES = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}


def index_cards(directory):
    cards = {}
    for path in sorted(directory.rglob("*.txt")):
        faces = []
        mode = ""
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, _, value = line.partition(":")
            if key == "Name":
                faces.append({"Name": value.strip()})
            elif key == "AlternateMode":
                mode = value.strip()
            elif faces and key in ("ManaCost", "Types", "Colors"):
                faces[-1][key] = value.strip()

        if not faces:
            continue
        displayed_faces = faces if mode == "Split" else faces[:1]
        costs = []
        colors = set()
        for face in displayed_faces:
            cost = face.get("ManaCost", "")
            if cost and cost != "no cost":
                costs.append(cost)
            if "Colors" in face:
                colors.update(COLOR_NAMES[color] for name in face["Colors"].lower().split(",")
                              if (color := name.strip()) in COLOR_NAMES)
            else:
                colors.update(set(cost) & set("WUBRG"))
        frame = "land" if "Land" in faces[0].get("Types", "").split() else (
            "gold" if len(colors) > 1 else next(iter(colors), "neutral"))
        entry = [" // ".join(costs), frame]
        name = unicodedata.normalize("NFC", faces[0]["Name"]).lower()
        cards[name] = entry
        if len(faces) > 1:
            joined = " // ".join(face["Name"] for face in faces)
            cards[unicodedata.normalize("NFC", joined).lower()] = entry
    if not cards:
        raise ValueError(f"No Forge card scripts found under {directory}")
    return cards


if __name__ == "__main__":
    result = index_cards(Path(sys.argv[1]))
    Path(sys.argv[2]).write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
