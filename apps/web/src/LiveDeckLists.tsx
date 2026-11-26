// SPDX-License-Identifier: GPL-3.0-or-later

import { ManaPip } from "./ManaSymbols";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useCardHover } from "./CardImages";
import { printingKey } from "./decks";
import type { DeckCard, LiveDeckList, Room } from "./protocol";

type CardIndex = Record<string, [cost: string, frame: string]>;
const normalize = (name: string) => name.trim().normalize("NFC").toLowerCase();
const sum = (cards: DeckCard[]) => cards.reduce((count, card) => count + card.count, 0);

function manaValue(cost: string) {
  return cost.split(" ").reduce((total, symbol) => {
    if (!symbol || symbol === "//" || symbol === "X") return total;
    return total + (Number.parseInt(symbol, 10) || (symbol === "0" ? 0 : 1));
  }, 0);
}

function DeckSection({ name, cards, index }: { name: string; cards: DeckCard[]; index: CardIndex }) {
  const hover = useCardHover();
  const rows = new Map<string, { card: DeckCard; count: number; cost: string; frame: string }>();
  for (const card of cards) {
    const key = printingKey(card);
    const existing = rows.get(key);
    if (existing) existing.count += card.count;
    else {
      const name = normalize(card.name);
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
    <ul>{sorted.map((row) => <li key={printingKey(row.card)} data-frame={row.frame} tabIndex={0}
      onMouseEnter={(event) => hover(row.card, event.currentTarget)} onMouseLeave={() => hover()}
      onFocus={(event) => hover(row.card, event.currentTarget)} onBlur={() => hover()}>
      <b className="deck-quantity">{row.count}</b>
      <span className="live-card-name">{row.card.name}
        {row.card.setCode && <small>{row.card.setCode.toUpperCase()} {row.card.collectorNumber}</small>}
      </span>
      {row.cost && <span className="deck-mana" role="img" aria-label={`Mana cost: ${row.cost}`}>
        {row.cost.split(/\s+/).map((symbol, i) => <ManaPip key={i} symbol={symbol} />)}
      </span>}
    </li>)}</ul>
  </section>;
}

export function LiveDeckLists({ lists, seats }: { lists: LiveDeckList[]; seats: Room["seats"] }) {
  const [seat, setSeat] = useState(lists[0].seat);
  const [expanded, setExpanded] = useState(false);
  const [index, setIndex] = useState<CardIndex>({});
  const deck = lists.find((entry) => entry.seat === seat) ?? lists[0];
  useEffect(() => {
    const controller = new AbortController();
    fetch("/assets/deck-cards.json", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : undefined)
      .then((data) => { if (data && !controller.signal.aborted) setIndex(data); })
      .catch(() => { /* Quantities and registered names are carried in the room snapshot. */ });
    return () => controller.abort();
  }, []);

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next;
    switch (event.key) {
      case "ArrowLeft": next = (i + lists.length - 1) % lists.length; break;
      case "ArrowRight": next = (i + 1) % lists.length; break;
      case "Home": next = 0; break;
      case "End": next = lists.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setSeat(lists[next].seat);
    event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
  }

  return <aside className="live-decks" aria-label="Registered decklists" data-expanded={expanded}>
    <button type="button" className="live-deck-toggle" aria-expanded={expanded} aria-controls="live-deck-content"
      onClick={() => setExpanded(!expanded)}>Decklists <span aria-hidden="true">{expanded ? "−" : "+"}</span></button>
    <div id="live-deck-content">
      <div className="live-deck-tabs" role="tablist" aria-label="Players">
        {lists.map((entry, i) => <button key={entry.seat} type="button" role="tab" id={`deck-tab-${entry.seat}`}
          aria-selected={deck.seat === entry.seat} aria-controls="live-deck-panel"
          tabIndex={deck.seat === entry.seat ? 0 : -1} onKeyDown={(event) => moveTab(event, i)}
          onClick={() => setSeat(entry.seat)} title={seats[entry.seat]?.displayName}>
          {seats[entry.seat]?.displayName || `Player ${entry.seat + 1}`}
        </button>)}
      </div>
      <div key={deck.seat} id="live-deck-panel" role="tabpanel" aria-labelledby={`deck-tab-${deck.seat}`} tabIndex={0}>
        <h2>{deck.name}</h2>
        <DeckSection name="Main deck" cards={deck.mainboard} index={index} />
        <DeckSection name="Sideboard" cards={deck.sideboard} index={index} />
      </div>
    </div>
  </aside>;
}
