// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import forge.game.StaticEffect;
import forge.game.card.Card;
import forge.game.zone.ZoneType;

/** Active, table-wide reveal permissions for otherwise hidden cards. */
final class NativePublicVisibility {
    private NativePublicVisibility() { }

    static boolean isPubliclyShown(Card card) {
        if (card.isFaceDown() || !(card.isInZone(ZoneType.Library) || card.isInZone(ZoneType.Hand))) return false;
        var game = card.getGame();
        if (card.isInZone(ZoneType.Library)) {
            // Forge can defer showing a new top card in the middle of casting or activating.
            var top = game.getTopLibForPlayer(card.getOwner());
            if (top != null && top != card) return false;
        }
        for (StaticEffect effect : game.getStaticEffects().getEffects()) {
            // Only a single rule granting every player access makes this public.
            // Two independent private looks must never grant a spectator access.
            if ("Player".equals(effect.getParams().get("MayLookAt")) && effect.getAffectedCards().contains(card)) return true;
        }
        return false;
    }
}
