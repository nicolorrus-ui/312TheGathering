// SPDX-License-Identifier: GPL-3.0-or-later

import type { Deck, DeckCard, Identity } from "./protocol";
import mtgoFaces from "./mtgo-card-names.json";

export const deckStorage = "hexproof-club.decks.v1";

export type DeckZone = "mainboard" | "sideboard";
export type DeckList = Pick<Deck, DeckZone>;

function catalogCardName(name: string) {
  return name.toLowerCase() === "all good things . . ." ? "All Good Things..." : name;
}

export const normalizeCardName = (name: string) => catalogCardName(name.trim().normalize("NFC")).toLowerCase();
const multifaceNames = new Map<string, { club: string; mtgo: string }>();
for (const [group, names] of Object.entries(mtgoFaces)) {
  for (const full of names) {
    const faces = full.split(" // ");
    const front = faces[0];
    const joined = faces.join("/");
    const entry = { club: group === "meldOrSpecialize" ? front : full, mtgo: group === "split" ? joined : front };
    multifaceNames.set(normalizeCardName(front), entry);
    multifaceNames.set(normalizeCardName(joined), entry);
  }
}

function knownFaceNames(name: string) {
  const key = normalizeCardName(name);
  const exact = multifaceNames.get(key);
  if (exact || !key.includes("/")) return exact;
  // A slash is also literal in ordinary names such as Summon: Choco/Mog.
  // Only match alternate spellings when Forge supplies the actual face pair.
  return multifaceNames.get(key.split(/\/{1,2}/).map((face) => face.trim()).join("/"));
}

export function cardNameKey(name: string): string {
  return normalizeCardName(knownFaceNames(name)?.club ?? name);
}

export function printingKey(card: Identity): string {
  return JSON.stringify([cardNameKey(card.name),
    card.setCode.toUpperCase(), card.collectorNumber.toLowerCase()]);
}

export function findDeckCard(cards: DeckCard[], name: string) {
  const key = cardNameKey(name);
  return cards.find((card) => cardNameKey(card.name) === key);
}

function setCopies(cards: DeckCard[], identity: Identity, count: number): DeckCard[] {
  const key = cardNameKey(identity.name);
  const index = cards.findIndex((card) => cardNameKey(card.name) === key);
  const entry = { name: identity.name, setCode: identity.setCode, collectorNumber: identity.collectorNumber, count };
  if (index < 0) return count ? [...cards, entry] : cards;
  const next = cards.slice();
  if (!count) next.splice(index, 1);
  else next[index] = entry;
  return next;
}

export function editDeckCard(list: DeckList, zone: DeckZone, printing: Identity, total: number, move = 0): DeckList {
  const other = zone === "mainboard" ? "sideboard" : "mainboard";
  const kept = Math.min(total, findDeckCard(list[other], printing.name)?.count ?? 0);
  return { ...list, [zone]: setCopies(list[zone], printing, total - kept - move),
    [other]: setCopies(list[other], printing, kept + move) };
}

export function addDeckCard(list: DeckList, zone: DeckZone, result: Identity): DeckList {
  const main = findDeckCard(list.mainboard, result.name), side = findDeckCard(list.sideboard, result.name);
  return editDeckCard(list, zone, main ?? side ?? result, (main?.count ?? 0) + (side?.count ?? 0) + 1);
}

/** Parse a quantity and optional Club printing, shared by deck and cube imports. */
export function parseCardLine(line: string, lineNumber: number, options?: { allowSingle: boolean; maxCount: number }): DeckCard {
  const match = line.match(/^(\d+)[x×]?\s+(.+)$/i);
  const count = match ? Number(match[1]) : options?.allowSingle ? 1 : 0;
  if (!Number.isSafeInteger(count) || count < 1 || count > (options?.maxCount ?? 1000)) {
    throw new Error(`Line ${lineNumber} needs a quantity and card name.`);
  }
  const printing = (match?.[2] ?? line).match(/^(.+?)(?:\s+\(([a-z0-9]+)\)\s+(\S+))?$/i);
  if (!printing) throw new Error(`Line ${lineNumber} needs a card name.`);
  return { name: knownFaceNames(printing[1])?.club ?? catalogCardName(printing[1]), setCode: printing[2]?.toUpperCase() ?? "",
    collectorNumber: printing[3] ?? "", count };
}

function readDeckLines(text: string, onCard: (zone: DeckZone, entry: Identity, count: number) => void,
  onComment?: (zone: DeckZone, line: string) => void) {
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
    if (line.startsWith("//") || line.startsWith("#")) {
      onComment?.(zone, raw);
      continue;
    }
    const sideboard = /^SB:\s*/i.test(line);
    const { count, ...entry } = parseCardLine(sideboard ? line.replace(/^SB:\s*/i, "") : line, index + 1);
    if (possibleSideboard && zone === "mainboard" && !sideboard) zone = "sideboard";
    onCard(sideboard ? "sideboard" : zone, entry, count);
    started = true;
    possibleSideboard = false;
  }
}

export function parseDeckList(text: string): DeckList {
  const groups = { mainboard: new Map<string, number>(), sideboard: new Map<string, number>() };
  const printings = new Map<string, Identity>();
  readDeckLines(text, (zone, entry, count) => {
    const key = cardNameKey(entry.name);
    const existing = printings.get(key);
    // On importing mixed lists, the first explicit printing applies across both zones.
    if (!existing || (!existing.setCode && entry.setCode)) printings.set(key, entry);
    const counts = groups[zone];
    counts.set(key, (counts.get(key) ?? 0) + count);
  });
  const entries = (counts: Map<string, number>) => Array.from(counts, ([key, count]) => ({ ...printings.get(key)!, count }));
  return { mainboard: entries(groups.mainboard), sideboard: entries(groups.sideboard) };
}

// Keep each text entry within the club importer's per-line quantity range.
function quantityLines(count: number, name: string): string[] {
  return Array.from({ length: Math.ceil(count / 1000) }, (_, index) =>
    `${Math.min(1000, count - index * 1000)} ${name}`);
}

export function formatDeckList(deck: DeckList, original = ""): string {
  const lines: Record<DeckZone, string[]> = { mainboard: [], sideboard: [] };
  const remaining = (cards: DeckCard[]) => new Map(cards.map((card) => [cardNameKey(card.name), card]));
  const cards = { mainboard: remaining(deck.mainboard), sideboard: remaining(deck.sideboard) };
  function append(zone: DeckZone, key: string) {
    const card = cards[zone].get(key);
    if (!card) return;
    const name = card.name + (card.setCode && card.collectorNumber ? ` (${card.setCode}) ${card.collectorNumber}` : "");
    lines[zone].push(...quantityLines(card.count, name));
    cards[zone].delete(key);
  }
  // Retain comments next to surviving entries when a card edit rebuilds the list.
  if (/^[ \t]*(?:#|\/\/)/m.test(original)) {
    readDeckLines(original, (zone, card) => append(zone, cardNameKey(card.name)), (zone, line) => lines[zone].push(line));
  }
  for (const zone of ["mainboard", "sideboard"] as const) {
    for (const key of cards[zone].keys()) append(zone, key);
  }
  return ["Deck", ...lines.mainboard, ...(lines.sideboard.length ? ["", "Sideboard", ...lines.sideboard] : [])]
    .join(original.includes("\r\n") ? "\r\n" : "\n");
}

export function formatMtgoDeckList(deck: DeckList): string {
  const lines = (cards: DeckCard[]) => cards.flatMap((card) => quantityLines(card.count, knownFaceNames(card.name)?.mtgo ?? card.name));
  return [...lines(deck.mainboard), ...(deck.sideboard.length ? ["", ...lines(deck.sideboard)] : [])].join("\r\n") + "\r\n";
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
