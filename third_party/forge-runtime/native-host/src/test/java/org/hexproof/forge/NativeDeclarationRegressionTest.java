// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameStage;
import forge.game.ability.AbilityFactory;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.model.FModel;
import forge.localinstance.properties.ForgePreferences.FPref;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Real as-enters decisions and a resolving naming sorcery, using two human controllers. */
public final class NativeDeclarationRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (var base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, p -> { p.setPref(FPref.DECKGEN_CARDBASED, false); return null; });
            for (String source : new String[]{"Cavern of Souls", "Pithing Needle", "Slaughter Games", "Favored Enemy", "Secret type"}) {
                JsonObject config = JsonParser.parseString("""
                    {"gameId":"declaration","seed":42,"variant":"constructed","startingLife":20,"players":[
                     {"name":"Alice","deck":[{"name":"Forest"}]},{"name":"Bob","deck":[{"name":"Forest"}]}]}
                    """).getAsJsonObject();
                try (var session = new NativeSession(config, base); var scope = session.context.enter()) {
                    base.setTestSession(session);
                    session.game.setAge(GameStage.Play);
                    Player owner = session.game.getPlayers().get(0);
                    session.game.setStartingPlayer(owner);
                    session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 1);
                    verify(session, owner, source);
                    System.out.println("PASS " + source);
                }
            }
        }
    }

    private static void verify(NativeSession session, Player owner, String name) throws Exception {
        boolean secret = name.equals("Secret type");
        boolean sorcery = name.equals("Slaughter Games");
        boolean noted = name.equals("Favored Enemy");
        boolean type = name.equals("Cavern of Souls") || noted || secret;
        if (noted) card(session.game, owner.getSingleOpponent(), "Savannah Lions", ZoneType.Library);
        String value = noted ? "Cat" : type ? "Human" : "Black Lotus";
        Card source = card(session.game, owner, secret ? "Cavern of Souls" : name,
                sorcery ? ZoneType.Stack : secret ? ZoneType.Battlefield : ZoneType.Hand);
        AtomicInteger prompts = new AtomicInteger();
        drive(session, owner, () -> {
            Card current = source;
            if (sorcery) {
                var spell = source.getSpellAbilities().get(0);
                spell.setActivatingPlayer(owner);
                spell.getSubAbility().getTargets().add(owner.getSingleOpponent());
                AbilityUtils.resolve(spell);
                current = session.game.getAction().moveToGraveyard(source, spell);
            } else if (secret) {
                var spell = AbilityFactory.getAbility(source.getSVar("ChooseCT") + " | Secretly$ True", source);
                spell.setActivatingPlayer(owner);
                AbilityUtils.resolve(spell);
            } else {
                current = session.game.getAction().moveToPlay(source, null, null);
                require(current.isInPlay(), "Permanent did not enter the battlefield");
            }
            for (int viewer : new int[]{0, 1, -1}) {
                JsonObject shown = NativeCardStateRegressionTest.projected(session, current, viewer);
                if (secret || sorcery) require(!shown.has("annotations"), "Private or expired choice persisted on card");
                else require(shown.getAsJsonArray("annotations").toString().contains(value), "Missing public permanent label");
            }
        }, input -> {
            // Favored Enemy first selects an opponent. Its separate player-selection notice
            // precedes the declaration and contains no creature type.
            if (noted && input.get("type").getAsString().equals("acknowledge")
                    && input.getAsJsonObject("presentation").get("description").getAsString().equals("Alice picked Bob"))
                return NativeSession.object("type", "acknowledged");
            prompts.incrementAndGet();
            require(JsonParser.parseString(session.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString()
                    .equals("player-0"), "Opponent was asked to confirm the declaration");
            if (type) {
                require(input.get("searchKind").getAsString().equals("type"), "Type menu lacks search");
                JsonArray options = input.getAsJsonArray("options");
                for (int i = 0; i < options.size(); i++) {
                    if (!options.get(i).getAsJsonObject().get("label").getAsString().equals(value)) continue;
                    JsonObject output = NativeSession.object("type", "selectionDecision");
                    JsonArray selected = new JsonArray(); selected.add(i); output.add("chosenIndices", selected);
                    return output;
                }
                throw new AssertionError("Missing legal type " + value);
            }
            require(input.get("type").getAsString().equals("chooseCardName"), "Unexpected decision: " + input.get("type"));
            var names = input.getAsJsonArray("legalNames");
            require(names.contains(new JsonPrimitive(value)), "Name absent from actual Forge domain");
            require(names.contains(new JsonPrimitive("Forest")) != sorcery, "Printed nonland restriction ignored");
            var output = NativeSession.object("type", "cardName"); output.addProperty("name", value); return output;
        });
        require(prompts.get() == 1, "Declaration unexpectedly interrupted one of the players");
        var spectator = JsonParser.parseString(session.snapshot(-1)).getAsJsonObject();
        if (secret) require(!spectator.has("publicChoices"), "Secret declaration leaked into the journal");
        else {
            var entries = spectator.getAsJsonArray("publicChoices");
            require(entries != null && entries.size() == 1, "Missing or duplicated public declaration: " + name);
            var entry = entries.get(0).getAsJsonObject();
            require(entry.get("value").getAsString().equals(value) && entry.get("source").getAsString().equals(name) &&
                    entry.get("playerId").getAsString().equals("player-0"), "Incorrect public declaration: " + entry);
        }
    }
}
