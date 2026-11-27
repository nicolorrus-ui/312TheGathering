// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.zone.ZoneType;
import forge.item.IPaperCard;
import forge.model.FModel;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Counts only named main-deck cards. No library positions, object IDs or unregistered names leave the engine. */
final class NativeLiveLibraries {
    private record Titles(Map<String, String> lookup, Set<String> registered) {}
    private final List<Titles> titles = new ArrayList<>();

    private record Printing(String name, String set, String number) {}

    NativeLiveLibraries(JsonArray players) {
        for (var player : players) {
            Map<String, String> exact = new HashMap<>();
            Map<String, String> fallback = new LinkedHashMap<>();
            Set<String> registered = new LinkedHashSet<>();
            Set<Printing> seen = new HashSet<>();
            for (var entry : player.getAsJsonObject().getAsJsonArray("deck")) {
                JsonObject row = entry.getAsJsonObject();
                String name = row.get("name").getAsString();
                registered.add(name);
                String set = NativeSession.text(row, "setCode", "");
                String number = NativeSession.text(row, "collectorNumber", "");
                if (!seen.add(new Printing(name, set, number))) continue;
                var db = FModel.getMagicDb();
                var paper = NativeSession.findCard(db.getCommonCards(), name, set, number);
                if (paper == null) paper = NativeSession.findCard(db.getVariantCards(), name, set, number);
                if (paper != null) {
                    exact.putIfAbsent(title(paper), name);
                    fallback.putIfAbsent(paper.getName(), name);
                }
            }
            // A Universes Within printing and its original can share a Forge rules name.
            fallback.forEach(exact::putIfAbsent);
            titles.add(new Titles(exact, registered));
        }
    }

    private static String title(IPaperCard paper) {
        return paper instanceof NativePromoCard promo ? promo.catalogName : paper.getDisplayName();
    }

    void project(Game game, JsonObject snapshot) {
        var players = game.getRegisteredPlayers();
        for (int i = 0; i < players.size(); i++) {
            Titles playerTitles = titles.get(i);
            Map<String, Integer> counts = new HashMap<>();
            for (var card : players.get(i).getCardsIn(ZoneType.Library)) {
                var paper = card.getPaperCard();
                if (paper == null || card.isToken()) continue;
                String registered = playerTitles.lookup.get(title(paper));
                if (registered == null) registered = playerTitles.lookup.get(paper.getName());
                if (registered != null) counts.merge(registered, 1, Integer::sum);
            }
            JsonObject summary = new JsonObject();
            // Iterate registration order, independent of the current shuffle.
            for (String name : playerTitles.registered) summary.addProperty(name, counts.getOrDefault(name, 0));
            snapshot.getAsJsonArray("players").get(i).getAsJsonObject().add("liveLibraryCounts", summary);
        }
    }
}
