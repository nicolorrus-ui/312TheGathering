// SPDX-License-Identifier: GPL-3.0-or-later

import { useMemo } from "react";
import { DecisionCard } from "./DecisionCard";
import "./declarations.css";

export function matchNames(names: string[], value: string) {
  const query = value.trim().toLowerCase();
  const starts: string[] = [], contains: string[] = [];
  for (const name of names) {
    const text = name.toLowerCase();
    if (text.startsWith(query)) {
      starts.push(name);
      if (starts.length === 20) break;
    } else if (contains.length < 20 && text.includes(query)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, 20);
}

export function CardNameSearch({ names, value, change }: {
  names?: string[]; value: string; change: (name: string) => void;
}) {
  const matches = useMemo(() => names ? matchNames(names, value) : [], [names, value]);
  return <div className="declaration-search">
    <label>Card name<input type="search" autoComplete="off" value={value}
      onChange={(event) => change(event.target.value)} /></label>
    {names && <div className="declaration-results" role="group" aria-label="Matching legal card names">
      {matches.map((name) => <button key={name} className="choice-card" type="button" aria-label={name} aria-pressed={name.toLowerCase() === value.trim().toLowerCase()}
        onClick={() => change(name)}><DecisionCard card={{ name }} /></button>)}
      {matches.length === 0 && <span role="status">No matching legal names.</span>}
    </div>}
  </div>;
}
