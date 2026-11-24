// SPDX-License-Identifier: GPL-3.0-or-later

import type { Deck, DeckCard } from "./protocol";

export const deckStorage = "hexproof-club.decks.v1";

export function parseDeck(id: string, name: string, text: string): Deck {
  const result: Deck = { id, name: name.trim(), text, mainboard: [], sideboard: [] };
  if (!result.name) throw new Error("Give this deck a name.");
  let zone = result.mainboard;
  let started = false;
  let possibleSideboard = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      possibleSideboard = started;
      continue;
    }
    if (/^(?:\/\/\s*)?(?:deck|mainboard|main deck)$/i.test(line)) {
      zone = result.mainboard;
      possibleSideboard = false;
      continue;
    }
    if (/^(?:\/\/\s*)?(?:sideboard|sb):?$/i.test(line)) {
      zone = result.sideboard;
      possibleSideboard = false;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) continue;
    const card = line.match(/^(SB:\s*)?(\d+)x?\s+(.+?)(?:\s+\(([a-z0-9]+)\)\s+(\S+))?$/i);
    if (!card || Number(card[2]) < 1 || Number(card[2]) > 1000) {
      throw new Error(`Line ${index + 1} needs a quantity and card name.`);
    }
    if (possibleSideboard && zone === result.mainboard && !card[1]) zone = result.sideboard;
    const entry: DeckCard = {
      count: Number(card[2]), name: card[3], setCode: card[4]?.toUpperCase() ?? "", collectorNumber: card[5] ?? "",
    };
    (card[1] ? result.sideboard : zone).push(entry);
    started = true;
    possibleSideboard = false;
  }
  if (!result.mainboard.length) throw new Error("Add at least one line to the main deck.");
  return result;
}

export function readDecks(): Deck[] {
  try {
    const stored = JSON.parse(localStorage.getItem(deckStorage) ?? "[]") as Deck[];
    return stored.map(({ id, name, text }) => parseDeck(id, name, text));
  } catch {
    return [];
  }
}
