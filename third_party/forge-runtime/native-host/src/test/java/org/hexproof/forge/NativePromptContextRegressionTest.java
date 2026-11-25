// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameStage;
import forge.game.ability.AbilityFactory;
import forge.game.ability.AbilityUtils;
import forge.game.ability.AbilityKey;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.PlayerControllerHuman;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Private context from actual native surveil/confirmation callbacks. */
public final class NativePromptContextRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            JsonObject config = JsonParser.parseString("{\"gameId\":\"native-context-test\",\"seed\":42,\"variant\":\"constructed\",\"startingLife\":20,\"players\":[{\"name\":\"Context A\",\"deck\":[{\"name\":\"Forest\"}]},{\"name\":\"Context B\",\"deck\":[{\"name\":\"Forest\"}]}]}").getAsJsonObject();
            try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
                base.setTestSession(session);
                session.game.setAge(GameStage.Play);
                Player owner = session.game.getPlayers().get(0);
                session.game.setStartingPlayer(owner);
                session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 1);
                Card troll = card(session.game, owner, "Troll of Khazad-dûm", ZoneType.Library);
                card(session.game, owner, "Mountain", ZoneType.Library);
                Card cause = card(session.game, owner, "Consider", ZoneType.Hand);
                var ability = cause.getSpellAbilities().get(0);
                ability.setActivatingPlayer(owner);
                var gui = ((PlayerControllerHuman) owner.getController()).getGui();
                Card hidden = card(session.game, session.game.getPlayers().get(1), "Willbender", ZoneType.Battlefield);
                hidden.turnFaceDown(true);
                Card ownedFaceDown = card(session.game, owner, "Willbender", ZoneType.Battlefield);
                ownedFaceDown.turnFaceDown(true);
                require(ownedFaceDown.getView().canFaceDownBeShownTo(owner.getView())
                    && ownedFaceDown.getView().getName().isBlank(), "Missing anonymous owner-visible face-down fixture");
                AtomicInteger decisions = new AtomicInteger();
                drive(session, owner, () -> {
                    owner.surveil(1, ability, new HashMap<>());
                    require(owner.getCardsIn(ZoneType.Library).getFirst() == troll, "Library answer moved the surveilled card");
                    owner.surveil(1, ability, new HashMap<>());
                    require(owner.getCardsIn(ZoneType.Graveyard).contains(troll), "Graveyard answer did not move the surveilled card");
                    require(gui.confirm(null, "Unrelated decision", true, List.of("Yes", "No")), "No-card confirmation changed its answer");
                    require(gui.confirm(hidden.getView(), "Public confirmation", true, List.of("Yes", "No")), "Hidden confirmation changed its answer");
                    require(gui.confirm(ownedFaceDown.getView(), "Anonymous own-card confirmation", true, List.of("Yes", "No")), "Anonymous own-card confirmation changed its answer");
                    require(gui.confirm(troll.getView(), "Explicit card confirmation", true, List.of("Yes", "No")), "Explicit confirmation changed its answer");
                }, input -> {
                    int index = decisions.getAndIncrement();
                    require(input.get("type").getAsString().equals("chooseBoolean"), "Unexpected native confirmation family");
                    JsonObject envelope = JsonParser.parseString(session.prompt(0)).getAsJsonObject();
                    if (index < 2 || index == 5) {
                        require(envelope.has("sourceCard"), "Native confirmation dropped the decision card");
                        JsonObject source = envelope.getAsJsonObject("sourceCard");
                        require(source.get("id").getAsString().equals(NativeSession.cardId(troll)), "Wrong decision card");
                        require(source.getAsJsonObject("identity").get("name").getAsString().equals(troll.getName()), "Decision card lost identity");
                        require(input.getAsJsonObject("presentation").get("text").getAsString().contains("Swampcycling"), "Decision card lost rules text");
                    } else {
                        require(!envelope.has("sourceCard") && !input.getAsJsonObject("presentation").has("text"), "Confirmation retained unrelated or hidden context");
                        require(!envelope.toString().contains(troll.getName()), "Confirmation retained another input's description");
                    }
                    require(!envelope.toString().contains("Mountain") && !envelope.toString().contains("Willbender"), "Confirmation disclosed an unauthorized card");
                    if (index < 2) for (int viewer : new int[]{-1, 1})
                        require(!session.snapshot(viewer).contains(troll.getName()), "Private surveil leaked to another viewer");
                    JsonObject answer = NativeSession.object("type", "decision");
                    answer.addProperty("value", index != 1);
                    return answer;
                });
                require(decisions.get() == 6, "Missing confirmation callbacks");
            }
            testBinaryDecisions(config, base);
        }
        System.out.println("PASS native private prompt context");
    }

    private static void testBinaryDecisions(JsonObject config, NativeGuiBase base) throws Exception {
        try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
            base.setTestSession(session);
            Player owner = session.game.getPlayers().get(0);
            session.game.setAge(GameStage.Play);
            session.game.setStartingPlayer(owner);
            session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 1);
            owner.setLife(20, null);
            Card heir = card(session.game, owner, "Saprazzan Heir", ZoneType.Battlefield);
            var draw = AbilityFactory.getAbility(heir.getSVar("TrigDraw"), heir);
            draw.setActivatingPlayer(owner);
            for (int i = 0; i < 4; i++) card(session.game, owner, "Island", ZoneType.Library);
            AtomicInteger decisions = new AtomicInteger();
            drive(session, owner, () -> {
                for (boolean pay : List.of(true, false)) {
                    Card land = card(session.game, owner, "Breeding Pool", ZoneType.Hand);
                    int life = owner.getLife();
                    Card entered = session.game.getAction().moveToPlay(land, null, AbilityKey.newMap());
                    require(entered.isInPlay() && entered.isTapped() == !pay && owner.getLife() == life - (pay ? 2 : 0),
                            "Shock land did not obey the chosen payment");
                }
                for (boolean accept : List.of(true, false)) {
                    int hand = owner.getCardsIn(ZoneType.Hand).size();
                    AbilityUtils.resolve(draw);
                    require(owner.getCardsIn(ZoneType.Hand).size() == hand + (accept ? 3 : 0),
                            "Optional draw did not obey the chosen response");
                }
            }, input -> {
                int index = decisions.getAndIncrement();
                require(input.get("type").getAsString().equals("chooseBoolean"), "Unexpected input: " + input);
                require(input.get("confirmLabel").getAsString().equals(index < 2 ? "Pay 2 life" : "Yes")
                        && input.get("denyLabel").getAsString().equals(index < 2 ? "Enters tapped" : "No"),
                        "Wrong binary labels: " + input);
                JsonObject response = NativeSession.object("type", "decision");
                response.addProperty("value", index % 2 == 0);
                return response;
            });
            require(decisions.get() == 4, "Expected both answers to each confirmation");
        }
        System.out.println("PASS native Breeding Pool payment and optional Saprazzan Heir draw");
    }
}
