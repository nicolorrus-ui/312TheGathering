#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Build the Club spectator decklist's compact mana and frame index from Forge."""

import json
from pathlib import Path
import sys

from forge_card_data import card_scripts, card_style, normalize


def index_cards(directory):
    cards = {}
    for mode, faces in card_scripts(directory):
        entry = card_style(mode, faces)
        cards[normalize(faces[0]["Name"])] = entry
        if len(faces) > 1:
            cards[normalize(" // ".join(face["Name"] for face in faces))] = entry
    if not cards:
        raise ValueError(f"No Forge card scripts found under {directory}")
    return cards


if __name__ == "__main__":
    result = index_cards(Path(sys.argv[1]))
    Path(sys.argv[2]).write_text(json.dumps(result, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
