// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.GameStage;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

public final class NativeReplacementOrderRegressionTest {
    private static final String FIELD = "Lotus Field";
    private static final String SPELUNKING = "Spelunking";
    private static final String AMULET = "Amulet of Vigor";
    private static final String MAZE = "Root Maze";

    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("replacement-order", 42), base);
                    var scope = session.context.enter()) {
                base.setTestSession(session);
                testLandEntries(session);
            }
        }
        System.out.println("PASS native replacement order, both Lotus Field outcomes, scoped memory and Amulet triggers");
    }

    private static void testLandEntries(NativeSession session) throws Exception {
        Player owner = session.game.getPlayers().get(0);
        session.game.setAge(GameStage.Play);
        session.game.setStartingPlayer(owner);
        session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 2);
        card(session.game, owner, SPELUNKING, ZoneType.Battlefield);
        card(session.game, owner, AMULET, ZoneType.Battlefield);
        for (String extraLandPlays : List.of("Azusa, Lost but Seeking", "Exploration"))
            card(session.game, owner, extraLandPlays, ZoneType.Battlefield).setGameTimestamp(session.game.getNextTimestamp());
        Set<String> forests = new HashSet<>();
        for (int i = 0; i < 8; i++) forests.add(NativeSession.cardId(card(session.game, owner, "Forest", ZoneType.Battlefield)));
        AtomicInteger entry = new AtomicInteger();
        List<Integer> replacementPrompts = new ArrayList<>();
        List<Integer> triggerPrompts = new ArrayList<>();
        drive(session, owner, () -> {
            for (int i = 0; i < 4; i++) {
                entry.set(i);
                if (i == 3) card(session.game, owner, MAZE, ZoneType.Battlefield);
                session.game.getAction().checkStaticAbilities();
                session.game.getTriggerHandler().resetActiveTriggers();
                Card physical = card(session.game, owner, FIELD, ZoneType.Hand);
                require(owner.canPlayLand(physical, false, null), "Illegal turn or land play for entry " + i);
                Card field = owner.playLand(physical, null);
                boolean tapped = i == 1 || i == 2;
                require(field.isInZone(ZoneType.Battlefield) && field.isTapped() == tapped,
                        "Lotus Field entry " + i + " had the wrong tapped state");
                session.game.getStack().addAllTriggeredAbilitiesToStack();
                List<String> sources = new ArrayList<>();
                for (var instance : session.game.getStack()) sources.add(instance.getSourceCard().getName());
                require(sources.contains(FIELD) && sources.contains(AMULET) == tapped && sources.size() == (tapped ? 2 : 1),
                        "Unexpected triggered abilities after entry " + i + ": " + sources);
                while (!session.game.getStack().isEmpty()) session.game.getStack().resolveStack();
                require(!field.isTapped() && field.isInZone(ZoneType.Battlefield), "Resolved Amulet did not untap the entering land");
            }
        }, input -> {
            String type = input.get("type").getAsString();
            if (type.equals("chooseBoardTargets")) return sacrificeForests(input, forests);
            require(type.equals("reorder"), "Unexpected native input " + input);
            var items = new LinkedHashMap<String, String>();
            for (var element : input.getAsJsonArray("items")) {
                var item = element.getAsJsonObject();
                String name = item.getAsJsonObject("card").getAsJsonObject("identity").get("name").getAsString();
                require(items.put(name, item.get("id").getAsString()) == null, "Unexpected duplicate source " + name);
            }
            int i = entry.get();
            List<String> order;
            JsonObject answer = NativeSession.object("type", "reorderDecision");
            if (input.has("replacementOrder")) {
                require(input.get("replacementOrder").getAsBoolean(), "Non-replacement prompt marked for memorizing");
                replacementPrompts.add(i);
                order = switch (i) {
                    case 0 -> List.of(FIELD, SPELUNKING);
                    case 1 -> List.of(SPELUNKING, FIELD);
                    case 3 -> List.of(FIELD, MAZE, SPELUNKING);
                    default -> throw new AssertionError("Memorized Lotus Field prompted again");
                };
                if (i == 1) answer.addProperty("memorize", true);
            } else {
                triggerPrompts.add(i);
                order = List.of(FIELD, AMULET);
            }
            require(items.size() == order.size() && items.keySet().containsAll(order), "Unexpected order candidates: " + items);
            JsonArray ids = new JsonArray();
            for (String name : order) ids.add(items.get(name));
            answer.add("orderedIds", ids);
            return answer;
        });
        require(replacementPrompts.equals(List.of(0, 1, 3)), "Unexpected replacement prompts: " + replacementPrompts);
        require(triggerPrompts.equals(List.of(1, 2)), "Trigger order was memorized or misclassified: " + triggerPrompts);
    }

    private static JsonObject sacrificeForests(JsonObject input, Set<String> forests) {
        JsonArray chosen = new JsonArray();
        for (var element : input.getAsJsonArray("candidates")) {
            if (chosen.size() < 2 && forests.contains(element.getAsJsonObject().get("id").getAsString()))
                chosen.add(element);
        }
        require(chosen.size() == 2, "Lotus Field could not sacrifice two Forests: " + input);
        JsonObject answer = NativeSession.object("type", "boardTargets");
        answer.add("chosen", chosen);
        return answer;
    }
}
