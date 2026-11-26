// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.game.card.Card;
import forge.game.card.CardFaceView;
import forge.game.GameEntityView;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import forge.player.PlayerControllerHuman;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

public final class NativeChoiceCardRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("mixed-card-choices", 42), base);
                    var scope = session.context.enter()) {
                base.setTestSession(session);
                checkChoices(session);
            }
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("catalog-and-delayed-choices", 43), base);
                    var scope = session.context.enter()) {
                base.setTestSession(session);
                checkRevealedChoices(session);
            }
        }
        System.out.println("PASS native mixed choices, custom labels, insertion positions and ability ordering");
    }

    private static void checkChoices(NativeSession session) throws Exception {
        Player owner = session.game.getPlayers().get(0), opponent = session.game.getPlayers().get(1);
        var gui = ((PlayerControllerHuman) owner.getController()).getGui();
        Card forest = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card hidden = card(session.game, opponent, "Grizzly Bears", ZoneType.Hand);
        Card morph = card(session.game, opponent, "Willbender", ZoneType.Battlefield);
        morph.turnFaceDown();
        var ability = forest.getManaAbilities().getFirst().getView();
        var secretAbility = hidden.getSpellAbilities().getFirst().getView();
        var choices = List.of(forest.getView(), owner.getView(), hidden.getView(), morph.getView());
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(gui.one("Card or player", choices) == owner.getView(), "Mixed selection changed its index");
            var views = List.of(forest.getView(), hidden.getView(), morph.getView());
            var custom = gui.getChoices("Choose with context", 1, 1, views, List.of(),
                    view -> view == forest.getView() ? "Forest — Return to hand" : "Secret: " + view.getName());
            require(custom.equals(List.of(forest.getView())), "Display callback changed selected object");
            require(gui.one("Default display", List.of(forest.getView(), owner.getView()), Object::toString) == forest.getView(),
                    "Default display changed the selected card");

            var insertion = NativeOrdering.insertInList(session, owner, "Insert", "new", choices);
            require(insertion.get(1).equals("new") && insertion.get(0) == forest.getView(), "After changed its index");

            var ordered = NativeOrdering.order(session, owner, "Choose and order", 0, 1,
                    List.of(ability, secretAbility, owner.getView()), List.of());
            require(ordered.ordered().equals(List.of(secretAbility, ability)), "Mixed ordering changed its objects");
        }, input -> {
            int step = steps.getAndIncrement();
            var envelope = JsonParser.parseString(session.prompt(0)).getAsJsonObject();
            require(envelope.get("decidingPlayerId").getAsString().equals("player-0"), "Wrong deciding seat");
            require(!input.toString().contains("Grizzly Bears") && !input.toString().contains("Willbender")
                    && !input.toString().contains("Secret:"), "A hidden identity or display callback leaked: " + input);
            if (step == 5) {
                JsonArray items = input.getAsJsonArray("items");
                var first = items.get(0).getAsJsonObject();
                require(first.has("abilityText") && first.getAsJsonObject("card").getAsJsonObject("identity")
                        .get("name").getAsString().equals("Forest"), "Visible ability missing text or image");
                var other = items.get(1).getAsJsonObject();
                require(!other.has("abilityText") && other.get("oracle").getAsString().equals("Face-down card"),
                        "Hidden ability disclosed its effect");
                JsonObject answer = NativeSession.object("type", "reorderDecision");
                JsonArray ids = new JsonArray(); ids.add("order-1"); ids.add("order-0");
                answer.add("orderedIds", ids);
                return answer;
            }
            JsonArray options = input.getAsJsonArray("options");
            if (step == 0 || step == 1 || step == 2) {
                var first = options.get(0).getAsJsonObject();
                JsonObject identity = first.getAsJsonObject("card");
                require(identity.get("name").getAsString().equals("Forest") && identity.has("setCode")
                        && !identity.has("id"), "Missing or unsafe printing detail");
                require(first.has("actionLabel") == (step == 1), "Unexpected visible card label: " + first);
                if (step == 1) require(first.get("actionLabel").getAsString().equals("Return to hand"), "Lost callback semantics");
                if (step == 0 || step == 2) require(!options.get(1).getAsJsonObject().has("card"), "A player became a card");
                if (step == 0 || step == 1) checkBack(options.get(step == 0 ? 2 : 1).getAsJsonObject());
                return indices(step == 0 ? 1 : 0);
            }
            if (step == 3) {
                require(options.get(0).getAsJsonObject().get("label").getAsString().equals("First"), "Missing first position");
                require(options.get(1).getAsJsonObject().get("actionLabel").getAsString().equals("After"), "Missing After position");
                checkBack(options.get(3).getAsJsonObject());
                return indices(1);
            }
            require(step == 4 && options.get(0).getAsJsonObject().has("actionLabel"), "Visible ability lost its meaning");
            checkBack(options.get(1).getAsJsonObject());
            return indices(0, 1);
        });
        require(steps.get() == 6, "Expected six interactive native callbacks");
    }

    private static void checkRevealedChoices(NativeSession session) throws Exception {
        Player owner = session.game.getPlayers().get(0);
        var gui = ((PlayerControllerHuman) owner.getController()).getGui();
        var lost = new CardFaceView("Lost Mine of Phandelver", "Lost Mine of Phandelver");
        var mad = new CardFaceView("Dungeon of the Mad Mage", "Dungeon of the Mad Mage");
        Card seen = card(session.game, owner, "Brainstorm", ZoneType.Library);
        Card unseen = card(session.game, owner, "Counterspell", ZoneType.Library);
        var choices = List.<GameEntityView>of(seen.getView(), owner.getView(), unseen.getView());
        var reveal = new DelayedReveal(List.of(seen), ZoneType.Library, owner.getView());
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(gui.one("Venture", List.of(lost, mad)) == mad, "Dungeon selection did not return its Forge face");
            require(gui.chooseSingleEntityForEffect("Choose one", choices, reveal, false) == seen.getView(), "Lost revealed choice");
            require(gui.chooseEntitiesForEffect("Choose some", choices, 1, 1, reveal).equals(List.of(owner.getView())),
                    "Player disappeared from mixed choices");
            require(gui.chooseSingleEntityForEffect("New choice", choices, null, false) == owner.getView(),
                    "A later prompt lost its player choice");
        }, input -> {
            int step = steps.getAndIncrement();
            require(!input.toString().contains("Counterspell"), "A different library card leaked");
            if (step == 0) {
                var options = input.getAsJsonArray("options");
                require(options.size() == 2 && options.get(1).getAsJsonObject().getAsJsonObject("card").get("name")
                        .getAsString().equals(mad.getName()), "Dungeon has no catalog image");
                return indices(1);
            }
            if (step == 1 || step == 3) {
                require(input.get("type").getAsString().equals("revealCards") && input.getAsJsonArray("cards").size() == 1,
                        "Private reveal confirmation changed");
                return NativeSession.object("type", "revealCardsAcknowledged");
            }
            var options = input.getAsJsonArray("options");
            var formerlyShown = options.get(0).getAsJsonObject();
            if (step == 5) checkBack(formerlyShown);
            else require(formerlyShown.getAsJsonObject("card").get("name").getAsString().equals("Brainstorm"),
                    "This prompt lost its explicitly revealed image");
            checkBack(options.get(2).getAsJsonObject());
            return indices(step == 2 ? 0 : 1);
        });
        require(steps.get() == 6, "Missing catalog or delayed reveal callback");
    }

    private static void checkBack(JsonObject option) {
        JsonObject identity = option.getAsJsonObject("card");
        require(identity.size() == 1 && identity.get("name").getAsString().equals("Face-down card"),
                "A hidden choice included printing or object identifiers: " + option);
    }

    private static JsonObject indices(int... values) {
        JsonArray indices = new JsonArray();
        for (int value : values) indices.add(value);
        JsonObject answer = NativeSession.object("type", "selectionDecision");
        answer.add("chosenIndices", indices);
        return answer;
    }
}
