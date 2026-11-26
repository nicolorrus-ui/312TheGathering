// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const roomId = "CHOICE", gameId = "choice-order";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const cards = [
  { name: "Island", readOnly: true }, { name: "Ponder" }, { name: "Grizzly Bears", readOnly: true }, { name: "Opt" },
].map((card, i) => ({ ...card, id: `card-${i}`, setCode: "TST", collectorNumber: String(100 + i) }));
const abilityFixture = JSON.parse(readFileSync(new URL("../../../testdata/protocol/v3/rules-prompt-order-abilities.json",
  import.meta.url), "utf8")).payload.orderItems;
const rulesText = "Draw a card, then discard a card.";

async function checkChoices(viewport, touch) {
  const page = await browser.newPage({ viewport, isMobile: touch, hasTouch: touch });
  page.setDefaultTimeout(6000);
  const errors = [], requestedFaces = [], events = new EventEmitter();
  page.on("pageerror", (err) => errors.push(err.message));
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  await page.route("**/assets/cards/index.json", (r) => r.fulfill({ json: { version: 1, names: {}, printings: {} } }));
  await page.route("**/card-art?**", (r) => {
    const face = new URL(r.request().url()).searchParams.get("name");
    requestedFaces.push(face);
    if (face === "no artwork") return r.fulfill({ status: 404, body: "" });
    return r.fulfill({ contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="green"/></svg>' });
  });
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === "rules.respond") events.emit("answer", payload);
      if (type !== "session.hello") return;
      send("session.welcome", { seat: 0, resumeToken: "choice-seat", roomId, forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map(({ name }) => ({ occupied: true, displayName: name })) });
      send("rules.snapshot", { roomId, gameId, turn: 1, activeSeat: 0, prioritySeat: 0, step: "main1",
        players, zones: [], stack: [], gameOver: false });
    });
  });
  await page.goto(process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320");
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  await page.getByRole("region", { name: "Your hand" }).waitFor();
  const panel = page.locator(".decision");
  const grid = panel.locator(".choice-card");
  const button = (name) => panel.getByRole("button", { name, exact: true });
  const names = () => grid.evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute("aria-label")));
  const imageNames = (region) => region.locator("img").evaluateAll((imgs) =>
    imgs.map((img) => new URL(img.src).searchParams.get("name")));
  async function show(kind, fields) {
    const title = `Testing ${kind} ${++promptId}`;
    send("rules.prompt", { roomId, gameId, promptId, kind, title, pending: true, supported: true,
      cards: [], choices: [], targets: [], options: [], contextCards: [], orderItems: [], damageTargets: [],
      scryDestinations: [], combatSources: [], combatTargets: [], ...fields });
    await panel.getByRole("heading", { name: title }).waitFor();
  }
  async function submit(label, response) {
    const action = button(label).and(panel.locator("button:enabled"));
    try {
      // Keyboard activation, unlike a Playwright click, does not wait for the
      // button to become enabled after the preceding React selection update.
      await action.waitFor();
      const [[received]] = await Promise.all([once(events, "answer", { signal: AbortSignal.timeout(6000) }),
        action.press("Enter")]);
      assert.deepEqual(received, { promptId, ...response });
    } catch (error) {
      throw new Error(`Could not submit ${label} at ${viewport.width}px, ${await panel.locator("header h2").innerText()}`, { cause: error });
    }
  }
  const confirm = (fields) => submit("Confirm", { responseId: "$submit", ...fields });
  async function cardFace(tile, name) {
    const art = tile.locator("img");
    await art.waitFor();
    await art.evaluate((img) => img.decode());
    assert.deepEqual(await imageNames(tile), [name.toLowerCase()]);
    assert.equal((await tile.innerText()).trim(), "", "the tile should show the card image without a second caption");
  }

  await show("chooseCards", { cards, minCardSelections: 1, maxCardSelections: 1 });
  assert.deepEqual(await names(), ["Ponder", "Opt", "Island", "Grizzly Bears"]);
  for (const card of cards) {
    const tile = button(card.name);
    await cardFace(tile, card.name);
    assert.equal(await tile.isDisabled(), Boolean(card.readOnly));
  }
  assert.ok(await button("Confirm").isDisabled());
  const opt = button("Opt");
  if (touch) {
    await opt.tap();
  } else {
    await button("Minimize").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Ponder");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Opt");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Island");
    await page.locator('.card-hover-preview img[src*="name=island"]').waitFor();
    await page.keyboard.press("Space");
    assert.ok(await button("Confirm").isDisabled(), "inspecting a read-only card cannot select it");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");
  }
  assert.equal(await opt.getAttribute("aria-pressed"), "true");
  assert.deepEqual(await names(), ["Opt", "Island", "Ponder", "Grizzly Bears"]);
  assert.equal(await grid.and(panel.locator(":enabled")).count(), 1);
  await opt.press("Space");
  assert.ok(await button("Confirm").isDisabled());
  assert.deepEqual(await names(), ["Ponder", "Opt", "Island", "Grizzly Bears"]);
  await button("Ponder").press("Enter");
  await confirm({ cardIds: [cards[1].id] });

  // A required singleton among revealed lands must still have a real, explicit
  // selection. A private optional hand picker can instead confirm zero.
  const revealedHand = [{ ...cards[0], name: "Mountain" }, { ...cards[1], name: "Lightning Bolt" }];
  await show("chooseCards", { cards: revealedHand, minCardSelections: 1, maxCardSelections: 1 });
  assert.deepEqual(await names(), ["Lightning Bolt", "Mountain"]);
  assert.ok(await button("Mountain").isDisabled());
  assert.ok(await button("Confirm").isDisabled());
  await button("Lightning Bolt").press("Space");
  await confirm({ cardIds: [revealedHand[1].id] });
  await show("chooseCards", { cards: revealedHand, minCardSelections: 0, maxCardSelections: 1 });
  assert.ok(await button("Confirm").isEnabled());
  await confirm({ cardIds: [] });

  await show("chooseFromSelection", { searchKind: "name", minChoiceTotal: 1, maxChoiceTotal: 1,
    contextCards: revealedHand.map((card, index) => ({ ...card, id: `context-card:${index}`, readOnly: true })),
    choices: [{ label: "Lightning Bolt", responseId: "choice:0", weight: 1, canRepeat: false, card: { name: "Lightning Bolt" } }] });
  const context = panel.getByRole("group", { name: "Decision context" });
  await context.locator("img").last().waitFor();
  assert.deepEqual(await imageNames(context), ["mountain", "lightning bolt"]);
  const search = panel.getByRole("searchbox", { name: "Search card names" });
  await search.fill("Mountain");
  assert.equal(await button("Mountain").count(), 0);
  assert.equal(await context.locator("img").count(), 2);
  await search.fill("bolt");
  await button("Lightning Bolt").press("Enter");
  await confirm({ choiceIds: ["choice:0"] });

  const reprint = { ...cards[1], id: "other-ponder", setCode: "ALT", collectorNumber: "201" };
  await show("chooseCards", { cards: [cards[1], reprint], minCardSelections: 1, maxCardSelections: 1 });
  const otherPrinting = button("Ponder").filter({ has: page.locator('img[src*="set=alt"][src*="number=201"]') });
  await otherPrinting.press("Space");
  await confirm({ cardIds: [reprint.id] });

  const missing = { ...cards[1], name: "No Artwork", id: "missing-printing" };
  await show("mulliganPutBack", { cards: [missing], minCardSelections: 1, maxCardSelections: 1 });
  await button(missing.name).getByText(missing.name, { exact: true }).waitFor();
  assert.equal((await button(missing.name).innerText()).trim(), missing.name);
  assert.ok(requestedFaces.includes("no artwork"));
  await button(missing.name).press("Space");
  await confirm({ cardIds: [missing.id] });

  await show("chooseBoardTargets", { minSelections: 1, maxSelections: 1, targets: [
    { ...cards[0], label: "Island", kind: "card", objectId: "visible-land", responseId: "target:0", selected: true },
    { label: "Bob", kind: "player", seat: 1, responseId: "target:1" },
    { ...cards[2], label: "Grizzly Bears", kind: "card", objectId: "visible-bear", responseId: "target:2" },
    { label: "Face-down permanent", kind: "card", objectId: "face-down-object", responseId: "target:3" },
  ] });
  assert.deepEqual(await panel.locator(".choices button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))),
    ["Bob", "Grizzly Bears", "Face-down permanent", "Island"]);
  assert.ok(await button("Island").isDisabled());
  assert.ok(await button("Bob").isEnabled());
  assert.equal(await button("Bob").innerText(), "Bob");
  await cardFace(button("Grizzly Bears"), "Grizzly Bears");
  const anonymous = button("Face-down permanent");
  await anonymous.getByRole("img").waitFor();
  assert.equal(await anonymous.locator("img").count(), 0);
  assert.ok(!requestedFaces.some((face) => /face.down|face-down-object/i.test(face)));
  await button("Grizzly Bears").press("Space");
  await confirm({ targetIds: ["target:2"] });

  await show("chooseFromSelection", { minChoiceTotal: 1, maxChoiceTotal: 2,
    choices: ["Double", "Draw a card", "Gain life"].map((label, i) => ({ label, responseId: `choice:${i}`, weight: i === 0 ? 2 : 1 })) });
  await button("Draw a card").press("Enter");
  assert.deepEqual(await panel.locator(".choices button").allTextContents(), ["Draw a card", "Gain life", "Double"]);
  assert.ok(await button("Double").isDisabled());
  await confirm({ choiceIds: ["choice:1"] });

  const modalCard = { id: "card-mode", name: "Lay Claim" };
  const modes = ["Cast", "Cycle"].map((actionLabel, i) => ({ responseId: `ability:${i}`, weight: 1, canRepeat: false,
    card: modalCard, label: `${actionLabel} Lay Claim`, actionLabel }));
  await show("chooseFromSelection", { minChoiceTotal: 1, maxChoiceTotal: 1, choices: modes,
    contextCards: [modalCard], contextText: rulesText, detail: "Choose how to play the card." });
  for (const mode of modes) {
    const choice = button(mode.label);
    await choice.locator("img").waitFor();
    assert.deepEqual(await imageNames(choice), ["lay claim"]);
    assert.equal((await choice.innerText()).trim(), mode.actionLabel, "different actions on the same card stay distinguishable");
  }
  await panel.getByText("Choose how to play the card.", { exact: true }).waitFor();
  assert.ok(!(await panel.innerText()).includes(rulesText));
  await button("Cycle Lay Claim").press("Enter");
  await confirm({ choiceIds: [modes[1].responseId] });

  await show("chooseCombatDamageAssignment", { damageSource: { name: "Colossal Dreadmaw", label: "Colossal Dreadmaw" },
    totalDamage: 3, damageTargets: [
      { ...cards[2], label: "Grizzly Bears", kind: "card", responseId: "damage:0", lethalDamage: 2 },
      { label: "Defender", kind: "defender", responseId: "damage:1", lethalDamage: -1 },
    ] });
  const defender = panel.locator(".damage-row").filter({ has: page.getByRole("spinbutton", { name: "Damage to Defender" }) });
  assert.equal((await defender.innerText()).trim(), "Defender");
  assert.equal(await defender.getByRole("img").count(), 0);
  await panel.getByRole("spinbutton", { name: "Damage to Grizzly Bears" }).fill("2");
  assert.ok(await button("Confirm").isDisabled());
  await defender.getByRole("spinbutton").fill("1");
  await confirm({ damageAssignments: [{ targetId: "damage:0", damage: 2 }, { targetId: "damage:1", damage: 1 }] });

  await show("revealCards", { cards, options: [{ kind: "acknowledge", label: "Continue", responseId: "$ack" }] });
  assert.deepEqual(await names(), cards.map((card) => card.name));
  assert.equal(await grid.and(panel.locator(":enabled")).count(), 0);
  await button("Minimize").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Island");
  await page.keyboard.press("End");
  await page.locator('.card-hover-preview img[src*="name=opt"]').waitFor();
  await page.keyboard.press("Space");
  assert.equal(await panel.locator('[aria-pressed="true"]').count(), 0);
  await page.keyboard.press("Tab");
  assert.ok(await button("Continue").evaluate((b) => b === document.activeElement));
  await submit("Continue", { responseId: "$ack" });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page overflow");

  await show("reorder", { orderItems: cards.map(({ id, ...card }) => ({ ...card, responseId: id, oracle: rulesText })) });
  const ordered = panel.locator(".order-strip");
  await ordered.locator("img").first().waitFor();
  assert.deepEqual(await imageNames(ordered), cards.map((card) => card.name.toLowerCase()));
  assert.doesNotMatch(await ordered.innerText(), /Island|Grizzly Bears|TST|Draw a card, then discard a card/);
  // Model moving to Confirm immediately after the cards change position,
  // before the next paint. Focus restoration must not steal the next keystroke.
  await ordered.evaluate((track) => {
    const observe = new MutationObserver(() => {
      observe.disconnect();
      track.closest(".decision").querySelector("button.primary").focus();
    });
    observe.observe(track, { childList: true });
  });
  await ordered.getByRole("button", { name: "Ponder", exact: true }).press("ArrowLeft");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await button("Confirm").evaluate((element) => element === document.activeElement));
  await confirm({ orderedIds: [cards[1].id, cards[0].id, cards[2].id, cards[3].id] });

  await show("reorder", { orderItems: abilityFixture });
  for (const item of abilityFixture) {
    const row = ordered.getByRole("listitem").filter({ has: page.getByRole("img", { name: item.name, exact: true }) });
    await row.waitFor();
    assert.deepEqual(await imageNames(row), [item.name.toLowerCase()]);
    assert.equal(await row.getAttribute("aria-description"), item.abilityText);
    assert.ok(!(await row.innerText()).includes(item.abilityText));
  }

  const triggers = [
    { name: "Lotus Field", abilityText: "Sacrifice two lands.", responseId: "order:land-a" },
    { name: "Crumbling Vestige", abilityText: "Add one mana of any color.", responseId: "order:land-b" },
  ];
  await show("reorder", { orderItems: triggers });
  await panel.getByText("Resolves first", { exact: true }).waitFor();
  assert.equal(await ordered.getByRole("button").count(), 2);
  assert.deepEqual(await imageNames(ordered), triggers.map((trigger) => trigger.name.toLowerCase()));
  // Read both rectangles in the same frame while the decision pane is opening.
  const [lotus, vestige] = await ordered.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().toJSON()));
  assert.ok(lotus && vestige && lotus.y === vestige.y);
  const y = lotus.y + lotus.height / 2, from = vestige.x + vestige.width / 2, to = lotus.x + lotus.width / 3;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const point = (x) => [{ x, y, id: 0 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
    for (let step = 1; step <= 5; step++)
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from + (to - from) * step / 5) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 5 });
    await page.mouse.up();
  }
  assert.deepEqual(await imageNames(ordered), ["crumbling vestige", "lotus field"]);
  await confirm({ orderedIds: [triggers[1].responseId, triggers[0].responseId] });
  assert.equal(await button("OK & Memorize").count(), 0);

  const replacement = JSON.parse(readFileSync(new URL("../../../testdata/protocol/v3/rules-prompt-replacement-order.json",
    import.meta.url), "utf8")).payload.orderItems;
  const replacementIds = replacement.map((item) => item.responseId);
  await show("reorder", { orderItems: replacement, replacementOrder: true });
  await panel.getByText("Applies first", { exact: true }).waitFor();
  await submit("OK", { responseId: "$submit", orderedIds: replacementIds });
  await show("reorder", { orderItems: replacement, replacementOrder: true });
  await ordered.getByRole("button", { name: "Spelunking", exact: true }).press("ArrowLeft");
  await submit("OK & Memorize", { responseId: "$submit", orderedIds: [...replacementIds].reverse(), memorize: true });

  const instructions = ["Draw two cards.", "Exile a permanent or a card from your hand or graveyard."];
  await show("reorder", { orderItems: instructions.map((abilityText, i) => ({ name: "Lich's Mastery", abilityText, responseId: `trigger:${i}` })) });
  for (const instruction of instructions) await ordered.getByText(instruction, { exact: true }).waitFor();
  const secondTrigger = ordered.getByRole("listitem").filter({ hasText: instructions[1] });
  await secondTrigger.getByRole("button").press("ArrowLeft");
  await confirm({ orderedIds: ["trigger:1", "trigger:0"] });

  await show("scry", { cards, scryDestinations: ["libraryTop", "libraryBottom"] });
  assert.deepEqual(await imageNames(panel), cards.map((card) => card.name.toLowerCase()));
  const destinations = panel.getByRole("combobox");
  assert.deepEqual(await destinations.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))),
    cards.map((card) => "Destination for " + card.name));
  await panel.getByRole("combobox", { name: "Destination for Opt" }).selectOption("libraryBottom");
  await confirm({ scryPiles: [{ destination: "libraryTop", cardIds: cards.slice(0, 3).map((card) => card.id) },
    { destination: "libraryBottom", cardIds: [cards[3].id] }] });
  assert.deepEqual(errors, []);
  await page.close();
  console.log(`Verified card choices, missing art, controls, targeting and ordering at ${viewport.width}px`);
}

try {
  await checkChoices({ width: 1440, height: 960 }, false);
  await checkChoices({ width: 390, height: 844 }, true);
} finally { await browser.close(); }
