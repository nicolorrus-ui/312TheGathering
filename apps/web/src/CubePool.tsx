// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { DecisionCard } from "./DecisionCard";
import type { LimitedCard } from "./protocol";
import "./cube-event.css";

export function CubePool({ cards, label, disabled, onPick }: {
  cards: LimitedCard[]; label: string; disabled?: boolean; onPick?: (instanceId: string) => void;
}) {
  const groups = new Map<string, { card: LimitedCard; count: number }>();
  for (const card of cards) {
    const key = card.name.trim().normalize("NFC").toLowerCase();
    const entry = groups.get(key);
    if (entry) entry.count++;
    else groups.set(key, { card, count: 1 });
  }

  return <section className="cube-pool" aria-label={label}>
    {Array.from(groups, ([name, { card, count }]) => {
      const face = <><DecisionCard card={card} className="cube-card-art" />
        {count > 1 && <strong className="cube-card-count">×{count}</strong>}</>;
      return onPick ? <button key={name} className="cube-image-choice" type="button" disabled={disabled}
        data-instance-id={card.instanceId} aria-label={card.name} aria-description={count > 1 ? `${count} copies` : undefined}
        onClick={() => onPick(card.instanceId)}>{face}</button>
        : <div key={name} className="cube-image-choice" data-art-focus tabIndex={0} aria-label={card.name}>{face}</div>;
    })}
  </section>;
}
