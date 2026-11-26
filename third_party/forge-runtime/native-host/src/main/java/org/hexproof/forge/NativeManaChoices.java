// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package org.hexproof.forge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.card.MagicColor;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import java.util.*;

/** Presentation of choices supplied by Forge's actual mana abilities and color callbacks. */
final class NativeManaChoices {
    record Entry<T>(T value, String label, List<String> symbols) { }
    record Activation(SpellAbility ability, List<String> output) { }
    static List<Entry<Activation>> activationOptions(SpellAbility ability) {
        String description = ability.getView().getDescription();
        List<List<String>> variants = ability.isManaAbility() ? alternatives(ability) : List.of();
        if (variants.isEmpty()) return List.of(new Entry<>(new Activation(ability, List.of()), description,
                ability.isManaAbility() ? fixedOutput(ability) : List.of()));
        return variants.stream().map(output -> new Entry<>(new Activation(ability, output),
                "{" + String.join("}{", output) + "} — " + description, output)).toList();
    }

    static List<String> fixedOutput(SpellAbility ability) {
        if (ability.getApi() != ApiType.Mana || ability.getAllManaParts().size() != 1) return List.of();
        String amount = ability.getParamOrDefault("Amount", "1");
        if (!amount.matches("(?:[1-9]|1[0-6])")) return List.of();
        var one = List.of(ability.getManaPart().getOrigProduced().split(" "));
        if (one.isEmpty() || !one.stream().allMatch(symbol -> symbol.matches("[WUBRGC]"))
                || one.size() * Integer.parseInt(amount) > 16) return List.of();
        var symbols = new ArrayList<String>();
        for (int i = 0; i < Integer.parseInt(amount); i++) symbols.addAll(one);
        return symbols;
    }

    static List<List<String>> alternatives(SpellAbility ability) {
        if (ability.getApi() != ApiType.Mana || ability.getAllManaParts().size() != 1) return List.of();
        var mana = ability.getManaPart();
        if (!mana.isAnyMana() && !mana.isComboMana()) return List.of();
        String amount = ability.getParamOrDefault("Amount", "1");
        if (!amount.matches("(?:[1-9]|1[0-6])") || ability.hasParam("Each")) return List.of();
        int count = Integer.parseInt(amount);
        if (mana.isAnyMana()) return forge.card.ColorSet.WUBRG.getOrderedColors().stream()
                .map(color -> Collections.nCopies(count, color.getShortName())).toList();
        String offered = mana.getComboColors(ability);
        if (offered.isBlank() || !offered.matches("[WUBRG](?: [WUBRG])*")) return List.of();
        var colors = List.copyOf(forge.card.ColorSet.fromNames(offered.split(" ")).getOrderedColors());
        return combinations(colors, count, mana.getOrigProduced().contains("Different")).stream().map(Entry::symbols).toList();
    }

    static Entry<Byte> colorOption(MagicColor.Color color, int count) {
        String symbol = color.getShortName();
        if (count < 1 || count > 16) return new Entry<>(color.getColorMask(), "{" + symbol + "} × " + count, List.of());
        return new Entry<>(color.getColorMask(), color.name(), Collections.nCopies(count, symbol));
    }

    // Keep large allocations bounded on the wire. Each range is narrowed until
    // a concrete legal count has been chosen. The last color receives the rest.
    static Map<Byte, Integer> allocate(NativeSession session, Player player, Card source,
            List<MagicColor.Color> colors, int amount, boolean different) {
        var counts = new LinkedHashMap<Byte, Integer>();
        int remaining = amount;
        for (int i = 0; i < colors.size() && remaining > 0; i++) {
            var color = colors.get(i);
            int min = different ? Math.max(0, remaining - (colors.size() - i - 1)) : 0;
            int max = different ? Math.min(1, remaining) : remaining;
            if (i + 1 == colors.size()) min = max;
            while (min < max) {
                int step = (int) (((long) max - min + 12) / 12);
                var entries = new ArrayList<Entry<Integer>>();
                for (long begin = min; begin <= max; begin += step) {
                    int from = (int) begin, end = (int) Math.min(begin + step - 1, max);
                    String range = from == end ? Integer.toString(from) : from + "–" + end;
                    entries.add(new Entry<>(from, range + " " + color.getSymbol(), List.of()));
                }
                min = choose(session, player, source, "Allocate " + remaining + " mana", entries, false);
                max = (int) Math.min((long) min + step - 1, max);
            }
            if (min > 0) counts.put(color.getColorMask(), min);
            remaining -= min;
        }
        return counts;
    }

    static <T> T choose(NativeSession session, Player player, Card source, String title, List<Entry<T>> entries, boolean optional) {
        JsonObject input = NativeSession.object("type", "chooseFromSelection");
        input.add("presentation", NativeSession.object("title", title));
        input.addProperty("minTotal", optional ? 0 : 1);
        input.addProperty("maxTotal", 1);
        input.addProperty("manaSourceId", NativeSnapshot.cardId(source));
        JsonArray options = new JsonArray();
        for (Entry<T> entry : entries) {
            JsonObject option = NativeSession.object("label", entry.label());
            option.addProperty("weight", 1); option.addProperty("canRepeat", false);
            if (!entry.symbols().isEmpty()) {
                JsonArray symbols = new JsonArray();
                entry.symbols().forEach(symbols::add);
                option.add("manaSymbols", symbols);
            }
            options.add(option);
        }
        input.add("options", options);
        return session.ask(player, input, output -> {
            if (!"selectionDecision".equals(NativeSession.text(output, "type", "")))
                throw new IllegalArgumentException("Expected a mana selection");
            JsonArray indices = output.getAsJsonArray("chosenIndices");
            if (optional && indices.isEmpty()) return null;
            if (indices.size() != 1) throw new IllegalArgumentException("Choose a single mana option");
            int index = indices.get(0).getAsInt();
            if (index < 0 || index >= entries.size()) throw new IllegalArgumentException("Unavailable mana option");
            return entries.get(index).value();
        });
    }

    static List<Entry<Map<Byte, Integer>>> combinations(List<MagicColor.Color> colors, int amount, boolean different) {
        if (amount <= 0 || amount > 16 || (different && amount > colors.size())) return List.of();
        var choices = new ArrayList<Entry<Map<Byte, Integer>>>();
        collect(colors, amount, different, 0, new ArrayList<>(), choices);
        return choices.size() <= 32 ? choices : List.of();
    }

    private static void collect(List<MagicColor.Color> colors, int left, boolean different, int first,
            List<MagicColor.Color> selected, List<Entry<Map<Byte, Integer>>> result) {
        if (result.size() > 32) return;
        if (left == 0) {
            var counts = new LinkedHashMap<Byte, Integer>();
            selected.forEach(color -> counts.merge(color.getColorMask(), 1, Integer::sum));
            var symbols = selected.stream().map(MagicColor.Color::getShortName).toList();
            result.add(new Entry<>(counts, "{" + String.join("}{", symbols) + "}", symbols));
            return;
        }
        for (int index = first; index < colors.size(); index++) {
            selected.add(colors.get(index));
            collect(colors, left - 1, different, different ? index + 1 : index, selected, result);
            selected.removeLast();
        }
    }

    private NativeManaChoices() { }
}
