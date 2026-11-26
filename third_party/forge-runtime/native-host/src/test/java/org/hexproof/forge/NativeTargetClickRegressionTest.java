// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameStage;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.PlayerControllerHuman;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Native cross-target restrictions reject clicks without terminating the game. */
public final class NativeTargetClickRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            JsonObject config = JsonParser.parseString("{\"gameId\":\"target-click\",\"seed\":42,\"variant\":\"constructed\",\"startingLife\":20,\"players\":[{\"name\":\"Target A\",\"deck\":[{\"name\":\"Swamp\"}]},{\"name\":\"Target B\",\"deck\":[{\"name\":\"Forest\"}]}]}").getAsJsonObject();
            try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
                base.setTestSession(session);
                Player owner = session.game.getPlayers().get(0);
                PlayerControllerHuman human = (PlayerControllerHuman) owner.getController();
                session.game.setAge(GameStage.Play);
                session.game.setStartingPlayer(owner);
                session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 33);
                Card bear = card(session.game, owner, "Grizzly Bears", ZoneType.Graveyard);
                Card lion = card(session.game, owner, "Silvercoat Lion", ZoneType.Graveyard);
                Card giant = card(session.game, owner, "Hill Giant", ZoneType.Graveyard);
                Card source = card(session.game, owner, "Agadeem's Awakening", ZoneType.Hand);
                SpellAbility ability = source.getSpellAbilities().get(0);
                ability.setXManaCostPaid(4);
                ability.setActivatingPlayer(owner);
                AtomicInteger clicks = new AtomicInteger();
                drive(session, owner, () -> {
                    require(human.chooseTargetsFor(ability), "Target selection did not complete");
                    require(ability.getTargets().getTargetCards().size() == 2
                            && ability.getTargets().getTargetCards().contains(bear)
                            && ability.getTargets().getTargetCards().contains(giant)
                            && !ability.getTargets().getTargetCards().contains(lion),
                            "Explicit graveyard targets changed");
                    AbilityUtils.resolve(ability);
                    require(owner.getCardsIn(ZoneType.Battlefield).stream().anyMatch(c -> c.getId() == bear.getId())
                            && owner.getCardsIn(ZoneType.Battlefield).stream().anyMatch(c -> c.getId() == giant.getId())
                            && lion.isInZone(ZoneType.Graveyard), "Native reanimation moved the wrong cards");
                }, input -> {
                    require(input.get("type").getAsString().equals("chooseBoardTargets"), "Unexpected target input: " + input);
                    int click = clicks.getAndIncrement();
                    require(click < 4, "Rejected click did not preserve a usable target input");
                    require(ability.getTargets().getTargetCards().size() == (click == 0 ? 0 : click == 3 ? 2 : 1),
                            "Rejected equal-mana-value target changed the native target set");
                    if (click == 0) {
                        JsonObject invalid = NativeSession.object("kind", "card"); invalid.addProperty("id", "card-unavailable");
                        reject(session, answer(invalid));
                        JsonObject candidate = input.getAsJsonArray("candidates").get(0).getAsJsonObject();
                        reject(session, answer(candidate, candidate));
                    }
                    if (click == 2)
                        require(input.getAsJsonObject("presentation").get("description").getAsString()
                                .contains("different mana values"), "Native rejection message was lost");
                    if (click == 3) return answer();
                    Card selected = click == 0 ? bear : click == 1 ? lion : giant;
                    JsonObject candidate = input.getAsJsonArray("candidates").asList().stream()
                            .map(JsonElement::getAsJsonObject)
                            .filter(value -> value.get("id").getAsString().equals(NativeSession.cardId(selected)))
                            .findFirst().orElseThrow();
                    return answer(candidate);
                });
                require(clicks.get() == 4 && !session.hasFailed(), "Target rejection failed the native session");
            }
            battlefieldSelection(base, config, false, false);
            battlefieldSelection(base, config, true, false);
            battlefieldSelection(base, config, true, true);
            mixedChooseCard(base, config);
        }
        System.out.println("PASS native graveyard targeting, Wasteland, and both Cloak and Dagger exile scopes");
    }

    private static void battlefieldSelection(NativeGuiBase base, JsonObject config, boolean cloak, boolean landOnly) throws Exception {
        try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
            base.setTestSession(session);
            var game = session.game;
            Player owner = game.getPlayers().get(0), opponent = game.getPlayers().get(1);
            game.setAge(GameStage.Play);
            game.setStartingPlayer(owner);
            game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 33);
            PlayerControllerHuman human = (PlayerControllerHuman) owner.getController();
            Card source = card(game, owner, cloak ? "Cloak and Dagger, Entwined" : "Wasteland", ZoneType.Battlefield);
            Card permanent = card(game, opponent, cloak ? "Grizzly Bears" : "Temple Garden", ZoneType.Battlefield);
            Card hand = card(game, opponent, landOnly ? "Forest" : "Lightning Bolt", ZoneType.Hand);
            card(game, owner, "Silvercoat Lion", ZoneType.Battlefield);
            SpellAbility ability = cloak ? source.getTriggers().stream().filter(t -> t.hasParam("Execute")).findFirst().orElseThrow().ensureAbility()
                    : source.getSpellAbilities().stream().filter(SpellAbility::usesTargeting).findFirst().orElseThrow();
            ability.setActivatingPlayer(owner);
            AtomicInteger table = new AtomicInteger(), mixed = new AtomicInteger();
            drive(session, owner, () -> {
                if (cloak) require(human.chooseTargetsFor(ability) && ability.getTargets().contains(opponent),
                        "Cloak and Dagger must first target the opponent");
                SpellAbility target = cloak ? ability.getSubAbility() : ability;
                target.setActivatingPlayer(owner);
                require(human.chooseTargetsFor(target), "Cannot choose the opposing permanent");
                require(target.getTargets().getTargetCards().contains(permanent), "Incorrect opposing permanent");
                AbilityUtils.resolve(ability);
                ZoneType destination = cloak ? ZoneType.Exile : ZoneType.Graveyard;
                Card expected = cloak && !landOnly ? hand : permanent;
                require(opponent.getCardsIn(destination).stream().anyMatch(c -> c.getId() == expected.getId()),
                        "The chosen opposing card did not reach " + destination);
            }, input -> {
                String type = input.get("type").getAsString();
                if (type.equals("revealCards")) return NativeSession.object("type", "revealCardsAcknowledged");
                if (type.equals("chooseBoolean")) {
                    JsonObject yes = NativeSession.object("type", "decision"); yes.addProperty("value", true); return yes;
                }
                boolean otherZones = input.has("includesOtherZones") && input.get("includesOtherZones").getAsBoolean();
                if (type.equals("chooseBoardTargets")) {
                    for (JsonElement element : input.getAsJsonArray("candidates")) {
                        JsonObject candidate = element.getAsJsonObject();
                        if (candidate.get("kind").getAsString().equals("player") &&
                                candidate.get("id").getAsString().equals(session.playerId(opponent))) return answer(candidate);
                    }
                }
                if (otherZones) mixed.incrementAndGet(); else table.incrementAndGet();
                Card chosen = otherZones && !landOnly ? hand : permanent;
                if (type.equals("chooseBoardTargets")) {
                    JsonArray candidates = input.getAsJsonArray("candidates");
                    JsonObject choice = candidates.asList().stream().map(JsonElement::getAsJsonObject)
                            .filter(item -> item.get("id").getAsString().equals(NativeSession.cardId(chosen)))
                            .findFirst().orElseThrow();
                    return answer(choice);
                }
                require(type.equals("chooseCards") && cloak && otherZones, "Unexpected selection: " + input);
                var cards = input.getAsJsonArray("cards").asList().stream().map(JsonElement::getAsJsonObject).toList();
                require(landOnly || cards.stream().anyMatch(c -> c.get("id").getAsString().equals(NativeSession.cardId(hand))),
                        "Eligible opposing hand card missing");
                JsonArray ids = new JsonArray(); ids.add(NativeSession.cardId(chosen));
                JsonObject out = NativeSession.object("type", "chooseCardsDecision"); out.add("chosenCardIds", ids);
                return out;
            });
            require(table.get() == 1 && mixed.get() == (cloak ? 1 : 0), "Wrong battlefield/mixed-zone choices: " + table + "/" + mixed);
        }
    }

    private static void mixedChooseCard(NativeGuiBase base, JsonObject config) throws Exception {
        try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
            base.setTestSession(session);
            var game = session.game;
            Player owner = game.getPlayers().get(0);
            game.setAge(GameStage.Play);
            game.setStartingPlayer(owner);
            game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 33);
            Card source = card(game, owner, "Scour the Scene", ZoneType.Battlefield);
            Card bear = card(game, owner, "Grizzly Bears", ZoneType.Battlefield);
            card(game, owner, "Silvercoat Lion", ZoneType.Battlefield);
            card(game, owner, "Forest", ZoneType.Hand);
            SpellAbility ability = source.getTriggers().stream().filter(t -> "TrigChooseCard".equals(t.getParam("Execute")))
                    .findFirst().orElseThrow().ensureAbility();
            ability.setActivatingPlayer(owner);
            AtomicInteger decisions = new AtomicInteger();
            drive(session, owner, () -> AbilityUtils.resolve(ability), input -> {
                require(input.get("includesOtherZones").getAsBoolean(), "ChooseCard discarded its Hand,Battlefield scope");
                require(decisions.incrementAndGet() == 1, "Unexpected additional Scour the Scene choice");
                JsonObject candidate = input.getAsJsonArray("candidates").asList().stream().map(JsonElement::getAsJsonObject)
                        .filter(item -> NativeSession.cardId(bear).equals(item.get("id").getAsString())).findFirst().orElseThrow();
                return answer(candidate);
            });
            require(decisions.get() == 1 && bear.getNetPower() == 3, "Scour the Scene did not apply to the chosen creature");
        }
    }

    private static JsonObject answer(JsonObject... candidates) {
        JsonObject answer = NativeSession.object("type", "boardTargets");
        JsonArray chosen = new JsonArray();
        for (JsonObject candidate : candidates) chosen.add(candidate);
        answer.add("chosen", chosen);
        return answer;
    }

    private static void reject(NativeSession session, JsonObject output) {
        String before = session.prompt(0);
        JsonObject envelope = NativeSession.object("type", "chooseBoardTargets"); envelope.add("output", output);
        boolean rejected = false;
        try { session.submit(envelope); } catch (IllegalArgumentException expected) { rejected = true; }
        require(rejected && before.equals(session.prompt(0)) && !session.hasFailed(),
                "Invalid target response consumed or failed the native prompt");
    }
}
