// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { protocol, type Envelope, type GameMetadata, type Prompt, type Response, type Room, type ServerError, type Snapshot, type Welcome } from "./protocol";

export const identityStorage = "hexproof-club.identity.v1";
type Identity = { name: string; resumeToken?: string; roomId?: string };
type Connection = "idle" | "connecting" | "online" | "offline";
type SessionState = { connection: Connection; welcome?: Welcome; seat?: number; room?: Room;
  game?: Snapshot; prompt?: Prompt; metadata?: GameMetadata; error?: string; awaiting?: number };
const initialState: SessionState = { connection: "idle" };
const rotatedIdentity = (identity: Identity, token: string, roomId?: string) => ({ name: identity.name, resumeToken: token, roomId });

export function readIdentity(): Identity | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(identityStorage) ?? "null") as Identity | null;
    return value?.name ? value : null;
  } catch {
    return null;
  }
}

export function useSession() {
  const [identity, setIdentity] = useState(readIdentity);
  const latestIdentity = useRef(identity);
  const [state, setState] = useState(initialState);
  const socket = useRef<WebSocket | null>(null);
  const counter = useRef(0);
  const inFlightDecision = useRef<{ request: string; promptId: number } | null>(null);

  const remember = useCallback((value: Identity | null) => {
    latestIdentity.current = value;
    if (value) sessionStorage.setItem(identityStorage, JSON.stringify(value));
    else sessionStorage.removeItem(identityStorage);
  }, []);

  const send = useCallback((type: string, payload = {}) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return undefined;
    const id = String(++counter.current);
    socket.current.send(JSON.stringify({ type, id, payload }));
    return id;
  }, []);

  useEffect(() => {
    if (!identity) return;
    let closing = false;
    let retry: ReturnType<typeof setTimeout>;
    let delay = 500;
    let refused = false;
    let current: WebSocket;
    function connect() {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      current = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.current = current;
      setState((previous) => ({ ...previous, connection: "connecting" }));
      let hello: string | undefined;
      current.onopen = () => {
        const value = latestIdentity.current ?? identity!;
        hello = send("session.hello", { displayName: value.name, resumeToken: value.resumeToken,
          clientVersion: "club-web/0.1", protocol, rulesCrashReportSchema: 1 });
      };
      current.onmessage = ({ data }) => {
        const envelope = JSON.parse(data) as Envelope;
        const payload = envelope.payload;
        switch (envelope.type) {
          case "session.welcome": {
            const welcome = payload as Welcome;
            const value = latestIdentity.current ?? identity!;
            if (value.roomId && !welcome.resumed) {
              // The old WebSocket may still be in the process of being released.
              if (delay < 4000) {
                current.close();
                return;
              }
            }
            delay = 500;
            remember(rotatedIdentity(value, welcome.resumeToken, welcome.roomId));
            inFlightDecision.current = null;
            setState({ connection: "online", welcome, seat: welcome.seat,
              error: value.roomId && !welcome.resumed ? "Your previous seat is no longer available." : undefined });
            break;
          }
          case "room.created":
          case "room.joined": {
            const joined = payload as { roomId: string; hostSeat?: number; seat?: number };
            const value = latestIdentity.current!;
            remember({ ...value, roomId: joined.roomId });
            setState((previous) => ({ ...previous, seat: joined.hostSeat ?? joined.seat, error: undefined }));
            break;
          }
          case "room.snapshot": {
            const room = payload as Room;
            setState((previous) => ({ ...previous, room,
              ...(room.phase === "waiting" ? { game: undefined, prompt: undefined, metadata: undefined } : {}) }));
            break;
          }
          case "game.returned_to_room":
            inFlightDecision.current = null;
            setState((previous) => ({ ...previous, game: undefined, prompt: undefined, metadata: undefined, awaiting: undefined }));
            break;
          case "room.left":
          case "room.disbanded":
          case "room.kicked":
            remember({ ...latestIdentity.current!, roomId: undefined });
            inFlightDecision.current = null;
            setState((previous) => ({ connection: previous.connection, welcome: previous.welcome }));
            break;
          case "rules.snapshot": {
            const game = payload as Snapshot;
            setState((previous) => ({ ...previous, game,
              prompt: game.gameOver || previous.prompt?.gameId !== game.gameId || game.promptFollows ? undefined : previous.prompt }));
            break;
          }
          case "rules.prompt": {
            const prompt = payload as Prompt;
            if (inFlightDecision.current?.promptId !== prompt.promptId || !prompt.pending) inFlightDecision.current = null;
            setState((previous) => ({ ...previous, prompt: prompt.pending ? prompt : undefined }));
            break;
          }
          case "rules.responded":
            if (envelope.id === inFlightDecision.current?.request) {
              setState((previous) => ({ ...previous, awaiting: inFlightDecision.current?.promptId }));
            }
            break;
          case "game.snapshot":
            setState((previous) => ({ ...previous, metadata: payload as GameMetadata }));
            break;
          case "error": {
            const error = payload as ServerError;
            refused = envelope.id === hello;
            const failedDecision = envelope.id === inFlightDecision.current?.request;
            if (failedDecision) inFlightDecision.current = null;
            setState((previous) => ({ ...previous, error: describeError(error),
              awaiting: failedDecision ? undefined : previous.awaiting }));
            break;
          }
        }
      };
      current.onclose = () => {
        if (closing) return;
        setState((previous) => ({ ...previous, connection: "offline" }));
        if (refused) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 4000);
      };
    }
    connect();
    return () => {
      closing = true;
      clearTimeout(retry);
      socket.current = null;
      current?.close();
    };
  }, [identity, remember, send]);

  function enter(name: string) {
    const next = { name: name.trim() };
    remember(next);
    setState(initialState);
    setIdentity(next);
  }

  function forget() {
    remember(null);
    setIdentity(null);
    setState(initialState);
  }

  function answer(prompt: Prompt, response: Response) {
    if (inFlightDecision.current?.promptId === prompt.promptId) return;
    const request = send("rules.respond", { promptId: prompt.promptId, ...response });
    if (!request) return;
    inFlightDecision.current = { request, promptId: prompt.promptId };
    setState((previous) => ({ ...previous, awaiting: prompt.promptId, error: undefined }));
  }

  return { ...state, identity: identity?.name, enter, forget, send, answer,
    clearError: () => setState((previous) => ({ ...previous, error: undefined })) };
}

function describeError(error: ServerError) {
  const issues = error.rulesStartFailure?.issues ?? [];
  const details = issues.map(({ cardName, code }) => {
    if (code === "format_violation") {
      return "Forge rejected your deck for this format. Check the main deck size, sideboard, and card legality.";
    }
    return [cardName, code].filter(Boolean).join(" ");
  });
  return [error.message, ...details].join(" ");
}
