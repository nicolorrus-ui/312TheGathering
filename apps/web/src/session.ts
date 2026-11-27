// SPDX-License-Identifier: GPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { protocol, type Envelope, type GameMetadata, type LimitedSnapshot, type Prompt, type Response, type Room, type RulesCrashReport, type ServerError, type Snapshot, type Tournament, type Welcome } from "./protocol";

export const identityStorage = "hexproof-club.identity.v1";
const activeRoomStorage = "hexproof-club.active-room.v1";
type Identity = { name: string; resumeToken?: string; roomId?: string };
type Connection = "idle" | "connecting" | "online" | "offline";
type SessionState = { connection: Connection; welcome?: Welcome; seat?: number; room?: Room;
  resuming?: boolean; pendingReady?: string;
  game?: Snapshot; prompt?: Prompt; metadata?: GameMetadata; error?: string; crash?: RulesCrashReport;
  dismissedCrashId?: string; awaiting?: number; tournament?: Tournament; limited?: LimitedSnapshot;
  pendingPick?: string; limitedReply?: { id: string; ok: boolean } };
const initialState: SessionState = { connection: "idle" };
const rotatedIdentity = (identity: Identity, token: string, roomId?: string) => ({ name: identity.name, resumeToken: token, roomId });

function readStoredIdentity(storage: Storage, key: string): Identity | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as Identity | null;
    return value?.name ? value : null;
  } catch {
    return null;
  }
}

export function readIdentity(): Identity | null {
  return readStoredIdentity(sessionStorage, identityStorage) ?? readStoredIdentity(localStorage, activeRoomStorage);
}

const eventTokenKey = (name: string, id: string) => `hexproof-club.event-token:${name}:${id}`;
const eventKey = (name: string) => `hexproof-club.active-event:${name}`;

export function useSession() {
  const [identity, setIdentity] = useState(readIdentity);
  const latestIdentity = useRef(identity);
  const [state, setState] = useState(initialState);
  const socket = useRef<WebSocket | null>(null);
  const counter = useRef(0);
  const pickRequest = useRef<{ id: string; accepted: boolean } | undefined>(undefined);
  const deckRequests = useRef(new Set<string>());
  const tournamentRole = useRef<{ id: string; role: string } | undefined>(undefined);
  const enteringEvent = useRef<{ request: string; id: string; credential?: string } | undefined>(undefined);
  const inFlightDecision = useRef<{ request: string; promptId: number } | null>(null);

  const remember = useCallback((value: Identity | null) => {
    const previous = latestIdentity.current;
    latestIdentity.current = value;
    if (value) sessionStorage.setItem(identityStorage, JSON.stringify(value));
    else sessionStorage.removeItem(identityStorage);
    if (value?.roomId && value.resumeToken) {
      localStorage.setItem(activeRoomStorage, JSON.stringify(value));
    } else if (previous?.resumeToken && previous.resumeToken === readStoredIdentity(localStorage, activeRoomStorage)?.resumeToken) {
      localStorage.removeItem(activeRoomStorage);
    }
  }, []);

  const send = useCallback((type: string, payload = {}) => {
    if (socket.current?.readyState !== WebSocket.OPEN || (type === "limited.pick" && pickRequest.current)) return undefined;
    const id = String(++counter.current);
    socket.current.send(JSON.stringify({ type, id, payload }));
    if (type === "limited.pick") {
      pickRequest.current = { id, accepted: false };
      setState((previous) => ({ ...previous, pendingPick: id, error: undefined }));
    }
    if (type === "limited.submit_deck") deckRequests.current.add(id);
    return id;
  }, []);

  const enterTournament = useCallback((id: string) => {
    const tournamentId = id.trim().toUpperCase();
    const name = latestIdentity.current?.name;
    if (!name || !tournamentId) return;
    const credential = localStorage.getItem(eventTokenKey(name, tournamentId)) ?? undefined;
    const request = send("tournament.enter", { tournamentId, credential });
    if (request) enteringEvent.current = { request, id: tournamentId, credential };
  }, [send]);

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
      setState((previous) => ({ ...previous, connection: "connecting",
        resuming: Boolean(latestIdentity.current?.roomId) }));
      let hello: string | undefined;
      current.onopen = () => {
        const value = latestIdentity.current ?? identity!;
        hello = send("session.hello", { displayName: value.name, resumeToken: value.resumeToken,
          clientVersion: "club-web/0.1", protocol, rulesCrashReportSchema: 1 });
      };
      current.onmessage = ({ data }) => {
        if (closing || current !== socket.current) return;
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
            pickRequest.current = undefined;
            deckRequests.current.clear();
            enteringEvent.current = undefined;
            setState((previous) => ({ connection: "online", welcome, seat: welcome.seat,
              crash: welcome.resumed ? previous.crash : undefined,
              dismissedCrashId: welcome.resumed ? previous.dismissedCrashId : undefined,
              error: value.roomId && !welcome.resumed ? "Your previous seat is no longer available." : undefined }));
            const event = localStorage.getItem(eventKey(value.name));
            const invitedCube = new URLSearchParams(location.search).get("cube")?.trim().toUpperCase();
            if (event && (!invitedCube || invitedCube === event || welcome.roomId)) {
              enterTournament(event);
            }
            break;
          }
          case "tournament.created":
          case "tournament.registered":
          case "tournament.entered": {
            const event = payload as { tournamentId: string; organizerToken?: string; participantToken?: string; role?: string };
            const name = latestIdentity.current!.name;
            const key = eventTokenKey(name, event.tournamentId);
            if (event.organizerToken) localStorage.setItem(key, event.organizerToken);
            if (event.participantToken && !(tournamentRole.current?.id === event.tournamentId && tournamentRole.current.role === "organizer")) {
              localStorage.setItem(key, event.participantToken);
            }
            if (event.role) tournamentRole.current = { id: event.tournamentId, role: event.role };
            if (envelope.id === enteringEvent.current?.request) enteringEvent.current = undefined;
            localStorage.setItem(eventKey(name), event.tournamentId);
            setState((previous) => ({ ...previous, error: undefined }));
            break;
          }
          case "tournament.snapshot": {
            const tournament = payload as Tournament;
            if (tournament.role === "viewer" && tournamentRole.current?.id === tournament.tournamentId && tournamentRole.current.role === "participant") {
              localStorage.removeItem(eventTokenKey(latestIdentity.current!.name, tournament.tournamentId));
            }
            tournamentRole.current = { id: tournament.tournamentId, role: tournament.role };
            setState((previous) => {
              const sameSeat = previous.tournament?.tournamentId === tournament.tournamentId &&
                previous.tournament?.participantId === tournament.participantId && previous.tournament.role === tournament.role;
              return { ...previous, tournament, limited: sameSeat ? previous.limited : undefined };
            });
            break;
          }
          case "limited.snapshot": {
            const limited = payload as LimitedSnapshot;
            if (pickRequest.current?.accepted) pickRequest.current = undefined;
            const pendingPick = pickRequest.current?.id;
            setState((previous) => previous.tournament?.tournamentId === limited.tournamentId
              ? { ...previous, limited, pendingPick } : previous);
            break;
          }
          case "limited.progress": {
            const { tournamentId, participants } = payload as Pick<LimitedSnapshot, "tournamentId" | "participants">;
            setState((previous) => previous.limited?.tournamentId === tournamentId
              ? { ...previous, limited: { ...previous.limited, participants } } : previous);
            break;
          }
          case "limited.picked":
            if (pickRequest.current && pickRequest.current.id === envelope.id) pickRequest.current.accepted = true;
            break;
          case "limited.deck_submitted":
            if (envelope.id && deckRequests.current.delete(envelope.id)) {
              const reply = { id: envelope.id, ok: true };
              setState((previous) => ({ ...previous, limitedReply: reply, error: undefined }));
            }
            break;
          case "tournament.left":
            pickRequest.current = undefined;
            deckRequests.current.clear();
            localStorage.removeItem(eventKey(latestIdentity.current!.name));
            setState((previous) => ({ ...previous, tournament: undefined, limited: undefined, pendingPick: undefined, limitedReply: undefined }));
            break;
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
          case "player.ready_changed":
            setState((previous) => previous.pendingReady === envelope.id
              ? { ...previous, pendingReady: undefined } : previous);
            break;
          case "match.started":
            setState((previous) => ({ ...previous, pendingReady: undefined, error: undefined }));
            break;
          case "game.returned_to_room":
            inFlightDecision.current = null;
            setState((previous) => ({ ...previous, game: undefined, prompt: undefined, metadata: undefined, awaiting: undefined }));
            break;
          case "room.left":
          case "room.disbanded":
          case "room.kicked":
            remember({ ...latestIdentity.current!, roomId: undefined });
            inFlightDecision.current = null;
            setState((previous) => ({ connection: previous.connection, welcome: previous.welcome, tournament: previous.tournament, limited: previous.limited }));
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
            const entry = enteringEvent.current;
            if (entry && envelope.id === entry.request) {
              enteringEvent.current = undefined;
              if (entry.credential && error.code === "tournament_forbidden" && error.message === "invalid tournament credential") {
                // A seat can be released while its player is disconnected. Re-enter the public lobby with no seat.
                const key = eventTokenKey(latestIdentity.current!.name, entry.id);
                if (localStorage.getItem(key) === entry.credential) localStorage.removeItem(key);
                enterTournament(entry.id);
                break;
              }
            }
            if (envelope.id === hello && error.code === "club_resume_pending") {
              current.close();
              break;
            }
            refused = envelope.id === hello;
            const failedDecision = envelope.id === inFlightDecision.current?.request;
            if (failedDecision) inFlightDecision.current = null;
            if (pickRequest.current && pickRequest.current.id === envelope.id) {
              pickRequest.current = undefined;
              setState((previous) => ({ ...previous, pendingPick: undefined }));
            }
            if (envelope.id && deckRequests.current.delete(envelope.id)) {
              const reply = { id: envelope.id, ok: false };
              setState((previous) => ({ ...previous, limitedReply: reply }));
            }
            const report = error.rulesCrashReport;
            if (report?.schemaVersion === 1) {
              setState((previous) => {
                if (report.reportId === previous.dismissedCrashId ||
                    (previous.crash && (report.reportId === previous.crash.reportId
                      ? report.revision <= previous.crash.revision
                      : report.occurredAt < previous.crash.occurredAt))) return previous;
                return { ...previous, crash: report };
              });
              break;
            }
            setState((previous) => ({ ...previous, error: describeError(error),
              pendingReady: envelope.id === previous.pendingReady ? undefined : previous.pendingReady,
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
  }, [identity, remember, send, enterTournament]);

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

  function setReady(ready: boolean) {
    const request = send("player.ready", { ready });
    if (request) setState((previous) => ({ ...previous, pendingReady: request, error: undefined }));
  }

  function answer(prompt: Prompt, response: Response) {
    if (inFlightDecision.current?.promptId === prompt.promptId) return;
    const request = send("rules.respond", { promptId: prompt.promptId, ...response });
    if (!request) return;
    inFlightDecision.current = { request, promptId: prompt.promptId };
    setState((previous) => ({ ...previous, awaiting: prompt.promptId, error: undefined }));
  }

  return { ...state, identity: identity?.name, enter, forget, send, setReady, answer, enterTournament,
    clearCrash: () => setState((previous) => ({ ...previous, crash: undefined, dismissedCrashId: previous.crash?.reportId })),
    clearError: () => setState((previous) => ({ ...previous, error: undefined })) };
}

function describeError(error: ServerError) {
  if (error.rulesStartFailure?.reason === "capacity") {
    return "All Forge match slots are in use. A match can hold its slot while starting, during sideboarding, or while a player reconnects. When a slot opens, press Ready again. Your seats and decks are kept.";
  }
  const issues = error.rulesStartFailure?.issues ?? [];
  const details = issues.map(({ cardName, code }) => {
    if (code === "format_violation") {
      return "Forge rejected your deck for this format. Check the main deck size, sideboard, and card legality.";
    }
    return [cardName, code].filter(Boolean).join(" ");
  });
  return [error.message, ...details].join(" ");
}
