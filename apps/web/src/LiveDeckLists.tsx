// SPDX-License-Identifier: GPL-3.0-or-later

import { useState, type KeyboardEvent } from "react";
import { DeckSection, useDeckCardIndex } from "./DeckSection";
import type { LiveDeckList, Player, Room } from "./protocol";

export function LiveDeckLists({ lists, seats, players }: { lists: LiveDeckList[]; seats: Room["seats"]; players?: Player[] }) {
  const [seat, setSeat] = useState(lists[0].seat);
  const [expanded, setExpanded] = useState(false);
  const index = useDeckCardIndex();
  const deck = lists.find((entry) => entry.seat === seat) ?? lists[0];

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
        <DeckSection name="Main deck" cards={deck.mainboard} index={index} library={{ counts: players?.find((player) => player.seat === deck.seat)?.liveLibraryCounts }} />
        <DeckSection name="Sideboard" cards={deck.sideboard} index={index} />
      </div>
    </div>
  </aside>;
}
