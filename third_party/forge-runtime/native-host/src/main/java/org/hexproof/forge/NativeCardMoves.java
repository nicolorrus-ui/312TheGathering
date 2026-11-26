// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.GameAction;
import forge.game.GameActionUtil;
import forge.game.card.Card;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventSpellAbilityCast;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.game.zone.ZoneView;
import java.util.*;

/** Actual physical card movement, with a separate, bounded history for each viewer. */
final class NativeCardMoves {
    private static final int LIMIT = 32;
    private static final Set<ZoneType> ZONES = EnumSet.of(ZoneType.Hand, ZoneType.Library, ZoneType.Battlefield,
            ZoneType.Graveyard, ZoneType.Exile, ZoneType.Command);
    private record Location(String zone, int player, String object) { }
    private record End(Location location, Set<Integer> viewers, String castId) {
        End(Location location, Set<Integer> viewers) { this(location, viewers, null); }
        boolean visible(int viewer) { return location.zone().equals("stack") || viewers.contains(viewer); }
        JsonObject project(int viewer) {
            JsonObject end = new JsonObject();
            end.addProperty("zone", location.zone());
            end.addProperty("playerId", "player-" + location.player());
            if (visible(viewer)) end.addProperty("objectId", location.object());
            return end;
        }
    }
    private record Move(long id, End from, End to) { }
    private final Game game;
    private final NativeHandKnowledge knowledge;
    // A physical move to the stack can precede cost payment and can be rolled back.
    private record Announcement(String id, End from, Set<Integer> shownTo) { }
    private final Map<Integer, Announcement> entering = new HashMap<>();
    private long nextCast;
    private final Map<Integer, End> spells = new HashMap<>();
    private final Map<Integer, Set<Location>> lastVisible = new HashMap<>();
    // Private moves must not leave gaps in another viewer's sequence or evict their public history.
    private static final class History {
        final Deque<Move> recent = new ArrayDeque<>();
        long sequence;
        void add(End from, End to) {
            if (recent.size() == LIMIT) recent.removeFirst();
            recent.addLast(new Move(++sequence, from, to));
        }
    }
    private final Map<Integer, History> histories = new HashMap<>();

    NativeCardMoves(Game game, NativeHandKnowledge knowledge) {
        this.game = game;
        this.knowledge = knowledge;
        game.subscribeToEvents(this);
    }

    @Subscribe public synchronized void withdrawn(GameActionUtil.WithdrawnSpell event) {
        Card restored = event.card();
        Announcement cast = entering.remove(restored.getId());
        if (cast == null || !restored.isInZone(ZoneType.Hand) || !cast.from().location().zone().equals("hand")) return;
        for (int viewer : cast.shownTo()) {
            knowledge.sawVisibleHand(restored, viewer < 0 ? null : game.getRegisteredPlayers().get(viewer));
        }
    }

    @Subscribe public synchronized void zoneChanged(GameEventCardChangeZone event) {
        if (event.from() == null || event.to() == null || event.from().equals(event.to())) return;
        int cardId = event.card().getId();
        if (event.to().zoneType() == ZoneType.Stack) {
            End source = sourceEnd(event.from(), cardId);
            if (source != null) entering.put(cardId, new Announcement("casting-" + ++nextCast, source, new HashSet<>()));
        } else if (event.from().zoneType() == ZoneType.Stack) {
            entering.remove(cardId); // Includes cancelled casting before a stack instance exists.
            End stack = spells.remove(cardId);
            if (stack == null && event.to().zoneType() != ZoneType.Battlefield) return;
            Card arrived = game.findByView(event.card());
            if (stack == null) stack = resolvingToken(arrived);
            if (stack == null) return;
            End destination = zoneEnd(event.to(), cardId, arrived, false);
            if (destination != null) add(stack, destination, false);
        } else if (ZONES.contains(event.from().zoneType()) && ZONES.contains(event.to().zoneType())) {
            End source = sourceEnd(event.from(), cardId);
            End to = zoneEnd(event.to(), cardId, game.findByView(event.card()), false);
            if (source != null && to != null) add(source, to, false);
        }
    }

    private End resolvingToken(Card arrived) {
        // A resolved copy of a permanent spell becomes a token (CR 111.11). The
        // resolving stack instance still exists when Forge reports its real entry.
        if (arrived == null || !arrived.isToken() || !arrived.isInPlay()) return null;
        for (var instance : game.getStack()) {
            var ability = instance.getSpellAbility();
            if (ability.isSpell() && ability.isCopied() && instance.getSourceCard().getId() == arrived.getId()) {
                return stackEnd(instance.getId(), ability.getActivatingPlayer());
            }
        }
        return null;
    }

    private End stackEnd(int id, Player controller) {
        int player = game.getRegisteredPlayers().indexOf(controller);
        return player < 0 ? null : new End(new Location("stack", player, "stack-" + id), Set.of());
    }

    @Subscribe public synchronized void cast(GameEventSpellAbilityCast cast) {
        if (!cast.sa().isSpell()) return;
        for (var instance : game.getStack()) {
            if (instance.getId() != cast.si().getId()) continue;
            var ability = instance.getSpellAbility();
            Card card = ability.getHostCard();
            if (!ability.isSpell() || ability.isCopied() || card.isCopiedSpell() || card.isToken()) return;
            End stack = stackEnd(instance.getId(), ability.getActivatingPlayer());
            if (stack == null) return;
            Announcement castEntry = entering.remove(card.getId());
            if (castEntry != null) {
                stack = new End(stack.location(), stack.viewers(), castEntry.id());
                add(castEntry.from(), stack, false);
            }
            spells.put(card.getId(), stack);
            return;
        }
    }

    @Subscribe public synchronized void draw(GameAction.CardDrawn event) {
        Card card = event.card();
        int owner = game.getRegisteredPlayers().indexOf(card.getZone().getPlayer());
        if (owner < 0) return;
        End from = new End(new Location("library", owner, ""), Set.of());
        End to = zoneEnd(card.getZone().getView(), card.getId(), card, false);
        // A real draw is public even when neither endpoint is identifiable to this viewer.
        // Viewers of the destination already received the ordinary zone-change event.
        if (to != null) add(from, to, true);
    }

    private End sourceEnd(ZoneView zone, int id) {
        End end = zoneEnd(zone, id, null, true);
        if (end != null) lastVisible.values().forEach(locations -> locations.remove(end.location()));
        return end;
    }

    private End zoneEnd(ZoneView zone, int id, Card arrived, boolean source) {
        if (!ZONES.contains(zone.zoneType()) || zone.player() == null) return null;
        int owner = game.getRegisteredPlayers().indexOf(game.getPlayer(zone.player()));
        if (owner < 0) return null;
        Location location = new Location(zone.zoneType().name().toLowerCase(Locale.ROOT), owner, "card-" + id);
        Set<Integer> viewers = new HashSet<>();
        if (zone.zoneType() != ZoneType.Library) {
            for (int viewer = -1; viewer < game.getRegisteredPlayers().size(); viewer++) {
                if (zone.zoneType() == ZoneType.Hand && owner != viewer) continue;
                if (source) {
                    if (lastVisible.getOrDefault(viewer, Set.of()).contains(location)) viewers.add(viewer);
                } else if (arrived != null && arrived.isInZone(zone.zoneType()) && arrived.getZone().getPlayer() == game.getPlayer(zone.player())) {
                    Player player = viewer < 0 ? null : game.getRegisteredPlayers().get(viewer);
                    // A publicly placed face-down permanent may be located without showing its face.
                    if (zone.zoneType() == ZoneType.Battlefield || NativeSnapshot.canSeeIdentity(arrived, player)) viewers.add(viewer);
                }
            }
        }
        return new End(location, viewers);
    }

    private void add(End from, End to, boolean anonymousDraw) {
        for (int viewer = -1; viewer < game.getRegisteredPlayers().size(); viewer++) {
            boolean visible = from.visible(viewer) || to.visible(viewer);
            if (visible != anonymousDraw) {
                histories.computeIfAbsent(viewer, ignored -> new History()).add(from, to);
                if (!to.location().zone().equals("stack") && to.visible(viewer)) {
                    lastVisible.computeIfAbsent(viewer, ignored -> new HashSet<>()).add(to.location());
                }
            }
        }
    }

    synchronized void project(JsonObject snapshot, int viewer) {
        Set<Location> visible = new HashSet<>();
        for (var value : snapshot.getAsJsonArray("zones")) {
            var zone = value.getAsJsonObject();
            String name = zone.get("zone").getAsString();
            if (name.equals("library")) continue;
            int owner = Integer.parseInt(zone.get("ownerId").getAsString().substring(7));
            for (var valueCard : zone.getAsJsonArray("cards")) {
                var card = valueCard.getAsJsonObject();
                if (!card.has("id") || !"visible".equals(card.get("visibility").getAsString())) continue;
                String objectId = card.get("id").getAsString();
                visible.add(new Location(name, owner, objectId));
            }
        }
        lastVisible.put(viewer, visible);
        // The physical card enters the public stack zone before targets and costs are
        // finalized. Neither the announcement ID nor its public face identifies a slot
        // in a private hand. A cancelled attempt gets a new ID if it is announced again.
        if (!entering.isEmpty() && !game.isGameOver()) {
            Player observer = viewer < 0 ? null : game.getRegisteredPlayers().get(viewer);
            for (Card card : game.getStackZone().getCards()) {
                Announcement announcement = entering.get(card.getId());
                var ability = card.getCastSA();
                if (announcement == null || ability == null || !ability.isSpell() || ability.getActivatingPlayer() == null) continue;
                JsonObject pending = new JsonObject();
                pending.addProperty("id", announcement.id());
                pending.addProperty("controllerId", NativeSnapshot.playerId(game, ability.getActivatingPlayer()));
                pending.add("from", announcement.from().project(viewer));
                boolean faceDown = card.isFaceDown() || ability.isCastFaceDown();
                pending.addProperty("faceDown", faceDown);
                JsonObject face = new JsonObject();
                if (!faceDown && NativeSnapshot.canSeeIdentity(card, observer)) {
                    face = NativeSnapshot.identity(card);
                    if (face.has("name") && !face.get("name").getAsString().isBlank()) announcement.shownTo().add(viewer);
                }
                pending.add("identity", face);
                snapshot.add("pendingCast", pending);
                break;
            }
        }
        if (!spells.isEmpty()) {
            Map<String, String> casts = new HashMap<>();
            for (End spell : spells.values()) {
                if (spell.castId() != null) casts.put(spell.location().object(), spell.castId());
            }
            for (var value : snapshot.getAsJsonArray("stack")) {
                var object = value.getAsJsonObject();
                String castId = casts.get(object.get("id").getAsString());
                if (castId != null) object.addProperty("castId", castId);
            }
        }
        History history = histories.get(viewer);
        if (history == null) return;
        JsonArray moves = new JsonArray();
        for (Move event : history.recent) {
            JsonObject move = new JsonObject();
            move.addProperty("id", event.id());
            move.add("from", event.from().project(viewer)); move.add("to", event.to().project(viewer));
            if (event.to().castId() != null) move.addProperty("castId", event.to().castId());
            moves.add(move);
        }
        snapshot.add("cardMoves", moves);
    }
}
