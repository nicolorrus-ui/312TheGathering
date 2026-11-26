// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { useLayoutEffect, useRef } from "react";
import { ManaPip } from "./ManaSymbols";
import type { Prompt, Response } from "./protocol";
import "./mana-choices.css";

export type ManaAnchor = { gameId: string; cardId: string; rect: DOMRect };

export function isManaChoice(prompt?: Prompt) {
  return prompt?.kind === "chooseFromSelection" && prompt.supported && prompt.manaSourceId &&
    (prompt.minChoiceTotal === 0 || prompt.minChoiceTotal === 1) && prompt.maxChoiceTotal === 1 &&
    prompt.choices.length > 0 && prompt.choices.every((choice) => choice.weight === 1 && !choice.canRepeat);
}

function AbilityLabel({ label }: { label: string }) {
  return <span className="mana-ability-label">{label.split(/(\{[\w/]+\})/g).map((part, index) => part.startsWith("{") && part.endsWith("}")
    ? <ManaPip key={index} symbol={part.slice(1, -1)} /> : part)}</span>;
}

export function ManaChoiceMenu({ prompt, anchor, locked, submit }: {
  prompt: Prompt; anchor?: ManaAnchor; locked: boolean; submit: (response: Response) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const board = node.closest(".duel");
    const selector = `.table-card[data-card-id="${CSS.escape(prompt.manaSourceId!)}"]`;
    let remembered = anchor?.gameId === prompt.gameId && anchor.cardId === prompt.manaSourceId ? anchor.rect : undefined;
    const home = board?.querySelector(".battlefield.home");
    const position = () => {
      const source = board?.querySelector(selector);
      if (source) remembered = source.getBoundingClientRect();
      const box = remembered ?? home?.getBoundingClientRect();
      if (!box) return;
      const width = node.offsetWidth, height = node.offsetHeight, margin = 6;
      const top = box.top >= height + 2 * margin ? box.top - height - margin : box.bottom + margin;
      const left = box.left + (box.width - width) / 2;
      node.style.left = Math.max(margin, Math.min(left, innerWidth - width - margin)) + "px";
      node.style.top = Math.max(margin, Math.min(top, innerHeight - height - margin)) + "px";
      node.style.visibility = "visible";
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(node);
    const cards = new MutationObserver(position);
    if (home) {
      resize.observe(home);
      cards.observe(home, { childList: true, subtree: true });
    }
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    node.querySelector("button")?.focus({ preventScroll: true });
    return () => {
      resize.disconnect();
      cards.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [anchor, prompt.gameId, prompt.manaSourceId]);
  const optional = prompt.minChoiceTotal === 0;
  const choose = (choiceIds: string[]) => !locked && submit({ responseId: "$submit", choiceIds });
  const groups = prompt.choices.map((choice) => choice.manaSymbols?.join(""));
  return <div ref={menu} className="mana-choice-menu" role="group" aria-label={prompt.title || "Choose mana"}
    onKeyDown={(event) => { if (optional && event.key === "Escape") { event.preventDefault(); choose([]); } }}>
    {prompt.choices.map((choice, index) => <button key={choice.responseId} type="button" disabled={locked}
      aria-label={choice.label} title={choice.label} onClick={() => choose([choice.responseId])}>
      {groups[index] && groups.indexOf(groups[index]) === groups.lastIndexOf(groups[index]) ?
        choice.manaSymbols!.map((symbol, offset) => <ManaPip symbol={symbol} key={offset} />) : <AbilityLabel label={choice.label} />}
    </button>)}
    {optional && <button type="button" className="mana-choice-cancel" disabled={locked} aria-label="Cancel mana choice"
      title="Cancel" onClick={() => choose([])}>×</button>}
  </div>;
}
