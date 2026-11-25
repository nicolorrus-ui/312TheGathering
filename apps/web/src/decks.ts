// SPDX-License-Identifier: GPL-3.0-or-later

import type { Deck, DeckCard, Identity } from "./protocol";

export const deckStorage = "hexproof-club.decks.v1";

export type DeckZone = "mainboard" | "sideboard";
export type DeckList = Pick<Deck, DeckZone>;

export function printingKey(card: Identity): string {
  return JSON.stringify([card.name.trim().normalize("NFC").toLowerCase(),
    card.setCode.toUpperCase(), card.collectorNumber.toLowerCase()]);
}

export function changeCopies(cards: DeckCard[], identity: Identity, change: number): DeckCard[] {
  const key = printingKey(identity);
  const index = cards.findIndex((card) => printingKey(card) === key);
  if (index < 0) return change > 0 ? [...cards, { ...identity, count: change }] : cards;
  const next = cards.slice();
  const count = cards[index].count + change;
  if (count <= 0) next.splice(index, 1);
  else next[index] = { ...cards[index], count };
  return next;
}

export function parseDeckList(text: string): DeckList {
  const groups = { mainboard: new Map<string, DeckCard>(), sideboard: new Map<string, DeckCard>() };
  let zone: DeckZone = "mainboard";
  let started = false;
  let possibleSideboard = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) {
      possibleSideboard = started;
      continue;
    }
    if (/^(?:\/\/\s*)?(?:deck|mainboard|main deck)$/i.test(line)) {
      zone = "mainboard";
      possibleSideboard = false;
      continue;
    }
    if (/^(?:\/\/\s*)?(?:sideboard|sb):?$/i.test(line)) {
      zone = "sideboard";
      possibleSideboard = false;
      continue;
    }
    if (line.startsWith("//") || line.startsWith("#")) continue;
    const card = line.match(/^(SB:\s*)?(\d+)x?\s+(.+?)(?:\s+\(([a-z0-9]+)\)\s+(\S+))?$/i);
    if (!card || Number(card[2]) < 1 || Number(card[2]) > 1000) {
      throw new Error(`Line ${index + 1} needs a quantity and card name.`);
    }
    if (possibleSideboard && zone === "mainboard" && !card[1]) zone = "sideboard";
    const entry: DeckCard = {
      count: Number(card[2]), name: card[3], setCode: card[4]?.toUpperCase() ?? "", collectorNumber: card[5] ?? "",
    };
    const byPrinting = groups[card[1] ? "sideboard" : zone];
    const key = printingKey(entry);
    const existing = byPrinting.get(key);
    if (existing) existing.count += entry.count;
    else byPrinting.set(key, entry);
    started = true;
    possibleSideboard = false;
  }
  return { mainboard: [...groups.mainboard.values()], sideboard: [...groups.sideboard.values()] };
}

export function formatDeckList(deck: DeckList): string {
  function lines(cards: DeckCard[]) {
    return cards.flatMap((card) => {
      const name = card.name + (card.setCode && card.collectorNumber ? ` (${card.setCode}) ${card.collectorNumber}` : "");
      // Keep each MTGA text entry within the parser's per-line quantity range.
      return Array.from({ length: Math.ceil(card.count / 1000) }, (_, index) =>
        `${Math.min(1000, card.count - index * 1000)} ${name}`);
    });
  }
  return ["Deck", ...lines(deck.mainboard), ...(deck.sideboard.length ? ["", "Sideboard", ...lines(deck.sideboard)] : [])].join("\n");
}

export function parseDeck(id: string, name: string, text: string): Deck {
  if (!name.trim()) throw new Error("Give this deck a name.");
  const list = parseDeckList(text);
  if (!list.mainboard.length) throw new Error("Add at least one card to the main deck.");
  return { id, name: name.trim(), text, ...list };
}

export function readDecks(): Deck[] {
  try {
    const stored = JSON.parse(localStorage.getItem(deckStorage) ?? "[]") as Deck[];
    return stored.map(({ id, name, text }) => parseDeck(id, name, text));
  } catch {
    return [];
  }
}
