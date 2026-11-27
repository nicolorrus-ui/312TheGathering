// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameStage;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Combined private looks and legal choices on real effects and constructed boards. */
public final class NativeDelayedRevealRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            for (String scenario : List.of("company", "single", "narset", "other-recipient", "fetch", "limited-fetch", "public-top-fetch", "continued-fetch", "multi-search", "discard", "no-discard", "no-choice", "public-visibility",
                    "seer-empty", "seer-lands", "seer-one", "seer-many", "bat", "prevented", "arbiter", "dreams")) {
                JsonObject config = JsonParser.parseString("{\"gameId\":\"delayed-reveal-test\",\"seed\":42,\"variant\":\"constructed\",\"startingLife\":20,\"players\":[{\"name\":\"Reveal A\",\"deck\":[{\"name\":\"Forest\"}]},{\"name\":\"Reveal B\",\"deck\":[{\"name\":\"Forest\"}]}]}").getAsJsonObject();
                if (scenario.startsWith("seer-") || scenario.equals("bat") || scenario.equals("prevented") || scenario.equals("arbiter"))
                    config.getAsJsonArray("players").add(JsonParser.parseString("{\"name\":\"Reveal C\",\"deck\":[{\"name\":\"Island\"}]}"));
                try (NativeSession session = new NativeSession(config, base); var scope = session.context.enter()) {
                    base.setTestSession(session);
                    session.game.setAge(GameStage.Play);
                    Player owner = session.game.getPlayers().get(0);
                    session.game.setStartingPlayer(owner);
                    session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 1);
                    switch (scenario) {
                        case "company", "single" -> run(session, owner, scenario.equals("single"));
                        case "narset", "other-recipient" -> narset(session, owner, scenario.equals("other-recipient"));
                        case "fetch", "limited-fetch", "public-top-fetch", "continued-fetch", "multi-search" -> fetch(session, owner, scenario);
                        case "discard", "no-discard" -> discard(session, owner, scenario.equals("no-discard"));
                        case "no-choice" -> noChoice(session, owner);
                        case "seer-empty", "seer-lands", "seer-one", "seer-many", "bat", "prevented" -> handExile(session, owner, scenario);
                        case "dreams" -> dreams(session, owner);
                        case "arbiter" -> arbiter(session, owner);
                        case "public-visibility" -> publicVisibility(session, owner);
                        default -> throw new AssertionError(scenario);
                    }
                }
            }
        }
        System.out.println("PASS native combined choices: Company, Narset, fetch, Thoughtseize, Thought-Knot Seer, Deep-Cavern Bat and audience boundaries");
    }

    private static void handExile(NativeSession session, Player chooser, String scenario) throws Exception {
        Player target = session.game.getPlayers().get(1);
        boolean privateLook = scenario.equals("bat");
        boolean prevented = scenario.equals("prevented");
        int eligibleCount = switch (scenario) {
            case "seer-empty", "seer-lands" -> 0;
            case "seer-many" -> 2;
            default -> 1;
        };
        Card source = card(session.game, chooser, privateLook || prevented ? "Deep-Cavern Bat" : "Thought-Knot Seer", ZoneType.Battlefield);
        Card land = scenario.equals("seer-empty") ? null : card(session.game, target, "Mountain", ZoneType.Hand);
        Card bolt = eligibleCount == 0 ? null : card(session.game, target, "Lightning Bolt", ZoneType.Hand);
        if (eligibleCount > 1) card(session.game, target, "Ponder", ZoneType.Hand);
        Card secret = card(session.game, target, "Primeval Titan", ZoneType.Library);
        Set<String> shown = new HashSet<>(), legal = new HashSet<>();
        for (Card card : target.getCardsIn(ZoneType.Hand)) {
            shown.add(card.getName());
            if (!card.isLand()) legal.add(card.getName());
        }

        SpellAbility ability = source.getTriggers().stream()
                .filter(trigger -> "Battlefield".equals(trigger.getParam("Destination")))
                .findFirst().orElseThrow().ensureAbility();
        ability.setActivatingPlayer(chooser);
        ability.getTargets().add(target);
        if (prevented) session.game.getAction().moveTo(ZoneType.Graveyard, source, null, null);
        List<String> chooserInputs = new ArrayList<>(), thirdSeatInputs = new ArrayList<>();
        drive(session, chooser, () -> {
            AbilityUtils.resolve(ability);
            require(target.getCardsIn(ZoneType.Exile).size() == (eligibleCount > 0 && !privateLook && !prevented ? 1 : 0),
                    "Unexpected exile result for " + scenario);
        }, input -> {
            String kind = input.get("type").getAsString();
            String seat = JsonParser.parseString(session.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString();
            require(!input.toString().contains(secret.getName()), "Exile choice disclosed the target's library");
            if (seat.equals("player-2")) {
                Set<String> disclosed = thirdSeatInputs.isEmpty() ? shown : Set.of(bolt.getName());
                require(!privateLook && !prevented && kind.equals("revealCards") && new HashSet<>(shownNames(input)).equals(disclosed),
                        "Another player received a private or incorrect disclosure");
                thirdSeatInputs.add(kind);
                return NativeSession.object("type", "revealCardsAcknowledged");
            }
            require(seat.equals("player-0"), "Hand choice assigned to the wrong player");
            chooserInputs.add(kind);
            if (kind.equals("revealCards")) {
                require(new HashSet<>(shownNames(input)).equals(shown), "No-choice reveal lost cards " + scenario + " " + input + " expected " + shown);
                return NativeSession.object("type", "revealCardsAcknowledged");
            }
            require(kind.equals("chooseCards") && eligibleCount > 0 && !prevented, "Unexpected hand choice " + scenario + ": " + input);
            checkCards(input, shown, legal);
            require(input.get("min").getAsInt() == (privateLook ? 0 : 1) && input.get("max").getAsInt() == 1,
                    "Mandatory/optional exile bounds changed: " + input);
            if (land != null) {
                String publicHand = "\"name\":\"" + land.getName() + "\"";
                for (int viewer : List.of(-1, 2)) require(session.snapshot(viewer).contains(publicHand) != privateLook,
                        "Revealed hand crossed its audience boundary: " + scenario);
                rejectCard(session, land);
            }
            if (!privateLook) rejectCard(session, null);
            return choose(privateLook ? null : bolt);
        });
        List<String> expected = shown.isEmpty() ? List.of() : eligibleCount == 0 || prevented
                ? List.of("revealCards") : List.of("chooseCards");
        require(chooserInputs.equals(expected), scenario + " had redundant or missing windows: " + chooserInputs);
        if (shown.isEmpty()) require(session.snapshot(0).contains("viewerNotices") && !session.snapshot(-1).contains("viewerNotices"),
                "Empty hand announcement missing or leaked into the spectator view");
        require(thirdSeatInputs.size() == (!shown.isEmpty() && !privateLook && !prevented ? (eligibleCount > 0 ? 2 : 1) : 0),
                "Bystander lost or gained a reveal in " + scenario);
    }

    private static void dreams(NativeSession session, Player caster) throws Exception {
        Player target = session.game.getPlayers().get(1);
        Card first = card(session.game, target, "Grizzly Bears", ZoneType.Hand);
        card(session.game, target, "Llanowar Elves", ZoneType.Hand);
        card(session.game, target, "Forest", ZoneType.Hand);
        Card second = card(session.game, target, "Birds of Paradise", ZoneType.Graveyard);
        card(session.game, target, "Raging Goblin", ZoneType.Graveyard);
        Card privateTop = card(session.game, target, "Divination", ZoneType.Library);
        Card source = card(session.game, caster, "Dreams of Steel and Oil", ZoneType.Stack);
        SpellAbility ability = source.getSpellAbilities().getFirst();
        ability.setActivatingPlayer(caster);
        ability.getTargets().add(target);
        List<String> kinds = new ArrayList<>();
        drive(session, caster, () -> {
            session.game.getStack().add(ability);
            session.game.getStack().resolveStack();
            require(target.getCardsIn(ZoneType.Exile).stream().map(Card::getName).collect(java.util.stream.Collectors.toSet())
                    .equals(Set.of(first.getName(), second.getName())), "Dreams exiled the wrong cards");
        }, input -> {
            String kind = input.get("type").getAsString();
            kinds.add(kind);
            require(!input.toString().contains(privateTop.getName()), "Dreams revealed the library");
            if (kind.equals("revealCards")) return NativeSession.object("type", "revealCardsAcknowledged");
            require(kind.equals("chooseCards"), "Unexpected Dreams decision " + kind);
            if (shownNames(input).contains(first.getName())) {
                checkCards(input, Set.of("Grizzly Bears", "Llanowar Elves", "Forest"), Set.of("Grizzly Bears", "Llanowar Elves"));
                return choose(first);
            }
            checkCards(input, Set.of("Birds of Paradise", "Raging Goblin"), Set.of("Birds of Paradise", "Raging Goblin"));
            return choose(second);
        });
        require(kinds.equals(List.of("chooseCards", "chooseCards")), "Dreams added a reveal to its hand and graveyard choices: " + kinds);
    }

    private static void arbiter(NativeSession session, Player chooser) throws Exception {
        Player second = session.game.getPlayers().get(1), third = session.game.getPlayers().get(2);
        card(session.game, second, "Island", ZoneType.Hand);
        card(session.game, second, "Lightning Bolt", ZoneType.Hand);
        card(session.game, third, "Forest", ZoneType.Hand);
        card(session.game, third, "Ponder", ZoneType.Hand);
        Card hidden = card(session.game, third, "Primeval Titan", ZoneType.Library);
        Card arbiter = card(session.game, chooser, "Alhammarret, High Arbiter", ZoneType.Battlefield);
        SpellAbility ability = forge.game.ability.AbilityFactory.getAbility(arbiter.getSVar("RevealHand"), arbiter);
        ability.setActivatingPlayer(chooser);
        List<String> seats = new ArrayList<>();
        drive(session, chooser, () -> {
            AbilityUtils.resolve(ability);
            require(arbiter.getNamedCards().contains("Ponder"), "Arbiter did not use the selected name");
        }, input -> {
            String seat = JsonParser.parseString(session.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString();
            seats.add(seat);
            String kind = input.get("type").getAsString();
            require(!input.toString().contains(hidden.getName()), "Arbiter leaked an unshown library card");
            if (seat.equals("player-0")) {
                require(kind.equals("chooseFromSelection") && input.get("searchKind").getAsString().equals("name"),
                        "Arbiter chooser lost the searchable combined choice: " + input);
                Set<String> shown = new HashSet<>(), legal = new HashSet<>();
                require(input.getAsJsonObject("presentation").has("shownCards"), "Missing name picker disclosure: " + input);
                for (JsonElement e : input.getAsJsonObject("presentation").getAsJsonArray("shownCards"))
                    shown.add(e.getAsJsonObject().getAsJsonObject("identity").get("name").getAsString());
                JsonArray options = input.getAsJsonArray("options"), chosen = new JsonArray();
                for (int i = 0; i < options.size(); i++) {
                    String label = options.get(i).getAsJsonObject().get("label").getAsString();
                    legal.add(label);
                    if (label.equals("Ponder")) chosen.add(i);
                }
                require(shown.equals(Set.of("Island", "Forest", "Ponder", "Lightning Bolt"))
                        && legal.equals(Set.of("Ponder", "Lightning Bolt")), "Arbiter disclosed or permitted the wrong names");
                JsonObject response = NativeSession.object("type", "selectionDecision");
                response.add("chosenIndices", chosen);
                return response;
            }
            Set<String> expected = seat.equals("player-2") ? Set.of("Island", "Lightning Bolt") : Set.of("Forest", "Ponder");
            require(kind.equals("revealCards") && new HashSet<>(shownNames(input)).equals(expected),
                    "Arbiter's other viewers lost a public reveal: " + input);
            return NativeSession.object("type", "revealCardsAcknowledged");
        });
        require(seats.size() == 3 && new HashSet<>(seats).size() == 3, "Arbiter duplicated a reveal for its chooser: " + seats);
    }

    private static void publicVisibility(NativeSession session, Player owner) {
        Player opponent = session.game.getPlayers().get(1);
        Card top = card(session.game, owner, "Island", ZoneType.Library);
        Card second = card(session.game, owner, "Forest", ZoneType.Library);
        Card hand = card(session.game, owner, "Lightning Bolt", ZoneType.Hand);
        owner.getZone(ZoneType.Library).setCards(List.of(top, second));
        card(session.game, owner, "Realmwalker", ZoneType.Battlefield);
        session.game.getAction().checkStaticAbilities();
        top.addMayLookTemp(opponent);
        require(top.getView().mayPlayerLook(owner.getView()) && top.getView().mayPlayerLook(opponent.getView()),
                "Fixture must grant each player an independent look at the same top card");
        require(!NativePublicVisibility.isPubliclyShown(top), "Separate private looks granted spectator access");
        top.removeMayLookTemp(opponent);
        card(session.game, owner, "Courser of Kruphix", ZoneType.Battlefield);
        card(session.game, opponent, "Telepathy", ZoneType.Battlefield);
        session.game.getAction().checkStaticAbilities();
        require(NativePublicVisibility.isPubliclyShown(top) && NativePublicVisibility.isPubliclyShown(hand),
                "Public library top or publicly revealed hand was hidden");
        require(!NativePublicVisibility.isPubliclyShown(second), "A lower library card became public");
        session.game.setTopLibsCast();
        owner.getZone(ZoneType.Library).setCards(List.of(second, top));
        session.game.getAction().checkStaticAbilities();
        require(!NativePublicVisibility.isPubliclyShown(second), "Casting exposed the new top before Forge's reveal");
    }

    private static void run(NativeSession session, Player owner, boolean single) throws Exception {
        Card bears = card(session.game, owner, "Grizzly Bears", ZoneType.Library);
        Card elves = card(session.game, owner, "Llanowar Elves", ZoneType.Library);
        Card bolt = card(session.game, owner, "Lightning Bolt", ZoneType.Library);
        Card forest = card(session.game, owner, "Forest", ZoneType.Library);
        Card dreadmaw = card(session.game, owner, "Colossal Dreadmaw", ZoneType.Library);
        Card mountain = card(session.game, owner, "Mountain", ZoneType.Library);
        Card unlooked = card(session.game, owner, "Primeval Titan", ZoneType.Library);
        Card privateHand = card(session.game, owner, "Solitude", ZoneType.Hand);
        Card opposingHand = card(session.game, session.game.getPlayers().get(1), "Thoughtseize", ZoneType.Hand);
        Card company = card(session.game, owner, "Collected Company", ZoneType.Hand);
        List<Card> topSix = List.of(bolt, bears, forest, elves, dreadmaw, mountain);
        List<Card> arranged = new ArrayList<>(topSix);
        arranged.add(unlooked);
        owner.getZone(ZoneType.Library).setCards(arranged);
        Set<String> lookedNames = new HashSet<>();
        for (Card c : topSix) lookedNames.add(c.getName());
        SpellAbility ability = company.getSpellAbilities().get(0);
        ability.setActivatingPlayer(owner);
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            if (single) {
                Card chosen = owner.getController().chooseSingleEntityForEffect(
                        new CardCollection(List.of(bears, elves)),
                        new DelayedReveal(topSix, ZoneType.Library, owner.getView()),
                        ability, "Choose one of the eligible creatures", false, owner, null);
                require(chosen == bears, "Native single-choice callback changed the explicit selection");
            } else {
                // Choose zero creatures, a legal CoCo decision, so the policy can
                // focus on the owner's private look without another seat's reveal.
                AbilityUtils.resolve(ability);
                require(owner.getCardsIn(ZoneType.Battlefield).isEmpty(), "CoCo ignored the explicit empty selection");
                List<Card> library = new ArrayList<>(owner.getCardsIn(ZoneType.Library));
                require(library.size() == 7 && library.get(0) == unlooked,
                        "CoCo did not put the six inspected cards beneath the unlooked seventh card");
            }
        }, input -> {
            String type = input.get("type").getAsString();
            String raw = input.toString();
            for (Card secret : List.of(unlooked, privateHand, opposingHand)) {
                require(!raw.contains(secret.getName()), "Delayed reveal included an unrelated private identity");
                require(!raw.contains("\"" + NativeSession.cardId(secret) + "\""), "Delayed reveal included an unrelated private object ID");
            }
            for (int viewer : List.of(-1, 1)) {
                String snapshot = session.snapshot(viewer);
                for (Card looked : topSix) {
                    require(!snapshot.contains("\"name\":\"" + looked.getName() + "\""), "Private library look leaked into another viewer's snapshot");
                    require(!snapshot.contains("\"" + NativeSession.cardId(looked) + "\""), "Private library object ID leaked into another viewer's snapshot");
                }
            }
            JsonObject envelope = JsonParser.parseString(session.prompt(0)).getAsJsonObject();
            require(envelope.get("decidingPlayerId").getAsString().equals("player-0"),
                    "Private delayed reveal assigned the wrong deciding player");
            int decision = decisions.getAndIncrement();
            if (decision == 0) {
                require(type.equals("chooseCards"), "Private look must be part of the choice without an acknowledgement");
                checkCards(input, lookedNames, Set.of("Grizzly Bears", "Llanowar Elves"));
                require(shownNames(input).equals(topSix.stream().map(Card::getName).toList()),
                        "Looking at top cards reordered a non-search choice");
                rejectCard(session, forest);
                JsonObject response = NativeSession.object("type", "chooseCardsDecision");
                JsonArray chosen = new JsonArray();
                if (single) chosen.add(NativeSession.cardId(bears));
                response.add("chosenCardIds", chosen);
                return response;
            }
            require(!single && decision == 1 && type.equals("reorder"), "Unexpected delayed-reveal callback");
            JsonObject response = NativeSession.object("type", "reorderDecision");
            JsonArray ordered = new JsonArray();
            for (JsonElement item : input.getAsJsonArray("items")) ordered.add(item.getAsJsonObject().get("id"));
            require(ordered.size() == 6, "CoCo omitted cards from the bottom-library ordering");
            response.add("orderedIds", ordered);
            return response;
        });
        require(decisions.get() == (single ? 1 : 2), "Missing native delayed-reveal decisions");
    }

    private static void narset(NativeSession session, Player owner, boolean otherRecipient) throws Exception {
        Card narset = card(session.game, owner, "Narset, Parter of Veils", ZoneType.Battlefield);
        List<Card> library = List.of("Island", "Ponder", "Grizzly Bears", "Lightning Bolt", "Primeval Titan").stream()
                .map(name -> card(session.game, owner, name, ZoneType.Library)).toList();
        owner.getZone(ZoneType.Library).setCards(library);
        SpellAbility ability = narset.getSpellAbilities().stream()
                .filter(sa -> sa.getApi() == forge.game.ability.ApiType.Dig).findFirst().orElseThrow();
        ability.setActivatingPlayer(owner);
        if (otherRecipient) {
            ability.putParam("ForceReveal", "Opponent");
            ability.putParam("NoLooking", "True");
        }
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            AbilityUtils.resolve(ability);
            require(owner.getCardsIn(ZoneType.Hand).getFirst().getId() == library.get(1).getId(), "Narset lost the chosen card");
            require(owner.getCardsIn(ZoneType.Library).getFirst() == library.get(4), "Narset changed the unlooked top");
        }, input -> {
            int stage = decisions.getAndIncrement() + (otherRecipient ? 0 : 1);
            String decider = JsonParser.parseString(session.prompt(0)).getAsJsonObject().get("decidingPlayerId").getAsString();
            require(!input.toString().contains("Primeval Titan"), "Narset disclosed a fifth card");
            if (stage == 1) {
                require(decider.equals("player-0") && input.get("type").getAsString().equals("chooseCards"), "Wrong Narset choice");
                Set<String> eligible = Set.of("Ponder", "Lightning Bolt");
                checkCards(input, otherRecipient ? eligible : Set.of("Island", "Ponder", "Grizzly Bears", "Lightning Bolt"), eligible);
                rejectCard(session, library.getFirst());
                return choose(library.get(1));
            }
            require(input.get("type").getAsString().equals("revealCards"), "Expected the separate Forge disclosure");
            require(decider.equals(stage == 0 && !otherRecipient ? "player-0" : "player-1"), "Reveal went to the wrong seat");
            require(shownNames(input).equals(stage == 0 ? library.subList(0, 4).stream().map(Card::getName).toList()
                    : List.of("Ponder")), "Narset's private look or public choice disclosed the wrong cards");
            return NativeSession.object("type", "revealCardsAcknowledged");
        });
        require(decisions.get() == (otherRecipient ? 3 : 2), "Unexpected Narset decisions");
    }

    private static void checkCards(JsonObject input, Set<String> expected, Set<String> eligible) {
        Set<String> names = new HashSet<>(), selectable = new HashSet<>();
        for (JsonElement element : input.getAsJsonArray("cards")) {
            JsonObject card = element.getAsJsonObject();
            String name = card.getAsJsonObject("identity").get("name").getAsString();
            names.add(name);
            if (!card.has("readOnly") || !card.get("readOnly").getAsBoolean()) selectable.add(name);
        }
        require(names.equals(expected), "Combined choice changed the authorized disclosure: " + names);
        require(selectable.equals(eligible), "Combined choice changed legal candidates: " + selectable);
    }

    private static JsonObject choose(Card card) {
        JsonObject output = NativeSession.object("type", "chooseCardsDecision");
        JsonArray cards = new JsonArray();
        if (card != null) cards.add(NativeSession.cardId(card));
        output.add("chosenCardIds", cards);
        return output;
    }

    private static void rejectCard(NativeSession session, Card card) {
        String original = session.prompt(0);
        JsonObject response = NativeSession.object("type", "chooseCards");
        response.add("output", choose(card));
        boolean rejected = false;
        try { session.submit(response); } catch (IllegalArgumentException expected) { rejected = true; }
        require(rejected && original.equals(session.prompt(0)), "Read-only card submission consumed the choice");
    }

    private static List<String> shownNames(JsonObject input) {
        return input.getAsJsonArray("cards").asList().stream().map(item ->
                item.getAsJsonObject().getAsJsonObject("identity").get("name").getAsString()).toList();
    }

    private static void fetch(NativeSession session, Player owner, String scenario) throws Exception {
        boolean limited = scenario.equals("limited-fetch"), multiple = scenario.equals("multi-search");
        boolean knownTop = scenario.equals("public-top-fetch"), continued = scenario.equals("continued-fetch");
        Player opponent = session.game.getPlayers().get(1);
        Card swamp = card(session.game, owner, "Swamp", ZoneType.Library);
        Card island = card(session.game, owner, "Island", ZoneType.Library);
        Card bolt = card(session.game, owner, "Lightning Bolt", ZoneType.Library);
        Card bears = card(session.game, owner, "Grizzly Bears", ZoneType.Library);
        List<Card> arranged = new ArrayList<>(continued ? List.of(island, bolt, swamp, bears) : List.of(bolt, swamp, bears, island));
        if (knownTop) card(session.game, owner, "Oracle of Mul Daya", ZoneType.Battlefield);
        if (limited) {
            card(session.game, opponent, "Aven Mindcensor", ZoneType.Battlefield);
            arranged.add(card(session.game, owner, "Watery Grave", ZoneType.Library));
        }
        owner.getZone(ZoneType.Library).setCards(arranged);
        Card source = card(session.game, owner, multiple ? "Explosive Vegetation" : "Polluted Delta",
                multiple ? ZoneType.Hand : ZoneType.Battlefield);
        SpellAbility ability = source.getSpellAbilities().stream()
                .filter(sa -> sa.getApi() == forge.game.ability.ApiType.ChangeZone).findFirst().orElseThrow();
        ability.setActivatingPlayer(owner);
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            session.game.getAction().checkStaticAbilities();
            require(arranged.getFirst().getView().canBeShownTo(owner.getView()) == knownTop,
                    "Unexpected fixture permission before the search");
            if (continued) {
                // Later picks of a different-names search reuse its authorized candidates
                // without a new DelayedReveal. The top candidate is still not a known top.
                Card chosen = owner.getController().chooseSingleCardForZoneChange(ZoneType.Hand,
                        List.of(ZoneType.Library), ability, new CardCollection(List.of(island, swamp)),
                        null, "Choose the next land", true, owner);
                require(chosen == swamp, "Search continuation lost the selected object");
                return;
            }
            AbilityUtils.resolve(ability);
            require(owner.getCardsIn(ZoneType.Battlefield).stream().anyMatch(c -> c.getId() == swamp.getId()), "Search failed to move the selected land");
            require(bolt.isInZone(ZoneType.Library), "Search moved a nonselectable card");
        }, input -> {
            require(input.get("type").getAsString().equals("chooseCards"), "Search required a separate reveal");
            if (continued) {
                checkCards(input, Set.of("Swamp", "Island"), Set.of("Swamp", "Island"));
            } else {
                checkCards(input, Set.of("Swamp", "Island", "Lightning Bolt", "Grizzly Bears"), Set.of("Swamp", "Island"));
                require(shownNames(input).equals(List.of("Island", "Swamp", "Grizzly Bears", "Lightning Bolt")),
                        "Expected legal choices first in a stable display order independent of library order");
            }
            JsonObject snapshot = JsonParser.parseString(session.snapshot(0)).getAsJsonObject();
            JsonObject library = snapshot.getAsJsonArray("zones").asList().stream()
                    .map(JsonElement::getAsJsonObject).filter(z -> z.get("zone").getAsString().equals("library")
                            && z.get("ownerId").getAsString().equals("player-0")).findFirst().orElseThrow();
            JsonArray visible = library.getAsJsonArray("cards");
            if (knownTop) {
                require(visible.size() == 1 && visible.get(0).getAsJsonObject().get("id").getAsString().equals(NativeSession.cardId(bolt)),
                        "Independent Oracle of Mul Daya permission was removed during the search");
            } else require(visible.isEmpty(), "Temporary search look disclosed the physical library top");
            require(new ArrayList<>(owner.getCardsIn(ZoneType.Library)).equals(arranged),
                    "Presenting the search changed the physical library order");
            require(!input.toString().contains("Watery Grave"), "Restricted search disclosed an unsearched land");
            require(!session.snapshot(1).contains("Grizzly Bears") && !session.snapshot(-1).contains("Grizzly Bears"),
                    "Search look escaped the deciding seat");
            rejectCard(session, bolt);
            decisions.incrementAndGet();
            return choose(swamp);
        });
        require(decisions.get() == 1, "Search should need only one choice");
    }

    private static void discard(NativeSession session, Player owner, boolean noChoice) throws Exception {
        Player opponent = session.game.getPlayers().get(1);
        Card land = card(session.game, opponent, "Forest", ZoneType.Hand);
        Card chosen = noChoice ? null : card(session.game, opponent, "Grizzly Bears", ZoneType.Hand);
        Card hidden = card(session.game, opponent, "Primeval Titan", ZoneType.Library);
        Card source = card(session.game, owner, "Thoughtseize", ZoneType.Hand);
        SpellAbility ability = source.getSpellAbilities().get(0);
        ability.setActivatingPlayer(owner);
        ability.getTargets().add(opponent);
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            AbilityUtils.resolve(ability);
            require(land.isInZone(ZoneType.Hand), "Thoughtseize discarded a land");
            if (!noChoice) require(chosen.isInZone(ZoneType.Graveyard), "Thoughtseize ignored the selected nonland");
            require(owner.getLife() == 18, "Thoughtseize failed to finish resolving");
        }, input -> {
            int decision = decisions.getAndIncrement();
            require(!input.toString().contains(hidden.getName()), "Thoughtseize disclosed the library");
            if (decision == 0 && !noChoice) {
                require(input.get("type").getAsString().equals("chooseCards"), "Thoughtseize required a separate hand reveal");
                checkCards(input, Set.of("Forest", "Grizzly Bears"), Set.of("Grizzly Bears"));
                String publicView = session.snapshot(-1);
                require(publicView.contains("\"" + NativeSession.cardId(chosen) + "\"")
                                && publicView.contains("\"" + NativeSession.cardId(land) + "\""),
                        "Thoughtseize omitted the public hand reveal");
                for (Card privateCard : List.of(hidden, source))
                    require(!publicView.contains("\"" + NativeSession.cardId(privateCard) + "\""),
                            "Thoughtseize disclosed an unrelated private card");
                rejectCard(session, land);
                return choose(chosen);
            }
            require(input.get("type").getAsString().equals("revealCards"), "Standalone disclosure was lost");
            require(input.getAsJsonArray("cards").size() == 1, "Disclosure included extra cards");
            return NativeSession.object("type", "revealCardsAcknowledged");
        });
        require(decisions.get() == (noChoice ? 1 : 2), "Thoughtseize disclosure/choice count changed");
    }

    private static void noChoice(NativeSession session, Player owner) throws Exception {
        Card forest = card(session.game, owner, "Forest", ZoneType.Library);
        Card source = card(session.game, owner, "Collected Company", ZoneType.Hand);
        AtomicInteger decisions = new AtomicInteger();
        drive(session, owner, () -> {
            Card result = owner.getController().chooseSingleEntityForEffect(new CardCollection(),
                    new DelayedReveal(List.of(forest), ZoneType.Library, owner.getView()),
                    source.getSpellAbilities().get(0), "No eligible creatures", false, owner, null);
            require(result == null, "Empty candidates produced a card");
        }, input -> {
            require(input.get("type").getAsString().equals("revealCards"), "Empty choice lost its disclosure");
            require(input.getAsJsonArray("cards").size() == 1, "Empty choice omitted the visible card");
            decisions.incrementAndGet();
            return NativeSession.object("type", "revealCardsAcknowledged");
        });
        require(decisions.get() == 1, "Empty choice should retain one standalone disclosure");
    }
}
