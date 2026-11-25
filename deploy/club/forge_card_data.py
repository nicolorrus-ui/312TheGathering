# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Read the card display fields shared by the two Club Forge indexes."""

import unicodedata

COLOR_NAMES = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}


def normalize(name):
    return unicodedata.normalize("NFC", name).lower()


def card_scripts(directory):
    for path in sorted(directory.rglob("*.txt")):
        faces = []
        mode = ""
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, _, value = line.partition(":")
            if key == "Name":
                faces.append({"Name": value.strip()})
            elif key == "AlternateMode":
                mode = value.strip()
            elif faces and key in ("ManaCost", "Types", "Colors", "Oracle", "PT"):
                faces[-1][key] = value.strip()
        if faces:
            yield mode, faces


def card_style(mode, faces):
    colors = set()
    costs = []
    for face in faces if mode == "Split" else faces[:1]:
        cost = face.get("ManaCost", "")
        if cost and cost != "no cost":
            costs.append(cost)
        if "Colors" in face:
            colors.update(COLOR_NAMES[color] for name in face["Colors"].lower().split(",")
                          if (color := name.strip()) in COLOR_NAMES)
        else:
            colors.update(set(cost) & set("WUBRG"))
    if "Land" in faces[0].get("Types", "").split():
        frame = "land"
    else:
        frame = "gold" if len(colors) > 1 else next(iter(colors), "neutral")
    return " // ".join(costs), frame
