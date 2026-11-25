// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import forge.LobbyPlayer;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.player.Player;
import forge.game.player.DelayedReveal;
import forge.game.zone.ZoneType;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.player.PlayerControllerHuman;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.function.Predicate;
import java.util.function.Supplier;

/** Retains the actual native object that requires a synchronous human decision. */
final class NativeDecisionController extends PlayerControllerHuman {
    private final NativeSession session;
    private final Integer starts;
    final NativeLandUndo landUndo;
    private record HiddenTop(Card card, Player viewer) {}
    private volatile Set<HiddenTop> hiddenSearchTops = Set.of();
    private volatile SpellAbilityStackInstance ownStackAction;

    NativeDecisionController(NativeSession session, Game game, Player player, LobbyPlayer lobby, Integer starts) {
        super(game, player, lobby);
        this.session = session;
        this.starts = starts;
        this.landUndo = new NativeLandUndo(game, player);
    }

    private <T> T deciding(SpellAbility ability, Supplier<T> action) {
        return session.withDecisionAbility(ability, action);
    }

    @Override public Player chooseStartingPlayer(boolean firstGame) {
        return starts == null ? super.chooseStartingPlayer(firstGame) : getGame().getRegisteredPlayers().get(starts);
    }
    // Forge temporarily grants visibility to the objects in a choice. Remember which
    // physical tops were hidden before that grant so a snapshot cannot identify them
    // among the authorized cards. The prompt still uses Forge's full disclosure.
    private <T> T libraryChoice(List<ZoneType> origin, Supplier<T> action) {
        if (!origin.contains(ZoneType.Library)) return action.get();
        var hidden = new HashSet<HiddenTop>();
        var players = getGame().getRegisteredPlayers();
        for (Player owner : players) {
            var library = owner.getCardsIn(ZoneType.Library);
            if (library.isEmpty()) continue;
            Card top = library.getFirst();
            for (Player viewer : players) {
                if (!top.getView().canBeShownTo(viewer.getView())) hidden.add(new HiddenTop(top, viewer));
            }
        }
        var previous = hiddenSearchTops;
        hidden.addAll(previous);
        hiddenSearchTops = Set.copyOf(hidden);
        try { return action.get(); }
        finally { hiddenSearchTops = previous; }
    }

    static boolean hidesSearchTop(Card top, Player viewer) {
        if (viewer == null) return false;
        for (Player player : viewer.getGame().getRegisteredPlayers()) {
            if (player.getController() instanceof NativeDecisionController controller && !controller.hiddenSearchTops.isEmpty()
                    && controller.hiddenSearchTops.contains(new HiddenTop(top, viewer))) return true;
        }
        return false;
    }

    @Override public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility ability,
            CardCollection candidates, DelayedReveal reveal, String prompt, boolean optional, Player decider) {
        return libraryChoice(origin, () -> super.chooseSingleCardForZoneChange(destination, origin, ability, candidates,
                NativeLibrarySearch.forZoneChange(reveal, getPlayer()), prompt, optional, decider));
    }

    @Override public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility ability,
            CardCollection candidates, int min, int max, DelayedReveal reveal, String prompt, Player decider) {
        return libraryChoice(origin, () -> super.chooseCardsForZoneChange(destination, origin, ability, candidates, min, max,
                NativeLibrarySearch.forZoneChange(reveal, getPlayer()), prompt, decider));
    }

    @Override public void revealForDiscard(forge.game.card.CardCollectionView cards, Player owner) {
        // DiscardEffect calls this only when a choice follows immediately. Its
        // exact authorized disclosure is supplied again as visibleToChooser.
    }
    @Override public forge.game.card.CardCollectionView chooseCardsToDiscardFrom(Player player, SpellAbility ability,
            CardCollection valid, int min, int max, forge.game.card.CardCollectionView visibleToChooser) {
        if (player == getPlayer()) return super.chooseCardsToDiscardFrom(player, ability, valid, min, max, visibleToChooser);
        return deciding(ability, () -> {
            tempShowCards(visibleToChooser);
            try {
                var candidates = forge.game.GameEntityView.getMap(valid);
                var reveal = new forge.game.player.DelayedReveal(visibleToChooser,
                        forge.game.zone.ZoneType.Hand, player.getView());
                var chosen = getGui().chooseEntitiesForEffect(
                        String.format(forge.util.Localizer.getInstance().getMessage("lblChooseMinCardToDiscard"), min == 0 ? max : min),
                        candidates.getTrackableKeys(), min, max, reveal);
                var result = new CardCollection();
                candidates.addToList(chosen, result);
                return result;
            } finally { endTempShowCards(); }
        });
    }
    @Override public forge.game.card.CardCollectionView chooseCardsToDiscardToMaximumHandSize(int count) {
        // The desktop uses a specialized incremental input here. Use Forge's
        // complete card-dialog contract so selecting two cards stays one choice.
        var hand = getPlayer().getCardsIn(forge.game.zone.ZoneType.Hand);
        tempShowCards(hand);
        try {
            var candidates = forge.game.GameEntityView.getMap(hand);
            var chosen = getGui().many("Discard to maximum hand size", "Discarded", count, count,
                    candidates.getTrackableKeys(), null);
            var result = new CardCollection();
            candidates.addToList(chosen, result);
            return result;
        } finally { endTempShowCards(); }
    }
    @Override public org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection>
            arrangeForScry(CardCollection topN) {
        // Expose both ordered piles in one private decision. The desktop's
        // generic dual-list callbacks otherwise split selection and ordering
        // across unrelated dialogs and hide the top-order step in a small dock.
        var candidates = new CardCollection(topN);
        if (candidates.isEmpty()) return org.apache.commons.lang3.tuple.ImmutablePair.of(
                new CardCollection(), new CardCollection());
        var input = NativeSession.object("type", "scry");
        var cards = new com.google.gson.JsonArray();
        for (Card card : candidates) {
            var choice = NativeSession.object("id", NativeSession.cardId(card));
            choice.add("identity", NativeSnapshot.identity(card));
            cards.add(choice);
        }
        input.add("cards", cards);
        var zones = new com.google.gson.JsonArray();
        zones.add("libraryTop"); zones.add("libraryBottom"); input.add("zones", zones);
        input.add("presentation", NativeSession.object("title", "Scry"));
        return session.ask(getPlayer(), input, raw -> {
            if (!NativeSession.text(raw, "type", "").equals("scryDecision"))
                throw new IllegalArgumentException("Expected scry placement");
            var piles = raw.getAsJsonArray("zoneCardIds");
            if (piles == null || piles.size() != 2) throw new IllegalArgumentException("Expected two scry piles");
            var result = List.of(new CardCollection(), new CardCollection());
            var seen = new HashSet<String>();
            for (int index = 0; index < 2; index++) {
                for (var value : piles.get(index).getAsJsonArray()) {
                    String id = value.getAsString();
                    Card card = candidates.stream().filter(c -> NativeSession.cardId(c).equals(id)).findFirst().orElse(null);
                    if (card == null || !seen.add(id)) throw new IllegalArgumentException("Invalid scry card");
                    result.get(index).add(card);
                }
            }
            if (seen.size() != candidates.size()) throw new IllegalArgumentException("Incomplete scry placement");
            return org.apache.commons.lang3.tuple.ImmutablePair.of(result.get(0), result.get(1));
        });
    }
    @Override public List<SpellAbility> chooseSpellAbilityToPlay() {
        landUndo.finishLand();
        List<SpellAbility> choices;
        try {
            choices = super.chooseSpellAbilityToPlay();
        } finally {
            // This covers exactly one native priority decision, even when Forge yields internally.
            ownStackAction = null;
        }
        if (choices == null || choices.isEmpty()) {
            landUndo.clear();
            if (getGame().getStack().canUndo(getPlayer())) getGame().getStack().clearUndoStack();
        }
        return choices;
    }
    boolean priorityAfterOwnStackAction() {
        var action = ownStackAction;
        if (action == null) return false;
        // State-based actions and pending triggers run before priority. Keep the
        // window if an opponent put anything above our action in the meantime.
        for (var item : getGame().getStack()) {
            if (item == action) return true;
            if (item.getSpellAbility().getActivatingPlayer() != getPlayer()) return false;
        }
        return false;
    }
    @Override public boolean playChosenSpellAbility(SpellAbility ability) {
        // Affordability previews can leave a planned color on the reusable ability.
        // Manual activation of an irreversible source must ask the player again.
        if (ability.isManaAbility() && !ability.isUndoable())
            ability.setManaExpressChoice(ColorSet.fromMask(0));
        landUndo.begin(ability);
        var previousStack = new HashSet<Integer>();
        for (var item : getGame().getStack()) previousStack.add(item.getId());
        boolean played = deciding(ability, () -> super.playChosenSpellAbility(ability));
        if (played && !ability.isManaAbility() && (ability.isSpell() || ability.isActivatedAbility())) {
            // Forge can copy the chosen ability for alternate costs or an activation.
            // Inspect the actual stack to exclude special actions, land drops and failed casts.
            for (var item : getGame().getStack()) {
                SpellAbility placed = item.getSpellAbility();
                if (!previousStack.contains(item.getId()) && placed.getActivatingPlayer() == getPlayer()
                        && placed.getHostCard().getId() == ability.getHostCard().getId()
                        && !placed.isTrigger() && !placed.isCopied() && (placed.isSpell() || placed.isActivatedAbility())) {
                    ownStackAction = item;
                    break;
                }
            }
        }
        landUndo.finishMana(ability, played);
        return played;
    }
    @Override public void playSpellAbilityNoStack(SpellAbility ability, boolean canSetupTargets) {
        deciding(ability, () -> { super.playSpellAbilityNoStack(ability, canSetupTargets); return null; });
    }
    @Override public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        return deciding(ability, () -> super.announceRequirements(ability, min, max, announce));
    }
    @Override public int chooseNumber(SpellAbility ability, String title, int min, int max) {
        return deciding(ability, () -> super.chooseNumber(ability, title, min, max));
    }
    @Override public int chooseNumber(SpellAbility ability, String title, List<Integer> choices, Player relatedPlayer) {
        return deciding(ability, () -> super.chooseNumber(ability, title, choices, relatedPlayer));
    }
    @Override public String chooseCardName(SpellAbility ability, Predicate<ICardFace> predicate, String valid, String message) {
        return deciding(ability, () -> super.chooseCardName(ability, predicate, valid, message));
    }
    @Override public String chooseCardName(SpellAbility ability, List<ICardFace> faces, String message) {
        return deciding(ability, () -> super.chooseCardName(ability, faces, message));
    }
}
