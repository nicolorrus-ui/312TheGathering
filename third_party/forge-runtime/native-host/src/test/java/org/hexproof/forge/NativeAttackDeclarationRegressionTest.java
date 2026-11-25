// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameStage;
import forge.game.card.Card;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.PlayerControllerHuman;
import java.util.*;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;
import static org.hexproof.forge.NativeSession.*;

/** A complete declaration against players, planeswalkers and protected battles through real InputAttack. */
public final class NativeAttackDeclarationRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> { prefs.setPref(FPref.DECKGEN_CARDBASED, false); return null; });
            for (String mode : List.of("split", "skip", "required")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("attack-" + mode, 42), base);
                     var scope = session.context.enter()) {
                    base.setTestSession(session);
                    Player attacker = session.game.getPlayers().get(0), defender = session.game.getPlayers().get(1);
                    session.game.setAge(GameStage.Play);
                    session.game.setStartingPlayer(attacker);
                    session.game.getPhaseHandler().devModeSet(PhaseType.COMBAT_DECLARE_ATTACKERS, attacker, false, 2);
                    Card first = card(session.game, attacker, mode.equals("required") ? "Juggernaut" : "Grizzly Bears", ZoneType.Battlefield);
                    Card second = card(session.game, attacker, "Grizzly Bears", ZoneType.Battlefield);
                    Card pegasus = card(session.game, attacker, "Loyal Pegasus", ZoneType.Battlefield);
                    for (Card creature : List.of(first, second, pegasus)) creature.setSickness(false);
                    Card tapped = card(session.game, attacker, "Grizzly Bears", ZoneType.Battlefield);
                    tapped.setTapped(true);
                    Card walker = card(session.game, defender, "Jace Beleren", ZoneType.Battlefield);
                    Card battle = card(session.game, attacker, "Invasion of Zendikar", ZoneType.Battlefield);
                    battle.setProtectingPlayer(defender);
                    Card protectedBattle = card(session.game, defender, "Invasion of Zendikar", ZoneType.Battlefield);
                    protectedBattle.setProtectingPlayer(attacker);
                    card(session.game, defender, "Sandwurm Convergence", ZoneType.Battlefield);
                    session.game.getAction().checkStaticAbilities();
                    Combat combat = new Combat(attacker);
                    session.game.getPhaseHandler().setCombat(combat);
                    String playerId = session.playerId(defender), walkerId = cardId(walker), battleId = cardId(battle);
                    drive(session, attacker, () -> {
                        ((PlayerControllerHuman)attacker.getController()).declareAttackers(attacker, combat);
                        require(CombatUtil.validateAttackers(combat), "Final declaration violated native rules");
                        if (mode.equals("skip")) require(combat.getAttackers().isEmpty(), "Empty submission declared creatures");
                        else require(combat.getDefenderByAttacker(first) == defender && combat.getDefenderByAttacker(second) == walker
                                && combat.getDefenderByAttacker(pegasus) == battle, "Wrong confirmed defender");
                    }, input -> {
                        require(input.get("type").getAsString().equals("chooseAttackers"), "Unexpected combat prompt");
                        Map<String, String> targets = new LinkedHashMap<>();
                        for (JsonElement raw : input.getAsJsonArray("attackTargets")) {
                            var target = raw.getAsJsonObject();
                            targets.put(target.get("id").getAsString(), target.get("kind").getAsString());
                        }
                        require(targets.equals(Map.of(playerId, "player", walkerId, "planeswalker", battleId, "battle")),
                                "Defender identity, kind or protector mismatch: " + targets);
                        Map<String, Set<String>> legal = new HashMap<>();
                        for (JsonElement raw : input.getAsJsonArray("attackers")) {
                            var source = raw.getAsJsonObject();
                            Set<String> ids = new HashSet<>();
                            source.getAsJsonArray("validTargetIds").forEach(id -> ids.add(id.getAsString()));
                            legal.put(source.get("attackerId").getAsString(), ids);
                        }
                        require(legal.equals(Map.of(cardId(first), targets.keySet(), cardId(second), targets.keySet(),
                                cardId(pegasus), Set.of(battleId))), "Incorrect legal defenders by attacker: " + legal);
                        reject(session, combat, List.of(pair(first, playerId), pair(pegasus, walkerId)));
                        reject(session, combat, List.of(pair(first, playerId), pair(first, battleId)));
                        reject(session, combat, List.of(pair(pegasus, battleId))); // Cannot attack alone.
                        if (mode.equals("required")) reject(session, combat, List.of()); // Juggernaut must attack if able.
                        return declaration(mode.equals("skip") ? List.of()
                                : List.of(pair(first, playerId), pair(second, walkerId), pair(pegasus, battleId)));
                    });
                }
            }
        }
        System.out.println("PASS native attack declaration: legal targets, three defenders, atomic rejection, empty and required attacks");
    }

    private static JsonObject pair(Card source, String target) {
        JsonObject value = object("attackerId", cardId(source));
        value.addProperty("targetId", target);
        return value;
    }
    private static JsonObject declaration(List<JsonObject> pairs) {
        JsonArray assignments = new JsonArray();
        pairs.forEach(assignments::add);
        JsonObject result = object("type", "declareAttackers");
        result.add("assignments", assignments);
        return result;
    }
    private static void reject(NativeSession session, Combat combat, List<JsonObject> pairs) {
        String before = session.prompt(0);
        JsonObject response = object("type", "chooseAttackers");
        response.add("output", declaration(pairs));
        try {
            session.submit(response);
            throw new AssertionError("Invalid attack was accepted");
        } catch (IllegalArgumentException expected) {
            require(before.equals(session.prompt(0)) && combat.getAttackers().isEmpty(), "Rejection altered the prompt or combat");
        }
    }
}
