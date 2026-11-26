#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

"""Generate apps/web/src/mtgo-card-names.json from the pinned Forge cardsfolder."""

import json
from pathlib import Path
import sys

from forge_card_data import card_scripts


def mtgo_names(directory):
    groups = {"split": [], "front": [], "meldOrSpecialize": []}
    for mode, faces in card_scripts(directory):
        if len(faces) < 2:
            continue
        # Rooms, aftermath, and fuse share Forge's Split mode. Meld and
        # specialize decks register individual front cards in the Club catalog.
        group = "split" if mode == "Split" else "meldOrSpecialize" if mode in ("Meld", "Specialize") else "front"
        groups[group].append(" // ".join(face["Name"] for face in faces))
    if not groups["split"] or not groups["front"]:
        raise ValueError(f"No complete multiface Forge dataset in {directory}")
    return {group: sorted(names) for group, names in groups.items()}


if __name__ == "__main__":
    Path(sys.argv[2]).write_text(json.dumps(mtgo_names(Path(sys.argv[1])), ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8")
