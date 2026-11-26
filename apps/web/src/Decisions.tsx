// SPDX-License-Identifier: GPL-3.0-or-later

import { ManaPip } from "./ManaSymbols";
import { useId, useState, type ReactNode } from "react";
import { CardNameSearch } from "./DeclarationSearch";
import { DecisionCard } from "./DecisionCard";
import { OrderStrip } from "./OrderStrip";
import { CardChoiceGrid } from "./CardChoiceGrid";
import { dismissPanel } from "./boardMotion";
import type { Choice, Option, Prompt, PromptCard, Response, Target } from "./protocol";

export function DecisionPanel({ title, children, compactActions, hideTitle = false }: {
  title: string; children: ReactNode; compactActions?: ReactNode; hideTitle?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  return <section className={`decision ${expanded ? "floating" : "collapsed"}`} aria-label={title}>
    <header className={hideTitle ? "decision-actions" : undefined}>{!hideTitle && <h2>{title}</h2>}<button className="quiet" type="button" onClick={(event) => {
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

function namesDisplayedCard(prompt: Prompt, text: string) {
  return text && ([prompt.contextCards, prompt.cards, prompt.orderItems, prompt.targets, prompt.contextTargets,
    prompt.combatSources, prompt.combatTargets, prompt.damageTargets].some((group) => group?.some((card) => card.name === text)) ||
    prompt.choices.some((choice) => choice.card?.name === text) || prompt.damageSource?.name === text);
}

function PromptContext({ prompt }: { prompt: Prompt }) {
  return <>
    {Boolean(prompt.contextCards.length || prompt.contextTargets?.length) && <div className="prompt-context" role="group" aria-label="Decision context">
      {prompt.contextCards.map((card) => <DecisionCard key={card.id} card={card} focusable />)}
      {prompt.contextTargets?.map((target) => <span key={target.responseId}><TargetFace target={target} /></span>)}
    </div>}
    {prompt.detail && prompt.detail !== prompt.title && !namesDisplayedCard(prompt, prompt.detail) &&
      !(prompt.contextCards.length && prompt.detail === prompt.contextText) && <p>{prompt.detail}</p>}
    {!prompt.contextCards.length && prompt.contextText && prompt.contextText !== prompt.detail && prompt.contextText !== prompt.title &&
      <small>{prompt.contextText}</small>}
  </>;
}

function TargetFace({ target }: { target: Target }) {
  return ["card", "spell", "attacker", "planeswalker", "battle"].includes(target.kind)
    ? <DecisionCard card={target} label={target.label} /> : <>{target.label}</>;
}

export function ConfirmationActions({ confirmation, submit }: {
  confirmation: NonNullable<ReturnType<typeof simpleConfirmation>>; submit: (response: Response) => void;
}) {
  const { prompt, yes, no } = confirmation;
  return <>
    <div className="confirmation-question" role="status">
      {!namesDisplayedCard(prompt, prompt.title) && <strong>{prompt.title}</strong>}
      <PromptContext prompt={prompt} />
    </div>
    <button type="button" onClick={() => submit({ responseId: "$submit", choiceIds: [no.responseId] })}>{no.label}</button>
    <button type="button" className="primary" onClick={() => submit({ responseId: "$submit", choiceIds: [yes.responseId] })}>{yes.label}</button>
  </>;
}

type Props = { prompt: Prompt; targetIds: string[]; toggleTarget: (id: string) => void;
  submit: (response: Response) => void; disabled: boolean };

export function Decision({ prompt, targetIds, toggleTarget, submit, disabled }: Props) {
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
          className={target.kind === "player" ? undefined : "choice-card"} aria-label={target.label}
          aria-pressed={target.selected || targetIds.includes(target.responseId)} disabled={!selectable(target)}
          onClick={() => toggleTarget(target.responseId)}><TargetFace target={target} /></button>)}</div>,
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
        <CardChoiceGrid cards={selectableFirst(matching, selectable)} selected={cards} selectable={selectable} choose={toggleCard} /></>, !reveal && within(cards.length, prompt.minCardSelections, prompt.maxCardSelections), { cardIds: cards }] as const;
      }
      case "chooseBoolean":
      case "chooseColor":
      case "chooseFromSelection": {
        const total = choices.reduce((sum, id) => sum + (prompt.choices.find((choice) => choice.responseId === id)?.weight ?? 0), 0);
        const replaceChoice = Boolean(prompt.searchKind) && prompt.maxChoiceTotal === 1;
        const canAdd = (choice: Choice) => (replaceChoice ? 0 : total) + choice.weight <= prompt.maxChoiceTotal;
        const selectable = (choice: Choice) => choices.includes(choice.responseId) || canAdd(choice);
        const needle = filter.trim().toLowerCase();
        const listed = prompt.searchKind ? prompt.choices.filter((choice) =>
          (choice.card?.name || choice.label).toLowerCase().includes(needle)) : prompt.choices;
        return [<>{prompt.searchKind && <label>{prompt.searchKind === "type" ? "Search types" : "Search card names"}
          <input type="search" autoComplete="off" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>}
        {prompt.searchKind && !listed.length && <p role="status">No matching options.</p>}
        <div className="choices">{selectableFirst(listed, selectable).map((choice) => {
          const count = choices.filter((id) => id === choice.responseId).length;
          return <div key={choice.responseId} className="choice-group">
            <button type="button" className={choice.card ? "choice-card" : undefined} aria-label={choice.card ? choice.label : undefined} aria-pressed={count > 0} disabled={(!count || choice.canRepeat) && !canAdd(choice)} onClick={() => {
              if (!choice.canRepeat && count) setChoices(choices.filter((id) => id !== choice.responseId));
              else if (canAdd(choice)) setChoices(replaceChoice ? [choice.responseId] : [...choices, choice.responseId]);
            }}>{choice.card ? <><DecisionCard card={choice.card} />{choice.actionLabel && <span>{choice.actionLabel}</span>}</> : choice.label}{choice.canRepeat && count > 0 ? ` ×${count}` : ""}</button>
            {choice.canRepeat && count > 0 && <button type="button" aria-label={`Remove ${choice.label}`} onClick={() => {
              const index = choices.lastIndexOf(choice.responseId);
              setChoices(choices.filter((_, i) => i !== index));
            }}>−</button>}
          </div>;
        })}</div></>, within(total, prompt.minChoiceTotal, prompt.maxChoiceTotal), { choiceIds: choices }] as const;
      }
      case "chooseNumber":
        return [<label>Number<input type="number" min={prompt.minNumber} max={prompt.maxNumber} value={number}
          onChange={(event) => setNumber(event.target.value)} /></label>, number !== "" && Number.isInteger(Number(number)) &&
          within(Number(number), prompt.minNumber, prompt.maxNumber), { chosenNumber: Number(number) }] as const;
      case "chooseCardName":
        return [<CardNameSearch names={prompt.legalNames} value={name} change={setName} />,
          Boolean(name.trim()) && (!prompt.legalNames || prompt.legalNames.some((option) =>
            option.toLowerCase() === name.trim().toLowerCase())), { name: name.trim() }] as const;
      case "reorder":
      case "chooseDamageAssignmentOrder":
        return [<OrderStrip label="Effect or card order" change={setOrder}
          resolution={prompt.orderItems.some((item) => item.abilityText)} replacement={prompt.replacementOrder}
          items={order.map((id) => {
            const item = prompt.orderItems.find((entry) => entry.responseId === id);
            const target = prompt.damageTargets.find((entry) => entry.responseId === id);
            const label = item?.name || item?.oracle || target?.label || id;
            const instruction = item?.abilityText || (item?.oracle !== item?.name ? item?.oracle : undefined);
            // Keep distinct cards image-only. If two abilities share the same
            // face, the actual ability text identifies the choice, even offline.
            const distinguish = item?.name && instruction && prompt.orderItems.some((other) =>
              other.name === item.name && (other.setCode || "") === (item.setCode || "") &&
              (other.collectorNumber || "") === (item.collectorNumber || "") && Boolean(other.token) === Boolean(item.token) &&
              (other.abilityText || other.oracle) !== (item.abilityText || item.oracle));
            const face = item?.name ? <><DecisionCard card={item} />{distinguish && <span>{instruction}</span>}</>
              : target ? <TargetFace target={target} /> : label;
            return { id, label: distinguish ? `${label} — ${instruction}` : label, description: instruction, face };
        })} />, true, prompt.kind === "reorder" ? { orderedIds: order } : { damageOrderIds: order }] as const;
      case "scry":
        return [<div className="pile-grid">{prompt.scryDestinations.map((zone) => <section key={zone}>
          <h3>{zone}</h3><ol className="order-list">{scry[zone].map((id) => {
            const card = prompt.cards.find((entry) => entry.id === id);
            const label = card?.name ?? id;
          return <li key={id} data-art-focus><div><DecisionCard card={card} /><select aria-label={`Destination for ${label}`} value={zone} onChange={(event) => {
              const destination = event.target.value;
              setScry({ ...scry, [zone]: scry[zone].filter((cardId) => cardId !== id), [destination]: [...scry[destination], id] });
            }}>{prompt.scryDestinations.map((destination) => <option key={destination}>{destination}</option>)}</select></div>
              {orderControls(scry[zone], id, (next) => setScry({ ...scry, [zone]: next }), label)}</li>;
          })}</ol></section>)}</div>, true, { scryPiles: prompt.scryDestinations.map((destination) =>
            ({ destination, cardIds: scry[destination] })) }] as const;
      case "chooseBlockers":
        return [<div className="choice-grid">{prompt.combatSources.map((source) => <section key={source.responseId} className="combat-source">
          <DecisionCard card={source} label={source.label} focusable />
          {prompt.combatTargets.filter((target) => source.validTargetIds.includes(target.responseId)).map((target) => {
            const assignment = { sourceId: source.responseId, targetId: target.responseId };
            const matches = (value: typeof assignment) => value.sourceId === assignment.sourceId && value.targetId === assignment.targetId;
            const chosen = combat.some(matches);
            return <button key={target.responseId} type="button" aria-label={target.label} aria-pressed={chosen} onClick={() => {
              if (chosen) setCombat(combat.filter((value) => !matches(value)));
              else setCombat([...combat, assignment]);
            }}><TargetFace target={target} /></button>;
          })}
        </section>)}</div>, true, { assignments: combat }] as const;
      case "chooseCombatDamageAssignment": {
        const assigned = prompt.damageTargets.map((target) => ({ targetId: target.responseId, damage: damage[target.responseId] ?? 0 }));
        const total = assigned.reduce((sum, target) => sum + target.damage, 0);
        return [<><div className="damage-source">{prompt.damageSource && <DecisionCard card={prompt.damageSource} label={prompt.damageSource.label} focusable />}
          <span>{total} / {prompt.totalDamage}</span></div>
          {prompt.damageTargets.map((target) => <label className="damage-row" key={target.responseId} data-art-focus>
            <TargetFace target={target} />{target.lethalDamage >= 0 && ` (lethal ${target.lethalDamage})`}
            <input type="number" aria-label={`Damage to ${target.label}`} min={0} max={prompt.totalDamage} value={damage[target.responseId] ?? 0}
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
    <button className="primary" type="button" disabled={disabled || !enabled} onClick={() => confirm(response)}>{prompt.replacementOrder ? "OK" : "Confirm"}</button>;
  return <DecisionPanel title={prompt.title || "Forge decision"} hideTitle={Boolean(namesDisplayedCard(prompt, prompt.title))}
    compactActions={prompt.kind === "chooseBoardTargets" && confirmButton ? <footer>{confirmButton}</footer> : undefined}>
    <fieldset disabled={disabled}>
      <div className="decision-content">
        <PromptContext prompt={prompt} />
        {content}
      </div>
      {prompt.supported && <footer>
        <Options options={prompt.options.filter((option) => !option.cardId || option.kind === "undoMana")} submit={submit} />
        {confirmButton}
        {prompt.kind === "reorder" && prompt.replacementOrder &&
          <button type="button" disabled={disabled || !enabled} onClick={() => confirm({ ...response, memorize: true })}>OK &amp; Memorize</button>}
        {prompt.cancellable && !prompt.options.some((option) => option.responseId === "$cancel") &&
          <button className="quiet" type="button" onClick={() => submit({ responseId: "$cancel" })}>Cancel action</button>}
      </footer>}
    </fieldset>
  </DecisionPanel>;
}
