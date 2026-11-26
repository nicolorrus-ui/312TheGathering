// SPDX-License-Identifier: GPL-3.0-or-later

import type { Card, Prompt, Response } from "./protocol";

export function battlefieldChoice(prompt: Prompt | undefined, permanents: Card[]) {
  if (!prompt?.supported || prompt.includesOtherZones) return;
  const onTable = new Set(permanents.map((card) => card.id));
  const candidates = new Map<string, string>();
  const selected = new Set<string>();
  let min: number, max: number;
  if (prompt.kind === "chooseBoardTargets") {
    for (const target of prompt.targets) {
      if (target.kind !== "card" || !target.objectId || !onTable.has(target.objectId) || candidates.has(target.objectId)) return;
      candidates.set(target.objectId, target.responseId);
      if (target.selected) selected.add(target.responseId);
    }
    min = prompt.minSelections;
    max = prompt.maxSelections;
  } else if (prompt.kind === "chooseCards") {
    for (const card of prompt.cards) {
      // Reveals can contain additional read-only faces that still need to be shown.
      if (card.readOnly || !onTable.has(card.id) || candidates.has(card.id)) return;
      candidates.set(card.id, card.id);
    }
    min = prompt.minCardSelections;
    max = prompt.maxCardSelections;
  } else return;
  if (!candidates.size) return;
  const response = (ids: string[]): Response => prompt.kind === "chooseCards"
    ? { responseId: "$submit", cardIds: ids } : { responseId: "$submit", targetIds: ids };
  return { candidates, selected, min, max, response, prompt };
}

export function BattlefieldActions({ choice, ids, submit }: {
  choice: NonNullable<ReturnType<typeof battlefieldChoice>>; ids: string[]; submit: (response: Response) => void;
}) {
  const { prompt, min, max, response } = choice;
  return <>
    <div className="confirmation-question" role="status" aria-label="Battlefield choice">
      <strong>{prompt.title}</strong>
      {prompt.detail && prompt.detail !== prompt.title && <span>{prompt.detail}</span>}
      {max > 1 && <span>{ids.length} selected</span>}
    </div>
    {prompt.cancellable && <button type="button" className="quiet" onClick={() => submit({ responseId: "$cancel" })}>Cancel</button>}
    {(max !== 1 || min === 0) && <button className="primary" type="button" disabled={ids.length < min || ids.length > max}
      onClick={() => submit(response(ids))}>{max === 1 && min === 0 && !choice.selected.size ? "Skip" : "Confirm"}</button>}
  </>;
}
