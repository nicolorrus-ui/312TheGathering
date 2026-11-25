// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import forge.game.card.CardView;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;

/** Presentation of a zone-change search, detached from the physical ordering of the library. */
final class NativeLibrarySearch extends DelayedReveal {
    private static final long serialVersionUID = 1L;
    private final Comparator<CardView> displayOrder;

    private NativeLibrarySearch(DelayedReveal reveal, Player viewer) {
        super(List.of(), reveal.getZone(), reveal.getOwner(), reveal.getMessagePrefix());
        displayOrder = Comparator.comparing((CardView view) ->
                view.isFaceDown() && !view.canFaceDownBeShownTo(viewer.getView()) ? "" : view.getName(),
                String.CASE_INSENSITIVE_ORDER).thenComparingInt(CardView::getId);
        getCards().addAll(reveal.getCards());
        // A search with no choice can still produce a standalone private reveal.
        getCards().sort(displayOrder);
    }

    static DelayedReveal forZoneChange(DelayedReveal reveal, Player viewer) {
        return reveal != null && reveal.getZone().contains(ZoneType.Library)
                ? new NativeLibrarySearch(reveal, viewer) : reveal;
    }

    static List<CardView> visibleChoices(DelayedReveal reveal, List<?> candidates) {
        if (!(reveal instanceof NativeLibrarySearch search)) return reveal.getCards();
        // A search can also offer cards from another zone. Only the objects
        // Forge already supplied to this choice may join its authorized reveal.
        var seen = new HashSet<CardView>();
        List<CardView> eligible = new ArrayList<>();
        for (Object item : candidates) {
            CardView card = (CardView) item;
            if (seen.add(card)) eligible.add(card);
        }
        eligible.sort(search.displayOrder);
        for (CardView visible : search.getCards()) if (seen.add(visible)) eligible.add(visible);
        return eligible;
    }
}
