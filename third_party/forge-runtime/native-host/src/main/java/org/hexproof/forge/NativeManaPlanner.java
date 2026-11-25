// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.common.collect.Multimap;
import forge.ai.ComputerUtilMana;
import forge.ai.ComputerUtilMana.HumanPaymentPlan;
import forge.card.CardStateName;
import forge.card.MagicColor;
import forge.card.mana.ManaAtom;
import forge.card.mana.ManaCostShard;
import forge.game.ability.AbilityUtils;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.card.CardCopyService;
import forge.game.cost.CostPayLife;
import forge.game.cost.CostTap;
import forge.game.cost.CostPart;
import forge.game.cost.CostSacrifice;
import forge.game.cost.CostRemoveCounter;
import forge.game.cost.CostPayment;
import forge.game.mana.Mana;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.trigger.TriggerType;
import forge.game.zone.ZoneType;
import java.util.*;

/** Forecast mana use on copies of costs. Only Forge's native payment code activates a source. */
final class NativeManaPlanner {
    private record Option(SpellAbility ability, String choice, List<Mana> output, int life) {}
    private record Source(List<Option> options) {}
    private record Spell(SpellAbility ability, ManaCostBeingPaid cost) {}
    private record State(BitSet used, List<Mana> floating, int life) {}
    private record Future(int card, State state) {}
    private record Step(Option option, List<Mana> spent) {}
    private interface Paid { void accept(State remainder, List<Step> steps); }

    private final Player payer;
    private final List<Source> sources = new ArrayList<>();
    private final List<List<Spell>> hand = new ArrayList<>();
    // Enumerating allocations and subsets is exponential on very large boards.
    // Always keep the best complete payment found. The native preview checks it again.
    private int budget = 40_000;
    private int futureBudget;
    private int initialSources;
    private boolean converge;
    private int colorsAlreadySpent;
    private final Map<Future, Integer> knownCasts = new HashMap<>();
    private Score best;
    private HumanPaymentPlan result;

    static HumanPaymentPlan plan(ManaCostBeingPaid due, SpellAbility casting, Player payer,
                                 Multimap<Integer, SpellAbility> available) {
        NativeManaPlanner planner = new NativeManaPlanner(payer);
        planner.collectSources(available, casting);
        if (planner.sources.isEmpty() && payer.getManaPool().isEmpty()) return null;
        planner.collectHand(casting);
        List<Mana> pool = new ArrayList<>();
        payer.getManaPool().forEach(pool::add);
        // Model a floating globe as its own selectable resource, so paying generic does not
        // automatically consume the only blue mana when a colorless land is available.
        for (Mana mana : pool) {
            planner.sources.add(floatingSource(mana));
        }
        planner.initialSources = planner.sources.size();
        planner.converge = casting.getHostCard().hasConverge();
        planner.colorsAlreadySpent = due.getColorsPaid();
        State initial = new State(new BitSet(), List.of(), payer.getLife());
        planner.pay(new Spell(casting, due), due, initial, 0, new ArrayList<>(), planner::score, false);
        return planner.result;
    }

    private static Source floatingSource(Mana mana) {
        return new Source(List.of(new Option(null, "", List.of(mana), 0)));
    }

    private NativeManaPlanner(Player payer) { this.payer = payer; }

    static int activationLife(SpellAbility ability, Player payer) {
        int life = 0;
        for (var cost : ability.getPayCosts().getCostParts())
            if (cost instanceof CostPayLife) life += cost.getAbilityAmount(ability);
        if (!payer.canLoseLife()) return life;
        for (SpellAbility part = ability; part != null; part = part.getSubAbility())
            life += selfDamage(part, ability.getHostCard(), payer);
        for (var trigger : ability.getHostCard().getTriggers())
            if (trigger.getMode() == TriggerType.Taps || trigger.getMode() == TriggerType.TapsForMana)
                life += selfDamage(trigger.getOverridingAbility(), ability.getHostCard(), payer);
        return life;
    }

    private static int selfDamage(SpellAbility part, Card source, Player payer) {
        if (part == null || !"You".equals(part.getParam("Defined"))) return 0;
        if (part.getApi() == ApiType.LoseLife)
            return AbilityUtils.calculateAmount(source, part.getParamOrDefault("LifeAmount", "1"), part);
        if (part.getApi() != ApiType.DealDamage) return 0;
        return payer.staticReplaceDamage(AbilityUtils.calculateAmount(source, part.getParam("NumDmg"), part), source, false);
    }

    private void collectSources(Multimap<Integer, SpellAbility> available, SpellAbility casting) {
        Map<Card, List<Option>> grouped = new LinkedHashMap<>();
        for (SpellAbility ability : new LinkedHashSet<>(available.values())) {
            var part = ability.getManaPart();
            if (ability.getHostCard() == casting.getHostCard() || part == null || !ability.canPlay(true)
                    || !ability.checkRestrictions(payer) || !CostPayment.canPayAdditionalCosts(ability.getPayCosts(), ability, false))
                continue;
            // Sources that consume another permanent, a shared counter pool, or mana
            // cannot be projected as independent activations. Forge may still use them.
            if (!ability.getPayCosts().getCostParts().stream().allMatch(NativeManaPlanner::independentCost)) continue;
            if (part.isComboMana() && ability.amountOfManaGenerated(false) != 1) continue;
            int life = activationLife(ability, payer);
            if (!safeAtLife(life, payer.getLife())) continue;
            String original = part.getExpressChoice();
            try {
                Set<String> tried = new HashSet<>();
                for (byte color : ManaAtom.MANATYPES) {
                    if (!available.containsEntry((int)color, ability)) continue;
                    String choice = part.isAnyMana() || part.isComboMana() || ability.getApi() == ApiType.ManaReflected
                            ? MagicColor.toShortString(color) : "";
                    if (part.isAnyMana() && color == ManaAtom.COLORLESS) continue;
                    if (part.isComboMana() && !Arrays.asList(part.getComboColors(ability).split(" ")).contains(choice)) continue;
                    if (!tried.add(choice)) continue;
                    if (!choice.isEmpty()) part.setExpressChoice(choice);
                    String predicted = ComputerUtilMana.predictMana(ability, payer, ManaCostShard.valueOf(color));
                    if (!predicted.matches("[WUBRGC]( [WUBRGC])*")) continue;
                    List<Mana> output = new ArrayList<>();
                    for (String unit : predicted.split(" "))
                        output.add(new Mana(ManaAtom.fromName(unit), ability.getHostCard(), part, payer));
                    grouped.computeIfAbsent(ability.getHostCard(), ignored -> new ArrayList<>())
                            .add(new Option(ability, choice, output, life));
                }
            } finally {
                part.setExpressChoice(original);
            }
        }
        for (List<Option> options : grouped.values()) sources.add(new Source(options));
    }

    private static boolean independentCost(CostPart cost) {
        return cost instanceof CostTap || cost instanceof CostPayLife
                || ((cost instanceof CostSacrifice || cost instanceof CostRemoveCounter) && cost.payCostFromSource());
    }

    private boolean safeAtLife(int loss, int life) {
        return loss <= 0 || loss < life || payer.cantLoseForZeroOrLessLife();
    }

    private void collectHand(SpellAbility casting) {
        for (Card card : payer.getCardsIn(ZoneType.Hand)) {
            if (card == casting.getHostCard()) continue;
            List<Spell> alternatives = new ArrayList<>();
            List<SpellAbility> modes = new ArrayList<>(card.getSpells());
            if (card.isModal() && card.hasState(CardStateName.Backside))
                modes.addAll(card.getState(CardStateName.Backside).getNonManaAbilities());
            if (card.hasState(CardStateName.Secondary))
                modes.addAll(card.getState(CardStateName.Secondary).getNonManaAbilities());
            for (SpellAbility printed : modes) {
                if (!printed.isSpell() || printed.getPayCosts() == null || printed.getPayCosts().hasNoManaCost()) continue;
                Card forecastCard = CardCopyService.getLKICopy(card);
                forecastCard.setZone(card.getZone());
                CardStateName face = printed.getCardStateName();
                if (face != null && forecastCard.hasState(face)) forecastCard.setState(face, false);
                SpellAbility spell = printed.copy(forecastCard, payer, true);
                var phase = payer.getGame().getPhaseHandler();
                if ((!phase.isPlayerTurn(payer) || !phase.getPhase().isMain()) && !spell.withFlash(forecastCard, payer)) continue;
                if (!spell.checkRestrictions(payer) || !spell.getRestrictions().checkTimingRestrictions(forecastCard, spell)
                        || !spell.getRestrictions().checkOtherRestrictions(forecastCard, spell, payer)
                        || !CostPayment.canPayAdditionalCosts(spell.getPayCosts(), spell, false)) continue;
                if (spell.usesTargeting() && spell.getTargetRestrictions().getMinTargets(forecastCard, spell) > 0
                        && !spell.getTargetRestrictions().hasCandidates(spell)) continue;
                ManaCostBeingPaid cost = ComputerUtilMana.calculateManaCost(spell.getPayCosts(), spell, payer, true, 0, false);
                alternatives.add(new Spell(spell, cost));
            }
            if (!alternatives.isEmpty()) hand.add(alternatives);
        }
        hand.sort(Comparator.comparingInt(modes -> modes.get(0).cost().getConvertedManaCost()));
    }

    private void pay(Spell spell, ManaCostBeingPaid cost, State state, int from, List<Step> steps,
                     Paid paid, boolean future) {
        if (--budget < 0 || (future && --futureBudget < 0)) return;
        if (cost.isPaid()) {
            paid.accept(state, steps);
            return;
        }
        for (int i = state.used().nextClearBit(from); i < sources.size() && budget > 0; i = state.used().nextClearBit(i + 1)) {
            if (future && futureBudget <= 0) return;
            for (Option option : sources.get(i).options()) {
                if (!safeAtLife(option.life(), state.life())) continue;
                ManaCostBeingPaid remaining = new ManaCostBeingPaid(cost);
                List<Mana> spare = new ArrayList<>(state.floating());
                List<Mana> spent = new ArrayList<>();
                for (Mana mana : option.output()) {
                    if (spend(mana, remaining, spell.ability())) spent.add(mana);
                    else spare.add(mana);
                }
                if (spent.isEmpty()) continue;
                BitSet used = (BitSet)state.used().clone();
                used.set(i);
                steps.add(new Step(option, spent));
                pay(spell, remaining, new State(used, spare, state.life() - option.life()), i + 1, steps, paid, future);
                steps.remove(steps.size() - 1);
            }
        }
    }

    private boolean spend(Mana mana, ManaCostBeingPaid cost, SpellAbility spell) {
        return mana.meetsManaRestrictions(spell) && spell.allowsPayingWithShard(mana.getSourceCard(), mana.getColor())
                && cost.isNeeded(mana, payer.getManaPool()) && cost.payMana(mana, payer.getManaPool());
    }

    private int futureCasts(int card, State state) {
        if (card >= hand.size() || budget <= 0 || futureBudget <= 0) return 0;
        if (!state.floating().isEmpty()) {
            // Surplus from a multi-mana activation can fund any later hand spell.
            // Give every globe a separate choice, preserving its source restrictions.
            int before = sources.size();
            try {
                for (Mana mana : state.floating()) sources.add(floatingSource(mana));
                return futureCasts(card, new State(state.used(), List.of(), state.life()));
            } finally {
                sources.subList(before, sources.size()).clear();
            }
        }
        // Temporary surplus slots have branch-specific identities. Cache only states
        // expressed in the original input's source indices, after complete searches.
        Future key = sources.size() == initialSources ? new Future(card, state) : null;
        Integer known = key == null ? null : knownCasts.get(key);
        if (known != null) return known;
        int[] bestCount = {0};
        for (Spell spell : hand.get(card)) {
            pay(spell, spell.cost(), state, 0, new ArrayList<>(),
                    (next, steps) -> bestCount[0] = Math.max(bestCount[0], 1 + futureCasts(card + 1, next)), true);
            if (bestCount[0] == hand.size() - card) {
                if (key != null) knownCasts.put(key, bestCount[0]);
                return bestCount[0];
            }
        }
        int count = Math.max(bestCount[0], futureCasts(card + 1, state));
        if (key != null && budget > 0 && futureBudget > 0) knownCasts.put(key, count);
        return count;
    }

    private record Score(int spells, int colors, int lifeLeftToSpend, int convergeColors, int currentLife, int activations, int excess) {
        boolean beats(Score other) {
            if (other == null || spells != other.spells) return other == null || spells > other.spells;
            if (colors != other.colors) return colors > other.colors;
            if (lifeLeftToSpend != other.lifeLeftToSpend) return lifeLeftToSpend < other.lifeLeftToSpend;
            if (convergeColors != other.convergeColors) return convergeColors > other.convergeColors;
            if (currentLife != other.currentLife) return currentLife > other.currentLife;
            if (activations != other.activations) return activations < other.activations;
            return excess < other.excess;
        }
    }

    private void score(State state, List<Step> steps) {
        int colors = 0, life = 0;
        for (Mana mana : state.floating()) colors |= mana.getColor();
        for (int i = state.used().nextClearBit(0); i < sources.size(); i = state.used().nextClearBit(i + 1)) {
            Map<Byte, Integer> price = new HashMap<>();
            for (Option option : sources.get(i).options()) {
                if (!safeAtLife(option.life(), state.life())) continue;
                for (Mana mana : option.output()) {
                    colors |= mana.getColor();
                    price.merge(mana.getColor(), option.life(), Math::min);
                }
            }
            // A painland's colorless mode is free but accessing a color can cost life.
            if (!price.isEmpty()) life += Collections.max(price.values());
        }
        futureBudget = 1200;
        int count = futureCasts(0, state);
        int activations = (int)steps.stream().filter(s -> s.option().ability() != null).count();
        int colorsSpent = 0;
        if (converge) {
            colorsSpent = colorsAlreadySpent;
            for (Step step : steps)
                for (Mana mana : step.spent()) colorsSpent |= mana.getColor();
        }
        Score score = new Score(count, Integer.bitCount(colors & ManaAtom.ALL_MANA_COLORS), life,
                Integer.bitCount(colorsSpent & ManaAtom.ALL_MANA_COLORS), state.life(), activations, state.floating().size());
        if (!score.beats(best)) return;
        best = score;
        Map<SpellAbility, String> choices = new LinkedHashMap<>();
        List<Mana> pool = new ArrayList<>();
        for (Step step : steps) {
            if (step.option().ability() != null) choices.put(step.option().ability(), step.option().choice());
            else pool.addAll(step.spent());
        }
        result = new HumanPaymentPlan(choices, pool);
    }
}
