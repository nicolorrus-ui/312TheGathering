// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.game.GameStage;
import forge.game.ability.AbilityFactory;
import forge.game.ability.AbilityKey;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.List;
import java.util.HashSet;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** The recipient of a private look, other players and the public projection see different tops. */
public final class NativeTopRevealRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            JsonObject config = JsonParser.parseString("""
                    {"gameId":"revealed-top","seed":42,"variant":"constructed","startingLife":20,
                     "players":[{"name":"A","deck":[{"name":"Forest"}]},{"name":"B","deck":[{"name":"Swamp"}]},
                                {"name":"C","deck":[{"name":"Island"}]}]}
                    """).getAsJsonObject();
            for (boolean delver : List.of(true, false)) for (boolean accept : List.of(true, false)) {
                try (NativeSession s = new NativeSession(config, base); var scope = s.context.enter()) {
                    base.setTestSession(s);
                    Player first = s.game.getPlayers().get(0), second = s.game.getPlayers().get(1);
                    s.game.setAge(GameStage.Play);
                    s.game.setStartingPlayer(first);
                    s.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, first, false, 2);
                    if (delver) delver(s, first, accept);
                    else clash(s, first, second, accept);
                }
            }
        }
        System.out.println("PASS native Delver private/public reveals and Clash top/bottom for both players");
    }

    private static Card[] library(NativeSession s, Player owner, String first, String second) {
        Card top = card(s.game, owner, first, ZoneType.Library), next = card(s.game, owner, second, ZoneType.Library);
        owner.getZone(ZoneType.Library).setCards(List.of(top, next));
        return new Card[]{top, next};
    }

    private static void expectTop(NativeSession s, int receiver, int librarySeat, Card expected) {
        JsonArray zones = JsonParser.parseString(s.snapshot(receiver)).getAsJsonObject().getAsJsonArray("zones");
        JsonObject library = zones.asList().stream().map(JsonElement::getAsJsonObject)
                .filter(zone -> zone.get("zone").getAsString().equals("library")
                        && zone.get("ownerId").getAsString().equals("player-" + librarySeat)).findFirst().orElseThrow();
        JsonArray faces = library.getAsJsonArray("cards");
        String diagnostic = "Library " + librarySeat + " for viewer " + receiver + ": " + faces;
        require(library.get("count").getAsInt() == 2 && faces.size() == (expected == null ? 0 : 1), diagnostic);
        if (expected != null) {
            var face = faces.get(0).getAsJsonObject();
            require(face.get("id").getAsString().equals(NativeSnapshot.cardId(expected))
                    && NativeSnapshot.identity(expected).equals(face.get("identity")), diagnostic);
        }
    }

    private static JsonObject respond(String kind, boolean answer) {
        if (kind.equals("revealCards")) return NativeSession.object("type", "revealCardsAcknowledged");
        require(kind.equals("chooseBoolean"), "Unexpected native input: " + kind);
        JsonObject response = NativeSession.object("type", "decision");
        response.addProperty("value", answer);
        return response;
    }

    private static void delver(NativeSession s, Player owner, boolean reveal) throws Exception {
        Card creature = card(s.game, owner, "Delver of Secrets", ZoneType.Battlefield);
        Card top = library(s, owner, "Lightning Bolt", "Island")[0];
        var ability = AbilityFactory.getAbility(creature.getSVar("TrigPeek"), creature);
        ability.setActivatingPlayer(owner);
        drive(s, owner, () -> {
            AbilityUtils.resolve(ability);
            require(creature.isTransformed() == reveal, "Delver did not follow the selected reveal");
            require(owner.getCardsIn(ZoneType.Library).getFirst() == top, "Delver moved the revealed card");
            s.ask(owner, NativeSession.object("type", "verifyDelverTop"), ignored -> true);
        }, input -> {
            String kind = input.get("type").getAsString();
            if (kind.equals("verifyDelverTop")) {
                for (int viewer : List.of(-1, 0, 1, 2)) expectTop(s, viewer, 0, reveal || viewer == 0 ? top : null);
                return new JsonObject();
            }
            return respond(kind, reveal);
        });
    }

    private static void clash(NativeSession s, Player first, Player second, boolean keepFirst) throws Exception {
        Card source = card(s.game, first, "Marvo, Deep Operative", ZoneType.Battlefield);
        Card[] a = library(s, first, "Island", "Forest"), b = library(s, second, "Swamp", "Mountain");
        var ability = AbilityFactory.getAbility(source.getSVar("TrigClash"), source);
        ability.setActivatingPlayer(first);
        ability.setTriggeringObject(AbilityKey.DefendingPlayer, second);
        var chose = new HashSet<String>();
        drive(s, first, () -> {
            AbilityUtils.resolve(ability);
            require(first.getCardsIn(ZoneType.Library).getFirst().getId() == a[keepFirst ? 0 : 1].getId()
                    && second.getCardsIn(ZoneType.Library).getFirst().getId() == b[keepFirst ? 1 : 0].getId(),
                    "Clash did not place the revealed cards as selected");
            s.ask(first, NativeSession.object("type", "verifyClashTops"), ignored -> true);
        }, input -> {
            String kind = input.get("type").getAsString();
            if (kind.equals("verifyClashTops")) {
                for (int receiver : List.of(-1, 0, 1, 2)) {
                    expectTop(s, receiver, 0, keepFirst ? a[0] : null);
                    expectTop(s, receiver, 1, keepFirst ? null : b[0]);
                }
                return new JsonObject();
            }
            if (!kind.equals("chooseBoolean")) return respond(kind, false);
            require(input.get("confirmLabel").getAsString().equals("Top")
                    && input.get("denyLabel").getAsString().equals("Bottom"), "Unexpected Clash choice: " + input);
            String player = JsonParser.parseString(s.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString();
            require((player.equals("player-0") || player.equals("player-1")) && chose.add(player),
                    "Unexpected Clash chooser: " + player);
            return respond(kind, player.equals("player-0") ? keepFirst : !keepFirst);
        });
        require(chose.size() == 2, "Both players must choose where their own revealed card goes");
    }
}
