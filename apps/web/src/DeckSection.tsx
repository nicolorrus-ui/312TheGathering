// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import { ManaPip } from "./ManaSymbols";
import { useCardHover } from "./CardImages";
import { normalizeCardName, printingKey } from "./decks";
import type { DeckCard } from "./protocol";

type CardIndex = Record<string, [cost: string, frame: string]>;
const sum = (cards: DeckCard[]) => cards.reduce((count, card) => count + card.count, 0);

function manaValue(cost: string) {
  return cost.split(" ").reduce((total, symbol) => {
    if (!symbol || symbol === "//" || symbol === "X") return total;
    return total + (Number.parseInt(symbol, 10) || (symbol === "0" ? 0 : 1));
  }, 0);
}

export function useDeckCardIndex() {
  const [index, setIndex] = useState<CardIndex>({});
  useEffect(() => {
    const controller = new AbortController();
    fetch("/assets/deck-cards.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : undefined)
      .then((data) => { if (data && !controller.signal.aborted) setIndex(data); })
      .catch(() => { /* Quantities and registered names are carried in the room snapshot. */ });
    return () => controller.abort();
  }, []);
  return index;
}

export function DeckSection({ name, cards, index, remove, disabled }: {
  name: string; cards: DeckCard[]; index: CardIndex; remove?: (card: DeckCard) => void; disabled?: boolean;
}) {
  const hover = useCardHover();
  const rows = new Map<string, { card: DeckCard; count: number; cost: string; frame: string }>();
  for (const card of cards) {
    const key = printingKey(card);
    const existing = rows.get(key);
    if (existing) existing.count += card.count;
    else {
      const name = normalizeCardName(card.name);
      const face = name.split(/\s*\/\/\s*/)[0];
      const info = Object.hasOwn(index, name) ? index[name] : Object.hasOwn(index, face) ? index[face] : undefined;
      const [cost, frame] = info ?? ["", "neutral"];
      rows.set(key, { card, count: card.count, cost, frame });
    }
  }
  const sorted = [...rows.values()].sort((a, b) => Number(a.frame === "land") - Number(b.frame === "land")
    || manaValue(a.cost) - manaValue(b.cost) || a.card.name.localeCompare(b.card.name));
  return <section className="live-deck-section" aria-label={name}>
    <h3>{name}<span>{sum(cards)}</span></h3>
    <ul>{sorted.map((row) => {
      const content = <>
        <b className="deck-quantity">{row.count}</b>
        <span className="live-card-name">{row.card.name}
          {row.card.setCode && <small>{row.card.setCode.toUpperCase()} {row.card.collectorNumber}</small>}
        </span>
        {row.cost && <span className="deck-mana" role="img" aria-label={`Mana cost: ${row.cost}`}>
          {row.cost.split(/\s+/).map((symbol, i) => <ManaPip key={i} symbol={symbol} />)}
        </span>}
      </>;
      return <li key={printingKey(row.card)} data-frame={row.frame} tabIndex={remove ? undefined : 0}
        onMouseEnter={(event) => hover(row.card, event.currentTarget)} onMouseLeave={() => hover()}
        onFocus={(event) => hover(row.card, event.currentTarget)} onBlur={() => hover()}>
        {remove ? <button type="button" className="deck-row-action" aria-label={`Remove ${row.card.name}`}
          disabled={disabled} onClick={() => remove(row.card)}>{content}</button> : content}
      </li>;
    })}</ul>
  </section>;
}
