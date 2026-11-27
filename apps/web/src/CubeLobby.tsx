// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { CubeListTable } from "./CubeListTable";
import { cardsPerSeat, createCubeRequest, parseCubeFile, type CubeList, type CubePreset, type DraftMode } from "./cubes";
import "./cube-lobby.css";

const presetTitles = { modovintage: "Vintage Cube", "100-ornithopters": "100 Ornithopters" };
const customKey = "hexproof-club.custom-cube.v1";
const defaultCustom: CubeList = { name: "My cube", cards: [] };
type CubeRoomRequest = ReturnType<typeof createCubeRequest>;

function savedCube(): CubeList {
  try {
    const value = JSON.parse(localStorage.getItem(customKey) ?? "null") as CubeList | null;
    if (value && typeof value.name === "string" && Array.isArray(value.cards) &&
        value.cards.every((card) => card && typeof card.name === "string" && typeof card.typeLine === "string" &&
          Array.isArray(card.colors) && Number.isInteger(card.count) && card.count > 0)) return value;
  } catch { /* A custom cube can be used without browser storage. */ }
  return defaultCustom;
}

async function cubeData(url: string, init: RequestInit) {
  const result = await fetch(url, init);
  if (!result.ok) {
    const detail = (await result.text()).trim();
    let message = detail;
    try { message = JSON.parse(detail).error || detail; } catch { /* Also accept plain-text server errors. */ }
    throw new Error(typeof message === "string" && !message.startsWith("<") && message.length < 500
      && message ? message : `Could not load the cube (${result.status}).`);
  }
  const data = await result.json() as CubeList;
  if (!Array.isArray(data.cards) || !data.cards.length) throw new Error("The server returned an empty cube.");
  return data;
}

function CubeSettings({ slug, online, onCreate }: {
  slug: CubePreset | "custom"; online: boolean; onCreate: (request: CubeRoomRequest) => void;
}) {
  const [cube, setCube] = useState<CubeList>(() => slug === "custom" ? savedCube() : { name: presetTitles[slug], cards: [] });
  const [seats, setSeats] = useState(8);
  const [mode, setMode] = useState<DraftMode>("booster");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const request = useRef<AbortController>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const createKey = useRef<{ cube: CubeList; seats: number; mode: DraftMode; request: CubeRoomRequest }>(undefined);
  const total = cube.cards.reduce((count, card) => count + card.count, 0);
  const needed = seats * cardsPerSeat;
  const custom = slug === "custom";
  const loadPreset = useCallback(async (refresh: boolean) => {
    request.current?.abort();
    const active = new AbortController();
    request.current = active;
    setBusy(refresh ? "Updating cube…" : "Loading cube…");
    setError(""); setMessage("");
    try {
      const latest = await cubeData(`/club-cubes/${slug}${refresh ? "/refresh" : ""}`, { method: refresh ? "POST" : "GET",
        signal: active.signal, cache: "no-store" });
      if (!active.signal.aborted) {
        setCube(latest);
        if (refresh) setMessage("Cube list updated.");
      }
    } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load this cube.");
    } finally {
      if (!active.signal.aborted) setBusy("");
    }
  }, [slug]);
  useEffect(() => {
    if (!custom) void loadPreset(false);
    return () => request.current?.abort();
  }, [custom, loadPreset]);
  useEffect(() => {
    if (custom) try { localStorage.setItem(customKey, JSON.stringify(cube)); } catch { /* Storage may be full or unavailable. */ }
  }, [cube, custom]);

  async function importFile(file: File) {
    request.current?.abort();
    const active = new AbortController();
    request.current = active;
    setBusy("Importing cube…"); setMessage(""); setError("");
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Choose a cube list under 8 MB.");
      const cards = parseCubeFile(await file.text(), file.name);
      if (active.signal.aborted) return;
      const imported = await cubeData("/club-cubes/resolve", { method: "POST", signal: active.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cards }) });
      if (!active.signal.aborted) {
        setCube((current) => ({ ...current, cards: imported.cards }));
        setMessage(`Imported ${file.name}.`);
      }
    } catch (cause) {
      if (!active.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not import the file.");
    } finally {
      if (!active.signal.aborted) setBusy("");
    }
  }

  return <section className="panel cube-settings" aria-label="Cube setup">
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!online || busy || !cube.name.trim() || total < needed) return;
      const last = createKey.current;
      if (!last || last.cube !== cube || last.seats !== seats || last.mode !== mode)
        createKey.current = { cube, seats, mode, request: createCubeRequest(slug, cube, seats, mode) };
      onCreate(createKey.current!.request);
    }}>
      <div className="cube-settings-bar">
        <div className="cube-identity">{custom ? <label>Cube name<input required maxLength={128} value={cube.name}
          onChange={(event) => setCube({ ...cube, name: event.target.value })} /></label> : <h2>{cube.name}</h2>}
          {total > 0 && <small>{total.toLocaleString("en-US")} cards</small>}
        </div>
        <div className="cube-source-action">{custom ? <>
          <input type="file" hidden ref={fileInput} accept=".txt,.csv,text/plain,text/csv" aria-label="Import cube list"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }} />
          <button type="button" disabled={!!busy} onClick={() => fileInput.current?.click()}>Import</button>
        </> : <button type="button" disabled={!!busy} onClick={() => void loadPreset(true)}>Update list</button>}</div>
        <label>Players<select aria-label="Players" value={seats} onChange={(event) => setSeats(Number(event.target.value))}>
          {[4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label>Draft format<select aria-label="Draft format" value={mode} onChange={(event) => setMode(event.target.value as DraftMode)}>
          <option value="booster">Booster draft</option><option value="rochester">Rochester draft</option></select></label>
        <button type="submit" className="primary cube-start" disabled={!online || !!busy || !cube.name.trim() || total < needed}>Start cube</button>
      </div>
    </form>
    {error && <p className="notice" role="alert">{error}</p>}
    {(busy || message) && <p className="cube-message" role="status">{busy || message}</p>}
    {total > 0 && total < needed && <p className="cube-message">This table needs {needed} cards for {seats} players.</p>}
    {cube.cards.length ? <CubeListTable cards={cube.cards} /> : custom && !busy &&
      <p className="cube-empty">Import a text list or Cube Cobra CSV. Text lists accept one card name per line or a quantity followed by the name.</p>}
  </section>;
}

export function CubeLobby({ online, onCreate, onJoin }: {
  online: boolean; onCreate: (request: CubeRoomRequest) => void; onJoin: (code: string) => void;
}) {
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("cube")?.trim().toUpperCase() ?? "");
  const [selected, setSelected] = useState<CubePreset | "custom" | "join">(() => code ? "join" : "modovintage");
  return <>
    <nav className="tabs cube-variants" aria-label="Cube selection">
      {(Object.entries(presetTitles) as [CubePreset, string][]).map(([slug, title]) =>
        <button key={slug} type="button" aria-pressed={selected === slug} onClick={() => setSelected(slug)}>{title}</button>)}
      <button type="button" aria-pressed={selected === "custom"} onClick={() => setSelected("custom")}>Customed</button>
      <button type="button" className="cube-join-tab" aria-pressed={selected === "join"} onClick={() => setSelected("join")}>Join cube</button>
    </nav>
    {selected === "join" ? <section className="panel cube-join">
      <form onSubmit={(event) => { event.preventDefault(); if (online && code.trim()) onJoin(code.trim()); }}>
        <label>Cube code<input value={code} maxLength={16} required onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>
        <button className="primary" disabled={!online || !code.trim()}>Join room</button>
      </form>
    </section> : <CubeSettings key={selected} slug={selected} online={online} onCreate={onCreate} />}
  </>;
}
