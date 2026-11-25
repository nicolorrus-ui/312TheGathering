// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonObject;
import forge.card.MagicColor;
import forge.game.GameStage;
import forge.game.card.Card;
import forge.game.mana.Mana;
import forge.game.phase.PhaseType;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.PlayerControllerHuman;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Real human auto-payment with cost floors, conditional mana and competing future resources. */
public final class NativeAutoPayRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            for (String scenario : List.of("tron-tax", "missing-tron", "tapped-tower", "damping",
                    "colored", "two-mana", "floating", "manual")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("tron-auto-pay", 42), base);
                        var scope = session.context.enter()) {
                    run(session, startFixture(session, base), scenario);
                }
            }
            for (RankedPayment example : List.of(
                    new RankedPayment("shared hand budget", List.of("Forest", "Forest", "Island"),
                            List.of("Llanowar Elves", "Llanowar Elves"), "Island", 20, 20),
                    new RankedPayment("other hand colors", List.of("Forest", "Forest", "Island"),
                            List.of("Cloudfin Raptor", "Llanowar Elves"), "Forest", 20, 20),
                    new RankedPayment("reserve floating green", List.of("Wastes"),
                            List.of("Llanowar Elves"), "Wastes", 20, 20, true),
                    new RankedPayment("future colors", List.of("Waterlogged Grove", "Island"),
                            List.of(), "Island", 20, 20),
                    new RankedPayment("future activation life", List.of("Botanical Sanctum", "Waterlogged Grove"),
                            List.of(), "Waterlogged Grove", 20, 19),
                    new RankedPayment("colors still usable at remaining life", List.of("Waterlogged Grove", "Waterlogged Grove", "Wastes"),
                            List.of(), "Wastes", 2, 2),
                    new RankedPayment("lethal activation", List.of("Botanical Sanctum", "Waterlogged Grove"),
                            List.of(), "Botanical Sanctum", 1, 1))) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("rank-auto-pay", 42), base);
                        var scope = session.context.enter()) {
                    rankedPayment(session, startFixture(session, base), example);
                }
            }
            for (boolean reserveGreen : List.of(true, false)) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("converge-reserves", 42), base);
                        var scope = session.context.enter()) {
                    converge(session, startFixture(session, base), reserveGreen);
                }
            }
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("lethal-only", 42), base);
                    var scope = session.context.enter()) {
                lethalOnly(session, startFixture(session, base));
            }
        }
        System.out.println("PASS native auto-pay: Tron, hand spells, future colors and life");
    }

    private static Player startFixture(NativeSession session, NativeGuiBase base) {
        base.setTestSession(session);
        Player owner = session.game.getPlayers().get(0);
        session.game.setAge(GameStage.Play);
        session.game.setStartingPlayer(owner);
        session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 14);
        return owner;
    }

    private record RankedPayment(String name, List<String> lands, List<String> nextSpells, String expectedTap,
                                 int initialLife, int expectedLife, boolean reserveFloatingGreen) {
        RankedPayment(String name, List<String> lands, List<String> nextSpells, String expectedTap, int initialLife, int expectedLife) {
            this(name, lands, nextSpells, expectedTap, initialLife, expectedLife, false);
        }
    }

    private static void rankedPayment(NativeSession session, Player owner, RankedPayment example) throws Exception {
        owner.setLife(example.initialLife(), null);
        List<Card> lands = example.lands().stream().map(name -> card(session.game, owner, name, ZoneType.Battlefield)).toList();
        List<Card> nextSpells = example.nextSpells().stream().map(name -> card(session.game, owner, name, ZoneType.Hand)).toList();
        if (example.reserveFloatingGreen()) {
            Card source = card(session.game, owner, "Forest", ZoneType.Battlefield);
            source.setTapped(true);
            owner.getManaPool().addMana(new Mana(MagicColor.GREEN, source, null, owner));
        }
        Card map = card(session.game, owner, "Expedition Map", ZoneType.Hand);
        drive(session, owner, () -> {
            require(PlaySpellAbility.playSpellAbility((PlayerControllerHuman) owner.getController(), owner,
                    map.getSpellAbilities().get(0)), example.name() + ": cast failed");
            List<String> tapped = lands.stream().filter(Card::isTapped).map(Card::getName).toList();
            require(tapped.equals(List.of(example.expectedTap())), example.name() + ": unexpected tapped lands " + tapped);
            require(owner.getLife() == example.expectedLife(), example.name() + ": life " + owner.getLife());
            require(nextSpells.stream().allMatch(spell -> spell.isInZone(ZoneType.Hand)), "Planning moved a hand card");
            int expectedFloating = example.reserveFloatingGreen() ? 1 : 0;
            require(owner.getManaPool().getAmountOfColor(MagicColor.GREEN) == expectedFloating
                    && owner.getManaPool().totalMana() == expectedFloating, example.name() + ": wrong floating mana");
            require(map.isInZone(ZoneType.Stack), "Payment failed to put spell on stack");
        }, input -> {
            require(input.get("type").getAsString().equals("payManaCost") && input.get("canAutoPay").getAsBoolean(),
                    example.name() + ": unexpected payment prompt " + input);
            return NativeSession.object("type", "pay");
        });
    }

    private static void converge(NativeSession session, Player owner, boolean reserveGreen) throws Exception {
        List<String> names = reserveGreen ? List.of("Swamp", "Island", "Island", "Forest", "Forest")
                : List.of("Swamp", "Swamp", "Island", "Island", "Island", "Forest", "Forest", "Forest");
        List<Card> lands = names.stream().map(name -> card(session.game, owner, name, ZoneType.Battlefield)).toList();
        if (reserveGreen) {
            for (int i = 0; i < 2; i++) card(session.game, owner, "Llanowar Elves", ZoneType.Hand);
        }
        Card truths = card(session.game, owner, "Painful Truths", ZoneType.Hand);
        drive(session, owner, () -> {
            require(PlaySpellAbility.playSpellAbility((PlayerControllerHuman)owner.getController(), owner,
                    truths.getFirstSpellAbility()), "Converge spell could not be cast");
            List<String> tapped = lands.stream().filter(Card::isTapped).map(Card::getName).toList();
            List<String> expected = reserveGreen ? List.of("Swamp", "Island", "Island") : List.of("Swamp", "Island", "Forest");
            require(tapped.equals(expected), "Unexpected sources for Converge: " + tapped);
            require(truths.isInZone(ZoneType.Stack), "Converge spell missing from the stack");
        }, input -> {
            require(input.get("type").getAsString().equals("payManaCost") && input.get("canAutoPay").getAsBoolean(),
                    "Unexpected Converge payment prompt " + input);
            return NativeSession.object("type", "pay");
        });
    }

    private static void lethalOnly(NativeSession session, Player owner) throws Exception {
        owner.setLife(1, null);
        Card city = card(session.game, owner, "City of Brass", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Llanowar Elves", ZoneType.Hand);
        AtomicInteger prompts = new AtomicInteger();
        drive(session, owner, () -> {
            boolean cast = PlaySpellAbility.playSpellAbility((PlayerControllerHuman) owner.getController(), owner,
                    spell.getSpellAbilities().get(0));
            require(!cast && spell.isInZone(ZoneType.Hand), "Cancel did not restore the spell to hand");
            require(!city.isTapped() && owner.getLife() == 1, "Preview used a lethal mana source");
        }, input -> {
            require(input.get("type").getAsString().equals("payManaCost"), "Unexpected lethal-only prompt " + input);
            require(!input.get("canAutoPay").getAsBoolean(), "Offered automatic payment using a lethal City of Brass");
            prompts.incrementAndGet();
            return NativeSession.object("type", "cancel");
        });
        require(prompts.get() == 1, "Missing native mana prompt for a manually payable spell");
    }

    private static void run(NativeSession session, Player owner, String scenario) throws Exception {
        List<Card> lands = new ArrayList<>();
        for (String name : List.of("Eldrazi Temple", "Forest", "Urza's Mine", "Urza's Power Plant",
                "Urza's Power Plant", "Urza's Tower"))
            if (!scenario.equals("missing-tron") || !name.equals("Urza's Power Plant"))
                lands.add(card(session.game, owner, name, ZoneType.Battlefield));
        Card tower = lands.get(lands.size() - 1);
        if (scenario.equals("floating")) owner.getManaPool().addMana(new Mana(MagicColor.COLORLESS, tower, null, owner));
        if (scenario.equals("tapped-tower")) tower.setTapped(true);
        if (!scenario.equals("two-mana")) card(session.game, owner, "Trinisphere", ZoneType.Battlefield);
        if (scenario.equals("damping")) card(session.game, owner, "Damping Sphere", ZoneType.Battlefield);
        Card spell = card(session.game, owner, scenario.equals("colored") ? "Llanowar Elves"
                : scenario.equals("two-mana") ? "Mind Stone" : "Expedition Map", ZoneType.Hand);
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            require(PlaySpellAbility.playSpellAbility((PlayerControllerHuman) owner.getController(), owner,
                    spell.getSpellAbilities().get(0)), "Spell could not be cast");
            List<String> tapped = lands.stream().filter(Card::isTapped).map(Card::getName).toList();
            System.out.println(scenario + " tapped: " + tapped + "; floating: " + owner.getManaPool().totalMana());
            if (scenario.equals("tron-tax") || scenario.equals("manual")) {
                require(tapped.equals(List.of("Urza's Tower")), "Expected only the three-mana Tower: " + tapped);
                require(owner.getManaPool().isEmpty(), "Three-mana cost left unexpected floating mana");
            } else if (scenario.equals("missing-tron") || scenario.equals("damping")) {
                require(tapped.size() == 3 && owner.getManaPool().isEmpty(), "Counted inactive or replaced Tron mana");
            } else if (scenario.equals("tapped-tower")) {
                require(tower.isTapped() && tapped.size() == 3, "Reused an already tapped Tower");
            } else if (scenario.equals("colored")) {
                require(tapped.contains("Forest") && tapped.size() == 2 && owner.getManaPool().isEmpty(),
                        "Colorless mana replaced required green or over-tapped: " + tapped);
            } else if (scenario.equals("two-mana") || scenario.equals("floating")) {
                require(tapped.size() == 1 && !tower.isTapped() && owner.getManaPool().isEmpty(),
                        "Did not prefer exact two mana to three: " + tapped);
            }
            require(spell.isInZone(ZoneType.Stack), "Casting did not put the spell on the stack");
        }, input -> {
            require(input.get("type").getAsString().equals("payManaCost"), "Unexpected casting decision: " + input);
            require(decisions.incrementAndGet() == 1, "Auto-pay did not complete the cost");
            String expectedCost = scenario.equals("colored") ? "{2}{G}" : scenario.equals("two-mana") ? "{2}" : "{3}";
            require(input.get("manaCost").getAsString().equals(expectedCost), "Wrong native cost: " + input);
            require(input.get("canAutoPay").getAsBoolean(), "Auto-pay not offered");
            if (scenario.equals("manual")) {
                JsonObject choice = NativeSession.object("type", "act");
                choice.addProperty("actionId", "card:" + tower.getId());
                return choice;
            }
            return NativeSession.object("type", "pay");
        });
    }
}
