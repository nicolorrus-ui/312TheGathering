// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useState } from "react";
import type { Prompt, Response } from "./protocol";

type Assignment = NonNullable<Response["assignments"]>[number];
type Source = Prompt["combatSources"][number];
type Target = Prompt["combatTargets"][number];
type Draft = { gameId: string; promptId: number; assignments: Assignment[]; choosing?: string };
export type AttackControl = {
  state: "eligible" | "choosing" | "attacking" | "target" | "defending";
  activate?: () => void;
  label?: string;
};

export function useAttackDeclaration(prompt: Prompt | undefined, opponentSeat?: number) {
  const [draft, setDraft] = useState<Draft>();
  const sources = prompt?.combatSources ?? [];
  const targets = prompt?.combatTargets ?? [];
  const current = draft?.gameId === prompt?.gameId && draft?.promptId === prompt?.promptId ? draft : undefined;
  const assignments = current?.assignments.filter(({ sourceId, targetId }) =>
    sources.some((source) => source.responseId === sourceId && source.validTargetIds.includes(targetId))) ?? [];
  const choosing = sources.find((source) => source.responseId === current?.choosing);

  function change(next: Assignment[], choosing?: string) {
    if (prompt) setDraft({ gameId: prompt.gameId, promptId: prompt.promptId, assignments: next, choosing });
  }

  function canAssign(source: Source, target: Target) {
    return source.maxAssignments !== 0 && source.validTargetIds.includes(target.responseId)
      && (target.maxAssignments === undefined || assignments.filter((assignment) =>
        assignment.sourceId !== source.responseId && assignment.targetId === target.responseId).length < target.maxAssignments);
  }

  function chooseSource(source: Source) {
    const others = assignments.filter((item) => item.sourceId !== source.responseId);
    const valid = targets.filter((target) => canAssign(source, target));
    if (choosing === source || (others.length !== assignments.length && valid.length <= 1)) {
      change(others);
    } else if (valid.length === 1) {
      change([...others, { sourceId: source.responseId, targetId: valid[0].responseId }]);
    } else if (valid.length) {
      change(others, source.responseId);
    }
  }

  function targetControl(target?: Target): AttackControl | undefined {
    if (!target) return;
    if (choosing && canAssign(choosing, target)) {
      return { state: "target", activate: () => change([...assignments,
        { sourceId: choosing.responseId, targetId: target.responseId }]) };
    }
    if (assignments.some((assignment) => assignment.targetId === target.responseId)) return { state: "defending" };
  }

  function cardControl(id: string): AttackControl | undefined {
    const target = targetControl(targets.find((target) => target.objectId === id));
    if (target?.state === "target") return target;
    const source = sources.find((source) => source.objectId === id);
    if (!source || !source.validTargetIds.length || source.maxAssignments === 0) return target;
    const selected = assignments.find((assignment) => assignment.sourceId === source.responseId);
    return {
      state: choosing === source ? "choosing" : selected ? "attacking" : "eligible",
      activate: () => chooseSource(source),
      label: selected ? targets.find((item) => item.responseId === selected.targetId)?.label : undefined,
    };
  }

  const opponent = targets.find((target) => target.kind === "player" && target.seat === opponentSeat);
  const all = opponent ? sources
    .filter((source) => source.maxAssignments !== 0 && source.validTargetIds.includes(opponent.responseId))
    .slice(0, opponent.maxAssignments)
    .map((source) => ({ sourceId: source.responseId, targetId: opponent.responseId })) : [];
  return {
    assignments, choosing, cardControl,
    playerControl: (seat: number) => targetControl(targets.find((target) => target.kind === "player" && target.seat === seat)),
    hasDraft: Boolean(choosing || assignments.length),
    canStrikeAll: all.length > 0,
    strikeAll: () => change(all),
    clear: () => change([]),
  };
}
