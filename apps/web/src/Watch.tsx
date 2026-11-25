// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { Board } from "./Board";
import { LiveDeckLists } from "./LiveDeckLists";
import { protocol, type Envelope, type GameMetadata, type Room, type ServerError, type Snapshot, type Welcome } from "./protocol";

type WatchState = {
  online: boolean;
  room?: Room;
  game?: Snapshot;
  metadata?: GameMetadata;
  error?: string;
  notice?: string;
};
const ignore = () => {};

function useWatch(roomId: string) {
  const [state, setState] = useState<WatchState>({ online: false });
  const socket = useRef<WebSocket>(null);
  const leaving = useRef(false);
  const tokenKey = `hexproof-club.watch:${roomId}`;
  useEffect(() => {
    if (!roomId) return;
    let current: WebSocket;
    let retry: number;
    let delay = 500;
    let stopped = false;
    let token: string | undefined;
    try { token = sessionStorage.getItem(tokenKey) ?? undefined; } catch { /* Storage may be disabled. */ }

    function remember(value?: string) {
      token = value;
      try {
        if (value) sessionStorage.setItem(tokenKey, value);
        else sessionStorage.removeItem(tokenKey);
      } catch { /* In-memory token still handles a transport drop. */ }
    }

    function joined() {
      delay = 500;
      setState({ online: true });
    }

    function connect() {
      const url = new URL("/ws", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      current = new WebSocket(url);
      socket.current = current;
      current.onopen = () => current.send(JSON.stringify({
        type: "session.hello", id: "hello",
        payload: { displayName: "Spectator", clientVersion: "club-web/0.1", protocol, resumeToken: token },
      }));
      current.onmessage = ({ data }) => {
        if (stopped) return;
        const { type, id, payload } = JSON.parse(data) as Envelope;
        switch (type) {
          case "session.welcome": {
            const welcome = payload as Welcome;
            if (welcome.resumed) {
              if (welcome.role !== "spectator" || welcome.roomId !== roomId) {
                stopped = true;
                remember();
                setState({ online: false, error: "The live room could not be restored." });
                current.close();
                break;
              }
              remember(welcome.resumeToken);
              joined();
            } else {
              remember(welcome.resumeToken);
              current.send(JSON.stringify({ type: "room.join", id: "watch", payload: { roomId, asSpectator: true } }));
            }
            break;
          }
          case "room.joined":
            joined();
            break;
          case "room.snapshot": {
            const room = payload as Room;
            setState((previous) => ({ ...previous, room,
              ...(room.phase === "waiting" ? { game: undefined, metadata: undefined } : {}) }));
            break;
          }
          case "rules.snapshot":
            setState((previous) => ({ ...previous, game: payload as Snapshot, notice: undefined }));
            break;
          case "game.snapshot":
            setState((previous) => ({ ...previous, metadata: payload as GameMetadata }));
            break;
          case "game.returned_to_room":
            setState((previous) => ({ ...previous, game: undefined, metadata: undefined }));
            break;
          case "error": {
            const failure = payload as ServerError;
            if (id === "hello" && failure.code === "club_resume_pending") {
              current.close();
              break;
            }
            if (id === "hello" || id === "watch") {
              stopped = true;
              remember();
              setState({ online: false, error: failure.message });
              current.close();
            } else {
              setState((previous) => ({ ...previous, notice: failure.message }));
            }
            break;
          }
          case "room.left":
            if (leaving.current) {
              remember();
              location.assign("?watch");
              break;
            }
            // An unsolicited departure has the same effect as room closure.
          case "room.disbanded":
          case "room.kicked":
            stopped = true;
            remember();
            setState({ online: false, error: "The live room has closed." });
            current.close();
            break;
        }
      };
      current.onclose = () => {
        if (stopped) return;
        setState((previous) => ({ ...previous, online: false }));
        retry = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 4000);
      };
    }
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      socket.current = null;
      current?.close();
    };
  }, [roomId, tokenKey]);

  function leave() {
    if (!state.online || socket.current?.readyState !== WebSocket.OPEN) {
      location.assign("?watch");
      return;
    }
    leaving.current = true;
    socket.current.send(JSON.stringify({ type: "room.leave", id: "leave", payload: {} }));
    window.setTimeout(() => location.assign("?watch"), 1000);
  }
  return { ...state, leave };
}

export function Watch({ roomId }: { roomId: string }) {
  const { room, game, metadata, online, error, notice, leave } = useWatch(roomId);
  const betweenGames = metadata?.result && !metadata.result.matchFinished;
  return <>
    <header className="topbar">
      <a className="brand" href={location.pathname}><span className="brand-mark" aria-hidden="true">◆</span>Hexproof <span>Club</span></a>
      <div className="account"><span>{room?.name ?? "Live duels"}</span>
        {roomId && <button type="button" className="quiet" onClick={leave}>Leave live view</button>}</div>
    </header>
    {notice && <p role="status" className="notice app-error">{notice}</p>}
    {!roomId || error ? <main className="shell">
      <section className="panel">
        <h1>Watch a live duel</h1>
        {error && <p role="alert" className="notice">{error}</p>}
        <form method="get" action={location.pathname}>
          <label>Room code<input name="watch" required minLength={6} maxLength={6} defaultValue={roomId}
            autoCapitalize="characters" autoComplete="off" /></label>
          <button className="primary" type="submit">Watch duel</button>
        </form>
      </section>
    </main> : <div className="watch-layout" data-decks={Boolean(room?.liveDeckLists?.length)}>
      {room?.liveDeckLists?.length ? <LiveDeckLists lists={room.liveDeckLists} seats={room.seats} /> : null}
      {game && !betweenGames ? <Board key={game.gameId} game={game} seat={game.players[0]?.seat ?? 0}
        spectating locked online={online} metadata={metadata} answer={ignore} back={ignore} sendPriority={ignore} />
        : <main className="shell"><p role="status">{!online ? "Connecting to the live room…" : betweenGames
          ? "Waiting for the next game…" : "Waiting for the players to start…"}</p></main>}
    </div>}
  </>;
}
