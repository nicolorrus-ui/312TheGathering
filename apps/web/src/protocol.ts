// SPDX-License-Identifier: GPL-3.0-or-later

export const protocol = "hexproof.v3";
export const formats = ["standard", "pioneer", "modern", "legacy", "vintage", "pauper", "custom"] as const;
export type DeckFormat = typeof formats[number];
export const formatLabel = (format: string) => format === "custom" ? "Custom" : format[0].toUpperCase() + format.slice(1);

export type Identity = { name: string; setCode: string; collectorNumber: string; token?: boolean };
export type DeckCard = Identity & { count: number };
export type Deck = { id: string; name: string; text: string; mainboard: DeckCard[]; sideboard: DeckCard[] };
export type Card = {
  id: string; visible: boolean; identity?: Identity; ownerSeat: number; controllerSeat: number;
  tapped?: boolean; faceDown?: boolean; attacking?: boolean; blocking?: string[];
  power?: string; toughness?: string; damage?: number; counters?: Counter[];
  typeLine?: string; oracle?: string; land?: boolean;
};
export type Counter = { name: string; value: number };
export type Player = { seat: number; name: string; life: number; manaPool: Counter[]; status: string };
export type Zone = { zone: string; ownerSeat: number; count: number; cards: Card[] };
export type StackObject = { id: string; identity: Identity; text: string };
export type Snapshot = {
  roomId: string; gameId: string; turn: number; step: string; activeSeat: number; prioritySeat: number;
  players: Player[]; zones: Zone[]; stack: StackObject[]; gameOver: boolean; winnerSeat?: number;
  promptFollows?: boolean;
};
export type Option = { responseId: string; kind: string; label: string; cardId?: string };
export type Target = Option & { objectId?: string; seat?: number; selected?: boolean };
export type Choice = { responseId: string; label: string; weight: number; canRepeat: boolean };
export type PromptCard = Identity & { id: string; selected?: boolean; readOnly?: boolean };
export type Prompt = {
  roomId: string; gameId: string; pending: boolean; promptId: number; kind: string; supported: boolean;
  title: string; detail: string; options: Option[]; contextText: string; contextCards: PromptCard[];
  targets: Target[]; choices: Choice[]; cards: PromptCard[]; cancellable: boolean;
  minSelections: number; maxSelections: number; minCardSelections: number; maxCardSelections: number;
  minChoiceTotal: number; maxChoiceTotal: number; minNumber: number; maxNumber: number;
  scryDestinations: string[]; orderItems: (Identity & { responseId: string; oracle?: string })[];
  combatSources: (Identity & { responseId: string; objectId: string; validTargetIds: string[]; label: string })[];
  combatTargets: Target[]; damageSource?: { label: string }; damageTargets: (Target & { lethalDamage: number })[];
  totalDamage: number; damageAssignmentMode?: string;
};
export type RulesPriority = { roomId: string; hold: boolean; stops: string[] };

export type Response = {
  responseId: string; cardIds?: string[]; targetIds?: string[]; choiceIds?: string[];
  orderedIds?: string[]; chosenNumber?: number; name?: string;
  scryPiles?: { destination: string; cardIds: string[] }[];
  assignments?: { sourceId: string; targetId: string }[];
  damageOrderIds?: string[]; damageAssignments?: { targetId: string; damage: number }[];
};
export type LiveDeckList = { seat: number; name: string; mainboard: DeckCard[]; sideboard: DeckCard[] };
export type Room = {
  liveDeckLists?: LiveDeckList[];
  tournamentId?: string;
  aiSource?: string;
  allowSpectators?: boolean;
  spectatorsSeeHands?: boolean;
  roomId: string; name: string; deckFormat: DeckFormat; matchMode: string; phase: string; ownDeckName?: string;
  seats: { occupied: boolean; displayName?: string; ready?: boolean; deckSelected?: boolean; deckLocked?: boolean }[];
};
export type Tournament = {
  tournamentId: string; name: string; format: DeckFormat; clubStyle: "swiss" | "conquest";
  topEight?: boolean; elimination?: boolean; champion?: string; currentRound: number; plannedRounds: number;
  status: string; stage: string; matchMode: string; role: string; participantId?: string; canRegister: boolean;
  checkedIn: number; minimumPlayers: number; roundComplete: boolean;
  ownLineup?: { name: string; locked: boolean }[];
  ownChoice?: number;
  participants: { participantId: string; displayName: string; checkedIn: boolean }[];
  pairings: { pairingId: string; playerAId: string; playerAName: string; playerBId?: string; playerBName?: string;
    roomId?: string; playerAWins: number; playerBWins: number; drawnGames: number; bye: boolean; status: string }[];
  standings: { rank: number; participantId: string; displayName: string; wins: number;
    losses: number; draws: number; matchPoints: number; oppMatchWin: number; gameWin: number; oppGameWin: number }[];
};
export type GameMetadata = {
  roomId: string; gameNumber: number; score: number[];
  result?: { reason: string; winnerSeat: number; matchFinished: boolean };
  sideboard?: {
    mainboard?: DeckCard[]; sideboard?: DeckCard[]; canChooseStartingPlayer?: boolean; chosenStartingSeat?: number;
    deadlineUnixMs: number; seats: { seat: number; ready: boolean }[];
  };
  log: { id: number; kind: string; text: string }[];
};
export type Welcome = { resumeToken: string; resumed?: boolean; roomId?: string; role?: string; seat?: number; forgeRulesAvailable: boolean };
export type Envelope = { type: string; id?: string; payload: unknown };
export type RulesCrashReport = {
  schemaVersion: number; reportId: string; revision: number; occurredAt: string; collectionState: string;
  fingerprint: string; failure: { code: string; stage: string };
};
export type ServerError = { message: string; code: string; rulesCrashReport?: RulesCrashReport; rulesStartFailure?: {
  reason?: string; issues?: { code: string; cardName?: string }[];
} };
