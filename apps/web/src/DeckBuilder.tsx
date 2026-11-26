// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { CardImage, cardArtURL } from "./CardImages";
import "./deck-builder.css";
import { addDeckCard, editDeckCard, findDeckCard, formatDeckList, formatMtgoDeckList, parseDeck, parseDeckList, printingKey, type DeckList, type DeckZone } from "./decks";
import type { Deck, DeckCard, Identity } from "./protocol";

const zoneNames = { mainboard: "Main deck", sideboard: "Sideboard" };
const zones = ["mainboard", "sideboard"] as const;
const total = (cards: DeckCard[]) => cards.reduce((sum, card) => sum + card.count, 0);
const edition = (card: Identity) => card.setCode ? `${card.setCode.toUpperCase()} #${card.collectorNumber}` : "Default printing";
type Draft = Pick<Deck, "id" | "name" | "text">;
type CatalogCard = Identity & { setName: string };
type CatalogPage = { cards: CatalogCard[]; hasMore: boolean };
function blank(): Draft {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, name: "", text: "" };
}

function useCatalog(parameter: "q" | "name", query: string, page: number) {
  const params = new URLSearchParams({ [parameter]: query, page: String(page) }).toString();
  const [result, setResult] = useState<{ params: string; data?: CatalogPage; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/card-search?" + params, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const data: CatalogPage = await response.json();
        if (!controller.signal.aborted) setResult({ params, data });
      } catch {
        if (!controller.signal.aborted) setResult({ params, error: "Card catalog unavailable." });
      }
    }, parameter === "q" ? 300 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [parameter, params, query, attempt]);
  return { ...(result?.params === params ? result : undefined), retry: () => { setResult(undefined); setAttempt(attempt + 1); } };
}

function CatalogPager({ page, hasMore, setPage }: { page: number; hasMore: boolean; setPage: (page: number) => void }) {
  if (page === 1 && !hasMore) return null;
  return <div className="catalog-pager"><button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</button>
    <small>Page {page}</small><button type="button" disabled={!hasMore} onClick={() => setPage(page + 1)}>Next</button></div>;
}

function CatalogError({ retry }: { retry: () => void }) {
  return <div className="catalog-error" role="status">Card catalog unavailable. <button type="button" onClick={retry}>Retry</button></div>;
}

function CardSearch({ add, disabled }: { add: (zone: DeckZone, card: Identity) => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [zone, setZone] = useState<DeckZone>("mainboard");
  const search = query.trim();
  const catalog = useCatalog("q", search, page);
  return <section className="deck-search">
    <label>Search cards<input type="search" placeholder="Card name" value={query} onChange={(event) => {
      setQuery(event.target.value); setPage(1);
    }} /></label>
    {search && <>
      <label>Add to<select aria-label="Add to" value={zone} onChange={(event) => setZone(event.target.value as DeckZone)}>
        {zones.map((key) => <option key={key} value={key}>{zoneNames[key]}</option>)}</select></label>
      {catalog.error ? <CatalogError retry={catalog.retry} /> : !catalog.data ? <small role="status">Searching…</small>
        : <>
          {!catalog.data.cards.length && <small role="status">No matching cards.</small>}
          <ul className="catalog-results">{catalog.data.cards.map((card) => <li key={printingKey(card)}>
            <button type="button" disabled={disabled} aria-label={`Add ${card.name} to ${zoneNames[zone]}`} onClick={() => add(zone, card)}>
              <span className="deck-art-frame"><CardImage identity={card} className="deck-card-art" decorative compact fallbackName /></span>
            </button></li>)}</ul>
          <CatalogPager page={page} hasMore={catalog.data.hasMore} setPage={setPage} />
        </>}
    </>}
  </section>;
}

function CardEditor({ card, zone, otherCount, close, change }: {
  card: DeckCard; zone: DeckZone; otherCount: number; close: () => void;
  change: (printing: Identity, total: number, move?: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(1);
  const initialCount = card.count + otherCount;
  const [copies, setCopies] = useState(String(initialCount));
  const [moving, setMoving] = useState("1");
  const [chosen, setChosen] = useState<CatalogCard>();
  const catalog = useCatalog("name", card.name, page);
  const other = zone === "mainboard" ? "sideboard" : "mainboard";
  const amount = Number(copies);
  const limit = Math.max(1000, initialCount);
  const valid = copies !== "" && Number.isInteger(amount) && amount >= 0 && amount <= limit;
  const move = Number(moving);
  const available = Math.max(0, amount - otherCount);
  const canMove = valid && Number.isInteger(move) && move > 0 && move <= available;
  const versions = catalog.data?.cards ?? [];
  const preview = chosen ?? card;
  const previewKey = printingKey(preview);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return <dialog ref={dialog} className="deck-card-dialog" aria-label={`Edit ${card.name} in ${zoneNames[zone].toLowerCase()}`} onCancel={close}>
    <header><button type="button" className="quiet" onClick={close}>Close</button></header>
    <div className="deck-card-tools"><div className="deck-card-preview"><CardImage identity={preview} className="deck-card-art" eager fallbackName /></div>
      <div className="card-edit-controls">
        <label title="Total copies in the main deck and sideboard">Copies<input type="number" min={0} max={limit} value={copies}
          onChange={(event) => setCopies(event.target.value)} /></label>
        <div><label>Printing<select aria-label="Printing" value={previewKey} onChange={(event) => {
          setChosen(versions.find((item) => printingKey(item) === event.target.value));
        }}>
          {!versions.some((item) => printingKey(item) === previewKey) && <option value={previewKey}>{edition(preview)}</option>}
          {versions.map((item) => <option key={printingKey(item)} value={printingKey(item)}>{item.setName} · {edition(item)}</option>)}
        </select></label>
          {catalog.error ? <CatalogError retry={catalog.retry} /> : !catalog.data ? <small role="status">Loading printings…</small>
            : <>
              {!versions.length && <small>No printings found.</small>}
              <CatalogPager page={page} hasMore={catalog.data.hasMore} setPage={setPage} />
            </>}
        </div>
        <button type="button" className="primary" disabled={!valid || (amount === initialCount && printingKey(card) === previewKey)}
          onClick={() => change(preview, amount)}>Apply changes</button>
        <label>Copies to move<input type="number" min={1} max={available} value={moving}
          onChange={(event) => setMoving(event.target.value)} /></label>
        <button type="button" disabled={!canMove} onClick={() => change(preview, amount, move)}>Move to {zoneNames[other].toLowerCase()}</button>
      </div>
    </div>
  </dialog>;
}

function downloadDecklist(name: string, list: DeckList) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([formatMtgoDeckList(list)], { type: "text/plain;charset=utf-8" }));
  const filename = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  link.href = url;
  link.download = (filename || "Deck") + ".txt";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DeckArtDownload({ list, refresh }: { list: DeckList; refresh: () => void }) {
  const active = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);

  async function download() {
    if (active.current) {
      active.current.abort();
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    const printings = new Map([...list.mainboard, ...list.sideboard].map((card) => [printingKey(card), card]));
    let available = 0;
    let checked = 0;
    const summary = () => `${available} of ${printings.size} printings available offline.`;
    try {
      for (const card of printings.values()) {
        setMessage(`Getting artwork · ${checked} / ${printings.size}`);
        let complete = true;
        for (const name of card.name.split(" // ")) {
          try {
            const response = await fetch(cardArtURL({ ...card, name }), { signal: controller.signal, cache: "no-store" });
            if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/jpeg")) complete = false;
            await response.arrayBuffer();
          } catch {
            complete = false;
          }
          if (controller.signal.aborted) return;
        }
        if (complete) available++;
        checked++;
      }
    } finally {
      if (active.current === controller) {
        active.current = null;
        setRunning(false);
        setMessage(controller.signal.aborted ? `Download stopped. ${summary()}` : summary());
        if (available) refresh();
      }
    }
  }
  return <div className="deck-art-download">
    <button type="button" className="quiet" onClick={download}>{running ? "Cancel download" : "Download deck art"}</button>
    {message && <small role="status">{message}</small>}
  </div>;
}

export function DeckBuilder({ decks, save }: { decks: Deck[]; save: (next: Deck[]) => void }) {
  const [draft, setDraft] = useState<Draft>(blank);
  const [inputMode, setInputMode] = useState<"search" | "import">("search");
  const [selection, setSelection] = useState<{ zone: DeckZone; card: DeckCard }>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [artRevision, setArtRevision] = useState(0);
  const current = decks.find((deck) => deck.id === draft.id);
  const dirty = draft.name !== (current?.name ?? "") || draft.text !== (current?.text ?? "");
  const parsed = useMemo(() => {
    try { return { list: parseDeckList(draft.text) }; }
    catch (cause) { return { error: cause instanceof Error ? cause.message : "Cannot read this decklist." }; }
  }, [draft.text]);
  const list = parsed.list;
  const edit = (next: Draft) => { setDraft(next); setStatus(""); setError(""); };
  function open(next: Draft) {
    if (dirty && !window.confirm("Discard unsaved deck changes?")) return;
    edit(next); setSelection(undefined);
  }
  function replace(next: DeckList) { edit({ ...draft, text: formatDeckList(next, draft.text) }); }
  function add(zone: DeckZone, card: Identity) {
    if (!list) return;
    replace(addDeckCard(list, zone, card));
    setStatus(`Added ${card.name} to ${zoneNames[zone].toLowerCase()}.`);
  }
  return <div className="builder-layout">
    <aside className="panel builder-library">
      <header><h2>My decks</h2><button type="button" className="quiet" onClick={() => open(blank())}>New deck</button></header>
      {decks.length ? <ul className="builder-decks">{decks.map((deck) => <li key={deck.id}><button type="button"
        aria-pressed={draft.id === deck.id} onClick={() => { if (draft.id !== deck.id) open(deck); }}>
        <strong>{deck.name}</strong><small>{total(deck.mainboard)} main · {total(deck.sideboard)} side</small>
      </button></li>)}</ul> : <p>No saved decks yet.</p>}
    </aside>
    <section className="panel builder-workspace">
      <header><h2>{current ? "Edit deck" : "Create deck"}</h2>
        <div className="choices">{current && <button type="button" className="quiet" onClick={() => {
          if (!window.confirm(`Delete ${current.name}?`)) return;
          save(decks.filter((item) => item.id !== current.id)); edit(blank());
        }}>Delete deck</button>}
        <button type="button" className="quiet" title="Download an MTGO text decklist" disabled={!list?.mainboard.length}
          onClick={() => list && downloadDecklist(draft.name, list)}>Export decklist</button>
        <button type="button" className="primary" onClick={() => {
          try {
            const deck = parseDeck(draft.id, draft.name, draft.text);
            save(current ? decks.map((item) => item.id === deck.id ? deck : item) : [...decks, deck]);
            edit(deck); setStatus("Deck saved.");
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Cannot save this deck."); }
        }}>Save deck</button></div>
      </header>
      <label>Deck name<input required maxLength={128} value={draft.name} onChange={(event) => edit({ ...draft, name: event.target.value })} /></label>
      <div className="builder-input">
        <div className="tabs"><button type="button" aria-pressed={inputMode === "search"} onClick={() => setInputMode("search")}>Card search</button>
          <button type="button" aria-pressed={inputMode === "import"} onClick={() => setInputMode("import")}>Import decklist</button></div>
        {inputMode === "import" ? <label>MTGA or MTGO decklist<textarea rows={5} spellCheck={false} value={draft.text}
          placeholder={"Deck\n4 Lightning Bolt (M11) 149\n\nSideboard\n2 Abrade"}
          onChange={(event) => edit({ ...draft, text: event.target.value })} /></label> : <CardSearch add={add} disabled={!list} />}
      </div>
      {(parsed.error || error) && <p className="notice" role="alert">{parsed.error || error}</p>}
      {status && <small className="builder-status" role="status">{status}</small>}
      {import.meta.env.MODE === "club-debug" && list && Boolean(list.mainboard.length || list.sideboard.length) &&
        <DeckArtDownload key={draft.id + "\n" + draft.text} list={list} refresh={() => setArtRevision((value) => value + 1)} />}
      {list && zones.map((zone) => <section key={zone} className="deck-gallery" aria-label={zoneNames[zone]}>
        <h3>{zoneNames[zone]} <small>{total(list[zone])}</small></h3>
        {list[zone].length ? <ul>{list[zone].map((card) => <li key={printingKey(card)}><button type="button"
          aria-label={`${card.count} × ${card.name}, ${edition(card)}`} onClick={() => setSelection({ zone, card })}>
          <span className="deck-art-frame"><CardImage className="deck-card-art" identity={card} revision={artRevision} decorative compact fallbackName />
            <b className="deck-quantity">×{card.count}</b></span>
        </button></li>)}</ul> : <p>No cards.</p>}
      </section>)}
      {selection && list && <CardEditor card={selection.card} zone={selection.zone}
        otherCount={findDeckCard(list[selection.zone === "mainboard" ? "sideboard" : "mainboard"], selection.card.name)?.count ?? 0}
        close={() => setSelection(undefined)} change={(printing, count, move) => {
          replace(editDeckCard(list, selection.zone, printing, count, move)); setSelection(undefined);
        }} />}
    </section>
  </div>;
}
