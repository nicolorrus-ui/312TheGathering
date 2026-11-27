// SPDX-License-Identifier: GPL-3.0-or-later

import { parseCardLine, printingKey } from "./decks";
import type { DeckCard } from "./protocol";

export const cubeCategories = ["White", "Blue", "Black", "Red", "Green", "Hybrid", "Multicolored", "Colorless", "Lands"] as const;
export type CubeCategory = typeof cubeCategories[number];
export type CubeCard = DeckCard & { typeLine: string; manaCost: string; colors: string[]; colorCategory: CubeCategory; rarity?: string };
export type CubeList = { name: string; cards: CubeCard[] };
export type CubePreset = "modovintage" | "100-ornithopters";
export type DraftMode = "booster" | "rochester";
export const cardsPerSeat = 45;

export function createCubeRequest(slug: string, cube: CubeList, seats: number, mode: DraftMode) {
  const name = cube.name.trim();
  const cards = cube.cards.map(({ name, setCode, collectorNumber, typeLine, rarity, count }) =>
    ({ name, setCode, collectorNumber, typeLine, rarity, weight: count }));
  return { name, clubStyle: "cube", eventType: "cube_draft", coordinator: "swiss", format: "limited",
    matchMode: "bo3", rulesMode: "forge", maxPlayers: seats, operationId: crypto.randomUUID(),
    draftSettings: { mode, packsPerPlayer: 3, packsPerBatch: 1, cardsPerPack: 15 },
    product: { id: slug, name, productType: "cube", authentic: false, cardsPerPack: 0,
      sheets: [{ name: "cube", withReplacement: false, cards }], variants: [] } };
}

const maxCubeSize = 10_000;

// Quoted card names frequently contain commas, and Cube Cobra exports can contain multiline notes.
function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(field.trim()); field = ""; }
    else if (char === "\n" && !quoted) { row.push(field.trim()); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quote.");
  row.push(field.trim());
  rows.push(row);
  return rows;
}

function csvCards(text: string): DeckCard[] {
  const [header, ...rows] = csvRows(text);
  const fields = header.map((key) => key.toLowerCase().replace(/[ _-]/g, ""));
  const name = fields.indexOf("name");
  if (name < 0) throw new Error("The CSV needs a Name column.");
  const quantity = fields.findIndex((key) => ["quantity", "count", "copies", "qty"].includes(key));
  const set = fields.findIndex((key) => ["set", "setcode"].includes(key));
  const number = fields.findIndex((key) => ["collectornumber", "collector", "number"].includes(key));
  const board = fields.indexOf("board");
  const maybe = fields.indexOf("maybeboard");
  const result: DeckCard[] = [];
  for (const [i, row] of rows.entries()) {
    if (!row.some(Boolean) || /^(?:true|1|yes)$/i.test(row[maybe] ?? "") ||
        (row[board] && !["mainboard", "main", "deck"].includes(row[board].toLowerCase()))) continue;
    const count = row[quantity] ? Number(row[quantity]) : 1;
    if (!row[name] || !Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid name or quantity on CSV row ${i + 2}.`);
    result.push({ name: row[name], setCode: row[set]?.toUpperCase() || "", collectorNumber: row[number] || "", count });
  }
  return result;
}

function textCards(text: string) {
  const cards: DeckCard[] = [];
  let sideboard = false;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (/^(?:\/\/\s*)?(?:mainboard|main deck|deck):?$/i.test(line)) { sideboard = false; continue; }
    if (/^(?:\/\/\s*)?(?:sideboard|maybeboard|sb):?$/i.test(line)) { sideboard = true; continue; }
    if (!line || sideboard || /^(?:\/\/|#|SB:)/i.test(line)) continue;
    cards.push(parseCardLine(line, i + 1, { allowSingle: true, maxCount: maxCubeSize }));
  }
  return cards;
}

export function parseCubeFile(text: string, filename: string): DeckCard[] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const cards = filename.toLowerCase().endsWith(".csv") ? csvCards(cleaned) : textCards(cleaned);
  const entries = new Map<string, DeckCard>();
  let total = 0;
  for (const card of cards) {
    total += card.count;
    if (total > maxCubeSize) throw new Error("A cube can contain up to 10,000 cards.");
    const key = printingKey(card);
    const existing = entries.get(key);
    if (existing) existing.count += card.count;
    else entries.set(key, card);
  }
  if (!entries.size) throw new Error("The file contains no mainboard cards.");
  if (entries.size > 5_000) throw new Error("A cube can contain up to 5,000 distinct printings.");
  return Array.from(entries.values());
}
