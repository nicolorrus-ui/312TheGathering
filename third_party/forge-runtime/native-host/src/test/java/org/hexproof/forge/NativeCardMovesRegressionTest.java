// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.*;
import forge.game.GameActionUtil;
import forge.game.GameStage;
import forge.game.cost.CostPayment;
import forge.game.ability.AbilityFactory;
import forge.game.card.Card;
import forge.game.card.CardFactory;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.PlaySpellAbility;
import forge.player.PlayerControllerHuman;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;
import java.util.*;
import static org.hexproof.forge.NativeCallbackRegressionTest.*;

/** Physical spells and their actual zone changes, including counterspells and a replacement. */
public final class NativeCardMovesRegressionTest {
    public static void main(String[] args) throws Exception {
        NativeProfile.create();
        try (NativeGuiBase base = new NativeGuiBase(args[0])) {
            GuiBase.setInterface(base.proxy());
            FModel.initialize(null, prefs -> {prefs.setPref(FPref.DECKGEN_CARDBASED, false); return null;});
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("ordinary",42),base);
                 var scope = session.context.enter()) { base.setTestSession(session); ordinary(session); }
            for (String mode : List.of("cancel", "confirm", "morph")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("pay", 42), base);
                     var scope = session.context.enter()) {
                    base.setTestSession(session);
                    pendingCast(session, mode);
                }
            }
            try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("disclosure", 42), base);
                 var scope = session.context.enter()) {
                base.setTestSession(session);
                selectiveRollback(session);
            }
            for (String copy : List.of("permanent", "instant", "countered")) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("copy", 42), base);
                     var scope = session.context.enter()) {
                    base.setTestSession(session);
                    spellCopy(session, copy);
                }
            }
            Map<String,String> cases = new LinkedHashMap<>();
            cases.put("resolve", "battlefield"); cases.put("Counterspell", "graveyard");
            cases.put("Dissipate", "exile"); cases.put("Unsubstantiate", "hand");
            cases.put("Memory Lapse", "library"); cases.put("replacement", "exile");
            for (var entry : cases.entrySet()) {
                try (NativeSession session = new NativeSession(NativeIsolationRegressionTest.setup("move",42),base);
                     var scope = session.context.enter()) {
                    base.setTestSession(session);
                    run(session, entry.getKey(), entry.getValue());
                }
            }
        }
        System.out.println("PASS native card movements: private searches, draws, lands, discards, bounce, five spell destinations, replacements and token copies");
    }
    private static void pendingCast(NativeSession session, String mode) throws Exception {
        var game = session.game;
        var caster = game.getPlayers().get(0);
        game.setAge(GameStage.Play);
        game.setStartingPlayer(caster);
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, caster, false, 1);
        boolean morph = mode.equals("morph");
        boolean cancel = mode.equals("cancel");
        for (int i = 0; i < (morph ? 3 : 1); i++) card(game, caster, "Forest", ZoneType.Battlefield);
        String name = morph ? "Willbender" : "Exploration";
        Card spell = card(game, caster, name, ZoneType.Hand);
        Card duplicate = card(game, caster, name, ZoneType.Hand);
        for (int viewer = -1; viewer < 2; viewer++) moves(session, viewer);
        String id = NativeSession.cardId(spell);
        var seen = new ArrayList<String>();
        drive(session, caster, () -> {
            var chosen = morph ? spell.getAllPossibleAbilities(caster, true).stream().filter(SpellAbility::isCastFaceDown)
                    .findFirst().orElseThrow() : spell.getFirstSpellAbility();
            if (!cancel) {
                require(!PlaySpellAbility.playSpellAbility((PlayerControllerHuman) caster.getController(),
                        caster, chosen), "First cast was not cancelled");
                checkKnownHand(session, -1, morph ? null : id);
                checkKnownHand(session, 1, morph ? null : id);
                // A real priority input after cancellation shows the card back in its owner's hand.
                for (int viewer = -1; viewer < 2; viewer++) moves(session, viewer);
            }
            boolean cast = PlaySpellAbility.playSpellAbility((PlayerControllerHuman) caster.getController(), caster, chosen);
            require(cast != cancel, "Unexpected casting outcome");
        }, input -> {
            require("payManaCost".equals(input.get("type").getAsString()), "Unexpected " + input);
            for (int viewer = -1; viewer < 2; viewer++) {
                JsonObject snap = JsonParser.parseString(session.snapshot(viewer)).getAsJsonObject();
                require(snap.getAsJsonArray("stack").isEmpty(), "Unpaid spell was targetable");
                JsonObject pending = snap.getAsJsonObject("pendingCast");
                String attempt = pending.get("id").getAsString();
                if (viewer == -1) {
                    require(!seen.contains(attempt), "Recasting exposed a stable private hand ID");
                    seen.add(attempt);
                }
                JsonObject face = pending.getAsJsonObject("identity");
                JsonObject from = pending.getAsJsonObject("from");
                require(!pending.has("sourceId") && attempt.equals(seen.getLast()) && attempt.matches("casting-[0-9]+")
                        && (viewer == 0 ? from.has("objectId") && id.equals(from.get("objectId").getAsString()) : !from.has("objectId"))
                        && (morph ? face.isEmpty() : name.equals(face.get("name").getAsString())),
                        "Incorrect announced face or hidden source for viewer " + viewer + ": " + pending);
            }
            return NativeSession.object("type", cancel || seen.size() == 1 ? "cancel" : "pay");
        });
        for (int viewer = -1; viewer < 2; viewer++) {
            JsonObject snap = JsonParser.parseString(session.snapshot(viewer)).getAsJsonObject();
            require(!snap.has("pendingCast"), "Finished or cancelled cast remained pending");
            JsonArray stack = snap.getAsJsonArray("stack");
            require(cancel ? stack.isEmpty() && caster.getCardsIn(ZoneType.Hand).contains(spell)
                    : stack.size() == 1 && id.equals(stack.get(0).getAsJsonObject().get("sourceId").getAsString())
                            && seen.getLast().equals(stack.get(0).getAsJsonObject().get("castId").getAsString()),
                    "Cast rollback or stack handoff lost the exact physical card");
        }
        if (cancel) {
            checkKnownHand(session, -1, id);
            checkKnownHand(session, 1, id);
            game.getAction().moveToLibrary(duplicate, null);
            checkKnownHand(session, -1, null);
            checkKnownHand(session, 1, null);
        }
    }

    private static void selectiveRollback(NativeSession session) {
        var game = session.game;
        Player caster = game.getPlayers().get(0);
        for (boolean discloseToOpponent : List.of(false, true)) {
            Card physical = card(game, caster, "Grizzly Bears", ZoneType.Hand);
            var hand = caster.getZone(ZoneType.Hand);
            var ability = physical.getFirstSpellAbility();
            ability.setActivatingPlayer(caster);
            final int waitingMark = game.getTriggerHandler().getWaitingTriggerCount();
            ability.setHostCard(game.getAction().moveToStack(physical, ability));
            // Reproduce a cancellation with no published announcement, or just one authorized view.
            if (discloseToOpponent) moves(session, 1);
            GameActionUtil.rollbackAbility(ability, hand, 0, new CostPayment(ability.getPayCosts(), ability), physical, waitingMark);
            checkKnownHand(session, -1, null);
            checkKnownHand(session, 1, discloseToOpponent ? NativeSession.cardId(physical) : null);
        }
    }

    private static void checkKnownHand(NativeSession session, int viewer, String expected) {
        var snapshot = NativeSnapshot.capture(session.game, session.id, viewer, null, session.knowledge);
        for (var zoned : snapshot.getAsJsonArray("zones")) {
            var zone = zoned.getAsJsonObject();
            if (!"player-0".equals(zone.get("ownerId").getAsString()) || !"hand".equals(zone.get("zone").getAsString())) continue;
            var cards = zone.getAsJsonArray("cards");
            require(expected == null ? cards.isEmpty() : cards.size() == 1
                    && expected.equals(cards.get(0).getAsJsonObject().get("id").getAsString()),
                    "Incorrect remembered hand for viewer " + viewer + ": " + cards);
            return;
        }
        throw new AssertionError("Missing hand");
    }

    private static void spellCopy(NativeSession s, String mode) {
        var g = s.game;
        Player a = g.getPlayers().get(0), b = g.getPlayers().get(1);
        g.setAge(GameStage.Play);
        g.setStartingPlayer(a);
        g.getPhaseHandler().devModeSet(PhaseType.MAIN1, a, false, 1);
        var spell = cast(card(g, a, mode.equals("instant") ? "Revitalize" : "Grizzly Bears", ZoneType.Hand), a, null);
        var copy = CardFactory.copySpellAbilityAndPossiblyHost(spell, spell, b);
        g.getStack().add(copy);
        String id = "stack-" + g.getStack().peek().getId();
        int source = copy.getHostCard().getId();
        if (mode.equals("countered")) cast(card(g, a, "Counterspell", ZoneType.Hand), a, copy);
        g.getStack().resolveStack();
        var history = moves(s, -1);
        JsonObject destination = null;
        for (int i = 0; i < history.size(); i++) {
            JsonObject from = end(history, i, "from"), to = end(history, i, "to");
            require(!to.has("objectId") || !id.equals(to.get("objectId").getAsString()), "Copy invented a physical origin");
            if (from.has("objectId") && from.has("objectId") && id.equals(from.get("objectId").getAsString())) destination = to;
        }
        if (mode.equals("permanent")) {
            require(destination != null && destination.get("zone").getAsString().equals("battlefield")
                && destination.get("objectId").getAsString().equals("card-" + source)
                && b.getCardsIn(ZoneType.Battlefield).stream().anyMatch(card -> card.getId() == source && card.isToken()),
                "Resolved permanent copy did not land on its actual token: " + history);
        } else require(destination == null, "Vanished spell copy was assigned a zone: " + history);
    }
    private static void ordinary(NativeSession s) {
        var g=s.game; Player a=g.getPlayers().get(0);
        g.setAge(GameStage.Play); g.setStartingPlayer(a); g.getPhaseHandler().devModeSet(PhaseType.MAIN1,a,false,1);
        Card land=card(g,a,"Forest",ZoneType.Hand), secret=card(g,a,"Grizzly Bears",ZoneType.Library);
        card(g,a,"Mountain",ZoneType.Library);
        for (int v=-1;v<2;v++) moves(s,v);
        // A library search and private reorder are not public draws. No event or sequence gap reaches an observer.
        Card found=g.getAction().moveToHand(secret,null);
        Card returned=g.getAction().moveToLibrary(found,-1,null);
        g.getAction().moveToLibrary(returned,0,null);
        require(moves(s,-1).isEmpty() && moves(s,1).isEmpty(), "Private library movement reached other viewers");
        require(moves(s,0).size()==2, "Owner lost personally visible hand movement");
        g.getPhaseHandler().devModeSet(PhaseType.DRAW,a,false,2);
        Card drawn=a.drawCards(1).getFirst();
        g.getPhaseHandler().devModeSet(PhaseType.MAIN1,a,false,2);
        Card played=a.playLand(land,null);
        require(played!=null && played.isInZone(ZoneType.Battlefield), "Land fixture failed");
        g.getAction().moveToGraveyard(drawn,null);
        g.getAction().moveToHand(played,null);
        for (int v=-1;v<2;v++) {
            var list=moves(s,v); int at=v==0?2:0;
            require(list.size()==at+4,"Draw, land, discard or bounce missing: " + list);
            for (int i=0;i<list.size();i++) require(list.get(i).getAsJsonObject().get("id").getAsLong()==i+1,"Private event leaked a sequence gap");
            require(end(list,at,"from").get("zone").getAsString().equals("library") && !end(list,at,"from").has("objectId")
                    && end(list,at,"to").has("objectId")== (v==0), "Draw exposed a private ID");
            require(end(list,at+1,"to").get("objectId").getAsString().equals(NativeSession.cardId(played)) && end(list,at+1,"from").has("objectId")== (v==0), "Land move mismatch");
            require(end(list,at+2,"to").get("zone").getAsString().equals("graveyard") && end(list,at+2,"to").has("objectId"), "Discard did not reach graveyard");
            require(end(list,at+3,"from").has("objectId") && end(list,at+3,"to").has("objectId")== (v==0), "Bounce disclosed hidden hand object");
        }
    }
    private static void run(NativeSession s, String scenario, String expected) {
        var game = s.game; Player a = game.getPlayers().get(0), b = game.getPlayers().get(1);
        game.setAge(GameStage.Play); game.setStartingPlayer(a); game.getPhaseHandler().devModeSet(PhaseType.MAIN1,a,false,1);
        Card first = card(game,a,"Grizzly Bears",ZoneType.Hand), second = card(game,a,"Grizzly Bears",ZoneType.Hand);
        Card response = scenario.equals("resolve") ? null : card(game,b,scenario.equals("replacement") ? "Counterspell" : scenario,ZoneType.Hand);
        if (scenario.equals("replacement")) card(game,b,"Rest in Peace",ZoneType.Battlefield);
        game.getAction().checkStaticAbilities();
        for (int viewer=-1; viewer<2; viewer++) moves(s,viewer);
        SpellAbility firstSpell = cast(first,a,null), spell = cast(second,a,null);
        String stack = "stack-" + game.getStack().peek().getId();
        for (int viewer=-1; viewer<2; viewer++) {
            JsonArray moves = moves(s,viewer);
            require(moves.size()==2, "Lost real casts: " + moves);
            JsonObject from = end(moves,1,"from"), to = end(moves,1,"to");
            require(to.get("objectId").getAsString().equals(stack) && from.get("zone").getAsString().equals("hand"), "Wrong stack instance");
            require(viewer==0 ? from.get("objectId").getAsString().equals(NativeSession.cardId(second)) : !from.has("objectId"), "Hand link crossed viewer boundary");
        }
        if (scenario.equals("resolve")) {
            // A copy on top of the original has the same host, but gets no physical movement.
            SpellAbility copied = spell.copy(); copied.setCopied(true); game.getStack().add(copied);
            game.getStack().remove(game.getStack().peek());
            SpellAbility ability = AbilityFactory.getAbility("AB$ GainLife | Cost$ 0 | LifeAmount$ 1",firstSpell.getHostCard());
            ability.setActivatingPlayer(a); game.getStack().add(ability); game.getStack().remove(game.getStack().peek());
            require(moves(s,0).size()==2, "Copy or ability invented a card move");
        }
        if (response != null) cast(response,b,spell);
        game.getStack().resolveStack();
        for (int viewer=-1;viewer<2;viewer++) {
            JsonArray list = moves(s,viewer);
            JsonObject target = null;
            for (int i=0;i<list.size();i++) {
                JsonObject from=end(list,i,"from");
                if (from.has("objectId") && from.get("objectId").getAsString().equals(stack)) target=end(list,i,"to");
            }
            require(target!=null && expected.equals(target.get("zone").getAsString()) && target.get("playerId").getAsString().equals("player-0"), "Wrong physical destination: " + list);
            boolean visible = !expected.equals("library") && (!expected.equals("hand") || viewer==0);
            require(visible ? NativeSession.cardId(second).equals(target.get("objectId").getAsString()) : !target.has("objectId"), "Exposed hidden destination or confused duplicate names: " + target);
            require(list.equals(moves(s,viewer)), "Repeated capture consumed or duplicated movement");
        }
    }
    private static JsonObject end(JsonArray list,int index,String name) { return list.get(index).getAsJsonObject().getAsJsonObject(name); }
    private static JsonArray moves(NativeSession s,int viewer) {
        var view = NativeSnapshot.capture(s.game,s.id,viewer,null); s.cardMoves.project(view,viewer);
        return view.has("cardMoves") ? view.getAsJsonArray("cardMoves") : new JsonArray();
    }
    private static SpellAbility cast(Card card, Player player, SpellAbility target) {
        SpellAbility spell = card.getFirstSpellAbility(); spell.setActivatingPlayer(player);
        if (target!=null) spell.getTargets().add(target);
        player.getGame().getStack().addAndUnfreeze(spell);
        return player.getGame().getStack().peekAbility();
    }
}
