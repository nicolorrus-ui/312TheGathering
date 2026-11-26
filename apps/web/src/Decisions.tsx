// SPDX-License-Identifier: GPL-3.0-or-later

import { ManaPip } from "./ManaSymbols";
import { useId, useState, type ReactNode } from "react";
import { CardImage, type CardHover } from "./CardImages";
import { dismissPanel } from "./boardMotion";
import type { Choice, Option, Prompt, PromptCard, Response, Target } from "./protocol";

export function DecisionPanel({ title, children, compactActions }: {
  title: string; children: ReactNode; compactActions?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  return <section className={`decision ${expanded ? "floating" : "collapsed"}`} aria-label={title}>
    <header><h2>{title}</h2><button className="quiet" type="button" onClick={(event) => {
      dismissPanel(event.currentTarget.closest(".decision"));
      setExpanded(!expanded);
    }}
      aria-expanded={expanded} aria-controls={bodyId}>{expanded ? "Minimize" : "Expand"}</button></header>
    <div className="decision-body" id={bodyId} hidden={!expanded}>{children}</div>
    {!expanded && compactActions}
  </section>;
}

export function Options({ options, submit }: { options: Option[]; submit: (response: Response) => void }) {
  return <div className="choices">{options.map((option) => <button type="button" key={option.responseId}
    aria-label={option.kind === "spendFloatingMana" ? `Spend floating ${option.label} mana` : undefined}
    onClick={() => submit({ responseId: option.responseId })}>
    {option.kind === "spendFloatingMana" ? <ManaPip symbol={option.label} /> : option.label}
  </button>)}</div>;
}

const within = (value: number, min: number, max: number) => value >= min && value <= max;

function selectableFirst<T>(items: T[], isSelectable: (item: T) => boolean) {
  const selectable: T[] = [], unavailable: T[] = [];
  for (const item of items) (isSelectable(item) ? selectable : unavailable).push(item);
  return [...selectable, ...unavailable];
}

export function simpleConfirmation(prompt?: Prompt) {
  if (!prompt?.supported || prompt.kind !== "chooseBoolean" || prompt.cancellable || prompt.options.length ||
      prompt.cards.length || prompt.targets.length || prompt.minChoiceTotal !== 1 || prompt.maxChoiceTotal !== 1 ||
      prompt.choices.length !== 2 || prompt.choices.some((choice) => choice.canRepeat || choice.weight !== 1)) return;
  const yes = prompt.choices.find((choice) => choice.responseId === "choice:1");
  const no = prompt.choices.find((choice) => choice.responseId === "choice:0");
  if (yes && no) return { prompt, yes, no };
}

export function ConfirmationActions({ confirmation, submit }: {
  confirmation: NonNullable<ReturnType<typeof simpleConfirmation>>; submit: (response: Response) => void;
}) {
  const { prompt, yes, no } = confirmation;
  return <>
    <div className="confirmation-question" role="status">
      <strong>{prompt.title}</strong>
      {prompt.detail && prompt.detail !== prompt.title && <span>{prompt.detail}</span>}
      {prompt.contextText && prompt.contextText !== prompt.detail && prompt.contextText !== prompt.title &&
        <small>{prompt.contextText}</small>}
    </div>
    <button type="button" onClick={() => submit({ responseId: "$submit", choiceIds: [no.responseId] })}>{no.label}</button>
    <button type="button" className="primary" onClick={() => submit({ responseId: "$submit", choiceIds: [yes.responseId] })}>{yes.label}</button>
  </>;
}

type Props = { prompt: Prompt; targetIds: string[]; toggleTarget: (id: string) => void;
  submit: (response: Response) => void; disabled: boolean; hoverCard: CardHover };

export function Decision({ prompt, targetIds, toggleTarget, submit, disabled, hoverCard }: Props) {
  const [cards, setCards] = useState<string[]>([]);
  const [choices, setChoices] = useState<string[]>([]);
  const [order, setOrder] = useState(() => (prompt.kind === "chooseDamageAssignmentOrder"
    ? prompt.damageTargets : prompt.orderItems).map((item) => item.responseId));
  const [scry, setScry] = useState(() => Object.fromEntries(prompt.scryDestinations.map((zone, index) =>
    [zone, index === 0 ? prompt.cards.map((card) => card.id) : []])) as Record<string, string[]>);
  const [number, setNumber] = useState(String(prompt.minNumber));
  const [name, setName] = useState("");
  const [combat, setCombat] = useState<NonNullable<Response["assignments"]>>([]);
  const [damage, setDamage] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const confirm = (response: Omit<Response, "responseId"> = {}) => submit({ responseId: "$submit", ...response });

  function reorder(list: string[], id: string, offset: number) {
    const index = list.indexOf(id);
    const next = [...list];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    return next;
  }

  function orderControls(list: string[], id: string, change: (value: string[]) => void, label: string) {
    return <div className="order-controls">
      <button type="button" aria-label={`Move ${label} earlier`} disabled={list[0] === id} onClick={() => change(reorder(list, id, -1))}>↑</button>
      <button type="button" aria-label={`Move ${label} later`} disabled={list.at(-1) === id} onClick={() => change(reorder(list, id, 1))}>↓</button>
    </div>;
  }

  function toggleCard(id: string) {
    setCards((previous) => previous.includes(id) ? previous.filter((card) => card !== id)
      : previous.length < prompt.maxCardSelections ? [...previous, id] : previous);
  }

  const [content, enabled, response] = (() => {
    if (!prompt.supported) return [<p role="alert">This Forge decision is unavailable in the browser. {prompt.kind}</p>, false, {}] as const;
    switch (prompt.kind) {
      case "chooseBoardTargets": {
        const selectable = (target: Target) => !target.selected &&
          (targetIds.includes(target.responseId) || targetIds.length < prompt.maxSelections);
        return [<div className="choices">{selectableFirst(prompt.targets, selectable).map((target) => <button key={target.responseId} type="button"
          aria-pressed={target.selected || targetIds.includes(target.responseId)} disabled={!selectable(target)}
          onClick={() => toggleTarget(target.responseId)}>{target.label}</button>)}</div>,
          within(targetIds.length, prompt.minSelections, prompt.maxSelections), { targetIds }] as const;
      }
      case "chooseCards":
      case "mulliganPutBack":
      case "revealCards": {
        const reveal = prompt.kind === "revealCards";
        const selectable = (card: PromptCard) => !reveal && !card.readOnly &&
          (cards.includes(card.id) || cards.length < prompt.maxCardSelections);
        const matching = prompt.cards.filter((card) => card.name.toLowerCase().includes(filter.toLowerCase()));
        return [<><div className="prompt-filter">{prompt.cards.length > 10 && <input aria-label="Filter cards" placeholder="Filter cards"
          value={filter} onChange={(event) => setFilter(event.target.value)} />}{!reveal && <span>{cards.length} selected</span>}</div>
        <div className="choice-grid">{selectableFirst(matching, selectable).map((card) =>
          <button className="choice-card" type="button" key={card.id} disabled={!selectable(card)}
            onMouseEnter={(event) => hoverCard(card, event.currentTarget)} onMouseLeave={() => hoverCard()}
            aria-pressed={card.selected || cards.includes(card.id)} onClick={() => toggleCard(card.id)}>
            <CardImage identity={card} className="choice-card-image" decorative />
            <strong>{card.name}</strong><small>{card.setCode} {card.collectorNumber}</small>
          </button>)}</div></>, !reveal && within(cards.length, prompt.minCardSelections, prompt.maxCardSelections), { cardIds: cards }] as const;
      }
      case "chooseBoolean":
      case "chooseColor":
      case "chooseFromSelection": {
        const total = choices.reduce((sum, id) => sum + (prompt.choices.find((choice) => choice.responseId === id)?.weight ?? 0), 0);
        const canAdd = (choice: Choice) => total + choice.weight <= prompt.maxChoiceTotal;
        const selectable = (choice: Choice) => choices.includes(choice.responseId) || canAdd(choice);
        return [<div className="choices">{selectableFirst(prompt.choices, selectable).map((choice) => {
          const count = choices.filter((id) => id === choice.responseId).length;
          return <div key={choice.responseId} className="choice-group">
            <button type="button" aria-pressed={count > 0} disabled={(!count || choice.canRepeat) && !canAdd(choice)} onClick={() => {
              if (!choice.canRepeat && count) setChoices(choices.filter((id) => id !== choice.responseId));
              else if (canAdd(choice)) setChoices([...choices, choice.responseId]);
            }}>{choice.label}{choice.canRepeat && count > 0 ? ` ×${count}` : ""}</button>
            {choice.canRepeat && count > 0 && <button type="button" aria-label={`Remove ${choice.label}`} onClick={() => {
              const index = choices.lastIndexOf(choice.responseId);
              setChoices(choices.filter((_, i) => i !== index));
            }}>−</button>}
          </div>;
        })}</div>, within(total, prompt.minChoiceTotal, prompt.maxChoiceTotal), { choiceIds: choices }] as const;
      }
      case "chooseNumber":
        return [<label>Number<input type="number" min={prompt.minNumber} max={prompt.maxNumber} value={number}
          onChange={(event) => setNumber(event.target.value)} /></label>, number !== "" && Number.isInteger(Number(number)) &&
          within(Number(number), prompt.minNumber, prompt.maxNumber), { chosenNumber: Number(number) }] as const;
      case "chooseCardName":
        return [<label>Card name<input value={name} onChange={(event) => setName(event.target.value)} /></label>,
          Boolean(name.trim()), { name: name.trim() }] as const;
      case "reorder":
      case "chooseDamageAssignmentOrder":
        return [<ol className="order-list">{order.map((id) => {
          const item = prompt.orderItems.find((entry) => entry.responseId === id);
          const label = item?.name ?? prompt.damageTargets.find((entry) => entry.responseId === id)?.label ?? id;
          return <li key={id}><div>{label}{item?.oracle && <small>{item.oracle}</small>}</div>
            {orderControls(order, id, setOrder, label)}</li>;
        })}</ol>, true, prompt.kind === "reorder" ? { orderedIds: order } : { damageOrderIds: order }] as const;
      case "scry":
        return [<div className="pile-grid">{prompt.scryDestinations.map((zone) => <section key={zone}>
          <h3>{zone}</h3><ol className="order-list">{scry[zone].map((id) => {
            const card = prompt.cards.find((entry) => entry.id === id);
            const label = card?.name ?? id;
          return <li key={id}><div onMouseEnter={(event) => hoverCard(card, event.currentTarget)} onMouseLeave={() => hoverCard()}>
            <CardImage identity={card} className="choice-card-image" decorative />{label}<select aria-label={`Destination for ${label}`} value={zone} onChange={(event) => {
              const destination = event.target.value;
              setScry({ ...scry, [zone]: scry[zone].filter((cardId) => cardId !== id), [destination]: [...scry[destination], id] });
            }}>{prompt.scryDestinations.map((destination) => <option key={destination}>{destination}</option>)}</select></div>
              {orderControls(scry[zone], id, (next) => setScry({ ...scry, [zone]: next }), label)}</li>;
          })}</ol></section>)}</div>, true, { scryPiles: prompt.scryDestinations.map((destination) =>
            ({ destination, cardIds: scry[destination] })) }] as const;
      case "chooseBlockers":
        return [<div className="choice-grid">{prompt.combatSources.map((source) => <section key={source.responseId} className="combat-source">
          <strong>{source.label || source.name}</strong>
          {prompt.combatTargets.filter((target) => source.validTargetIds.includes(target.responseId)).map((target) => {
            const assignment = { sourceId: source.responseId, targetId: target.responseId };
            const matches = (value: typeof assignment) => value.sourceId === assignment.sourceId && value.targetId === assignment.targetId;
            const chosen = combat.some(matches);
            return <button key={target.responseId} type="button" aria-pressed={chosen} onClick={() => {
              if (chosen) setCombat(combat.filter((value) => !matches(value)));
              else setCombat([...combat, assignment]);
            }}>{target.label}</button>;
          })}
        </section>)}</div>, true, { assignments: combat }] as const;
      case "chooseCombatDamageAssignment": {
        const assigned = prompt.damageTargets.map((target) => ({ targetId: target.responseId, damage: damage[target.responseId] ?? 0 }));
        const total = assigned.reduce((sum, target) => sum + target.damage, 0);
        return [<><p>{prompt.damageSource?.label} · {total} / {prompt.totalDamage}</p>
          {prompt.damageTargets.map((target) => <label className="damage-row" key={target.responseId}>
            {target.label}{target.lethalDamage >= 0 && ` (lethal ${target.lethalDamage})`}
            <input type="number" min={0} max={prompt.totalDamage} value={damage[target.responseId] ?? 0}
              onChange={(event) => setDamage({ ...damage, [target.responseId]: Number(event.target.value) })} />
          </label>)}</>, total === prompt.totalDamage && assigned.every((target) => Number.isInteger(target.damage) && target.damage >= 0),
          { damageAssignments: assigned }] as const;
      }
      case "mulligan":
      case "acknowledge":
      case "diceRolled":
        return [null, false, {}] as const;
      default:
        return [<p role="alert">This Forge decision is unavailable in the browser. {prompt.kind}</p>, false, {}] as const;
    }
  })();
  const submitKinds = ["chooseBoardTargets", "chooseCards", "mulliganPutBack", "chooseBoolean", "chooseColor", "chooseFromSelection",
    "chooseNumber", "chooseCardName", "reorder", "chooseDamageAssignmentOrder", "scry",
    "chooseBlockers", "chooseCombatDamageAssignment"];
  const confirmButton = prompt.supported && submitKinds.includes(prompt.kind) &&
    <button className="primary" type="button" disabled={disabled || !enabled} onClick={() => confirm(response)}>Confirm</button>;
  return <DecisionPanel title={prompt.title || "Forge decision"}
    compactActions={prompt.kind === "chooseBoardTargets" && confirmButton ? <footer>{confirmButton}</footer> : undefined}>
    <fieldset disabled={disabled}>
      <div className="decision-content">
        {prompt.detail && <p>{prompt.detail}</p>}
        {prompt.contextText && prompt.contextText !== prompt.detail && <small>{prompt.contextText}</small>}
        {content}
      </div>
      {prompt.supported && <footer>
        <Options options={prompt.options.filter((option) => !option.cardId || option.kind === "undoMana")} submit={submit} />
        {confirmButton}
        {prompt.cancellable && !prompt.options.some((option) => option.responseId === "$cancel") &&
          <button className="quiet" type="button" onClick={() => submit({ responseId: "$cancel" })}>Cancel action</button>}
      </footer>}
    </fieldset>
  </DecisionPanel>;
}
