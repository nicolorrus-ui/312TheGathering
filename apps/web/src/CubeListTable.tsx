// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo } from "react";
import { useCardHover } from "./CardImages";
import { ManaPip } from "./ManaSymbols";
import { printingKey } from "./decks";
import { cubeCategories, type CubeCard, type CubeCategory } from "./cubes";

const typeOrder = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land"];
const colorOrder = "WUBRG";
const groupNames: Record<string, string> = {
  W: "White", U: "Blue", B: "Black", R: "Red", G: "Green",
  WU: "Azorius", UB: "Dimir", BR: "Rakdos", RG: "Gruul", WG: "Selesnya",
  WB: "Orzhov", UR: "Izzet", BG: "Golgari", WR: "Boros", UG: "Simic",
  WUB: "Esper", UBR: "Grixis", BRG: "Jund", WRG: "Naya", WUG: "Bant",
  WBG: "Abzan", WUR: "Jeskai", UBG: "Sultai", WBR: "Mardu", URG: "Temur",
};
function groupName(card: CubeCard) {
  if (["Hybrid", "Multicolored", "Lands"].includes(card.colorCategory)) {
    const colors = Array.from(colorOrder).filter((color) => card.colors.includes(color)).join("");
    return groupNames[colors] ?? (colors || (card.colorCategory === "Lands" ? "Land" : "Colorless"));
  }
  const types = card.typeLine.split(/\s+(?:—|-)\s+|\s+\/\/\s+/)[0].split(/\s+/);
  return typeOrder.find((type) => types.includes(type)) ?? "Other";
}

function arranged(cards: CubeCard[]) {
  type Group = { name: string; count: number; cards: CubeCard[] };
  const columns = new Map<CubeCategory, { count: number; groups: Map<string, Group> }>(
    cubeCategories.map((category) => [category, { count: 0, groups: new Map() }]));
  for (const card of cards) {
    const col = columns.get(card.colorCategory);
    if (!col) continue;
    const name = groupName(card), group = col.groups.get(name) ?? { name, count: 0, cards: [] };
    group.cards.push(card);
    group.count += card.count;
    col.count += card.count;
    col.groups.set(name, group);
  }
  const rank = (name: string) => typeOrder.includes(name) ? typeOrder.indexOf(name) : typeOrder.length;
  return Array.from(columns, ([category, { count, groups }]) => ({ category, count, groups: [...groups.values()]
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((group) => ({ ...group, cards: group.cards.sort((a, b) => a.name.localeCompare(b.name)) })) }));
}

export function CubeListTable({ cards }: { cards: CubeCard[] }) {
  const columns = useMemo(() => arranged(cards), [cards]);
  const hover = useCardHover();
  return <div className="cube-list-scroll" role="region" aria-label="Cube card list" tabIndex={0}>
    <div className="cube-list-columns">{columns.map(({ category, count, groups }) =>
      <section className="cube-list-column" data-category={category} key={category} aria-label={category}>
        <h3>{category}<small>{count}</small></h3>
        {groups.map((group) => <section key={group.name} className="cube-card-type">
          <h4>{group.name}<small>{group.count}</small></h4>
          <ul>{group.cards.map((card) => <li key={printingKey(card)} tabIndex={0} title={card.name}
            onMouseEnter={(event) => hover(card, event.currentTarget)} onMouseLeave={() => hover()}
            onFocus={(event) => hover(card, event.currentTarget)} onBlur={() => hover()}>
            {card.count > 1 && <span className="cube-copy-count">×{card.count}</span>}
            <span className="cube-list-name">{card.name}</span>
            {card.manaCost && <span className="cube-list-cost" role="img" aria-label={`Mana cost ${card.manaCost}`}>
              {card.manaCost.split(/\s+/).map((symbol, i) => <ManaPip key={i} symbol={symbol} />)}
            </span>}
          </li>)}</ul>
        </section>)}
      </section>)}</div>
  </div>;
}
