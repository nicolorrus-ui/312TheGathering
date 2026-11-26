// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useRef, useState, type KeyboardEvent } from "react";
import { DecisionCard } from "./DecisionCard";
import type { PromptCard } from "./protocol";

export function CardChoiceGrid({ cards, selected, selectable, choose }: {
  cards: PromptCard[]; selected: string[]; selectable: (card: PromptCard) => boolean; choose: (id: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("");
  const active = cards.some((card) => card.id === current) ? current : cards[0]?.id;

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || !grid.current) return;
    const cell = (event.target as Element).closest<HTMLElement>("[data-choice-index]");
    if (!cell) return;
    if (event.target === cell && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      return;
    }
    const index = Number(cell.dataset.choiceIndex);
    const columns = getComputedStyle(grid.current).gridTemplateColumns.split(" ").length;
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : index + offsets[event.key];
    if (!Number.isFinite(next)) return;
    event.preventDefault();
    const target = grid.current.children[Math.max(0, Math.min(cards.length - 1, next))] as HTMLElement;
    (target.querySelector<HTMLButtonElement>("button:enabled") ?? target).focus();
  }

  return <div ref={grid} className="choice-grid" role="group" aria-label="Card choices"
    aria-description="Use the arrow keys to inspect cards." onKeyDown={navigate}>
    {cards.map((card, index) => {
      const enabled = selectable(card);
      // Enabled cards keep their native button action. A disabled card's wrapper
      // can receive roving focus for inspection, without making it selectable.
      return <div key={card.id} data-choice-index={index} data-art-focus
        role={enabled ? undefined : "group"} aria-label={enabled ? undefined : card.name}
        tabIndex={enabled ? undefined : card.id === active ? 0 : -1}
        onFocus={() => setCurrent(card.id)}>
        <button type="button" className="choice-card" aria-label={card.name} disabled={!enabled}
          tabIndex={enabled && card.id === active ? 0 : -1} aria-pressed={card.selected || selected.includes(card.id)}
          onClick={() => choose(card.id)}><DecisionCard card={card} /></button>
      </div>;
    })}
  </div>;
}
