// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.card.MagicColor;
import forge.game.GameStage;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;
import static org.hexproof.forge.NativeSession.object;

public final class NativeSimultaneousEntryRegressionTest {
    private static final String LOTUS = "Lotus Field", VESTIGE = "Crumbling Vestige";
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            for (String scenario : List.of(LOTUS, VESTIGE, "Collected Company")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("entry", 42), base);
                        var scope = session.context.enter()) {
                    base.setTestSession(session);
                    var owner = session.game.getPlayers().get(0);
                    session.game.setAge(GameStage.Play);
                    session.game.setStartingPlayer(owner);
                    session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 1);
                    if (scenario.equals("Collected Company")) company(session, owner);
                    else scapeshift(session, owner, scenario);
                    System.out.println("PASS native simultaneous entry " + scenario);
                }
            }
        }
    }

    private static JsonObject withArray(String type, String key, JsonArray array) {
        JsonObject result = object("type", type);
        result.add(key, array);
        return result;
    }

    private static JsonObject chooseCards(Card... cards) {
        var ids = new JsonArray();
        for (Card card : cards) ids.add(NativeSession.cardId(card));
        return withArray("chooseCardsDecision", "chosenCardIds", ids);
    }

    private static List<JsonObject> items(JsonObject input) {
        return input.getAsJsonArray("items").asList().stream().map(JsonElement::getAsJsonObject).toList();
    }

    private static String name(JsonObject item) {
        return item.getAsJsonObject("card").getAsJsonObject("identity").get("name").getAsString();
    }

    private static JsonObject order(List<JsonObject> items) {
        var ids = new JsonArray();
        for (JsonObject item : items) ids.add(item.get("id"));
        return withArray("reorderDecision", "orderedIds", ids);
    }

    private static void company(NativeSession session, Player owner) throws Exception {
        var library = List.of("Grizzly Bears", "Llanowar Elves", "Island", "Mountain", "Swamp", "Forest", "Plains")
                .stream().map(n -> card(session.game, owner, n, ZoneType.Library)).toList();
        owner.getZone(ZoneType.Library).setCards(library);
        var spell = card(session.game, owner, "Collected Company", ZoneType.Hand).getFirstSpellAbility();
        spell.setActivatingPlayer(owner);
        AtomicInteger picks = new AtomicInteger(), bottomOrders = new AtomicInteger();
        drive(session, owner, () -> {
            AbilityUtils.resolve(spell);
            require(owner.getCardsIn(ZoneType.Battlefield).size() == 2 && owner.getCardsIn(ZoneType.Battlefield)
                    .stream().map(Card::getName).toList().containsAll(List.of("Grizzly Bears", "Llanowar Elves")), "Company lost selected creatures");
            var finalLibrary = owner.getCardsIn(ZoneType.Library).stream().map(Card::getName).toList();
            require(finalLibrary.equals(List.of("Plains", "Swamp", "Island", "Forest", "Mountain")),
                    "Company lost the real bottom-library order: " + finalLibrary);
        }, input -> switch (input.get("type").getAsString()) {
            case "chooseCards" -> {
                require(picks.incrementAndGet() == 1 && input.getAsJsonArray("cards").size() == 6
                        && input.get("max").getAsInt() == 2, "Company must look at six and choose up to two creatures");
                yield chooseCards(library.get(0), library.get(1));
            }
            case "revealCards" -> NativeSession.object("type", "revealCardsAcknowledged");
            case "reorder" -> {
                var items = items(input);
                require(bottomOrders.incrementAndGet() == 1 && items.stream().map(NativeSimultaneousEntryRegressionTest::name)
                        .toList().equals(List.of("Island", "Mountain", "Swamp", "Forest")), "Unexpected Company ordering: " + input);
                yield order(List.of(items.get(1), items.get(3), items.get(0), items.get(2)));
            }
            default -> throw new AssertionError("Unexpected Company decision: " + input);
        });
        require(picks.get() == 1 && bottomOrders.get() == 1, "Company omitted a real card decision");
    }

    private static void scapeshift(NativeSession session, Player owner, String first) throws Exception {
        List<Card> forests = List.of(1, 2, 3, 4).stream().map(i -> card(session.game, owner, "Forest", ZoneType.Battlefield)).toList();
        Card lotus = card(session.game, owner, LOTUS, ZoneType.Library);
        Card vestige = card(session.game, owner, VESTIGE, ZoneType.Library);
        owner.getZone(ZoneType.Library).setCards(List.of(lotus, vestige));
        var spell = card(session.game, owner, "Scapeshift", ZoneType.Hand).getFirstSpellAbility();
        spell.setActivatingPlayer(owner);
        AtomicInteger sacrifices = new AtomicInteger(), searches = new AtomicInteger(), triggers = new AtomicInteger();
        drive(session, owner, () -> {
            session.game.getAction().checkStaticAbilities();
            session.game.copyLastState();
            AbilityUtils.resolve(spell);
            var battlefield = owner.getCardsIn(ZoneType.Battlefield);
            require(battlefield.size() == 4 && battlefield.stream().filter(c -> !c.getName().equals("Forest"))
                    .filter(Card::isTapped).count() == 2, "Scapeshift must put both selected lands onto the battlefield tapped");
            var stack = session.game.getStack();
            session.game.getTriggerHandler().runWaitingTriggers();
            stack.addAllTriggeredAbilitiesToStack();
            require(stack.size() == 2 && stack.peekAbility().getHostCard().getName().equals(first),
                    "Leftmost trigger must resolve first");
            stack.resolveStack();
            boolean manaFirst = VESTIGE.equals(first);
            require(owner.getManaPool().getAmountOfColor(MagicColor.BLUE) == (manaFirst ? 1 : 0)
                    && owner.getCardsIn(ZoneType.Battlefield).size() == (manaFirst ? 4 : 2),
                    "First trigger resolved in reverse order");
            stack.resolveStack();
            require(owner.getManaPool().getAmountOfColor(MagicColor.BLUE) == 1 && owner.getCardsIn(ZoneType.Battlefield).size() == 2,
                    "Both real triggers must resolve");
        }, input -> switch (input.get("type").getAsString()) {
            case "chooseBoolean" -> {
                var result = object("type", "decision"); result.addProperty("value", true); yield result;
            }
            case "chooseBoardTargets" -> {
                int count = sacrifices.getAndIncrement();
                require(count <= 1, "Unexpected sacrifice");
                var selected = new JsonArray();
                for (Card forest : forests.subList(count * 2, count * 2 + 2)) {
                    var target = object("kind", "card"); target.addProperty("id", NativeSession.cardId(forest)); selected.add(target);
                }
                yield withArray("boardTargets", "chosen", selected);
            }
            case "chooseCards" -> {
                require(searches.incrementAndGet() == 1 && input.getAsJsonArray("cards").size() == 2,
                        "Unexpected extra land selection: " + input);
                yield chooseCards(lotus, vestige);
            }
            case "reorder" -> {
                var items = items(input);
                if (items.stream().allMatch(item -> name(item).equals("Forest"))) yield order(items);
                require(items.size() == 2 && items.stream().allMatch(item -> item.has("abilityText"))
                        && items.stream().map(NativeSimultaneousEntryRegressionTest::name).toList().containsAll(List.of(LOTUS, VESTIGE))
                        && triggers.incrementAndGet() == 1, "Ordered the physical entry or lost trigger source information: " + input);
                yield order(name(items.getFirst()).equals(first) ? items : items.reversed());
            }
            case "chooseFromSelection" -> {
                var options = input.getAsJsonArray("options").asList();
                require(options.size() == 5, "Vestige should offer all five colours: " + input);
                int blue = -1;
                for (int i = 0; i < options.size(); i++)
                    if (options.get(i).getAsJsonObject().get("label").getAsString().equalsIgnoreCase("blue")) blue = i;
                require(blue >= 0, "Vestige omitted blue");
                var selected = new JsonArray(); selected.add(blue);
                yield withArray("selectionDecision", "chosenIndices", selected);
            }
            default -> throw new AssertionError("Unexpected Scapeshift decision: " + input);
        });
        require(sacrifices.get() == 2 && searches.get() == 1 && triggers.get() == 1, "Missing real Scapeshift decisions");
        require(session.snapshot(1).contains("picked {U}") && !session.snapshot(0).contains("picked {U}")
                && !session.snapshot(-1).contains("picked {U}"), "Vestige's color announcement reached the wrong audience");
    }
}
