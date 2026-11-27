// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useEffect, useRef, useState } from "react";
import { CubePool } from "./CubePool";
import { DeckSection, useDeckCardIndex } from "./DeckSection";
import { DecisionCard } from "./DecisionCard";
import type { DeckCard, LimitedBasicLand, LimitedSnapshot } from "./protocol";
import "./cube-build.css";

const basics = ["Plains", "Island", "Swamp", "Mountain", "Forest"];
const maxDeckCards = 1000;
const cardName = (name: string) => name.trim().normalize("NFC").toLowerCase();
const totalLands = (lands: LimitedBasicLand[]) => lands.reduce((sum, land) => sum + land.count, 0);

type DeckEdit = { mainboardInstanceIds: string[]; basicLands: LimitedBasicLand[]; ready?: boolean };
type BuildProps = {
  limited: LimitedSnapshot;
  online: boolean;
  send: (type: string, payload: object) => string | undefined;
  lastReply?: { id: string; ok: boolean };
};

function BasicLandsDialog({ available, add, close }: {
  available: number; add: (lands: LimitedBasicLand[]) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [counts, setCounts] = useState<string[]>(() => basics.map(() => "0"));
  const additions = basics.map((name, i) => ({ name, count: Number(counts[i]) }));
  const total = totalLands(additions);
  const valid = additions.every((land) => Number.isSafeInteger(land.count) && land.count >= 0) && total > 0 && total <= available;
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog className="cube-basics-dialog" aria-labelledby="cube-basics-label" ref={dialog}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (valid) add(additions.filter((land) => land.count > 0));
    }}>
      <h2 id="cube-basics-label">Basic lands</h2>
      <p>Choose how many to add to your deck.</p>
      <div className="cube-basics-choices">{basics.map((name, i) =>
        <label key={name}><span>{name}</span>
          <input type="number" aria-label={name} min={0} step={1} max={available} value={counts[i]} onFocus={(e) => e.target.select()}
            onChange={(e) => setCounts(counts.map((old, index) => index === i ? e.target.value : old))} />
          <DecisionCard card={{ name }} className="cube-basic-art" />
        </label>)}</div>
      <footer>{total > available && <span role="alert">You can add up to {available} more basic lands.</span>}
        <button type="button" onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={!valid}>Confirm</button>
      </footer>
    </form>
  </dialog>;
}

export function CubeBuild({ limited, online, send, lastReply }: BuildProps) {
  const [draft, setDraft] = useState<DeckEdit>();
  const [showBasics, setShowBasics] = useState(false);
  const [now, setNow] = useState(Date.now);
  const request = useRef<{ id: string; edit: DeckEdit }>(undefined);
  const saved = useRef<DeckEdit>(undefined);
  const index = useDeckCardIndex();
  const deadline = limited.buildDeadline ? Date.parse(limited.buildDeadline) : NaN;
  const seconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : undefined;
  const expired = seconds === 0;
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [deadline]);

  // Coalesce rapid clicks into one complete selection while an earlier save is in flight.
  // A draft acknowledgement precedes any public progress message and does not lock the deck.
  useEffect(() => {
    if (!online || limited.deckSubmitted) {
      request.current = undefined;
      saved.current = undefined;
      setDraft(undefined);
      setShowBasics(false);
      return;
    }
    if (request.current) {
      if (lastReply?.id !== request.current.id) return;
      const submitted = request.current.edit;
      request.current = undefined;
      if (!lastReply.ok) {
        setDraft(saved.current);
        return;
      }
      saved.current = submitted;
    }
    if (expired || !draft || draft === saved.current) return;
    const id = send("limited.submit_deck", {
      name: "Cube deck", mainboardInstanceIds: draft.mainboardInstanceIds, basicLands: draft.basicLands,
      ...(draft.ready ? {} : { draftOnly: true }),
    });
    if (id) request.current = { id, edit: draft };
    else setDraft(saved.current);
  }, [draft, lastReply, online, limited.deckSubmitted, expired, send]);

  const pool = limited.pool ?? [];
  const edit = draft ?? { mainboardInstanceIds: limited.mainboardInstanceIds ?? [], basicLands: limited.basicLands ?? [] };
  const selected = new Set(edit.mainboardInstanceIds);
  const available = pool.filter((card) => !selected.has(card.instanceId));
  const rows = new Map<string, DeckCard>();
  function addRow(name: string, setCode: string, collectorNumber: string, count: number) {
    const key = cardName(name);
    const row = rows.get(key);
    if (row) row.count += count;
    else rows.set(key, { name, setCode, collectorNumber, count });
  }
  for (const card of pool) if (selected.has(card.instanceId)) addRow(card.name, card.setCode, card.collectorNumber, 1);
  for (const land of edit.basicLands) addRow(land.name, land.setCode ?? "", land.collectorNumber ?? "", land.count);
  const landCount = totalLands(edit.basicLands);
  const minimum = limited.minimumDeckCards ?? 40;
  const count = edit.mainboardInstanceIds.length + landCount;
  const participants = limited.participants.filter((participant) => !participant.withdrawn);
  const readyCount = participants.filter((participant) => participant.deckSubmitted).length;
  const locked = !online || expired || limited.deckSubmitted || !!edit.ready;
  function remove(card: DeckCard) {
    if (locked) return;
    const key = cardName(card.name);
    // Added basics disappear first. Every drafted card, including a basic, retains its instance.
    const virtual = edit.basicLands.find((land) => cardName(land.name) === key);
    if (virtual) {
      setDraft({ ...edit, basicLands: edit.basicLands.map((land) => land === virtual ? { ...land, count: land.count - 1 } : land)
        .filter((land) => land.count > 0) });
      return;
    }
    const physical = pool.find((item) => selected.has(item.instanceId) && cardName(item.name) === key);
    if (physical) setDraft({ ...edit, mainboardInstanceIds: edit.mainboardInstanceIds.filter((id) => id !== physical.instanceId) });
  }
  function addBasics(additions: LimitedBasicLand[]) {
    if (locked) return;
    const lands = [...edit.basicLands];
    for (const addition of additions) {
      const i = lands.findIndex((land) => land.name === addition.name && !land.setCode);
      if (i < 0) lands.push(addition);
      else lands[i] = { ...lands[i], count: lands[i].count + addition.count };
    }
    setDraft({ ...edit, basicLands: lands });
    setShowBasics(false);
  }

  return <section className="cube-build" aria-labelledby="cube-build-title">
    <header className="cube-build-heading"><h2 id="cube-build-title">Build your deck</h2>
      {seconds !== undefined && <div className="cube-build-time"><span>Time remaining</span>
        <time role="timer" aria-label="Time remaining">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</time>
      </div>}</header>
    <div className="cube-build-table">
      <div className="cube-build-left">
        <h3>Drafted cards <span>{available.length}</span></h3>
        <CubePool cards={available} label="Drafted cards" disabled={locked} onPick={(id) => {
          if (!locked && !selected.has(id)) setDraft({ ...edit, mainboardInstanceIds: [...edit.mainboardInstanceIds, id] });
        }} />
        <footer className="cube-build-actions">
          <button type="button" disabled={locked || maxDeckCards <= pool.length + landCount} onClick={() => setShowBasics(true)}>Basic lands</button>
          <div><span>{readyCount}/{participants.length} ready</span>
            <button className="primary" type="button" disabled={locked || count < minimum}
              onClick={() => setDraft({ ...edit, ready: true })}>{limited.deckSubmitted ? "Ready ✓" : "Ready"}</button>
          </div>
        </footer>
      </div>
      <aside className="cube-build-list"><DeckSection name="Main deck" cards={[...rows.values()]}
        index={index} remove={remove} disabled={locked} />
        {count < minimum && <p>{minimum} cards minimum · {minimum - count} more needed</p>}
      </aside>
    </div>
    {showBasics && !locked && <BasicLandsDialog available={maxDeckCards - pool.length - landCount}
      add={addBasics} close={() => setShowBasics(false)} />}
  </section>;
}
