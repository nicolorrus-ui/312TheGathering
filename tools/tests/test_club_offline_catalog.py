# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Hexproof contributors

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


CLUB_DIR = Path(__file__).resolve().parents[2] / "deploy/club"
sys.path.insert(0, str(CLUB_DIR))
spec = importlib.util.spec_from_file_location("club_catalog", CLUB_DIR / "offline-card-catalog.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class ClubOfflineCatalogTest(unittest.TestCase):
    def test_registerable_printings_and_card_display(self):
        with tempfile.TemporaryDirectory() as temp:
            res = Path(temp)
            scripts, editions = res / "cardsfolder", res / "editions"
            scripts.mkdir()
            editions.mkdir()
            (scripts / "double.txt").write_text(
                "Name:First Face\nManaCost:2 U\nTypes:Creature Wizard\nPT:*/1+*\nAlternateMode:DoubleFaced\n"
                "Oracle:Line one.\\nLine two.\nALTERNATE\nName:Other Face\nColors:blue\nTypes:Creature Insect\nPT:3/2\nOracle:Fly.\n")
            (scripts / "split.txt").write_text(
                "Name:Left\nManaCost:R\nTypes:Instant\nAlternateMode:Split\n"
                "ALTERNATE\nName:Right\nManaCost:1 G\nTypes:Instant\n")
            (scripts / "unlisted.txt").write_text("Name:Unlisted\nManaCost:no cost\nTypes:Basic Land Island\n")
            (scripts / "ellipsis.txt").write_text("Name:All Good Things . . .\nManaCost:10 G G\nTypes:Sorcery\n")
            (editions / "old.txt").write_text(
                "[metadata]\nName=Old Set\nCode=OLD\nDate=1993-11-01\n[cards]\n9 R First Face @First artist\n")
            (editions / "new.txt").write_text(
                "[metadata]\nName=New Set\nCode=NEW\nDate=2017-01-20\n[cards]\n"
                "11 C First Face @Painter\n2 C First Face @Painter\n18 R Left // Right @Artist\n226 R All Good Things . . . @Artist\n"
                "[alternate art]\n2 C First Face @Duplicate\n13a R First Face @Artist ${\"flavorName\":\"Nickname\"}\n"
                "[tokens]\n22 R First Face @Token artist\n[Draft Slot]\n18 R Unlisted\n[other]\n23a First Face\n")
            (res / "printing-aliases.tsv").write_text("First Face\tPNEW\t2s\tNEW\t2\n")
            (res / "printing-unavailable.tsv").write_text("First Face\tNEW\t11\tdifferent_rules_same_name\n")

            data = catalog.generate(res, res)
            cards = {card["name"]: card for card in data["cards"]}
            self.assertEqual(data["sets"]["NEW"], "New Set")
            self.assertEqual(cards["All Good Things..."]["printings"], [{"setCode": "NEW", "collectorNumber": "226"}])
            front = cards["First Face // Other Face"]
            self.assertEqual((front["manaCost"], front["typeLine"]), ("2 U", "Creature Wizard"))
            self.assertEqual((front["power"], front["toughness"]), ("*", "1+*"))
            self.assertEqual(front["faces"][1], {"name": "Other Face", "typeLine": "Creature Insect",
                             "manaCost": "", "power": "3", "toughness": "2", "oracle": "Fly."})
            self.assertEqual(front["oracle"], "First Face\nLine one.\nLine two.\n\nOther Face\nFly.")
            self.assertEqual([(card["setCode"], card["collectorNumber"]) for card in front["printings"]],
                             [("NEW", "2"), ("NEW", "13a"), ("PNEW", "2s"), ("OLD", "9")])
            split = cards["Left // Right"]
            self.assertEqual(split["manaCost"], "R // 1 G")
            self.assertEqual(split["printings"], [{"setCode": "NEW", "collectorNumber": "18"}])
            self.assertEqual(cards["Unlisted"]["printings"], [])
            self.assertNotIn("power", cards["Unlisted"])
            self.assertNotIn("faces", cards["Unlisted"])
