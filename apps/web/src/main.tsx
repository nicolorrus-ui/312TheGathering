// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "./Board";
import { CardImages } from "./CardImages";
import { CubeEvent, isClubCube } from "./CubeEvent";
import { CubeLobby } from "./CubeLobby";
import { DecisionCard } from "./DecisionCard";
import { DeckBuilder } from "./DeckBuilder";
import { deckStorage, readDecks } from "./decks";
import { formatLabel, formats, type Deck, type DeckFormat, type GameMetadata, type RulesCrashReport, type RulesPriority } from "./protocol";
import { useSession } from "./session";
import { Tournaments } from "./Tournaments";
import { Watch } from "./Watch";
import "./style.css";

type Session = ReturnType<typeof useSession>;

function CrashNotice({ report, dismiss }: { report: RulesCrashReport; dismiss: () => void }) {
  const [copy, setCopy] = useState<{ revision: number; text: string }>();
  const contents = JSON.stringify(report, null, 2);
  async function copyReport() {
    try {
      await navigator.clipboard.writeText(contents);
      setCopy({ revision: report.revision, text: "Copied." });
    } catch {
      setCopy({ revision: report.revision, text: "Select and copy the report below." });
    }
  }
  return <section className="notice app-error crash-notice" aria-label="Forge crash">
    <div><strong role="alert">Forge stopped</strong><button type="button" className="quiet" onClick={dismiss}>Dismiss</button></div>
    <details>
      <summary>View crash report</summary>
      <p>{report.failure.code} · {report.failure.stage} · {report.collectionState}</p>
      <button type="button" onClick={copyReport}>Copy report</button>
      <span role="status">{copy?.revision === report.revision ? copy.text : ""}</span>
      <pre tabIndex={0}>{contents}</pre>
    </details>
  </section>;
}

function Lobby({ session }: { session: Session }) {
  const [tab, setTab] = useState<"create" | "join">(() => new URLSearchParams(location.search).has("room") ? "join" : "create");
  const [name, setName] = useState("Club duel");
  const [password, setPassword] = useState("");
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get("room") ?? "");
  const [matchMode, setMatchMode] = useState("bo1");
  const [practice, setPractice] = useState(false);
  const [live, setLive] = useState(false);
  const [deckFormat, setDeckFormat] = useState<DeckFormat>("modern");
  const blocked = session.connection !== "online" || !session.welcome?.forgeRulesAvailable;
  const broadcast = !practice && live;
  return <section className="panel duel-lobby">
    <div className="tabs"><button type="button" aria-pressed={tab === "create"} onClick={() => { setTab("create"); setPassword(""); }}>Create room</button>
      <button type="button" aria-pressed={tab === "join"} onClick={() => { setTab("join"); setPassword(""); }}>Join room</button>
      <a className="watch-link" href="?watch">Watch live</a></div>
    {session.connection === "online" && !session.welcome?.forgeRulesAvailable && <p role="alert">Forge is unavailable.</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (tab === "join") session.send("room.join", { roomId, password, asSpectator: false });
      else session.send("room.create", { name, password: practice ? "" : password, deckFormat, matchMode: practice ? "bo1" : matchMode, practice, format: "modern", rulesMode: "forge",
        maxSeats: 2, allowSpectators: broadcast, spectatorsSeeHands: broadcast, cardLoadMode: "background" });
    }}>
      {tab === "create" ? <>
        <label>Room name<input required maxLength={128} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Opponent<select value={practice ? "practice" : "player"} onChange={(event) => setPractice(event.target.value === "practice")}>
          <option value="player">Another player</option><option value="practice">Practice opponent</option>
        </select></label>
        <div className="form-row"><label>Format<select aria-label="Format" value={deckFormat} onChange={(event) => setDeckFormat(event.target.value as DeckFormat)}>
          {formats.map((item) => <option key={item} value={item}>{formatLabel(item)}</option>)}</select></label>
          <label>Match<select aria-label="Match" value={practice ? "bo1" : matchMode} disabled={practice} onChange={(event) => setMatchMode(event.target.value)}>
            <option value="bo1">Best of one</option><option value="bo3">Best of three</option></select></label></div>
      </> : <label>Room code<input required minLength={6} maxLength={6} value={roomId} onChange={(event) => setRoomId(event.target.value.toUpperCase())} /></label>}
      {(tab === "join" || !practice) && <label>Room password<input required type="password" maxLength={72} value={password} autoComplete="off"
        onChange={(event) => setPassword(event.target.value)} /></label>}
      {tab === "create" && !practice && <div>
        <label className="checkbox"><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)}
          aria-describedby="live-mode-details" /> Live mode</label>
        <small id="live-mode-details">This room appears in Watch live. Viewers can see both hands and registered decklists.</small>
      </div>}
      <button className="primary" type="submit" disabled={blocked}>{tab === "create" ? (practice ? "Create practice room" :
        broadcast ? "Create live duel" : "Create private duel") : "Join duel"}</button>
    </form>
  </section>;
}

function WatchInvite({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false);
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("watch", roomId);
  return <button type="button" className="quiet" onClick={async () => {
    try {
      await navigator.clipboard.writeText(url.href);
      setCopied(true);
    } catch {
      window.prompt("Copy this watch link", url.href);
    }
  }}>{copied ? "Watch link copied" : "Copy watch link"}</button>;
}

type ForgeAvailability = "warming" | "busy" | "ready";

function useForgeAvailability(online: boolean): ForgeAvailability {
  const [status, setStatus] = useState<ForgeAvailability>("warming");
  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      try {
        const response = await fetch("/forge-ready", { cache: "no-store", signal: controller.signal });
        const payload = response.ok ? await response.json() as { status?: string } : {};
        if (!controller.signal.aborted) {
          setStatus(payload.status === "ready" || payload.status === "busy" ? payload.status : "warming");
        }
      } catch {
        if (!controller.signal.aborted) setStatus("warming");
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 1500);
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [online]);
  return status;
}

function RoomPanel({ session, decks }: { session: Session; decks: Deck[] }) {
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState("");
  const room = session.room!;
  const ownSeat = room.seats[session.seat ?? -1];
  const deck = decks.find((item) => item.id === selected);
  const online = session.connection === "online";
  const forgeAvailability = useForgeAvailability(online);
  const waitingForForge = !ownSeat?.ready && forgeAvailability !== "ready";
  const invite = new URL(location.pathname, location.origin);
  invite.searchParams.set("room", room.roomId);
  return <section className="panel duel-room">
    <header><div><h2>{room.name}</h2><small>{formatLabel(room.deckFormat)} · {room.matchMode.toUpperCase()}</small></div>
      <button className="quiet" type="button" onClick={() => session.send("room.leave")} disabled={!online}>Leave</button></header>
    {!room.tournamentId && !room.aiSource && <div className="room-code"><span>Room code</span><strong>{room.roomId}</strong>
      <button type="button" className="quiet" onClick={async () => {
        try { await navigator.clipboard.writeText(invite.href); setCopied(true); }
        catch { setCopied(false); }
      }}>{copied ? "Copied" : "Copy invite"}</button></div>}
    {room.allowSpectators && room.spectatorsSeeHands && <div className="notice live-notice">
      <span><strong>Live duel.</strong> This room appears in Watch live. Viewers can see both hands and registered decklists.</span>
      <WatchInvite roomId={room.roomId} />
    </div>}
    <ul className="seats">{room.seats.map((seat, index) => <li key={index} className={index === session.seat ? "own-seat" : undefined}>
      <strong>{seat.displayName || "Open seat"}{index === session.seat ? " (you)" : ""}</strong>
      <small className={seat.ready ? "seat-ready" : undefined}>{seat.ready ? "Ready" : seat.deckSelected ? "Deck selected" : seat.occupied ? "Choosing a deck" : "Awaiting player"}</small>
    </li>)}</ul>
    {!(session.tournament && isClubCube(session.tournament) && ownSeat?.deckLocked) && <div className="form-row">
      <label>Your deck<select aria-label="Your deck" value={selected} disabled={!online || ownSeat?.ready || ownSeat?.deckLocked} onChange={(event) => setSelected(event.target.value)}>
        <option value="">Select a deck</option>{decks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" disabled={!online || !deck || ownSeat?.ready || ownSeat?.deckLocked} onClick={() => {
        if (!deck) return;
        session.send("deck.select", { name: deck.name, mainboard: deck.mainboard, sideboard: deck.sideboard,
          format: "modern", deckFormat: room.deckFormat });
      }}>Use deck</button>
    </div>}
    {room.ownDeckName && <p className="selected-deck">{room.ownDeckName} {ownSeat?.deckLocked ? "registered for this match" : "selected"}</p>}
    <button className="primary" type="button" disabled={!online || !ownSeat?.deckSelected || waitingForForge || Boolean(session.pendingReady)}
      onClick={() => session.setReady(!ownSeat?.ready)}>{session.pendingReady ? "Submitting…" : ownSeat?.ready ? "Cancel ready" : "Ready"}</button>
    {online && ownSeat?.deckSelected && waitingForForge && !session.pendingReady &&
      <p role="status">{forgeAvailability === "busy" ? "Forge is occupied by another match." : "Preparing Forge before Ready is available."}</p>}
    {session.pendingReady && !ownSeat?.ready && room.seats.every((seat, index) =>
      seat.occupied && (index === session.seat || seat.ready)) &&
      <p role="status">Setting up the match…</p>}
  </section>;
}

function Sideboard({ metadata, session }: { metadata: GameMetadata; session: Session }) {
  const board = metadata.sideboard!;
  const seat = session.seat!;
  const ready = board.seats.find((entry) => entry.seat === seat)?.ready;
  return <section className="panel sideboard">
    <header><h2>Sideboard for game {metadata.gameNumber + 1}</h2><span>{metadata.score[seat] ?? 0}–{metadata.score[1 - seat] ?? 0}</span></header>
    <fieldset disabled={session.connection !== "online"}>
      {board.canChooseStartingPlayer && <div className="choices">
        <button aria-pressed={board.chosenStartingSeat === seat} onClick={() => session.send("sideboard.choose_starting_player", { startingSeat: seat })}>Play first</button>
        <button aria-pressed={board.chosenStartingSeat === 1 - seat} onClick={() => session.send("sideboard.choose_starting_player", { startingSeat: 1 - seat })}>Draw first</button>
      </div>}
      <div className="form-row">
        {(["mainboard", "sideboard"] as const).map((zone) => <section key={zone}>
          <h3>{zone === "mainboard" ? "Main deck" : "Sideboard"}</h3>
          <ul className="deck-list">{(board[zone] ?? []).map((card, index) => <li key={index} data-art-focus><div className="sideboard-card">
            <DecisionCard card={card} className="sideboard-card-image" />
            <strong aria-label={`${card.count} copies`}>×{card.count}</strong></div>
            <button type="button" disabled={ready} aria-label={`Move one ${card.name} to ${zone === "mainboard" ? "sideboard" : "mainboard"}`}
              onClick={() => session.send("sideboard.move", { name: card.name, setCode: card.setCode, collectorNumber: card.collectorNumber,
                fromZone: zone, toZone: zone === "mainboard" ? "sideboard" : "mainboard" })}>Move one</button>
          </li>)}</ul>
        </section>)}
      </div>
      <button className="primary" type="button" onClick={() => session.send("sideboard.ready", { ready: !ready })}>{ready ? "Cancel ready" : "Ready for next game"}</button>
    </fieldset>
  </section>;
}

function PlayerApp() {
  const session = useSession();
  const send = session.send;
  const sendPriority = useCallback((preference: RulesPriority) => { send("rules.priority", preference); }, [send]);
  const [name, setName] = useState("");
  const [decks, setDecks] = useState(readDecks);
  const [deckScreen, setDeckScreen] = useState(false);
  const [section, setSection] = useState<"duels" | "cube" | "tournaments">(() => {
    const params = new URLSearchParams(location.search);
    return params.has("cube") ? "cube" : params.has("tournament") ? "tournaments" : "duels";
  });
  const matchSection = session.room?.phase === "started";
  const online = session.connection === "online";
  const sideboard = session.metadata?.sideboard && session.metadata.result && !session.metadata.result.matchFinished;
  const awaitingDecision = Boolean(session.prompt) && session.awaiting === session.prompt?.promptId;
  const tournamentTable = Boolean(session.room?.tournamentId);
  const activeSection = session.tournament ? (isClubCube(session.tournament) ? "cube" : "tournaments") : section;
  const cube = !session.room && activeSection === "cube";
  function openSection(next: typeof section) {
    setDeckScreen(false);
    setSection(next);
  }
  function saveDecks(next: Deck[]) {
    localStorage.setItem(deckStorage, JSON.stringify(next));
    setDecks(next);
  }
  return <>
    <header className="topbar">
      <a className="brand" href={location.pathname}><span className="brand-mark" aria-hidden="true"></span>312<span>TheGathering</span></a>
      {session.identity && <div className="account"><span className={`connection ${session.connection}`}>{session.connection}</span>
        <span>{session.identity}</span>
        {matchSection && session.room?.allowSpectators && session.room.spectatorsSeeHands &&
          <WatchInvite key={session.room.roomId} roomId={session.room.roomId} />}
        {matchSection && <button type="button" className="quiet" disabled={!online} onClick={() => {
          if (session.metadata?.result?.matchFinished || window.confirm("Leave the room and end this match?")) session.send("room.leave");
        }}>Leave room</button>}
        {matchSection && session.game && session.seat !== undefined && !sideboard && !session.game.gameOver &&
          <button type="button" className="quiet concede" disabled={!online || awaitingDecision} onClick={() => {
            if (window.confirm("Concede this game?")) session.send("game.concede");
          }}>Concede game</button>}
        {!session.room && <button type="button" className="quiet" onClick={session.forget}>Sign out</button>}</div>}
    </header>
    {session.crash ? <CrashNotice key={session.crash.reportId} report={session.crash} dismiss={session.clearCrash} />
      : session.error && <div className="notice app-error" role="alert">{session.error}
      <button type="button" className="quiet" onClick={session.clearError}>Dismiss</button></div>}
    {!session.identity ? <main className="shell intro">
      <div><p className="eyebrow">PRIVATE MAGIC DUELS</p><h1>Your club.<br />Your table.</h1></div>
      <section className="panel"><h2>Take a seat</h2><form onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) session.enter(name);
      }}><label>Player name<input required autoFocus maxLength={64} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button className="primary" type="submit">Enter club</button>
        <a className="watch-link" href="?watch">Watch live</a></form></section>
    </main> : session.resuming && !session.room ? <main className="shell"><p role="status">Reconnecting to your duel…</p></main>
      : sideboard && session.metadata ? <main className="shell"><Sideboard metadata={session.metadata} session={session} /></main>
      : matchSection && session.game && session.seat !== undefined ? <Board key={session.game.gameId} game={session.game}
        seat={session.seat} prompt={session.prompt} locked={!online || awaitingDecision}
        metadata={session.metadata} answer={session.answer} online={online} sendPriority={sendPriority}
        tournamentTable={tournamentTable}
        back={() => session.send(tournamentTable ? "room.leave" : "game.return_to_room")} />
      : session.room && session.room.phase !== "waiting" ? <main className="shell"><p role="status">Starting Forge…</p></main>
      : <main className={cube && !deckScreen ? "shell cube-shell" : "shell"}><div className="lobby-title">
          <h1>{deckScreen ? "Deck builder" : session.room ? "Duel room" : cube ? "Cube" : activeSection === "tournaments" ? "Tournaments" : "Club lobby"}</h1></div>
        <nav className="tabs lobby-nav" aria-label="Club lobby">
          {session.room ? <button type="button" aria-pressed={!deckScreen} onClick={() => setDeckScreen(false)}>Duel room</button> : <>
            {!session.tournament && <button type="button" aria-pressed={!deckScreen && activeSection === "duels"}
              onClick={() => openSection("duels")}>Duels</button>}
            {(!session.tournament || cube) && <button type="button" aria-pressed={!deckScreen && cube}
              onClick={() => openSection("cube")}>Cube</button>}
            {(!session.tournament || !cube) && <button type="button" aria-pressed={!deckScreen && activeSection === "tournaments"}
              onClick={() => openSection("tournaments")}>Tournaments</button>}
          </>}
          <button type="button" aria-pressed={deckScreen} onClick={() => setDeckScreen(true)}>Deck builder</button>
        </nav>
        <div hidden={deckScreen} className={cube ? "cube-content" : "lobby-content"}>{session.room ? <RoomPanel key={session.room.roomId} session={session} decks={decks} />
          : cube ? (session.tournament ? <CubeEvent session={session} /> :
            <CubeLobby online={online} onCreate={(request) => send("tournament.create", request)} onJoin={session.enterTournament} />)
          : activeSection === "tournaments" ? <Tournaments session={session} decks={decks} /> : <Lobby session={session} />}</div>
        <div hidden={!deckScreen}><DeckBuilder decks={decks} save={saveDecks} /></div>
      </main>}
  </>;
}

const watch = new URLSearchParams(location.search).get("watch");
createRoot(document.getElementById("root")!).render(<CardImages>
  {watch === null ? <PlayerApp /> : <Watch roomId={watch.trim().toUpperCase()} />}
</CardImages>);
