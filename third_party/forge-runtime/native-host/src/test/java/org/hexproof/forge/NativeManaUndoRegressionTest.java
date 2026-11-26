// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonObject;
import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.card.mana.ManaCost;
import forge.game.GameStage;
import forge.game.mana.Mana;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.card.Card;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Real human mana payment, source undo, and immediate repeated activation. */
public final class NativeManaUndoRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {
                prefs.setPref(FPref.DECKGEN_CARDBASED, false);
                prefs.setPref(FPref.UI_SELECT_FROM_CARD_DISPLAYS, false);
                return null;
            });
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("mana-undo", 42), base);
                    var scope = session.context.enter()) {
                base.setTestSession(session);
                Player owner = session.game.getPlayers().get(0);
                session.game.setAge(GameStage.Play);
                session.game.setStartingPlayer(owner);
                session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 2);
                Card forest = card(session.game, owner, "Forest", ZoneType.Battlefield);
                Card second = card(session.game, owner, "Forest", ZoneType.Battlefield);
                Card bears = card(session.game, owner, "Grizzly Bears", ZoneType.Hand);
                AtomicInteger steps = new AtomicInteger();
                drive(session, owner, () -> {
                    require(owner.getController().playChosenSpellAbility(bears.getSpellAbilities().get(0)), "Final payment failed");
                    require(forest.isTapped() && second.isTapped() && bears.isInZone(ZoneType.Stack), "Final cast lost its sources");
                }, input -> {
                    require(input.get("type").getAsString().equals("payManaCost"), "Unexpected input: " + input);
                    int step = steps.getAndIncrement();
                    System.out.println("MANA_UNDO step=" + step + " cost=" + input.get("manaCost")
                            + " tapped=" + forest.isTapped() + " pool=" + owner.getManaPool().totalMana());
                    if (step < 20) {
                        if (step % 2 == 0) {
                            require(!forest.isTapped() && input.get("manaCost").getAsString().equals("{1}{G}"), "Undo did not restore the original cost");
                            return action("card:" + forest.getId());
                        }
                        require(forest.isTapped() && owner.getManaPool().isEmpty(), "Activation did not pay its green symbol");
                        return action("undo:" + forest.getId());
                    }
                    return action("card:" + (step == 20 ? forest.getId() : second.getId()));
                });
                require(steps.get() == 22 && !session.hasFailed(), "Rapid source undo failed the native session");
            }
            for (String scenario : List.of("other-source", "hybrid", "partial-floating", "floating-choices", "floating-order", "failed-auto", "preexisting", "life", "completed", "irreversible", "cost-ledger", "nested-fee"))
                extended(base, scenario);
        }
        System.out.println("PASS native mana payment undo");
    }

    private static JsonObject action(String id) {
        JsonObject output = NativeSession.object("type", "act");
        output.addProperty("actionId", id);
        return output;
    }

    private static void extended(NativeGuiBase base, String scenario) throws Exception {
        try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("mana-undo-" + scenario, 42), base);
                var scope = session.context.enter()) {
            base.setTestSession(session);
            Player owner = session.game.getPlayers().get(0);
            session.game.setAge(GameStage.Play);
            session.game.setStartingPlayer(owner);
            session.game.getPhaseHandler().devModeSet(PhaseType.MAIN1, owner, false, 2);
            switch (scenario) {
                case "other-source", "hybrid" -> mixedSources(session, owner, scenario.equals("hybrid"));
                case "partial-floating" -> partialFloating(session, owner);
                case "floating-choices" -> floatingChoices(session, owner);
                case "failed-auto" -> failedAutoPay(session, owner);
                case "floating-order" -> floatingOrder(session, owner);
                case "preexisting" -> preexisting(session, owner);
                case "life" -> lifePayment(session, owner);
                case "completed" -> completedPayment(session, owner);
                case "irreversible" -> irreversible(session, owner);
                case "cost-ledger" -> costLedger(session, owner);
                case "nested-fee" -> nestedFee(session, owner);
                default -> throw new AssertionError("Unknown source undo scenario");
            }
            require(!session.hasFailed(), scenario + " failed its native session");
        }
        System.out.println("PASS native mana undo " + scenario);
    }

    private static void mixedSources(NativeSession session, Player owner, boolean hybrid) throws Exception {
        Card first = card(session.game, owner, hybrid ? "Sol Ring" : "Forest", ZoneType.Battlefield);
        Card second = card(session.game, owner, hybrid ? "Sol Ring" : "Forest", ZoneType.Battlefield);
        Card third = card(session.game, owner, hybrid ? "Plains" : "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, hybrid ? "Spectral Procession" : "Centaur Courser", ZoneType.Hand);
        String firstUndo = "undo:" + first.getId(), secondUndo = "undo:" + second.getId();
        String[] actions = {"card:" + first.getId(), "card:" + second.getId(), secondUndo, firstUndo,
                "card:" + first.getId(), "card:" + second.getId(), "card:" + third.getId()};
        String[] undos = {null, firstUndo, secondUndo, firstUndo, null, firstUndo, secondUndo};
        String[] costs = hybrid ? new String[]{"{2/W}{2/W}{2/W}", "{2/W}{2/W}", "{2/W}", "{2/W}{2/W}"}
                : new String[]{"{2}{G}", "{2}", "{1}", "{2}"};
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Mixed-source cast failed");
            require(first.isTapped() && second.isTapped() && third.isTapped(), "Final payment lost a source");
        }, input -> {
            int step = steps.getAndIncrement();
            require(step < actions.length && input.get("manaCost").getAsString().equals(costs[step % 4]), "Wrong unpaid cost: " + input);
            checkUndo(input, undos[step]);
            if (step == 3) {
                require(first.isTapped() && !second.isTapped() && owner.getManaPool().isEmpty(), "Undo changed the earlier source");
                var paid = spell.getSpellAbilities().get(0).getPayingMana();
                require(!paid.isEmpty() && paid.stream().allMatch(mana -> mana.getSourceCard().getId() == first.getId()),
                        "Source undo kept the wrong physical mana provenance");
            }
            return action(actions[step]);
        });
        require(steps.get() == actions.length, "Mixed-source input was not completed");
    }

    private static void checkUndo(JsonObject input, String expected) {
        var undos = input.getAsJsonArray("actions").asList().stream().map(value -> value.getAsJsonObject())
                .filter(option -> option.get("type").getAsString().equals("undoMana")).toList();
        require(expected == null ? undos.isEmpty() : undos.size() == 1
                && undos.get(0).get("id").getAsString().equals(expected) && undos.get(0).get("label").getAsString().equals("Undo"),
                "Wrong latest payment choice: " + undos);
    }

    private static void floatingChoices(NativeSession session, Player owner) throws Exception {
        Card workshop = card(session.game, owner, "Mishra's Workshop", ZoneType.Battlefield);
        Card ring = card(session.game, owner, "Sol Ring", ZoneType.Battlefield);
        Card forest = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Harmonize", ZoneType.Hand);
        Mana restricted = new Mana((byte) ManaAtom.COLORLESS, workshop, workshop.getManaAbilities().get(0).getManaPart(), owner);
        Mana unrestricted = new Mana((byte) ManaAtom.COLORLESS, ring, ring.getManaAbilities().get(0).getManaPart(), owner);
        // Forge can use the same physical Mana instance for more than one globe.
        owner.getManaPool().addMana(restricted, unrestricted, unrestricted);
        String spend = "pool:" + ManaAtom.COLORLESS;
        String sourceUndo = "undo:" + forest.getId();
        String[] actions = {spend, spend, "undo:pool", "undo:pool", "card:" + forest.getId(), spend, "undo:pool", sourceUndo};
        String[] undos = {null, "undo:pool", "undo:pool", "undo:pool", null, sourceUndo, "undo:pool", sourceUndo, null};
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(!owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Cancelled cast resolved");
            require(!forest.isTapped() && owner.getManaPool().totalMana() == 3, "Floating/source undo did not restore the starting state");
        }, input -> {
            int step = steps.getAndIncrement();
            checkUndo(input, undos[step]);
            var symbols = input.getAsJsonArray("actions").asList().stream().map(value -> value.getAsJsonObject())
                    .filter(option -> option.get("type").getAsString().equals("spendFloatingMana"))
                    .map(option -> option.get("label").getAsString()).toList();
            require(symbols.equals(step == 2 ? List.of() : List.of("C")), "Wrong pool symbols at step " + step + ": " + input);
            if (step == 2) require(owner.getManaPool().totalMana() == 1 && owner.getManaPool().iterator().next() == restricted,
                    "Spending same-color mana consumed the restricted globe");
            return step < actions.length ? action(actions[step]) : NativeSession.object("type", "cancel");
        });
    }

    private static void floatingOrder(NativeSession session, Player owner) throws Exception {
        Card hall = card(session.game, owner, "Hall of the Bandit Lord", ZoneType.Battlefield);
        Card wastes = card(session.game, owner, "Wastes", ZoneType.Battlefield);
        hall.setTapped(true);
        wastes.setTapped(true);
        Mana haste = new Mana((byte) ManaAtom.COLORLESS, hall, hall.getManaAbilities().get(0).getManaPart(), owner);
        Mana basic = new Mana((byte) ManaAtom.COLORLESS, wastes, wastes.getManaAbilities().get(0).getManaPart(), owner);
        owner.getManaPool().addMana(haste, basic);
        var spell = card(session.game, owner, "Centaur Courser", ZoneType.Hand).getSpellAbilities().get(0);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(!owner.getController().playChosenSpellAbility(spell), "Cancelled cast succeeded");
        }, input -> {
            int step = steps.getAndIncrement();
            if (step == 0 || step == 2) {
                require(owner.getManaPool().iterator().next() == haste, "Undo changed the next physical colorless mana");
                return action("pool:" + ManaAtom.COLORLESS);
            }
            require(spell.getPayingMana().getFirst() == haste, "Re-spending colorless lost the haste rider");
            if (step == 1) return action("undo:pool");
            require(step == 3, "Unexpected extra payment prompt");
            return NativeSession.object("type", "cancel");
        });
    }

    private static void partialFloating(NativeSession session, Player owner) throws Exception {
        Card ring = card(session.game, owner, "Sol Ring", ZoneType.Battlefield);
        Card mountain = card(session.game, owner, "Mountain", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Desperate Ritual", ZoneType.Hand);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Partial-floating cast failed");
            require(ring.isTapped() && mountain.isTapped() && owner.getManaPool().totalMana() == 1, "Surplus mana changed on the final payment");
        }, input -> {
            int step = steps.getAndIncrement();
            if (step == 1) require(ring.isTapped() && owner.getManaPool().totalMana() == 1
                    && input.get("manaCost").getAsString().equals("{R}"), "Two-mana source did not split paid and floating mana");
            if (step == 2) require(!ring.isTapped() && owner.getManaPool().isEmpty()
                    && input.get("manaCost").getAsString().equals("{1}{R}"), "Partial source undo lost mana or cost");
            require(step < 4, "Repeated partial source input");
            return action((step == 1 ? "undo:" : "card:") + (step == 3 ? mountain : ring).getId());
        });
    }

    private static void failedAutoPay(NativeSession session, Player owner) throws Exception {
        Card ring = card(session.game, owner, "Sol Ring", ZoneType.Battlefield);
        ring.setTapped(true);
        Mana floating = new Mana((byte) ManaAtom.COLORLESS, ring, ring.getManaAbilities().get(0).getManaPart(), owner);
        owner.getManaPool().addMana(floating);
        card(session.game, owner, "Ashnod's Altar", ZoneType.Battlefield);
        card(session.game, owner, "Ashnod's Altar", ZoneType.Battlefield);
        Card fodder = card(session.game, owner, "Ornithopter", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Solemn Simulacrum", ZoneType.Hand);
        var cast = spell.getSpellAbilities().get(0);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(!owner.getController().playChosenSpellAbility(cast), "Failed Auto Pay cast an underfunded spell");
            require(spell.isInZone(ZoneType.Hand) && fodder.isInZone(ZoneType.Graveyard),
                    "Cancel lost the spell or undid an irreversible sacrifice");
            require(owner.getManaPool().totalMana() == 3 && cast.getPayingMana().isEmpty(),
                    "Cancel duplicated or lost the floated mana or the two mana from the sacrifice");
        }, input -> {
            int step = steps.getAndIncrement();
            require(input.get("type").getAsString().equals("payManaCost"), "Unexpected failed-Auto input");
            if (step == 0) return action("pool:" + ManaAtom.COLORLESS);
            if (step == 1) {
                checkUndo(input, "undo:pool");
                // Forge's preview currently counts the same sacrifice for both Altars.
                require(input.get("canAutoPay").getAsBoolean(), "Fixture did not reach the automatic-payment path");
                return NativeSession.object("type", "pay");
            }
            require(step <= 4 && fodder.isInZone(ZoneType.Graveyard), "Auto did not attempt the actual cost");
            int paid = cast.getPayingMana().size(), pool = owner.getManaPool().totalMana();
            require(input.get("manaCost").getAsString().equals("{" + (4 - paid) + "}") && paid + pool == 3,
                    "Auto failed to account for each exact globe and the unpaid cost");
            require(!input.get("canAutoPay").getAsBoolean(), "Auto still uses the pre-sacrifice preview");
            if (step == 2) {
                checkUndo(input, "undo:pool");
                require(paid == 3 && pool == 0, "Partial payment was also refunded");
                return action("undo:pool");
            }
            if (step == 3) {
                checkUndo(input, null);
                require(paid == 2 && owner.getManaPool().iterator().next() == floating,
                        "Undo returned mana produced by the irreversible sacrifice");
                return action("pool:" + ManaAtom.COLORLESS);
            }
            require(paid == 3 && pool == 0, "Retry credited another mana");
            return NativeSession.object("type", "cancel");
        });
        require(steps.get() == 5, "Missing failed-Auto continuation");
    }

    private static void preexisting(NativeSession session, Player owner) throws Exception {
        Card previous = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card current = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Centaur Courser", ZoneType.Hand);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(previous.getManaAbilities().get(0)), "Previous floating activation failed");
            var original = previous.getManaAbilities().get(0).getManaPart().getLastManaProduced().iterator().next();
            require(!owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Cancellation unexpectedly cast the spell");
            require(previous.isTapped() && !current.isTapped() && owner.getManaPool().totalMana() == 1,
                    "Cancel changed resources from before this payment");
            require(owner.getManaPool().iterator().next() == original, "Same-color source undo replaced an existing mana globe");
        }, input -> {
            int step = steps.getAndIncrement();
            if (step == 2) require(previous.isTapped() && !current.isTapped() && owner.getManaPool().totalMana() == 1
                    && input.get("manaCost").getAsString().equals("{2}{G}"), "Undo did not preserve preexisting mana");
            require(step < 3, "Repeated preexisting-mana input");
            return step == 2 ? NativeSession.object("type", "cancel")
                    : action((step == 1 ? "undo:" : "card:") + current.getId());
        });
    }

    private static void lifePayment(NativeSession session, Player owner) throws Exception {
        Card[] forests = new Card[4];
        for (int i = 0; i < forests.length; i++) forests[i] = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Moltensteel Dragon", ZoneType.Hand);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Phyrexian-life cast failed");
            require(owner.getLife() == 16, "Source undo lost or duplicated a life payment");
        }, input -> {
            int step = steps.getAndIncrement();
            String source = "undo:" + forests[0].getId();
            String[] undos = {null, source, "undo:life", source, null, "undo:life", "undo:life", "undo:life"};
            if (step < undos.length) checkUndo(input, undos[step]);
            if (step == 3) require(input.get("manaCost").getAsString().equals("{3}{R/P}{R/P}"), "Undo failed to restore the life-paid symbol");
            if (step == 2 || step == 6) return action("undo:life");
            if (step == 3) return action(source);
            if (step == 1 || step == 4 || step == 5 || step == 7) return action("life:2");
            return action("card:" + forests[step == 0 ? 0 : step - 8].getId());
        });
    }

    private static void completedPayment(NativeSession session, Player owner) throws Exception {
        Card first = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card second = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Grizzly Bears", ZoneType.Hand);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Completed cast failed");
            session.game.getStack().reset();
            session.game.getAction().moveToGraveyard(spell, null);
            Card next = card(session.game, owner, "Grizzly Bears", ZoneType.Hand);
            require(!owner.getController().playChosenSpellAbility(next.getSpellAbilities().get(0)), "Unpaid second spell was cast");
            require(first.isTapped() && second.isTapped(), "Undo reached mana spent on a completed action");
        }, input -> {
            int step = steps.getAndIncrement();
            if (step < 2) return action("card:" + (step == 0 ? first : second).getId());
            require(step == 2 && input.getAsJsonArray("actions").asList().stream().noneMatch(value ->
                    value.getAsJsonObject().get("type").getAsString().equals("undoMana")), "Completed payment offered a source undo");
            String before = session.prompt(0);
            JsonObject invalid = NativeSession.object("type", "payManaCost");
            invalid.add("output", action("undo:" + first.getId()));
            try {
                session.submit(invalid);
                throw new AssertionError("Unavailable source undo was accepted");
            } catch (IllegalArgumentException expected) {
                require(!session.hasFailed() && session.prompt(0).equals(before), "Invalid undo destroyed its pending input");
            }
            return NativeSession.object("type", "cancel");
        });
    }

    private static void irreversible(NativeSession session, Player owner) throws Exception {
        Card lotus = card(session.game, owner, "Lotus Bloom", ZoneType.Battlefield);
        Card forest = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Harmonize", ZoneType.Hand);
        AtomicInteger payments = new AtomicInteger();
        drive(session, owner, () -> {
            require(owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Irreversible-source cast failed");
            require(lotus.isInZone(ZoneType.Graveyard) && forest.isTapped(), "Irreversible source was restored");
        }, input -> {
            String kind = input.get("type").getAsString();
            if (kind.equals("chooseBoolean")) {
                JsonObject output = NativeSession.object("type", "decision"); output.addProperty("value", true); return output;
            }
            if (kind.equals("chooseFromSelection")) {
                JsonObject output = NativeSession.object("type", "selectionDecision");
                com.google.gson.JsonArray chosen = new com.google.gson.JsonArray(); chosen.add(4); output.add("chosenIndices", chosen); return output;
            }
            require(kind.equals("payManaCost"), "Unexpected irreversible input: " + input);
            int step = payments.getAndIncrement();
            if (step == 1) require(input.getAsJsonArray("actions").asList().stream().noneMatch(value ->
                    value.getAsJsonObject().get("id").getAsString().equals("undo:" + lotus.getId())), "Sacrifice was offered as reversible mana");
            require(step < 2, "Repeated irreversible payment");
            return action("card:" + (step == 0 ? lotus : forest).getId());
        });
    }
    private static void costLedger(NativeSession session, Player owner) {
        Card forest = card(session.game, owner, "Forest", ZoneType.Battlefield);
        Card island = card(session.game, owner, "Island", ZoneType.Battlefield);
        Mana green = new Mana(MagicColor.GREEN, forest, forest.getManaAbilities().get(0).getManaPart(), owner);
        Mana blue = new Mana(MagicColor.BLUE, island, island.getManaAbilities().get(0).getManaPart(), owner);
        ManaCostBeingPaid coloredX = new ManaCostBeingPaid(new ManaCost("X"));
        coloredX.setXManaCostPaid(2, "WUBRGX");
        coloredX.beginPaymentUndoTracking();
        require(coloredX.payMana(green, owner.getManaPool()) && coloredX.payMana(blue, owner.getManaPool())
                && coloredX.isPaid() && coloredX.getSunburst() == 2, "Colored X initial payment failed");
        ManaCostBeingPaid copied = new ManaCostBeingPaid(coloredX);
        require(!copied.canRefundManaPayments(List.of(green)), "Native copy inherited another cost's source refund ledger");
        require(!coloredX.canRefundManaPayments(List.of(green, green)), "Refund accepted too many globes for one paid mana");
        require(coloredX.refundManaPayments(List.of(green)) && !coloredX.isPaid() && coloredX.getSunburst() == 1
                && coloredX.getXManaCostPaidByColor().equals(java.util.Map.of("U", 1)), "Colored X undo lost its color/count metadata");
        require(!coloredX.isNeeded(blue, owner.getManaPool()) && coloredX.isNeeded(green, owner.getManaPool()),
                "Colored X undo stopped enforcing distinct paid colors");
        require(coloredX.payMana(green, owner.getManaPool()) && coloredX.isPaid() && coloredX.getSunburst() == 2
                && coloredX.getXManaCostPaidByColor().equals(java.util.Map.of("U", 1, "G", 1)), "Colored X repeat payment changed provenance counts");

        Card snowForest = card(session.game, owner, "Snow-Covered Forest", ZoneType.Battlefield);
        Mana snow = new Mana(MagicColor.GREEN, snowForest, snowForest.getManaAbilities().get(0).getManaPart(), owner);
        ManaCostBeingPaid snowCost = new ManaCostBeingPaid(new ManaCost("1 S"));
        snowCost.beginPaymentUndoTracking();
        require(snowCost.payMana(snow, owner.getManaPool()) && snowCost.payMana(green, owner.getManaPool()) && snowCost.isPaid(),
                "Snow source did not pay its actual native shard");
        require(snowCost.refundManaPayments(List.of(snow)) && snowCost.toString().equals("{S}")
                && !snowCost.isNeeded(green, owner.getManaPool()) && snowCost.isNeeded(snow, owner.getManaPool()),
                "Source undo let ordinary retained mana pay a snow shard");
        require(snowCost.payMana(snow, owner.getManaPool()) && snowCost.isPaid(), "Snow repeat payment failed");
    }

    private static void nestedFee(NativeSession session, Player owner) throws Exception {
        Card ring = card(session.game, owner, "Sol Ring", ZoneType.Battlefield);
        Card prismite = card(session.game, owner, "Prismite", ZoneType.Battlefield);
        Card spell = card(session.game, owner, "Grizzly Bears", ZoneType.Hand);
        AtomicInteger steps = new AtomicInteger();
        drive(session, owner, () -> {
            require(!owner.getController().playChosenSpellAbility(spell.getSpellAbilities().get(0)), "Nested cancellation unexpectedly cast the spell");
            require(!ring.isTapped() && owner.getManaPool().isEmpty() && spell.isInZone(ZoneType.Hand),
                    "Nested source undo/cancel duplicated or lost its activation fee");
            require(prismite.getManaAbilities().get(0).getPayingMana().isEmpty()
                    && spell.getSpellAbilities().get(0).getPayingMana().isEmpty(), "Nested refund kept a spent native mana ledger");
        }, input -> {
            String kind = input.get("type").getAsString();
            if (kind.equals("chooseFromSelection")) {
                JsonObject output = NativeSession.object("type", "selectionDecision");
                com.google.gson.JsonArray chosen = new com.google.gson.JsonArray(); chosen.add(4); output.add("chosenIndices", chosen); return output;
            }
            require(kind.equals("payManaCost"), "Unexpected nested-fee input: " + input);
            int step = steps.getAndIncrement();
            System.out.println("NESTED_UNDO step=" + step + " input=" + input);
            require(step < 4, "Repeated nested source input");
            if (step == 0) return action("card:" + prismite.getId());
            if (step == 1) return action("card:" + ring.getId());
            if (step == 2) return action("undo:" + prismite.getId());
            return NativeSession.object("type", "cancel");
        });
    }

}
