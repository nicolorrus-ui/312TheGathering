// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.GameAction.PublicChoice;
import forge.game.card.Card;
import forge.game.ability.AbilityKey;
import forge.game.replacement.ReplacementType;
import forge.game.zone.ZoneType;
import java.util.Map;
import java.util.ArrayDeque;

/** Public, completed declarations; candidates and private choices never enter this journal. */
final class NativePublicChoices {
    private final Game game;
    private final ArrayDeque<JsonObject> recent = new ArrayDeque<>();
    private long sequence;

    NativePublicChoices(Game game) {
        this.game = game;
        game.subscribeToEvents(this);
    }

    @Subscribe public synchronized void declared(PublicChoice event) {
        var ability = event.ability();
        Card source = ability.getHostCard();
        if (source.isFaceDown() || event.value() == null || event.value().isBlank()) return;
        // An as-enters declaration happens before Forge installs the new battlefield object.
        // Other effects originating in a private zone cannot disclose their source here.
        var root = ability.getRootAbility();
        boolean entering = root.isReplacementAbility() && root.getReplacementEffect().getMode() == ReplacementType.Moved
                && root.getReplacingObject(AbilityKey.OriginalParams) instanceof Map<?, ?> moved
                && moved.get(AbilityKey.Destination) == ZoneType.Battlefield
                && moved.get(AbilityKey.Affected) instanceof Card enteringCard && enteringCard.getId() == source.getId()
                && !enteringCard.isFaceDown();
        if (!entering && !NativeSnapshot.canSeeIdentity(source, null)) return;
        JsonObject choice = new JsonObject();
        choice.addProperty("id", ++sequence);
        choice.addProperty("playerId", NativeSnapshot.playerId(game, event.player()));
        choice.addProperty("kind", event.kind());
        choice.addProperty("source", source.getName());
        choice.addProperty("value", event.value());
        if (recent.size() == 256) recent.removeFirst();
        recent.addLast(choice);
    }

    synchronized void project(JsonObject snapshot) {
        if (recent.isEmpty()) return;
        JsonArray choices = new JsonArray();
        recent.forEach(choices::add);
        snapshot.add("publicChoices", choices);
    }
}
