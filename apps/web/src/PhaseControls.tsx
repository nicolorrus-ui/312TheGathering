// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import type { RulesPriority, Snapshot } from "./protocol";

const phases = [
  ["untap", "Untap", "Untap"], ["upkeep", "Upkeep", "Upkeep"], ["draw", "Draw", "Draw"],
  ["main1", "First main", "Main I"], ["combatBegin", "Beginning of combat", "Combat"],
  ["combatDeclareAttackers", "Declare attackers", "Attack"], ["combatDeclareBlockers", "Declare blockers", "Block"],
  ["combatFirstStrikeDamage", "First strike damage", "First strike"], ["combatDamage", "Combat damage", "Damage"],
  ["combatEnd", "End of combat", "End combat"], ["main2", "Second main", "Main II"],
  ["endOfTurn", "End step", "End"], ["cleanup", "Cleanup", "Cleanup"],
] as const;

const sides = [["own", "My turn", "Me"], ["other", "Opponent's turn", "Opp."]] as const;
const stopKeys = phases.flatMap(([phase]) => sides.map(([side]) => `${side}:${phase}`));
const defaultStops = stopKeys.filter((key) => !/:(untap|draw|cleanup)$/.test(key));
const storageKey = "hexproof-club.priority.v1";

function readStops() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (Array.isArray(saved)) return new Set(stopKeys.filter((key) => saved.includes(key)));
  } catch {
    // A browser can block storage. Use in-memory preferences in that case.
  }
  return new Set(defaultStops);
}

export function usePriorityStops(roomId: string, online: boolean, sendPriority: (preference: RulesPriority) => void) {
  const [stops, setStops] = useState(readStops);
  const holdKey = `${storageKey}.hold:${roomId}`;
  const [hold, setHold] = useState(() => {
    try { return sessionStorage.getItem(holdKey) === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([...stops])); } catch { /* Storage can be disabled. */ }
  }, [stops]);
  useEffect(() => {
    try {
      if (hold) sessionStorage.setItem(holdKey, "true");
      else sessionStorage.removeItem(holdKey);
    } catch { /* Storage can be disabled. */ }
  }, [holdKey, hold]);
  useEffect(() => {
    if (online) sendPriority({ roomId, hold, stops: [...stops] });
  }, [roomId, online, hold, stops, sendPriority]);

  function toggleStop(key: string) {
    setStops((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return { stops, hold, toggleStop, setHold };
}

export function PhaseControls({ game, turnLabel, myTurn, stops, hold, toggleStop, setHold }: {
  game: Snapshot; turnLabel: string; myTurn: boolean; stops: ReadonlySet<string>; hold: boolean;
  toggleStop: (key: string) => void; setHold: (enabled: boolean) => void;
}) {
  return <aside className="phase-rail" aria-label="Turn phases">
    <header className="turn-widget"><strong>Turn {game.turn || "—"}</strong><small>{turnLabel}</small></header>
    <div className="phase-sides" aria-hidden="true">{sides.map(([side, , short]) => <span key={side}>{short}</span>)}</div>
    <ol className="phase-track">{phases.map(([id, label, short]) => <li key={id} data-phase={id}
      aria-current={game.step === id && !game.gameOver ? "step" : undefined}>
      {sides.map(([side, description]) => {
        const key = `${side}:${id}`;
        const name = `${description} · ${label} stop`;
        return <button key={side} type="button" className="phase-stop" aria-label={name} title={name}
          data-side={side} data-active={!game.gameOver && game.step === id && (side === "own") === myTurn}
          aria-pressed={stops.has(key)} onClick={() => toggleStop(key)} />;
      })}
      <span className="phase-label">{short}</span>
    </li>)}</ol>
    <button type="button" role="switch" aria-checked={hold} className="priority-hold"
      disabled={game.gameOver} onClick={() => setHold(!hold)}>Hold priority</button>
  </aside>;
}
