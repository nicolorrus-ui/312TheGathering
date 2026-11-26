// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import forge.LobbyPlayer;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.MagicColor;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.CardCollectionView;
import forge.util.collect.FCollectionView;
import forge.game.ability.ApiType;
import forge.game.ability.AbilityKey;
import forge.game.replacement.ReplacementEffect;
import forge.game.replacement.ReplacementHandler;
import forge.game.ability.AbilityUtils;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.cost.CostPart;
import forge.game.cost.CostPayLife;
import forge.game.player.Player;
import forge.game.player.actions.PayCostAction;
import forge.game.player.actions.ColorChoiceAction;
import forge.game.player.actions.ManaComboAction;
import forge.gamemodes.match.input.InputConfirm;
import forge.game.player.DelayedReveal;
import forge.game.zone.ZoneType;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityView;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.player.PlayerControllerHuman;
import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import java.util.function.Supplier;

/** Retains the actual native object that requires a synchronous human decision. */
final class NativeDecisionController extends PlayerControllerHuman implements ReplacementHandler.OrderChooser {
    private final NativeSession session;
    private final Integer starts;
    private final NativeReplacementOrder replacementOrder = new NativeReplacementOrder();

    @Override public ReplacementEffect chooseReplacement(List<ReplacementEffect> choices, Object event,
            Map<AbilityKey, Object> parameters, Map<ReplacementEffect, List<Map<AbilityKey, Object>>> damage) {
        return replacementOrder.choose(session, getPlayer(), choices, event, parameters, damage);
    }

    final NativeLandUndo landUndo;
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
    SpellAbility abilityFor(SpellAbilityView view) {
        return spellViewCache == null ? null : spellViewCache.get(view);
    }

    // Selection happens on the UI executor. Consumption is scoped to exactly one
    // play on the game executor, including nested or cancelled activation costs.
    private final AtomicReference<NativeManaChoices.Activation> pendingManaChoice = new AtomicReference<>();
    private final ThreadLocal<NativeManaChoices.Activation> resolvingManaChoice = new ThreadLocal<>();

    void queueManaChoice(NativeManaChoices.Activation choice) {
        pendingManaChoice.set(choice != null && !choice.output().isEmpty() ? choice : null);
    }

    @Override public boolean withManaActivation(SpellAbility ability, BooleanSupplier play) {
        var queued = pendingManaChoice.getAndSet(null);
        var previous = resolvingManaChoice.get();
        try {
            if (queued != null && queued.ability() == ability) {
                // The payment helper can have suggested a color needed for the
                // spell. Resolve the explicit manual choice against the full rules menu.
                ability.setManaExpressChoice(ColorSet.fromMask(0));
                resolvingManaChoice.set(queued);
            } else resolvingManaChoice.remove();
            return play.getAsBoolean();
        } finally {
            if (previous == null) resolvingManaChoice.remove();
            else resolvingManaChoice.set(previous);
        }
    }

    private boolean hasManaChoice(SpellAbility ability) {
        var selected = resolvingManaChoice.get();
        return selected != null && selected.ability() == ability;
    }

    private <T> T selectedOutput(SpellAbility ability, List<NativeManaChoices.Entry<T>> offered) {
        if (!hasManaChoice(ability)) return null;
        var expected = resolvingManaChoice.get().output();
        resolvingManaChoice.remove();
        for (var entry : offered) if (entry.symbols().equals(expected)) return entry.value();
        return null;
    }

    private byte pickManaColor(String title, SpellAbility ability, List<MagicColor.Color> colors, int count) {
        var entries = colors.stream().map(color -> NativeManaChoices.colorOption(color, count)).toList();
        var result = selectedOutput(ability, entries);
        if (result == null) {
            Byte remembered = macros().consumeRememberedColorChoice(colors);
            if (remembered != null) return remembered;
            result = NativeManaChoices.choose(session, getPlayer(), ability.getHostCard(), title, entries, false);
        }
        macros().addRememberedAction(new ColorChoiceAction(result));
        return result;
    }

    @Override public byte chooseColor(String title, SpellAbility ability, ColorSet colors) {
        if (ability != null && ability.getRootAbility().isManaAbility() && !colors.isColorless()
                && (colors.countColors() > 1 || hasManaChoice(ability))
                && (ability.getApi() == ApiType.Mana || ability.getApi() == ApiType.ManaReflected)) {
            int count = ability.getManaPart().isAnyMana() || ability.getApi() == ApiType.ManaReflected
                    ? ability.amountOfManaGenerated(false)
                    : ability.hasParam("Each") ? AbilityUtils.calculateAmount(ability.getHostCard(), ability.getParam("Each"), ability) : 1;
            return pickManaColor(title, ability, List.copyOf(colors.getOrderedColors()), count);
        }
        return super.chooseColor(title, ability, colors);
    }

    @Override public byte chooseManaColorAllowColorless(String title, SpellAbility ability, ColorSet colors) {
        if (ability.getRootAbility().isManaAbility() && !colors.isColorless()) {
            var offered = new ArrayList<>(colors.getOrderedColors());
            offered.add(MagicColor.Color.COLORLESS);
            int count = ability.getApi() == ApiType.ManaReflected ? ability.amountOfManaGenerated(false) : 1;
            return pickManaColor(title, ability, offered, count);
        }
        return super.chooseManaColorAllowColorless(title, ability, colors);
    }

    @Override public Map<Byte, Integer> specifyManaCombo(SpellAbility ability, ColorSet offered, int amount, boolean different) {
        if (!ability.getRootAbility().isManaAbility()) return super.specifyManaCombo(ability, offered, amount, different);
        var colors = offered.getOrderedColors().stream().filter(color -> color != MagicColor.Color.COLORLESS).toList();
        var entries = NativeManaChoices.combinations(colors, amount, different);
        var chosen = selectedOutput(ability, entries);
        if (chosen == null) {
            var remembered = macros().consumeRememberedManaCombo(colors, amount, different);
            if (remembered != null) return remembered;
            chosen = entries.isEmpty()
                    ? NativeManaChoices.allocate(session, getPlayer(), ability.getHostCard(), colors, amount, different)
                    : NativeManaChoices.choose(session, getPlayer(), ability.getHostCard(), "Choose mana", entries, false);
        }
        macros().addRememberedAction(new ManaComboAction(chosen));
        return chosen;
    }
    @Override public boolean confirmPayment(CostPart cost, String question, SpellAbility ability) {
        // A shock land's self-tap replacement offers exactly one alternative payment.
        if (cost instanceof CostPayLife && ability != null && ability.isReplacementAbility()
                && ability.getHostCard().isLand() && ability.getApi() == ApiType.Tap
                && "True".equals(ability.getParam("ETB")) && "Self".equals(ability.getParam("Defined"))
                && "You".equals(ability.getParam("UnlessPayer")) && "PayLife<2>".equals(ability.getParam("UnlessCost"))
                && ability.getSubAbility() == null && !ability.hasParam("UnlessSwitched")) {
            boolean paid = InputConfirm.confirm(this, ability, question, true, List.of("Pay 2 life", "Enters tapped"));
            if (paid) macros().addRememberedAction(new PayCostAction(ability.getCardView()));
            return paid;
        }
        return super.confirmPayment(cost, question, ability);
    }
    // Forge's modal callbacks run on the game thread; table input renders on its GUI thread.
    // Keep the declared scope while the controller waits, including when only a permanent matches.
    private volatile boolean includesOtherZones;
    boolean includesOtherZones() { return includesOtherZones; }

    private <T> T withOrigin(List<ZoneType> origin, Supplier<T> select) {
        return withChoiceScope(origin.stream().anyMatch(zone -> zone != ZoneType.Battlefield), select);
    }

    private <T> T withChoiceScope(boolean otherZones, Supplier<T> select) {
        boolean previous = includesOtherZones;
        includesOtherZones = otherZones;
        try { return select.get(); } finally { includesOtherZones = previous; }
    }

    private <T> T withChooseCardScope(SpellAbility ability, Supplier<T> select) {
        if (ability == null || ability.getApi() != ApiType.ChooseCard) return select.get();
        if (ability.hasParam("IncludeSpellsOnStack")) return withChoiceScope(true, select);
        // DefinedCards replaces the search pool with specific game objects.
        if (ability.hasParam("DefinedCards")) return select.get();
        if (ability.hasParam("AllCards")) return withChoiceScope(true, select);
        if (ability.hasParam("ChoiceZone")) return withOrigin(ZoneType.listValueOf(ability.getParam("ChoiceZone")), select);
        return select.get();
    }

    @Override public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> options, DelayedReveal reveal,
            SpellAbility ability, String title, boolean optional, Player target, Map<String, Object> params) {
        return withChooseCardScope(ability, () -> super.chooseSingleEntityForEffect(options, reveal, ability, title, optional, target, params));
    }

    @Override public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility ability,
            CardCollection candidates, DelayedReveal reveal, String prompt, boolean optional, Player decider) {
        boolean combined = consumeHandReveal(ability, reveal);
        Card chosen;
        if (combined && !optional && candidates.size() == 1) {
            // The desktop silently takes a forced singleton. Here the same dialog
            // is also the chooser's only view of the revealed hand.
            chosen = super.chooseEntitiesForEffect(candidates, 1, 1, reveal, ability, prompt, decider, null).getFirst();
        } else {
            chosen = withOrigin(origin, () -> super.chooseSingleCardForZoneChange(destination, origin, ability, candidates,
                    NativeLibrarySearch.forZoneChange(reveal, getPlayer()), prompt, optional, decider));
        }
        if (combined) rememberChosenHandCards(ability, chosen == null ? List.of() : List.of(chosen));
        return chosen;
    }

    private final ThreadLocal<Boolean> battlefieldBatch = new ThreadLocal<>();

    boolean selectingBattlefieldBatch() { return Boolean.TRUE.equals(battlefieldBatch.get()); }

    private <T> T selectBattlefieldBatch(Supplier<T> select) {
        if (selectingBattlefieldBatch()) return select.get();
        battlefieldBatch.set(true);
        try { return select.get(); } finally { battlefieldBatch.remove(); }
    }

    @Override public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility ability,
            CardCollection candidates, int min, int max, DelayedReveal reveal, String prompt, Player decider) {
        boolean combined = consumeHandReveal(ability, reveal);
        Supplier<List<Card>> select = () -> super.chooseCardsForZoneChange(destination, origin, ability, candidates, min, max,
                NativeLibrarySearch.forZoneChange(reveal, getPlayer()), prompt, decider);
        List<Card> chosen = withOrigin(origin, () -> destination == ZoneType.Battlefield ? selectBattlefieldBatch(select) : select.get());
        if (combined && chosen != null) rememberChosenHandCards(ability, chosen);
        return chosen;
    }

    @Override public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> options, int min, int max,
            DelayedReveal reveal, SpellAbility ability, String title, Player targetedPlayer, Map<String, Object> params) {
        // Dig (e.g. Collected Company) asks for its primary destination's cards
        // through the generic entity picker. The remaining pile has its own order.
        Supplier<List<T>> select = () -> super.chooseEntitiesForEffect(options, min, max, reveal, ability, title, targetedPlayer, params);
        return ability != null && ability.getApi() == ApiType.Dig &&
                ZoneType.smartValueOf(ability.getParamOrDefault("DestinationZone", "Hand")) == ZoneType.Battlefield
                ? selectBattlefieldBatch(select) : select.get();
    }

    @Override public CardCollectionView chooseCardsForEffect(CardCollectionView options, SpellAbility ability,
            String title, int min, int max, boolean optional, Map<String, Object> params) {
        if (handReveals.containsKey(ability) && ability.getApi() == ApiType.ChooseCard) {
            if (options.isEmpty()) {
                finishRevealForChoice(ability);
                return new CardCollection();
            }
            CardCollection shown = takeRevealedCards(ability);
            DelayedReveal hand = new DelayedReveal(shown, ZoneType.Hand, shown.getFirst().getOwner().getView());
            int upper = Math.min(max, options.size());
            int lower = optional ? 0 : Math.min(min, upper);
            return new CardCollection(super.chooseEntitiesForEffect(options, lower, upper, hand, ability, title, null, params));
        }
        Supplier<CardCollectionView> select = () -> super.chooseCardsForEffect(options, ability, title, min, max, optional, params);
        if (ability == null || ability.getApi() == null) return select.get();
        // Manifest and cloak choose the permanents entering face down. DigMultiple
        // uses this picker only for its extra pile, whose default zone is the battlefield.
        return switch (ability.getApi()) {
            case ChooseCard -> withChooseCardScope(ability, select);
            case Cloak, Manifest, ManifestDread -> selectBattlefieldBatch(select);
            case DigMultiple -> ZoneType.smartValueOf(ability.getParamOrDefault("ChosenZone", "Battlefield")) == ZoneType.Battlefield
                    ? selectBattlefieldBatch(select) : select.get();
            default -> select.get();
        };
    }

    @Override public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destination, SpellAbility source) {
        // Forge sometimes inserts a continuous effect into this list to choose
        // its timestamp relative to the entering cards. That choice is meaningful.
        if (destination == ZoneType.Battlefield && (source == null ||
                source.getApi() != ApiType.ReorderZone && !source.hasParam("StaticEffect")))
            return cards;
        return super.orderMoveToZoneList(cards, destination, source);
    }

    private record HandReveal(CardCollection cards, forge.game.player.PlayerView owner, String message, boolean addSuffix) {}
    private SpellAbility receivingReveal;
    private SpellAbility revealingResult;
    private final Map<SpellAbility, List<HandReveal>> handReveals = new java.util.IdentityHashMap<>();

    @Override public void revealForChoice(SpellAbility choice, Runnable disclose) {
        SpellAbility previous = receivingReveal;
        receivingReveal = choice;
        try { disclose.run(); } finally { receivingReveal = previous; }
    }

    @Override public void revealChoiceResult(SpellAbility choice, Runnable disclose) {
        SpellAbility previous = revealingResult;
        revealingResult = choice;
        try { disclose.run(); } finally { revealingResult = previous; }
    }

    private boolean consumeHandReveal(SpellAbility choice, DelayedReveal reveal) {
        List<HandReveal> hands = handReveals.get(choice);
        if (hands == null || hands.size() != 1) return false;
        HandReveal known = hands.getFirst();
        if (reveal == null || !reveal.getZone().equals(java.util.Set.of(ZoneType.Hand))
                || !known.owner().equals(reveal.getOwner()) || known.cards().size() != reveal.getCards().size()
                || !known.cards().stream().allMatch(card -> reveal.getCards().contains(card.getView()))) return false;
        handReveals.remove(choice);
        return true;
    }

    private final Map<SpellAbility, Map<Integer, String>> chosenHandCards = new java.util.IdentityHashMap<>();

    private void rememberChosenHandCards(SpellAbility choice, List<Card> cards) {
        Map<Integer, String> picked = new java.util.HashMap<>();
        for (Card card : cards) picked.put(card.getId(), card.getName());
        chosenHandCards.put(choice, picked);
    }

    @Override public boolean confirmAction(SpellAbility ability, forge.game.player.PlayerActionConfirmMode mode,
            String message, List<String> options, Card card, Map<String, Object> params) {
        Map<Integer, String> picked = chosenHandCards.get(ability);
        if (mode == forge.game.player.PlayerActionConfirmMode.ChangeZoneGeneral && picked != null && picked.isEmpty()) {
            // The combined picker already required an explicit submission of zero cards.
            chosenHandCards.remove(ability);
            return true;
        }
        return super.confirmAction(ability, mode, message, options, card, params);
    }

    private CardCollection takeRevealedCards(SpellAbility choice) {
        CardCollection cards = new CardCollection();
        List<HandReveal> hands = handReveals.remove(choice);
        if (hands != null) for (HandReveal hand : hands) cards.addAll(hand.cards());
        return cards;
    }

    private List<forge.game.card.CardView> namedFromHand = List.of();
    List<forge.game.card.CardView> namedFromHand() { return namedFromHand; }

    @Override public void finishRevealForChoice(SpellAbility choice) {
        chosenHandCards.remove(choice);
        List<HandReveal> hands = handReveals.remove(choice);
        if (hands != null) {
            for (HandReveal known : hands)
                super.reveal(known.cards(), ZoneType.Hand, known.owner(), known.message(), known.addSuffix());
        }
    }

    @Override protected void reveal(CardCollectionView cards, ZoneType zone,
            forge.game.player.PlayerView owner, String message, boolean addSuffix) {
        Map<Integer, String> picked = chosenHandCards.get(revealingResult);
        if (zone == ZoneType.Exile && picked != null && !cards.isEmpty()
                && cards.stream().allMatch(card -> !card.isFaceDown() && card.getName().equals(picked.get(card.getId())))) return;
        if (zone == ZoneType.Hand) {
            session.knowledge.sawHand(cards, getPlayer());
            if (receivingReveal != null && !cards.isEmpty()) {
                handReveals.computeIfAbsent(receivingReveal, ignored -> new ArrayList<>())
                        .add(new HandReveal(new CardCollection(cards), owner, message, addSuffix));
                return;
            }
        }
        super.reveal(cards, zone, owner, message, addSuffix);
    }

    @Override public void revealForDiscard(forge.game.card.CardCollectionView cards, Player owner) {
        session.knowledge.sawHand(cards, getPlayer());
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
    @Override public void notifyOfValue(SpellAbility ability, forge.game.GameObject target, String value) {
        // The completed public declaration is already recorded for the whole table.
        if (ability != null && ability.getApi() == ApiType.ChooseType) return;
        super.notifyOfValue(ability, target, value);
    }
    private final ThreadLocal<String> searchKind = new ThreadLocal<>();
    String searchKind() { return searchKind.get(); }

    private <T> T searchable(String kind, SpellAbility ability, Supplier<T> action) {
        String previous = searchKind.get();
        searchKind.set(kind);
        try { return deciding(ability, action); }
        finally { if (previous == null) searchKind.remove(); else searchKind.set(previous); }
    }

    @Override public String chooseSomeType(String kind, SpellAbility ability, java.util.Collection<String> options, boolean optional) {
        return searchable("type", ability, () -> super.chooseSomeType(kind, ability, options, optional));
    }
    @Override public String chooseCardName(SpellAbility ability, Predicate<ICardFace> predicate, String valid, String message) {
        return searchable("name", ability, () -> super.chooseCardName(ability, predicate, valid, message));
    }
    @Override public String chooseCardName(SpellAbility ability, List<ICardFace> faces, String message) {
        // Keep the exact Forge face/name options (including split faces), with
        // every physical card from the granted looks available for inspection.
        if (faces.isEmpty() || !handReveals.containsKey(ability))
            return searchable("name", ability, () -> super.chooseCardName(ability, faces, message));
        var previous = namedFromHand;
        namedFromHand = takeRevealedCards(ability).stream().map(Card::getView).toList();
        try { return searchable("name", ability, () -> super.chooseCardName(ability, faces, message)); }
        finally { namedFromHand = previous; }
    }
}
