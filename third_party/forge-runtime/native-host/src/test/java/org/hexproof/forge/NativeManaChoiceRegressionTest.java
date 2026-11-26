// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.game.GameStage;
import forge.game.card.Card;
import forge.game.mana.Mana;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

public final class NativeManaChoiceRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            for (String scenario : List.of("dual", "pain", "payment", "filter", "pair", "mixed", "other", "reflected", "convoke", "cancel", "large", "changed", "nested", "cancel-cost")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("mana-menu-" + scenario, 42), base);
                        var scope = session.context.enter()) {
                    base.setTestSession(session);
                    Player owner = session.game.getPlayers().get(0);
                    session.game.setAge(GameStage.Play);
                    session.game.setStartingPlayer(owner);
                    owner.setLife(20, null);
                    session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 4);
                    session.game.getPhaseHandler().setPriority(owner);
                    switch (scenario) {
                        case "changed" -> changedPalette(session, owner);
                        case "nested", "cancel-cost" -> filterCosts(session, owner, scenario.equals("cancel-cost"));
                        default -> exercise(session, owner, scenario);
                    }
                    System.out.println("PASS native mana menu " + scenario);
                }
            }
        }
    }

    private static void exercise(NativeSession session, Player owner, String scenario) throws Exception {
        String name = switch (scenario) {
            case "dual" -> "Seachrome Coast";
            case "filter" -> "Fetid Heath";
            case "pair" -> "Skycloud Expanse";
            case "mixed" -> "Basalt Monolith";
            case "other" -> "Staff of Domination";
            case "reflected" -> "Reflecting Pool";
            case "convoke" -> "Birds of Paradise";
            case "large" -> "Astral Cornucopia";
            default -> "Shivan Reef";
        };
        Card land = card(session.game, owner, name, ZoneType.Battlefield);
        Card second = scenario.equals("pain") ? card(session.game, owner, name, ZoneType.Battlefield) : null;
        Card spell = scenario.equals("payment") ? card(session.game, owner, "Signal Pest", ZoneType.Hand) : null;
        if (scenario.equals("filter") || scenario.equals("pair")) {
            Card plains = card(session.game, owner, "Plains", ZoneType.Battlefield);
            owner.getManaPool().addMana(new Mana(MagicColor.WHITE, plains, plains.getManaAbilities().get(0).getManaPart(), owner));
        }
        if (scenario.equals("reflected")) {
            card(session.game, owner, "Island", ZoneType.Battlefield);
            card(session.game, owner, "Wastes", ZoneType.Battlefield);
        }
        AtomicInteger menus = new AtomicInteger();
        drive(session, owner, () -> {
            var human = owner.getController();
            if (scenario.equals("convoke")) {
                byte paid = human.chooseColorAllowColorless("Convoke for which color?", land, ColorSet.fromMask(MagicColor.GREEN));
                require(paid == MagicColor.GREEN, "Convoke did not use the native decision");
                return;
            }
            if (scenario.equals("large")) {
                var result = human.specifyManaCombo(land.getManaAbilities().getFirst(), ColorSet.WUBRG, 40, false);
                require(result.equals(Map.of(MagicColor.WHITE, 37, MagicColor.BLACK, 3)), "Wrong large allocation: " + result);
                return;
            }
            if (scenario.equals("mixed") || scenario.equals("other")) {
                var chosen = human.getAbilityToPlay(land, land.getAllPossibleAbilities(owner, false));
                if (scenario.equals("mixed")) require(chosen != null && !chosen.isManaAbility(), "Nonmana ability lost from mixed menu");
                else require(chosen == null, "Ordinary ability menu did not honor cancellation");
                return;
            }
            if (spell != null) {
                require(human.playChosenSpellAbility(spell.getFirstSpellAbility()) && spell.isInZone(ZoneType.Stack), "Payment failed");
            } else {
                var actions = human.chooseSpellAbilityToPlay();
                require(actions != null && actions.size() == 1 && human.playChosenSpellAbility(actions.getFirst()), "Activation failed");
            }
            require(land.isTapped(), "Source did not tap");
            switch (scenario) {
                case "reflected" -> require(owner.getManaPool().getAmountOfColor((byte) ManaAtom.COLORLESS) == 1, "Lost reflected colorless");
                case "dual" -> require(owner.getManaPool().getAmountOfColor(MagicColor.BLUE) == 1, "Lost selected blue");
                case "cancel" -> require(owner.getManaPool().getAmountOfColor((byte) ManaAtom.COLORLESS) == 1 && owner.getLife() == 20 &&
                        menus.get() == 2, "Cancelled choice failed to restore priority safely");
                case "pain" -> {
                    require(owner.getManaPool().getAmountOfColor(MagicColor.BLUE) == 1 && owner.getLife() == 19 && menus.get() == 1,
                            "A single blue choice should deal one damage and add U");
                    var again = human.chooseSpellAbilityToPlay();
                    require(again != null && human.playChosenSpellAbility(again.getFirst()) && second.isTapped(), "Second Reef failed");
                    require(owner.getManaPool().getAmountOfColor((byte) ManaAtom.COLORLESS) == 1 && owner.getLife() == 19 && menus.get() == 2,
                            "The next colorless activation must not repeat the paid-life output");
                }
                case "payment" -> require(owner.getManaPool().isEmpty() && owner.getLife() == 19, "Payment ignored red pain ability");
                case "filter" -> require(owner.getManaPool().getAmountOfColor(MagicColor.BLACK) == 1 &&
                        owner.getManaPool().getAmountOfColor(MagicColor.WHITE) == 1, "Fetid Heath did not pay hybrid and add WB");
                case "pair" -> require(owner.getManaPool().getAmountOfColor(MagicColor.BLUE) == 1 &&
                        owner.getManaPool().getAmountOfColor(MagicColor.WHITE) == 1, "Skycloud Expanse did not add WU");
            }
        }, input -> {
            String kind = input.get("type").getAsString();
            if (kind.equals("chooseAction") || kind.equals("payManaCost")) {
                if (kind.equals("payManaCost") && !scenario.equals("payment")) return NativeSession.object("type", "pay");
                JsonObject act = NativeSession.object("type", "act");
                act.addProperty("actionId", "card:" + (second != null && menus.get() >= 1 ? second : land).getId());
                return act;
            }
            if (scenario.equals("convoke")) {
                require(kind.equals("chooseBoolean") && !input.has("manaSourceId"), "Convoke misclassified as a mana activation");
                menus.incrementAndGet();
                var yes = NativeSession.object("type", "decision"); yes.addProperty("value", true);
                return yes;
            }
            require(kind.equals("chooseFromSelection"), "Unexpected mana input: " + input);
            menus.incrementAndGet();
            if (scenario.equals("other")) {
                require(!input.has("manaSourceId"), "Nonmana menu was anchored");
                return select(-1);
            }
            require(input.get("manaSourceId").getAsString().equals(NativeSnapshot.cardId(second != null && menus.get() == 2 ? second : land)), "Wrong source anchor: " + input);
            var options = input.getAsJsonArray("options");
            if (scenario.equals("mixed")) {
                boolean hasMana = false;
                int other = -1;
                for (int i = 0; i < options.size(); i++) {
                    var option = options.get(i).getAsJsonObject();
                    if (option.has("manaSymbols")) hasMana |= option.get("manaSymbols").toString().equals("[\"C\",\"C\",\"C\"]");
                    else if (option.get("label").getAsString().contains("Untap")) other = i;
                }
                require(hasMana && other >= 0, "Mixed source must retain both native actions: " + input);
                return select(other);
            }
            if (scenario.equals("large")) {
                String wanted = switch (menus.get()) {
                    case 1 -> "36–39 {W}";
                    case 2 -> "37 {W}";
                    case 3 -> "0 {U}";
                    case 4 -> "3 {B}";
                    default -> throw new AssertionError("Extra allocation step " + input);
                };
                for (int i = 0; i < options.size(); i++)
                    if (options.get(i).getAsJsonObject().get("label").getAsString().equals(wanted)) return select(i);
            } else if (input.get("minTotal").getAsInt() == 0) {
                var outputs = options.asList().stream().map(element -> element.getAsJsonObject().get("manaSymbols").toString()).toList();
                var expected = scenario.equals("filter") ? List.of("[\"C\"]", "[\"W\",\"W\"]", "[\"W\",\"B\"]", "[\"B\",\"B\"]")
                        : List.of("[\"C\"]", "[\"U\"]", "[\"R\"]");
                require(outputs.size() == expected.size() && outputs.containsAll(expected), "Outputs are not independent: " + input);
                if (scenario.equals("cancel") && menus.get() == 1) return select(-1);
                String wanted = switch (scenario) {
                    case "filter" -> "[\"W\",\"B\"]";
                    case "cancel" -> "[\"C\"]";
                    case "pain" -> menus.get() == 1 ? "[\"U\"]" : "[\"C\"]";
                    default -> "[\"R\"]";
                };
                return select(outputs.indexOf(wanted));
            } else {
                String wanted = switch (scenario) {
                    case "dual" -> "[\"U\"]";
                    case "reflected" -> "[\"C\"]";
                    case "filter" -> "[\"W\",\"B\"]";
                    default -> "[\"R\"]";
                };
                for (int i = 0; i < options.size(); i++)
                    if (options.get(i).getAsJsonObject().get("manaSymbols").toString().equals(wanted)) return select(i);
            }
            throw new AssertionError("Missing actual mana selection: " + input);
        });
        if (scenario.equals("payment") || scenario.equals("filter")) require(menus.get() == 1, "Repeated the selected mana output");
        if (!scenario.equals("pair")) require(menus.get() > 0, "No menu opened");
        else require(NativeManaChoices.fixedOutput(land.getManaAbilities().getFirst()).equals(List.of("W", "U")), "Lost fixed two-color output");
    }

    private static JsonObject output(JsonObject input, Card source, String... symbols) {
        require(input.get("manaSourceId").getAsString().equals(NativeSnapshot.cardId(source)), "Unexpected source: " + input);
        var options = input.getAsJsonArray("options");
        for (int i = 0; i < options.size(); i++) {
            var offered = options.get(i).getAsJsonObject().getAsJsonArray("manaSymbols");
            if (offered != null && offered.asList().stream().map(e -> e.getAsString()).toList().equals(List.of(symbols))) return select(i);
        }
        throw new AssertionError("Missing " + List.of(symbols) + " from " + input);
    }

    private static void changedPalette(NativeSession session, Player owner) throws Exception {
        Card reef = card(session.game, owner, "Shivan Reef", ZoneType.Battlefield);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            var human = owner.getController();
            var abilities = reef.getManaAbilities().stream().toList();
            abilities.forEach(ability -> ability.setActivatingPlayer(owner));
            var ability = human.getAbilityToPlay(reef, abilities);
            // A changed resolving palette has to be offered again. A consumed or
            // invalid intention cannot suppress a later color decision on the same source.
            human.withManaActivation(ability, () -> {
                byte changed = human.chooseColor("Adjusted output", ability, ColorSet.fromNames("W", "G"));
                byte next = human.chooseColor("Later choice", ability, ColorSet.fromNames("U", "R"));
                require(changed == MagicColor.GREEN && next == MagicColor.RED, "An outdated selection leaked into the changed choice");
                return true;
            });
        }, input -> switch (steps.incrementAndGet()) {
            case 1 -> output(input, reef, "U");
            case 2 -> output(input, reef, "G");
            case 3 -> output(input, reef, "R");
            default -> throw new AssertionError("Unexpected changed choice: " + input);
        });
        require(steps.get() == 3, "A later real decision was skipped");
    }

    private static void filterCosts(NativeSession session, Player owner, boolean cancel) throws Exception {
        Card filter = card(session.game, owner, "Fetid Heath", ZoneType.Battlefield);
        Card fund = card(session.game, owner, cancel ? "Plains" : "Caves of Koilos", ZoneType.Battlefield);
        AtomicInteger payments = new AtomicInteger(), choices = new AtomicInteger();
        drive(session, owner, () -> {
            var human = owner.getController();
            var abilities = filter.getManaAbilities().stream().toList();
            abilities.forEach(ability -> ability.setActivatingPlayer(owner));
            var chosen = human.getAbilityToPlay(filter, abilities);
            if (cancel) {
                require(!human.playChosenSpellAbility(chosen) && !filter.isTapped() && !fund.isTapped(),
                        "Cancelling the activation cost consumed its sources");
                // Use precisely the same original engine ability without a fresh
                // variant. The previous WB choice must have expired on failure.
            }
            require(human.playChosenSpellAbility(chosen) && filter.isTapped() && fund.isTapped(), "Filter activation failed");
            require(owner.getManaPool().getAmountOfColor(MagicColor.BLACK) == (cancel ? 2 : 1) &&
                    owner.getManaPool().getAmountOfColor(MagicColor.WHITE) == (cancel ? 0 : 1), "Wrong filter result");
            require(owner.getLife() == (cancel ? 20 : 19), "Wrong activation cost or duplicated pain");
        }, input -> {
            if (input.get("type").getAsString().equals("payManaCost")) {
                if (payments.incrementAndGet() == 1 && cancel) return NativeSession.object("type", "cancel");
                var action = NativeSession.object("type", "act");
                action.addProperty("actionId", "card:" + fund.getId());
                return action;
            }
            int step = choices.incrementAndGet();
            if (step == 1) return output(input, filter, "W", "B");
            if (step == 2) return cancel ? output(input, filter, "B", "B") : output(input, fund, "W");
            throw new AssertionError("Duplicated output after cost: " + input);
        });
        require(payments.get() == (cancel ? 2 : 1) && choices.get() == 2, "Cost or mana selection skipped");
    }

    private static JsonObject select(int index) {
        var output = NativeSession.object("type", "selectionDecision");
        JsonArray selected = new JsonArray();
        if (index >= 0) selected.add(index);
        output.add("chosenIndices", selected);
        return output;
    }
}
