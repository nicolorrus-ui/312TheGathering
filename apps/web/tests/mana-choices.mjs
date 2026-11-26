// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const fixture = JSON.parse(readFileSync(new URL("../../../testdata/protocol/v3/rules-prompt-mana-source.json", import.meta.url))).payload;
const { roomId, gameId, manaSourceId } = fixture;
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const land = { id: manaSourceId, identity: { name: "Cascade Bluffs" }, visible: true, ownerSeat: 0, controllerSeat: 0, typeLine: "Land" };
const painland = { ...land, id: "card-19", identity: { name: "Shivan Reef" } };
const filter = { ...land, id: "card-26", identity: { name: "Mystic Gate" } };
const game = { roomId, gameId, turn: 4, activeSeat: 0, prioritySeat: 0, step: "main1", gameOver: false, players, stack: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function checkMenu(page, viewport, sourceRect, choices = fixture.choices, title = fixture.title) {
  const menu = page.getByRole("group", { name: title, exact: true });
  await menu.waitFor();
  assert.equal(await page.locator(".decision").count(), 0);
  const rect = await menu.boundingBox();
  assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width &&
    rect.y + rect.height <= viewport.height, "the whole mana menu stays within the viewport");
  assert.ok(Math.abs(sourceRect.y - (rect.y + rect.height)) < 14, "the menu is directly above the source");
  const left = Math.max(6, Math.min(sourceRect.x + (sourceRect.width - rect.width) / 2, viewport.width - rect.width - 6));
  assert.ok(Math.abs(rect.x - left) < 2, "the source centers the menu until it reaches a viewport edge");
  const buttons = menu.getByRole("button");
  const rows = await buttons.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  assert.equal(new Set(rows).size, 1, "all mana choices stay on one row");
  for (const choice of choices) {
    const group = menu.getByRole("button", { name: choice.label, exact: true }).locator(".deck-pip[data-glyph=true]");
    assert.deepEqual(await group.evaluateAll((nodes) => nodes.map((node) => node.dataset.color)), choice.manaSymbols);
  }
  return menu;
}

try {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const touch = viewport.width < 500;
    const page = await browser.newPage({ viewport, hasTouch: touch });
    page.setDefaultTimeout(6000);
    const errors = [], events = new EventEmitter();
    page.on("pageerror", (error) => errors.push(String(error)));
    let socket, promptId = 0;
    const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
    const prompt = (overrides) => send("rules.prompt", { ...fixture, ...overrides, promptId: ++promptId });
    const snapshot = (present, card = land) => send("rules.snapshot", { ...game, zones: [
      { zone: "battlefield", ownerSeat: 0, cards: present ? [card] : [], count: Number(present) },
      { zone: "graveyard", ownerSeat: 0, cards: present ? [] : [card], count: Number(!present) },
    ] });
    const sourcePrompt = (kind, card = land) => prompt({ kind, title: kind === "payManaCost" ? "Pay mana" : "Choose an action",
      manaSourceId: undefined, choices: [], options: [{ responseId: "action:8", kind: "activateAbility", cardId: card.id, label: `Activate ${card.identity.name}` }] });
    async function answer(button, expected) {
      const [reply] = await Promise.all([once(events, "response", { signal: AbortSignal.timeout(6000) }),
        touch ? button.tap() : button.click()]);
      assert.deepEqual(reply[0], { promptId, ...expected });
    }
    await page.route("**/card-art?**", (route) => route.abort());
    await page.routeWebSocket("**/ws", (route) => {
      socket = route;
      route.onMessage((raw) => {
        const { type, payload } = JSON.parse(raw.toString());
        if (type === "rules.respond") events.emit("response", payload);
        if (type !== "session.hello") return;
        send("session.welcome", { seat: 0, resumeToken: "mana-seat", roomId, forgeRulesAvailable: true });
        send("room.snapshot", { roomId, phase: "started", seats: players.map(({ name }) => ({ occupied: true, displayName: name })) });
        snapshot(true);
        sourcePrompt("chooseAction");
      });
    });
    await page.goto(url);
    await page.getByLabel("Player name").fill("Alice");
    await page.getByRole("button", { name: "Enter club" }).click();
    const source = page.locator(`.battlefield [data-card-id="${manaSourceId}"]`);
    await source.waitFor();
    await answer(source, { responseId: "action:8" });
    prompt({});
    let menu = await checkMenu(page, viewport, await source.boundingBox());
    // The sacrifice snapshot can arrive on either side of the mana prompt.
    const shownAt = await source.boundingBox();
    snapshot(false);
    await source.waitFor({ state: "detached" });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    menu = await checkMenu(page, viewport, shownAt);
    assert.equal(await menu.getByRole("button", { name: "Cancel mana choice" }).count(), 0);
    await answer(menu.getByRole("button", { name: "Blue and red" }), { responseId: "$submit", choiceIds: ["choice:1"] });

    snapshot(true);
    sourcePrompt("payManaCost");
    await page.getByRole("region", { name: "Mana payment" }).waitFor();
    await answer(source, { responseId: "action:8" });
    const lastPosition = await source.boundingBox();
    snapshot(false);
    await source.waitFor({ state: "detached" });
    prompt({ minChoiceTotal: 0 });
    menu = await checkMenu(page, viewport, lastPosition);
    await answer(menu.getByRole("button", { name: "Cancel mana choice" }), { responseId: "$submit", choiceIds: [] });

    // The native host projects each known outcome as an independent response.
    // Damage and activation costs remain accessible even when the button face is a glyph.
    const title = "Choose a mana ability";
    const choicesFor = (symbols, labels) => symbols.map((manaSymbols, index) => ({
      responseId: "choice:" + index, label: labels[index], manaSymbols, weight: 1, canRepeat: false,
    }));
    const painChoices = choicesFor([["C"], ["U"], ["R"]], ["{T}: Add {C}.",
      "{U} — {T}: Add {U} or {R}. Shivan Reef deals 1 damage to you.",
      "{R} — {T}: Add {U} or {R}. Shivan Reef deals 1 damage to you."]);
    snapshot(true, painland);
    const reef = page.locator(`.battlefield [data-card-id="${painland.id}"]`);
    for (const color of painChoices) {
      sourcePrompt("chooseAction", painland);
      await answer(reef, { responseId: "action:8" });
      prompt({ title, manaSourceId: painland.id, choices: painChoices, minChoiceTotal: 0 });
      menu = await checkMenu(page, viewport, await reef.boundingBox(), painChoices, title);
      assert.equal(await menu.getByRole("button").count(), 4, "three single-color choices plus optional Cancel");
      const button = menu.getByRole("button", { name: color.label, exact: true });
      assert.equal(await button.getAttribute("title"), color.label);
      await answer(button, { responseId: "$submit", choiceIds: [color.responseId] });
    }

    // Tap the filter land during payment. Its two simultaneous mana stay in one button.
    const filterCost = "{W/U}, {T}: Add {W}{W}, {W}{U}, or {U}{U}.";
    const pairs = choicesFor([["C"], ["W", "W"], ["W", "U"], ["U", "U"]], [
      "{T}: Add {C}.", `{W}{W} — ${filterCost}`, `{W}{U} — ${filterCost}`, `{U}{U} — ${filterCost}`]);
    snapshot(true, filter);
    sourcePrompt("payManaCost", filter);
    await page.getByRole("region", { name: "Mana payment" }).waitFor();
    const gate = page.locator(`.battlefield [data-card-id="${filter.id}"]`);
    await answer(gate, { responseId: "action:8" });
    prompt({ title, manaSourceId: filter.id, choices: pairs, minChoiceTotal: 0 });
    menu = await checkMenu(page, viewport, await gate.boundingBox(), pairs, title);
    assert.equal(await menu.getByRole("button").count(), 5, "colorless, three pairs and optional Cancel");
    await answer(menu.getByRole("button", { name: pairs[2].label }), { responseId: "$submit", choiceIds: [pairs[2].responseId] });

    prompt({ manaSourceId: undefined, title: "Choose a permanent", choices: [
      { responseId: "choice:9", label: "Forest", weight: 1, canRepeat: false }] });
    const decision = page.locator(".decision");
    await decision.waitFor();
    assert.equal(await page.locator(".mana-choice-menu").count(), 0);
    await decision.getByRole("button", { name: "Forest", exact: true }).click();
    await answer(decision.getByRole("button", { name: "Confirm", exact: true }), { responseId: "$submit", choiceIds: ["choice:9"] });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS mana choices at ${viewport.width}px`);
  }
} finally { await browser.close(); }
