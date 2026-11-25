// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.common.eventbus.Subscribe;
import forge.card.CardStateName;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.event.Event;
import forge.game.event.EventValueChangeType;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventCardStatsChanged;
import forge.game.event.GameEventCardTapped;
import forge.game.event.GameEventLandPlayed;
import forge.game.event.GameEventPlayerStatsChanged;
import forge.game.event.GameEventZone;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.Zone;
import forge.game.zone.ZoneType;
import java.util.ArrayDeque;
import java.util.Deque;

/** Records only land plays that can be reversed without reversing another game event. */
final class NativeLandUndo {
    record Entry(Card card, Zone hand, int index, CardStateName face, boolean backSide,
                 boolean tapped, boolean sick, long timestamp, long layerTimestamp,
                 int turnInZone, Player turnInController, SpellAbility previousMana) {
        Entry(Card card, Zone hand, SpellAbility previousMana) {
            this(card, hand, hand.getCards().indexOf(card), card.getCurrentStateName(),
                    card.isBackSide(), card.isTapped(), card.hasSickness(), card.getGameTimestamp(),
                    card.getLayerTimestamp(), card.getTurnInZone(), card.getTurnInController(), previousMana);
        }
    }

    private final Game game;
    private final Player player;
    private final Deque<Entry> history = new ArrayDeque<>();
    private Entry candidate;
    private boolean unsafe;

    NativeLandUndo(Game game, Player player) {
        this.game = game;
        this.player = player;
        game.subscribeToEvents(this);
    }

    synchronized void begin(SpellAbility ability) {
        if (!ability.isLandAbility()) {
            if (!ability.isManaAbility()) history.clear();
            return;
        }

        Card card = ability.getHostCard();
        Zone hand = player.getZone(ZoneType.Hand);
        if (atPriority() && card.getZone() == hand && card.getOwner() == player
                && card.getController() == player && !card.isFaceDown() && card.getCounters().isEmpty()
                && ability.getMayPlay() == null && hand.contains(card)) {
            candidate = new Entry(card, hand, game.getStack().peekUndoStack());
            unsafe = false;
        } else {
            clear();
        }
    }

    @Subscribe
    public synchronized void observe(Event event) {
        if (candidate == null || unsafe) return;
        int id = candidate.card().getId();
        // The normal land move publishes two zone events, a change-zone event,
        // and a land-play event. Allow a tap on that card and continuous updates.
        // Other changes (life payments, tokens, new zones, etc.) commit the play.
        unsafe = switch (event) {
            case GameEventZone zone -> {
                // Game.copyLastState also publishes updates on unattached LKI copies.
                if (zone.mode() == EventValueChangeType.ComplexUpdate && zone.player() == null) yield false;
                yield zone.card() == null || zone.card().getId() != id
                        || !(zone.zoneType() == ZoneType.Hand && zone.mode() == EventValueChangeType.Removed
                            || zone.zoneType() == ZoneType.Battlefield && zone.mode() == EventValueChangeType.Added);
            }
            case GameEventCardChangeZone change -> change.card().getId() != id
                    || change.from() == null || change.from().zoneType() != ZoneType.Hand
                    || change.to() == null || change.to().zoneType() != ZoneType.Battlefield;
            case GameEventCardTapped tap -> tap.card().getId() != id;
            case GameEventLandPlayed land -> land.land().getId() != id;
            case GameEventCardStatsChanged ignored -> false;
            case GameEventPlayerStatsChanged ignored -> false;
            default -> true;
        };
    }

    synchronized void finishLand() {
        if (candidate == null) return;
        if (!unsafe && atPriority() && candidate.card().isInPlay()
                && candidate.card().getController() == player && !candidate.card().isFaceDown()) {
            history.push(candidate);
        } else {
            history.clear();
        }
        candidate = null;
    }

    synchronized void finishMana(SpellAbility ability, boolean played) {
        if (played && ability.isManaAbility()
                && (game.getStack().peekUndoStack() != ability
                    || !NativePriorityManaUndo.canUndo(player, ability))) {
            history.clear();
        }
    }

    synchronized void clear() {
        history.clear();
        candidate = null;
    }

    private boolean atPriority() {
        return !game.isGameOver() && player.isInGame()
                && game.getPhaseHandler().getPriorityPlayer() == player && game.getStack().isEmpty();
    }

    synchronized Entry source() {
        Entry latest = history.peek();
        if (latest == null || !atPriority() || !latest.card().isInPlay()
                || latest.card().getController() != player) return null;

        SpellAbility latestMana = game.getStack().peekUndoStack();
        // Preserve mana depending on the presence of this new land. Existing
        // mana activations can remain when their native undo ledger permits it.
        if (latestMana != null && latestMana != latest.previousMana()) return null;
        return latest;
    }

    synchronized void undo(Entry entry) {
        if (entry != source()) return;
        history.pop();
        Card card = entry.card();
        Zone battlefield = card.getZone();
        battlefield.removeRollbackEntry(card, ZoneType.Hand);
        battlefield.remove(card);
        card.setTapped(entry.tapped());
        card.setSickness(entry.sick());
        card.setBackSide(entry.backSide());
        card.setState(entry.face(), true);
        card.setGameTimestamp(entry.timestamp());
        card.setLayerTimestamp(entry.layerTimestamp());
        card.setTurnInZone(entry.turnInZone());
        card.setTurnInController(entry.turnInController());
        entry.hand().add(card, Math.min(entry.index(), entry.hand().size()), null, true);
        player.undoLandPlayedThisTurn();
        game.getAction().checkStaticAbilities();
        game.getTriggerHandler().resetActiveTriggers();
        game.copyLastState();
    }
}
