// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.ability.AbilityKey;
import forge.game.card.Card;
import forge.game.card.CounterType;
import forge.game.player.Player;
import forge.game.replacement.ReplacementEffect;
import forge.game.replacement.ReplacementLayer;
import forge.game.replacement.ReplacementType;
import forge.game.spellability.SpellAbility;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import static org.hexproof.forge.NativeSession.object;
import static org.hexproof.forge.NativeSession.text;

/** One decision seat in one game. Forge supplies the legal choices anew after each replacement. */
final class NativeReplacementOrder {
    private record CardRole(String name, String state, Integer controller, Integer owner) { }
    private record Effect(CardRole source, ReplacementType event, ReplacementLayer layer, String description,
                          Map<String, String> parameters, String script, Map<Map<AbilityKey, Object>, Integer> events) { }
    private record Current(int id, Effect effect) { }
    private record Answer(List<Integer> indices, boolean memorize) { }
    private final Map<Set<Effect>, List<Effect>> remembered = new HashMap<>();
    private final Map<Set<Current>, List<Current>> rememberedCopies = new HashMap<>();
    private final Map<Object, List<Integer>> continuing = new WeakHashMap<>();

    ReplacementEffect choose(NativeSession session, Player player, List<ReplacementEffect> choices, Object event,
            Map<AbilityKey, Object> parameters, Map<ReplacementEffect, List<Map<AbilityKey, Object>>> damage) {
        if (choices.size() == 1) return choices.getFirst();
        Map<AbilityKey, Object> common = parameters == null ? Map.of() : context(parameters);
        var keys = new ArrayList<Effect>();
        var current = new ArrayList<Current>();
        for (ReplacementEffect effect : choices) {
            var applicability = new HashMap<Map<AbilityKey, Object>, Integer>();
            if (damage == null) applicability.put(common, 1);
            else for (var assignment : damage.get(effect)) applicability.merge(context(assignment), 1, Integer::sum);
            Card host = effect.getHostCard();
            String replacement = effect.getParamOrDefault("ReplaceWith", "");
            Effect key = new Effect(card(host), effect.getMode(), effect.getLayer(), effect.getDescription(),
                    Map.copyOf(effect.getMapParams()), host.getSVar(replacement), Map.copyOf(applicability));
            keys.add(key);
            current.add(new Current(effect.getId(), key));
        }

        var ids = current.stream().map(Current::id).toList();
        List<Integer> remaining = continuing.remove(event);
        List<Integer> order = null;
        // Some replacements may cease to apply after the first one. Keep
        // the requested order among the surviving native effects; any new
        // choice requires a new decision.
        if (remaining != null && remaining.containsAll(ids))
            order = remaining.stream().filter(ids::contains).map(ids::indexOf).toList();

        Set<Effect> available = Set.copyOf(keys);
        boolean distinct = available.size() == keys.size();
        if (order == null && distinct && remembered.containsKey(available))
            order = remembered.get(available).stream().map(keys::indexOf).toList();
        // Identically described copies might spend a counter or refer to an
        // attached card. A stored order for them matches the actual copies.
        Set<Current> copies = distinct ? Set.of() : Set.copyOf(current);
        if (order == null && !distinct && rememberedCopies.containsKey(copies))
            order = rememberedCopies.get(copies).stream().map(current::indexOf).toList();
        if (order == null) {
            Answer answer = ask(session, player, choices);
            order = answer.indices();
            if (answer.memorize()) {
                if (distinct) remembered.put(available, order.stream().map(keys::get).toList());
                else rememberedCopies.put(copies, order.stream().map(current::get).toList());
            }
        }
        if (order.size() > 2)
            continuing.put(event, order.subList(1, order.size()).stream().map(ids::get).toList());
        return choices.get(order.getFirst());
    }

    private static CardRole card(Card card) {
        return new CardRole(card.getName(), card.getCurrentStateName().name(),
                card.getController() == null ? null : card.getController().getId(),
                card.getOwner() == null ? null : card.getOwner().getId());
    }

    private static Map<AbilityKey, Object> context(Map<AbilityKey, Object> parameters) {
        // Match roles by printed name/state and seat across copies. Game-owned
        // LKI tables and bookkeeping objects are not the event's participants.
        var fields = new LinkedHashMap<AbilityKey, Object>();
        parameters.forEach((key, value) -> {
            if (value instanceof Card source) fields.put(key, card(source));
            else if (value instanceof Player player) fields.put(key, player.getId());
            else if (value instanceof SpellAbility ability && ability.getHostCard() != null)
                fields.put(key, List.of(card(ability.getHostCard()), Map.copyOf(ability.getMapParams())));
            else if (value instanceof CounterType counter) fields.put(key, counter.getName());
            else if (value instanceof Enum<?> || value instanceof String || value instanceof Number || value instanceof Boolean)
                fields.put(key, value);
        });
        return Map.copyOf(fields);
    }

    private static Answer ask(NativeSession session, Player player, List<ReplacementEffect> choices) {
        JsonObject input = object("type", "reorder");
        input.add("presentation", object("title", "Order replacement effects"));
        input.addProperty("replacementOrder", true);
        JsonArray items = new JsonArray();
        var indices = new HashMap<String, Integer>();
        var presentation = new NativePromptCard(session, player);
        for (int i = 0; i < choices.size(); i++) {
            ReplacementEffect effect = choices.get(i);
            String id = "replacement-" + i;
            JsonObject item = object("id", id);
            var identity = presentation.choiceIdentity(effect.getHostCard().getView(), List.of());
            JsonObject source = new JsonObject();
            source.add("identity", identity);
            item.add("card", source);
            String label = identity.get("name").getAsString();
            if (!label.equals("Face-down card") && !effect.getDescription().isBlank()) {
                label = effect.getDescription();
                item.addProperty("abilityText", label);
            }
            item.addProperty("oracle", label);
            items.add(item);
            indices.put(id, i);
        }
        input.add("items", items);
        return session.ask(player, input, raw -> {
            if (!"reorderDecision".equals(text(raw, "type", ""))) throw new IllegalArgumentException("Expected replacement order");
            JsonArray ids = raw.getAsJsonArray("orderedIds");
            if (ids.size() != choices.size()) throw new IllegalArgumentException("Incomplete replacement order");
            var order = new ArrayList<Integer>();
            var seen = new HashSet<Integer>();
            for (var id : ids) {
                Integer index = indices.get(id.getAsString());
                if (index == null || !seen.add(index)) throw new IllegalArgumentException("Invalid replacement order");
                order.add(index);
            }
            return new Answer(List.copyOf(order), raw.has("memorize") && raw.get("memorize").getAsBoolean());
        });
    }
}
