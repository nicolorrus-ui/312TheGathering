// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import forge.deck.Deck;
import forge.deck.DeckFormat;
import forge.game.GameFormat;
import forge.model.FModel;
import java.util.List;

/** Used by the club hub for sanctioned formats with Forge's pinned format data. */
final class NativeClubDeckValidation {
    private NativeClubDeckValidation() { }

    static void validate(String format, List<Deck> decks) {
        if (format.isEmpty() || format.equals("custom")) return;
        GameFormat.Collection formats = FModel.getFormats();
        GameFormat rules = switch (format) {
            case "standard" -> formats.getStandard();
            case "pioneer" -> formats.getPioneer();
            case "modern" -> formats.getModern();
            case "legacy" -> formats.getLegacy();
            case "vintage" -> formats.getVintage();
            case "pauper" -> formats.getPauper();
            default -> null;
        };
        if (rules == null) throw new IllegalArgumentException("Forge deck format unavailable");
        var failures = new NativeDeckException.Builder();
        for (int player = 0; player < decks.size(); player++) {
            Deck deck = decks.get(player);
            if (DeckFormat.Constructed.getDeckConformanceProblem(deck) != null || !rules.isDeckLegal(deck)) {
                failures.add(player, "mainboard", -1, NativeDeckException.Code.FORMAT_VIOLATION);
            }
        }
        failures.rejectIfPresent();
    }
}
