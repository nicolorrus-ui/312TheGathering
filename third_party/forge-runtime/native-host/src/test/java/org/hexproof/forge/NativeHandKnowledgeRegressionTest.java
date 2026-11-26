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
import forge.game.card.CardCollection;
import forge.game.card.CardFactory;
import forge.game.combat.Combat;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Stable recipient snapshots after actual private looks and public and hidden zone changes. */
public final class NativeHandKnowledgeRegressionTest {
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
                    {"gameId":"hand-knowledge","seed":42,"variant":"constructed","startingLife":20,
                     "players":[{"name":"Viewer","deck":[{"name":"Island"}]},
                                {"name":"Owner","deck":[{"name":"Forest"}]},
                                {"name":"Other","deck":[{"name":"Mountain"}]}]}
                    """).getAsJsonObject();
            for (String effect : List.of("probe", "brainsurge", "thoughtseize", "guide-land", "guide-nonland", "scrying", "courser")) {
                try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
                    base.setTestSession(session);
                    Player viewer = session.game.getPlayers().get(0);
                    Player owner = session.game.getPlayers().get(1);
                    session.game.setAge(GameStage.Play);
                    session.game.setStartingPlayer(viewer);
                    session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, viewer, false, 2);
                    switch (effect) {
                        case "probe" -> effects(session, viewer, owner);
                        case "brainsurge" -> brainsurge(session, viewer, owner);
                        case "thoughtseize" -> thoughtseize(session, viewer, owner);
                        case "guide-land", "guide-nonland" -> goblinGuide(session, viewer, owner, effect.equals("guide-land"));
                        case "scrying" -> searchedLibraryCard(session, viewer, owner);
                        case "courser" -> continuousTop(session, viewer, owner);
                        default -> throw new AssertionError(effect);
                    }
                }
            }
        }
        System.out.println("PASS recipient-scoped hands, Brainstorm, Brainsurge resolution and countering, Thoughtseize, Goblin Guide and shuffle invalidation");
    }

    private static void effects(NativeSession session, Player viewer, Player owner) throws Exception {
        Card probe = card(session.game, viewer, "Gitaxian Probe", ZoneType.Stack);
        card(session.game, viewer, "Plains", ZoneType.Library);
        Card first = card(session.game, owner, "Forest", ZoneType.Hand);
        var otherPrinting = FModel.getMagicDb().getCommonCards().getCard("Forest", "M11");
        Card second = CardFactory.getCard(otherPrinting, owner, session.game);
        owner.getZone(ZoneType.Hand).add(second);
        require(!first.getPaperCard().getEdition().equals(second.getPaperCard().getEdition()),
                "Duplicate-name fixture must exercise different printings");
        Card island = card(session.game, owner, "Island", ZoneType.Hand);
        Card bears = card(session.game, owner, "Grizzly Bears", ZoneType.Battlefield);
        Card brainstorm = card(session.game, owner, "Brainstorm", ZoneType.Stack);
        List<Card> library = List.of("Forest", "Swamp", "Mountain", "Counterspell").stream()
                .map(name -> card(session.game, owner, name, ZoneType.Library)).toList();
        owner.getZone(ZoneType.Library).setCards(library);

        AtomicInteger reveals = new AtomicInteger();
        drive(session, viewer, () -> {
            checkpoint(session, viewer);
            for (int seat : List.of(-1, 0, 2)) expectHand(session, seat, 3);
            expectHand(session, 1, 3, first, second, island);

            resolve(probe, viewer, owner);
            checkpoint(session, viewer);
            expectHand(session, 0, 3, first, second, island);
            expectHand(session, -1, 3);
            expectHand(session, 2, 3);

            owner.drawCard();
            checkpoint(session, viewer);
            expectHand(session, 0, 4, first, second, island);
            expectHand(session, 1, 4, first, second, island, library.getFirst());
            expectHand(session, 2, 4);
            expectHand(session, -1, 4);

            // The discarded Forest is the previously unseen draw. Its two
            // indistinguishable, previously observed copies remain in hand.
            owner.discard(session.game.getCardState(library.getFirst()), null, false, AbilityKey.newMap());
            checkpoint(session, viewer);
            expectHand(session, 0, 3, island);
            expectHand(session, 1, 3, first, second, island);
            expectHand(session, 2, 3);
            expectHand(session, -1, 3);

            Card returned = session.game.getAction().moveToHand(bears, null);
            checkpoint(session, viewer);
            expectHand(session, 0, 4, island, returned);
            expectHand(session, 2, 4, returned);
            expectHand(session, -1, 4, returned);

            resolve(brainstorm, owner, null);
            checkpoint(session, viewer);
            // Both cards actually returned were new draws. The physical cards
            // previously known are still in hand, but observers cannot tell.
            var returnedIds = owner.getCardsIn(ZoneType.Library).stream().map(Card::getId).toList();
            require(returnedIds.size() == 2 && returnedIds.containsAll(List.of(library.get(1).getId(), library.get(2).getId())),
                    "Brainstorm did not return the selected new draws");
            expectHand(session, 0, 5);
            expectHand(session, 2, 5);
            expectHand(session, -1, 5);
            expectHand(session, 1, 5, first, second, island, returned, library.get(3));

            // A new authorized look can establish fresh knowledge after invalidation.
            session.game.getAction().revealTo(owner.getCardsIn(ZoneType.Hand), viewer);
            checkpoint(session, viewer);
            expectHand(session, 0, 5, first, second, island, returned, library.get(3));
            expectHand(session, 2, 5);
            expectHand(session, -1, 5);

            // Every player now knows the same cards, through separate private looks.
            // A public spectator still received neither look.
            session.game.getAction().revealTo(owner.getCardsIn(ZoneType.Hand), session.game.getPlayers().get(2));
            checkpoint(session, viewer);
            expectHand(session, 2, 5, first, second, island, returned, library.get(3));
            expectHand(session, -1, 5);
        }, input -> {
            String type = input.get("type").getAsString();
            if (type.equals("checkpoint")) return new JsonObject();
            if (type.equals("revealCards")) {
                String receiver = reveals.getAndIncrement() < 2 ? "player-0" : "player-2";
                require(JsonParser.parseString(session.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString().equals(receiver),
                        "Private hand look was routed to a different player");
                return NativeSession.object("type", "revealCardsAcknowledged");
            }
            return putBack(input, library.get(1), library.get(2));
        });
        require(reveals.get() == 3, "Missing a native private hand look");
    }

    private static void brainsurge(NativeSession session, Player viewer, Player owner) throws Exception {
        Card publicCard = card(session.game, owner, "Island", ZoneType.Hand);
        Card privateCard = card(session.game, owner, "Lightning Bolt", ZoneType.Hand);
        List<Card> library = List.of("Forest", "Swamp", "Plains", "Mountain", "Grizzly Bears", "Counterspell")
                .stream().map(name -> card(session.game, owner, name, ZoneType.Library)).toList();
        owner.getZone(ZoneType.Library).setCards(library);
        AtomicInteger choices = new AtomicInteger();
        drive(session, owner, () -> {
            var game = session.game;
            game.getAction().reveal(new CardCollection(publicCard), owner);
            game.getAction().revealTo(new CardCollection(privateCard), viewer);
            owner.drawCard();

            // Merely putting Brainsurge on the stack, and later countering it,
            // makes no hidden choice about cards already in hand.
            SpellAbility first = card(game, owner, "Brainsurge", ZoneType.Stack).getFirstSpellAbility();
            first.setActivatingPlayer(owner);
            game.getStack().add(first);
            checkpoint(session, owner);
            expectHand(session, 0, 3, publicCard, privateCard);
            for (int seat : List.of(2, -1)) expectHand(session, seat, 3, publicCard);

            SpellAbility counter = card(game, viewer, "Counterspell", ZoneType.Stack).getFirstSpellAbility();
            counter.setActivatingPlayer(viewer);
            require(counter.canTargetSpellAbility(first), "Counterspell cannot target the stacked Brainsurge");
            counter.getTargets().add(first);
            game.getStack().add(counter);
            game.getStack().resolveStack();
            require(game.getStack().isEmpty() && owner.getCardsIn(ZoneType.Graveyard).stream()
                    .anyMatch(c -> c.getId() == first.getHostCard().getId()), "Counterspell did not counter Brainsurge");
            checkpoint(session, owner);
            expectHand(session, 0, 3, publicCard, privateCard);
            for (int seat : List.of(2, -1)) expectHand(session, seat, 3, publicCard);

            SpellAbility second = card(game, owner, "Brainsurge", ZoneType.Stack).getFirstSpellAbility();
            second.setActivatingPlayer(owner);
            game.getStack().add(second);
            game.getStack().resolveStack();
            checkpoint(session, owner);
            var top = owner.getTopXCardsFromLibrary(2).stream().map(Card::getId).toList();
            require(top.containsAll(List.of(library.get(1).getId(), library.get(2).getId())),
                    "Brainsurge did not return both selected, previously unseen draws");
            expectHand(session, 1, 5, publicCard, privateCard, library.get(0), library.get(3), library.get(4));
            for (int seat : List.of(0, 2, -1)) {
                expectHand(session, seat, 5);
                expectZone(session, seat, "library", 3);
            }
        }, input -> {
            String type = input.get("type").getAsString();
            if (type.equals("chooseCards")) {
                choices.incrementAndGet();
                expectHand(session, 1, 7, publicCard, privateCard, library.get(0), library.get(1),
                        library.get(2), library.get(3), library.get(4));
                expectHand(session, 0, 7, publicCard, privateCard);
                for (int seat : List.of(2, -1)) expectHand(session, seat, 7, publicCard);
            }
            if (type.equals("chooseCards") || type.equals("reorder")) return putBack(input, library.get(1), library.get(2));
            return acknowledge(input);
        });
        require(choices.get() == 1, "Only the resolving Brainsurge should ask which cards to return");
    }

    private static JsonObject putBack(JsonObject input, Card first, Card second) {
        JsonArray ids = new JsonArray();
        if (input.get("type").getAsString().equals("chooseCards")) {
            ids.add(NativeSession.cardId(first));
            ids.add(NativeSession.cardId(second));
            JsonObject answer = NativeSession.object("type", "chooseCardsDecision");
            answer.add("chosenCardIds", ids);
            return answer;
        }
        require(input.get("type").getAsString().equals("reorder"), "Unexpected library placement prompt: " + input);
        for (JsonElement item : input.getAsJsonArray("items")) ids.add(item.getAsJsonObject().get("id"));
        JsonObject answer = NativeSession.object("type", "reorderDecision");
        answer.add("orderedIds", ids);
        return answer;
    }

    private static void thoughtseize(NativeSession session, Player viewer, Player owner) throws Exception {
        Card thoughtseize = card(session.game, viewer, "Thoughtseize", ZoneType.Stack);
        Card first = card(session.game, owner, "Lightning Bolt", ZoneType.Hand);
        Card second = card(session.game, owner, "Lightning Bolt", ZoneType.Hand);
        Card forest = card(session.game, owner, "Forest", ZoneType.Hand);
        drive(session, viewer, () -> {
            checkpoint(session, viewer);
            for (int seat : List.of(0, 2, -1)) expectHand(session, seat, 3);
            resolve(thoughtseize, viewer, owner);
            require(owner.getCardsIn(ZoneType.Graveyard).stream().anyMatch(c -> c.getId() == first.getId()),
                    "Thoughtseize failed to discard the selected copy");
            checkpoint(session, viewer);
            // Thoughtseize explicitly reveals the hand. Unlike Probe, both
            // another player and a public observer witnessed this reveal.
            for (int seat : List.of(0, 2, -1)) expectHand(session, seat, 2, forest);
            expectHand(session, 1, 2, second, forest);
        }, input -> {
            String type = input.get("type").getAsString();
            if (type.equals("checkpoint")) return new JsonObject();
            if (type.equals("revealCards")) return NativeSession.object("type", "revealCardsAcknowledged");
            require(type.equals("chooseCards"), "Unexpected Thoughtseize prompt: " + input);
            JsonObject result = NativeSession.object("type", "chooseCardsDecision");
            JsonArray ids = new JsonArray();
            ids.add(NativeSession.cardId(first));
            result.add("chosenCardIds", ids);
            return result;
        });
    }

    private static void goblinGuide(NativeSession session, Player attacker, Player defender, boolean land) throws Exception {
        Card guide = card(session.game, attacker, "Goblin Guide", ZoneType.Battlefield);
        Card top = card(session.game, defender, land ? "Forest" : "Lightning Bolt", ZoneType.Library);
        if (land) {
            Card underneath = card(session.game, defender, "Counterspell", ZoneType.Library);
            defender.getZone(ZoneType.Library).setCards(List.of(top, underneath));
        }
        SpellAbility dig = AbilityFactory.getAbility(guide.getSVar("TrigDig"), guide);
        dig.setActivatingPlayer(attacker);
        dig.setTriggeringObject(AbilityKey.DefendingPlayer, defender);
        var all = List.of(-1, 0, 1, 2);
        drive(session, attacker, () -> {
            checkpoint(session, attacker);
            for (int seat : all) expectZone(session, seat, "library", land ? 2 : 1);
            AbilityUtils.resolve(dig);
            checkpoint(session, attacker);
            if (land) {
                for (int seat : all) {
                    expectHand(session, seat, 1, top);
                    expectZone(session, seat, "library", 1);
                }
            } else {
                for (int seat : all) {
                    expectZone(session, seat, "library", 1, top);
                    expectHand(session, seat, 0);
                }
                // A one-card library forces the physical top to be identical
                // after shuffling. Invalidation must respond to the shuffle itself.
                defender.shuffle(dig);
                checkpoint(session, attacker);
                require(defender.getCardsIn(ZoneType.Library).getFirst().getId() == top.getId(),
                        "Shuffle fixture failed to retain the same physical top");
                for (int seat : all) expectZone(session, seat, "library", 1);

                // The Guide reveals the top again. Condemn puts another card
                // explicitly on the bottom, so it cannot hide this top.
                AbilityUtils.resolve(dig);
                Card creature = card(session.game, defender, "Grizzly Bears", ZoneType.Battlefield);
                Card condemn = card(session.game, attacker, "Condemn", ZoneType.Stack);
                Combat combat = new Combat(defender);
                session.game.getPhaseHandler().setCombat(combat);
                combat.addAttacker(creature, attacker);
                SpellAbility removal = condemn.getSpellAbilities().get(0);
                removal.setActivatingPlayer(attacker);
                require(removal.canTarget(creature), "Condemn fixture needs a legal attacking creature");
                removal.getTargets().add(creature);
                AbilityUtils.resolve(removal);
                require(defender.getCardsIn(ZoneType.Library).getLast().getId() == creature.getId(),
                        "Condemn failed to put the attacking creature on the bottom");
                checkpoint(session, attacker);
                for (int seat : all) expectZone(session, seat, "library", 2, top);
            }
        }, input -> {
            if (input.get("type").getAsString().equals("revealCards")) {
                // The Guide explicitly reveals the top card to everyone,
                // including while the first acknowledgment is pending.
                for (int seat : all) expectZone(session, seat, "library", land ? 2 : 1, top);
            }
            return acknowledge(input);
        });
    }

    private static void searchedLibraryCard(NativeSession session, Player viewer, Player owner) throws Exception {
        Card top = card(session.game, owner, "Forest", ZoneType.Library);
        Card other = card(session.game, owner, "Swamp", ZoneType.Library);
        owner.getZone(ZoneType.Library).setCards(List.of(top, other));
        Card tutor = card(session.game, owner, "Sylvan Scrying", ZoneType.Stack);
        AtomicInteger choices = new AtomicInteger();
        drive(session, viewer, () -> {
            // Showing the face of an identified card in a library says
            // nothing about its position, even when it happens to be on top.
            session.game.getAction().reveal(new CardCollection(top), owner);
            checkpoint(session, viewer);
            for (int seat : List.of(-1, 0, 1, 2)) expectZone(session, seat, "library", 2);
            resolve(tutor, owner, null);
            checkpoint(session, viewer);
            for (int seat : List.of(-1, 0, 1, 2)) {
                expectHand(session, seat, 1, top);
                expectZone(session, seat, "library", 1);
            }
        }, input -> {
            String type = input.get("type").getAsString();
            if ((type.equals("revealCards") && choices.get() == 0) || type.equals("chooseCards")) {
                // Check the actual open callback too. Forge temporarily enables
                // a card's face for this UI, without disclosing its position.
                for (int seat : List.of(-1, 0, 1, 2)) expectZone(session, seat, "library", 2);
            }
            if (type.equals("chooseCards")) {
                choices.incrementAndGet();
                JsonObject result = NativeSession.object("type", "chooseCardsDecision");
                JsonArray ids = new JsonArray();
                ids.add(NativeSession.cardId(top));
                result.add("chosenCardIds", ids);
                return result;
            }
            return acknowledge(input);
        });
        require(choices.get() == 1, "Sylvan Scrying did not search and select the actual top card");
    }

    private static void continuousTop(NativeSession session, Player viewer, Player owner) throws Exception {
        Card top = card(session.game, owner, "Island", ZoneType.Library);
        Card next = card(session.game, owner, "Forest", ZoneType.Library);
        owner.getZone(ZoneType.Library).setCards(List.of(top, next));
        Card courser = card(session.game, owner, "Courser of Kruphix", ZoneType.Battlefield);
        var seats = List.of(-1, 0, 1, 2);
        drive(session, viewer, () -> {
            session.game.getAction().checkStaticAbilities();
            checkpoint(session, viewer);
            for (int seat : seats) expectZone(session, seat, "library", 2, top);

            session.game.getAction().moveToGraveyard(courser, null);
            session.game.getAction().checkStaticAbilities();
            require(!NativePublicVisibility.isPubliclyShown(top), "Courser's static permission did not expire");
            checkpoint(session, viewer);
            for (int seat : seats) expectZone(session, seat, "library", 2, top);

            owner.drawCard();
            checkpoint(session, viewer);
            for (int seat : seats) {
                expectHand(session, seat, 1, top);
                expectZone(session, seat, "library", 1);
            }
        }, NativeHandKnowledgeRegressionTest::acknowledge);
    }

    private static JsonObject acknowledge(JsonObject input) {
        if (input.get("type").getAsString().equals("checkpoint")) return new JsonObject();
        require(input.get("type").getAsString().equals("revealCards"), "Unexpected reveal decision: " + input);
        return NativeSession.object("type", "revealCardsAcknowledged");
    }

    private static void resolve(Card source, Player caster, Player target) {
        SpellAbility spell = source.getSpellAbilities().get(0);
        spell.setActivatingPlayer(caster);
        if (target != null) spell.getTargets().add(target);
        AbilityUtils.resolve(spell);
    }

    private static void checkpoint(NativeSession session, Player viewer) {
        session.ask(viewer, NativeSession.object("type", "checkpoint"), ignored -> true);
    }

    private static void expectHand(NativeSession session, int receiver, int count, Card... visible) {
        expectZone(session, receiver, "hand", count, visible);
    }

    private static void expectZone(NativeSession session, int receiver, String zone, int count, Card... visible) {
        JsonArray viewers = new JsonArray();
        viewers.add(receiver);
        JsonObject snapshot = JsonParser.parseString(session.snapshot(receiver)).getAsJsonObject();
        require(JsonParser.parseString(session.snapshots(viewers)).getAsJsonArray().get(0).equals(snapshot),
                "Fresh bulk snapshot lost the reconnecting receiver's view");
        JsonObject state = snapshot.getAsJsonArray("zones").asList().stream()
                .map(JsonElement::getAsJsonObject)
                .filter(z -> z.get("zone").getAsString().equals(zone) && z.get("ownerId").getAsString().equals("player-1"))
                .findFirst().orElseThrow();
        require(state.get("count").getAsInt() == count, zone + " count changed for receiver " + receiver);
        Map<String, JsonObject> expected = new HashMap<>();
        for (Card card : visible) expected.put(NativeSession.cardId(card), NativeSnapshot.identity(card));
        JsonArray cards = state.getAsJsonArray("cards");
        require(cards.size() == expected.size(), zone + " knowledge for receiver " + receiver + " expected " + expected + ", got " + cards);
        for (JsonElement item : cards) {
            JsonObject card = item.getAsJsonObject();
            require(card.getAsJsonObject("identity").equals(expected.remove(card.get("id").getAsString())),
                    "Unexpected identity, object ID or printing for receiver " + receiver + ": " + card);
        }
        require(expected.isEmpty(), "Snapshot omitted a known card in " + zone);
    }
}
