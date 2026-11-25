// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonObject;
import forge.card.CardStateName;
import forge.game.Game;
import forge.game.GameAction;
import forge.game.card.Card;
import forge.game.event.EventValueChangeType;
import forge.game.event.GameEventZone;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/** Per-game knowledge obtained by a particular player or by the whole table. */
final class NativeHandKnowledge {
    private static final int PUBLIC = -1;
    private record Known(int id, String name, JsonObject face, Set<Integer> viewers) {
        boolean visibleTo(int viewer) { return viewers.contains(PUBLIC) || viewers.contains(viewer); }
    }
    private final Game game;
    private final Map<Player, Map<Integer, Known>> hands = new HashMap<>();
    private final Map<Player, Known> tops = new HashMap<>();
    private final Map<Integer, Set<Integer>> draws = new HashMap<>();
    private final Map<Integer, Set<Integer>> arriving = new HashMap<>();
    private final Set<Integer> departing = new HashSet<>();
    private final Map<Player, Integer> belowTop = new HashMap<>();

    NativeHandKnowledge(Game game) {
        this.game = game;
        game.subscribeToEvents(this);
    }

    private int viewerId(Player viewer) { return viewer == null ? PUBLIC : viewer.getId(); }

    private Known shown(Card card) {
        return new Known(card.getId(), card.getState(CardStateName.Original).getName(),
                NativeSnapshot.knownFace(game, card), new HashSet<>());
    }

    private void rememberHand(Card card, int viewer) {
        if (!card.isInZone(ZoneType.Hand) || card.isFaceDown()
                || !card.getZone().contains(actual -> actual == card)) return;
        Player owner = card.getZone().getPlayer();
        hands.computeIfAbsent(owner, ignored -> new HashMap<>())
                .computeIfAbsent(card.getId(), ignored -> shown(card)).viewers().add(viewer);
    }

    synchronized void sawHand(Iterable<Card> cards, Player viewer) {
        Player receiver = viewer.isControlled() ? viewer.getControllingPlayer() : viewer;
        for (Card card : cards) {
            rememberHand(card, receiver.getId());
        }
    }

    @Subscribe public synchronized void revealHand(GameAction.PublicHandReveal reveal) {
        for (Card card : reveal.cards()) rememberHand(card, PUBLIC);
    }

    @Subscribe public synchronized void revealTop(GameAction.RevealedLibraryTop reveal) {
        Player receiver = reveal.recipient();
        if (receiver != null && receiver.isControlled()) receiver = receiver.getControllingPlayer();
        rememberTop(reveal.card(), receiver);
    }

    synchronized void rememberTop(Card card, Player receiver) {
        if (!card.isInZone(ZoneType.Library) || card.isFaceDown() || card.getZone().isEmpty()
                || card.getZone().get(0) != card) return;
        Player owner = card.getZone().getPlayer();
        Known top = tops.get(owner);
        if (top == null || top.id() != card.getId()) {
            top = shown(card);
            tops.put(owner, top);
        }
        top.viewers().add(viewerId(receiver));
    }

    @Subscribe public synchronized void placement(GameAction.PlacementBelowTop move) {
        belowTop.put(move.library().getPlayer(), move.card().getId());
    }

    @Subscribe public synchronized void moving(GameAction.MovingCard move) {
        Card card = move.card();
        arriving.remove(card.getId());
        if (move.from().is(ZoneType.Hand)) {
            departing.add(card.getId());
            Map<Integer, Known> hand = hands.get(move.from().getPlayer());
            if (hand == null) return;
            if (move.to().getZoneType().isHidden() || move.hiddenDestination()) {
                // Even an actually unknown card may have been the remembered one.
                hand.clear();
            } else {
                String printedName = card.getState(CardStateName.Original).getName();
                hand.values().removeIf(known -> known.name().equals(printedName));
            }
        } else if (move.to().is(ZoneType.Hand) && move.from().getZoneType().isKnown() && !move.faceDownOrigin() && !card.isFaceDown()) {
            arriving.put(card.getId(), Set.of(PUBLIC));
        }
    }

    @Subscribe public synchronized void draw(GameAction.TopDraw draw) {
        Card source = draw.source();
        if (draw.result() == null) {
            var viewers = new HashSet<Integer>();
            Known top = tops.get(source.getOwner());
            if (top != null && top.id() == source.getId()) viewers.addAll(top.viewers());
            if (NativePublicVisibility.isPubliclyShown(source)) viewers.add(PUBLIC);
            for (Player player : game.getRegisteredPlayers()) {
                if (source.mayContinuouslyLook(player) && NativeSnapshot.canSeeIdentity(source, player))
                    viewers.add(player.getId());
            }
            draws.put(source.getId(), viewers);
        } else {
            Set<Integer> viewers = draws.remove(source.getId());
            if (viewers == null || draw.result().getId() != source.getId()
                    || !draw.result().isInZone(ZoneType.Hand)) return;
            for (int viewer : viewers) rememberHand(draw.result(), viewer);
        }
    }

    @Subscribe public synchronized void zone(GameEventZone event) {
        if (event.player() == null) return; // Ignore changes to Forge's detached LKI zones.
        Player owner = game.getPlayer(event.player());
        if (event.zoneType() == ZoneType.Library) {
            // Hidden choices, reordering and shuffles can lose the top even when
            // Forge happens to put the same physical card back in that position.
            Integer fixedPlacement = belowTop.remove(owner);
            if (event.mode() != EventValueChangeType.Added || event.card() == null || fixedPlacement == null
                    || fixedPlacement != event.card().getId()) tops.remove(owner);
        } else if (event.zoneType() == ZoneType.Hand) {
            if (event.mode() == EventValueChangeType.ComplexUpdate || event.mode() == EventValueChangeType.Cleared) {
                hands.remove(owner);
            } else if (event.mode() == EventValueChangeType.Removed && event.card() != null) {
                if (!departing.remove(event.card().getId())) hands.remove(owner);
            } else if (event.mode() == EventValueChangeType.Added && event.card() != null) {
                Set<Integer> viewers = arriving.remove(event.card().getId());
                if (viewers != null) {
                    for (Card card : owner.getCardsIn(ZoneType.Hand)) {
                        if (card.getId() != event.card().getId()) continue;
                        for (int viewer : viewers) rememberHand(card, viewer);
                        break;
                    }
                }
            }
        }
    }

    synchronized JsonObject remembered(Card card, Player viewer) {
        Player owner = card.getZone().getPlayer();
        Known known = card.isInZone(ZoneType.Library) ? tops.get(owner)
                : hands.getOrDefault(owner, Map.of()).get(card.getId());
        if (known == null || known.id() != card.getId() || !known.visibleTo(viewerId(viewer))) return null;
        return known.face().deepCopy();
    }

    synchronized void sawVisibleHand(Card card, Player viewer) {
        if (viewer != card.getZone().getPlayer() && !card.isFaceDown()) rememberHand(card, viewerId(viewer));
    }
}
