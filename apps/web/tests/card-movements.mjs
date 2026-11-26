// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, manaPool: [], status: "playing" }));
const roomId = "MOTION", identity = { name: "Grizzly Bears", setCode: "10e", collectorNumber: "268" };
const at = (zone, seat, objectId) => ({ zone, seat, objectId });
const card = (id, ownerSeat = 0) => ({ id, ownerSeat, controllerSeat: ownerSeat, visible: true, identity });
const spell = { id: "stack-4", identity, text: identity.name, controllerSeat: 0 };
const empty = () => ({ roomId, gameId: "motion-test", turn: 1, activeSeat: 0, prioritySeat: 0,
  step: "main1", players, stack: [], gameOver: false, zones: players.flatMap(({ seat }) =>
    ["library", "hand", "battlefield", "exile", "graveyard"].map((zone) => ({ zone, ownerSeat: seat, count: 0, cards: [] }))) });
const point = (rect) => [rect.x + rect.width / 2, rect.y + rect.height / 2];
const near = (a, b) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 3, `centers ${a} / ${b}`);

async function verifyStackPile(page, update, send, events) {
  const pile = page.getByRole("complementary", { name: "Spell and ability stack" });
  const object = (id) => pile.locator(`[data-stack-id="${id}"]`);
  const middle = { ...spell, id: "stack-5", identity: { name: "Prodigal Sorcerer" }, text: "Deal 1 damage to any target." };
  const newest = { ...spell, id: "stack-6", identity: { name: "Counterspell" }, text: "Counter target spell." };
  const push = (stack) => update({ ...empty(), stack });
  const inspect = page.getByRole("region", { name: "Card preview" });
  const settle = () => pile.evaluate(async (stack) => {
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(stack.parentElement.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const edge = async (id) => {
    const rect = await object(id).boundingBox();
    const [x, y] = [rect.x + 7, rect.y + rect.height / 2];
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-stack-id]")?.dataset.stackId,
      [x, y]), id, "the lower card must have a pointer-accessible edge");
    return [x, y];
  };
  assert.equal(await pile.getByText("Stack", { exact: true }).count(), 0);
  assert.ok(await object(spell.id).evaluate((button) => {
    for (let wrapper = button.parentElement; wrapper && !wrapper.matches(".table"); wrapper = wrapper.parentElement) {
      const css = getComputedStyle(wrapper);
      if (css.borderTopWidth !== "0px" || css.backgroundColor !== "rgba(0, 0, 0, 0)" || css.boxShadow !== "none") return false;
    }
    return true;
  }), "a lone stack card must not have a visible tray around it");

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    // Forge sends top first. Verify the actual pointer hit where all three card images overlap.
    push([newest, middle, spell]);
    await object(newest.id).waitFor();
    await settle();
    const [front, back] = await Promise.all([object(newest.id).boundingBox(), object(spell.id).boundingBox()]);
    assert.ok(front.x > back.x && Math.abs(front.y - back.y) < 2, "the newest card must be to the right");
    const overlap = Math.min(front.x + front.width, back.x + back.width) - Math.max(front.x, back.x);
    assert.ok(overlap > 2, "three stack cards should visibly overlap");
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-stack-id]")?.dataset.stackId,
      [Math.max(front.x, back.x) + overlap / 2, front.y + front.height / 2]);
    assert.equal(hit, newest.id, "the newest object must cover older spells and abilities");
    await page.mouse.move(...await edge(middle.id));
    await page.locator('.card-hover-preview img[src*="name=prodigal+sorcerer"]').waitFor();
    await page.mouse.click(...await edge(middle.id));
    await inspect.getByText(middle.text, { exact: true }).waitFor();
    await inspect.getByRole("button", { name: "Close" }).click();

    const target = { kind: "spell", objectId: spell.id, responseId: "target:0", label: spell.identity.name };
    send("rules.prompt", { roomId, gameId: empty().gameId, promptId: width, pending: true, supported: true,
      kind: "chooseBoardTargets", title: "Choose a target", minSelections: 1, maxSelections: 1, targets: [target],
      options: [], choices: [], cards: [], contextCards: [], orderItems: [], scryDestinations: [], damageTargets: [] });
    const choice = page.getByRole("region", { name: "Choose a target" });
    await choice.getByRole("button", { name: "Minimize" }).click();
    await page.mouse.click(...await edge(spell.id));
    assert.equal(await object(spell.id).getAttribute("aria-pressed"), "true");
    const [[reply]] = await Promise.all([once(events, "response", { signal: AbortSignal.timeout(6000) }),
      choice.getByRole("button", { name: "Confirm" }).click()]);
    assert.deepEqual(reply, { promptId: width, responseId: "$submit", targetIds: [target.responseId] });
    send("rules.prompt", { roomId, gameId: empty().gameId, promptId: width, pending: false });
    await choice.waitFor({ state: "detached" });
    push([middle, spell]);
    await object(newest.id).waitFor({ state: "detached" });
    await settle();
    const center = point(await object(middle.id).boundingBox());
    await page.mouse.click(...center);
    await inspect.getByText(middle.text, { exact: true }).waitFor();
    await inspect.getByRole("button", { name: "Close" }).click();
  }
  const many = Array.from({ length: 36 }, (_, index) => ({ ...middle, id: `ability-${index}` }));
  push(many);
  const last = many.at(-1).id;
  await object(last).waitFor({ state: "attached" });
  await settle();
  await pile.hover();
  await page.mouse.wheel(0, 2000);
  await page.waitForFunction(() => {
    const stack = document.querySelector("[data-motion-zone=stack] aside");
    return stack.scrollLeft < 0 && Math.abs(stack.scrollLeft) + stack.clientWidth >= stack.scrollWidth - 2;
  });
  await page.mouse.click(...await edge(last));
  await inspect.getByText(middle.text, { exact: true }).waitFor();
  await inspect.getByRole("button", { name: "Close" }).click();
  assert.ok(await pile.evaluate((stack) => stack.scrollLeft < 0));
  await object(last).focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(() => Math.abs(document.querySelector("[data-motion-zone=stack] aside").scrollLeft) < 1);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.stackId), many[0].id);
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const stack = document.querySelector("[data-motion-zone=stack] aside");
    return Math.abs(stack.scrollLeft) + stack.clientWidth >= stack.scrollWidth - 2;
  });
  assert.equal(await page.evaluate(() => document.activeElement.dataset.stackId), last);
  push([newest, ...many]);
  await object(newest.id).waitFor({ state: "attached" });
  await settle();
  await page.waitForFunction(() => Math.abs(document.querySelector("[data-motion-zone=stack] aside").scrollLeft) < 1);
  const topCenter = point(await object(newest.id).boundingBox());
  assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("[data-stack-id]")?.dataset.stackId,
    topCenter), newest.id, "a new spell should be in front and visible after scrolling deep into the stack");
  push([spell]);
  await object(spell.id).waitFor();
  await settle();
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(6000);
  // Pause real Web Animations so Chromium can measure the start, midpoint and landing.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const run = animate.apply(this, args);
      if (this.matches(".moving-card, [data-returning]")) run.pause();
      return run;
    };
  });
  await page.route("**/assets/cards/index.json", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/card-art?**", (r) => r.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="green"/></svg>' }));
  let socket, count = 0, connections = 0;
  const events = new EventEmitter();
  const moves = [];
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  const update = (game, ...next) => {
    moves.push(...next.map(([from, to, castId]) => ({ id: ++count, from, to, castId })));
    send("rules.snapshot", { ...game, cardMoves: [...moves] });
  };
  const stack = () => ({ ...empty(), stack: [spell] });
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === "rules.respond") events.emit("response", payload);
      if (type !== "session.hello") return;
      ++connections;
      send("session.welcome", { seat: 0, resumed: connections > 1, resumeToken: "motion-seat", roomId, forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map((p) => ({ occupied: true, displayName: p.name })) });
      update(stack(), [at("hand", 0), at("stack", 0, spell.id)]);
      if (connections > 1) events.emit("resumed");
    });
  });
  await page.goto(url);
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  const tray = page.getByRole("complementary", { name: "Spell and ability stack" });
  const thumbnail = tray.getByRole("button", { name: identity.name });
  await thumbnail.waitFor();
  const ghost = page.locator(".moving-card");
  assert.equal(await ghost.count(), 0, "historical moves replayed at join");
  await verifyStackPile(page, update, send, events);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    const [table, pile, image] = await Promise.all([page.locator(".table"), tray, thumbnail.locator("img")].map((e) => e.boundingBox()));
    assert.ok(pile.x > table.x + table.width / 2 && Math.abs(point(pile)[1] - page.viewportSize().height / 2) < 2);
    assert.ok(image.width >= 40 && image.height > image.width, "stack should show a portrait thumbnail");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".table").evaluate((el) => { el.style.minHeight = "1650px"; window.scrollTo(0, 420); });
  const scrolled = await tray.boundingBox();
  assert.ok(Math.abs(point(scrolled)[1] - 480) < 2, "stack must remain centered when the battlefield scrolls");
  await page.locator(".table").evaluate((el) => { el.style.minHeight = ""; window.scrollTo(0, 0); });
  const finish = async () => {
    await ghost.evaluate((e) => e.getAnimations()[0].finish());
    await ghost.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-arriving]").count(), 0);
  };
  // Receiving the real stack entry preserves
  // its thumbnail and must not replay the inbound flight, even when the first flight is unfinished.
  const owned = card("card-81");
  const ownedHand = empty();
  Object.assign(ownedHand.zones.find((zone) => zone.zone === "hand" && zone.ownerSeat === 0), { count: 1, cards: [owned] });
  const origin = at("hand", 0, owned.id);
  const pending = { ...empty(), pendingCast: { id: "casting-81", controllerSeat: 0, identity, from: origin } };
  const pendingCard = tray.locator("[data-pending]");
  const paid = { ...spell, id: "stack-81", castId: "casting-81" };
  update(ownedHand);
  await page.locator('[data-card-id="card-81"]').waitFor();
  update(pending);
  await pendingCard.waitFor({ state: "attached" });
  assert.equal(await pendingCard.getAttribute("data-actionable"), "false");
  await ghost.waitFor();
  assert.equal(await ghost.getAttribute("data-to"), "stack");
  await finish();
  update(ownedHand);
  await ghost.waitFor();
  assert.equal(await ghost.getAttribute("data-from"), "stack");
  assert.equal(await ghost.getAttribute("data-to"), "hand");
  await finish();
  update(pending);
  await pendingCard.waitFor({ state: "attached" });
  await ghost.waitFor();
  await pendingCard.evaluate((el) => el.dataset.testContinuity = "before-payment");
  await ghost.evaluate((el) => el.dataset.testContinuity = "original-flight");
  update({ ...empty(), stack: [paid] }, [origin, at("stack", 0, paid.id), paid.castId]);
  await tray.locator('[data-stack-id="stack-81"]').waitFor({ state: "attached" });
  assert.equal(await tray.getByRole("button").count(), 1);
  assert.equal(await pendingCard.count(), 0);
  assert.equal(await tray.locator("[data-stack-id]").getAttribute("data-test-continuity"), "before-payment");
  assert.equal(await ghost.getAttribute("data-test-continuity"), "original-flight");
  await finish();

  // An observer learns the ordinary spell's public face when it enters the stack.
  // Its cancellation returns a back to the hand, without an identifiable hand slot.
  const unknownOrigin = at("hand", 1);
  update({ ...empty(), pendingCast: { id: "casting-82", controllerSeat: 1, from: unknownOrigin, identity } });
  await pendingCard.waitFor({ state: "attached" });
  await ghost.waitFor();
  await finish();
  update(empty());
  await ghost.waitFor();
  assert.equal(await ghost.getAttribute("data-to"), "hand");
  assert.ok(await ghost.evaluate((el) => el.classList.contains("card-back") && !el.textContent && !el.querySelector("img")));
  await finish();
  // A cast and its resolution can arrive together. The public announcement supplies
  // the exact stack source even though the hand source was anonymous all along.
  update({ ...empty(), pendingCast: { id: "casting-83", controllerSeat: 1, from: unknownOrigin, identity } });
  await pendingCard.waitFor({ state: "attached" });
  await ghost.waitFor();
  await finish();
  const resolved = empty();
  Object.assign(resolved.zones.find((zone) => zone.zone === "battlefield" && zone.ownerSeat === 1),
    { count: 1, cards: [card("card-83", 1)] });
  update(resolved, [unknownOrigin, at("stack", 1, "stack-83"), "casting-83"],
    [at("stack", 1, "stack-83"), at("battlefield", 1, "card-83")]);
  await ghost.waitFor();
  assert.equal(await ghost.getAttribute("data-from"), "stack");
  assert.equal(await ghost.getAttribute("data-to"), "battlefield");
  assert.equal(await ghost.count(), 1);
  await finish();
  // Public destinations use the exact visible card; hidden destinations expose only the pile.
  for (const [zone, seat, known] of [["hand", 0, true], ["hand", 1, false], ["library", 0, false],
    ["battlefield", 0, true], ["graveyard", 0, true], ["exile", 0, true]]) {
    update(stack());
    await thumbnail.waitFor();
    const from = point(await thumbnail.boundingBox());
    const result = empty();
    const pile = result.zones.find((z) => z.ownerSeat === seat && z.zone === zone);
    pile.count = 1;
    if (known) pile.cards = [card("card-4", seat)];
    update(result, [at("stack", 0, spell.id), at(zone, seat, known ? "card-4" : undefined)]);
    await ghost.waitFor();
    assert.equal(await tray.count(), 0);
    assert.equal(await ghost.evaluate((e) => e.classList.contains("card-back")), !known);
    assert.equal(await ghost.locator("img").count(), known ? 1 : 0);
    near(point(await ghost.boundingBox()), from);
    const target = known && (zone === "hand" || zone === "battlefield") ? page.locator('[data-card-id="card-4"]')
      : page.locator(`[data-motion-zone="${zone}"][data-seat="${seat}"]`);
    const to = point(await target.boundingBox());
    const sample = async (fraction) => {
      await ghost.evaluate((e, f) => {
        const animation = e.getAnimations()[0];
        animation.currentTime = animation.effect.getTiming().duration * f;
      }, fraction);
      return point(await ghost.boundingBox());
    };
    const mid = await sample(.4);
    assert.ok(Math.hypot(mid[0] - from[0], mid[1] - from[1]) > 5 && Math.hypot(mid[0] - to[0], mid[1] - to[1]) > 5);
    near(await sample(.999), to);
    await finish();
    update(result);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await ghost.count(), 0, "the next snapshot replayed a move");
  }
  function single(endpoint) {
    const game = empty();
    const zone = game.zones.find((z) => z.ownerSeat === endpoint.seat && z.zone === endpoint.zone);
    zone.count = 1;
    if (endpoint.objectId) zone.cards.push(card(endpoint.objectId, endpoint.seat));
    return game;
  }
  for (const [from, to] of [[at("library", 0), at("hand", 0, "card-4")],
    [at("hand", 0, "card-4"), at("battlefield", 0, "card-4")],
    [at("hand", 0, "card-4"), at("graveyard", 0, "card-4")],
    [at("battlefield", 0, "card-4"), at("hand", 0, "card-4")]]) {
    update(single(from));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const arrived = single(to);
    update(arrived, [from, to]);
    await ghost.waitFor();
    assert.equal(await ghost.locator("img").count(), from.objectId ? 1 : 0);
    if (to.zone === "battlefield") {
      arrived.zones.find((zone) => zone.zone === to.zone).cards[0].faceDown = true;
      update(arrived);
      await ghost.locator("img").waitFor({ state: "detached" });
      assert.equal(await ghost.textContent(), "");
    }
    await finish();
  }
  const anonymousHand = at("hand", 1), grave = at("graveyard", 1, "card-9"), board = at("battlefield", 1, "card-4");
  update(single(board));
  await page.locator('.away [data-card-id="card-4"]').waitFor();
  update(single(grave), [board, anonymousHand], [anonymousHand, grave]);
  await page.waitForFunction(() => document.querySelectorAll(".moving-card.card-back").length === 2);
  assert.equal(await ghost.locator("img").count(), 0, "an anonymous hand must not link two physical cards");
  await ghost.evaluateAll((cards) => cards.forEach((e) => e.getAnimations()[0].finish()));
  await ghost.first().waitFor({ state: "detached" });
  const hand = single(at("hand", 0, "card-4"));
  const held = at("hand", 0, "card-4"), onStack = at("stack", 0, spell.id), library = at("library", 0);
  update(hand);
  await page.locator('.own-hand [data-card-id="card-4"]').waitFor();
  update(stack(), [held, onStack]);
  await page.locator('.moving-card[data-to="stack"]').waitFor();
  await ghost.evaluate((e) => { e.getAnimations()[0].currentTime = 100; });
  const inFlight = point(await ghost.boundingBox());
  update(empty(), [onStack, library]);
  await page.locator('.moving-card[data-to="library"]').waitFor();
  near(point(await ghost.boundingBox()), inFlight);
  assert.equal(await ghost.evaluate((e) => e.getAnimations()[0].effect.getKeyframes().length), 3);
  await finish();
  update(hand);
  await page.locator('.own-hand [data-card-id="card-4"]').waitFor();
  update(empty(), [held, onStack], [onStack, library]);
  await ghost.waitFor();
  assert.equal(await ghost.evaluate((e) => e.getAnimations()[0].effect.getKeyframes().length), 3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await ghost.waitFor({ state: "detached" });
  update(stack(), [library, onStack]);
  await thumbnail.waitFor();
  assert.equal(await ghost.count(), 0);
  assert.equal(await page.locator("[data-arriving]").count(), 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  update(hand, [onStack, held]);
  await ghost.waitFor();
  await page.locator(".table").evaluate((el) => { el.style.minHeight = "1650px"; window.scrollTo(0, 300); });
  await ghost.waitFor({ state: "detached" });
  assert.equal(await page.locator("[data-arriving]").count(), 0, "scrolling releases the card at its new screen position");
  await page.locator(".table").evaluate((el) => { el.style.minHeight = ""; window.scrollTo(0, 0); });
  send("rules.prompt", { roomId, gameId: hand.gameId, promptId: 9011, pending: true, supported: true, kind: "chooseAction",
    options: [{ kind: "cast", cardId: held.objectId, responseId: "cast", label: "Cast" }], targets: [], choices: [], cards: [] });
  const inHand = page.locator('.own-hand [draggable="true"]');
  await inHand.dragTo(page.locator(".battlefield.away"));
  const returning = page.locator(".own-hand [data-returning]");
  await returning.waitFor();
  await returning.evaluate((card) => { card.getAnimations()[0].currentTime = 90; });
  update(single(at("hand", 0)));
  await returning.waitFor({ state: "detached" });
  assert.equal(await page.locator(".floating-hand-card, .own-hand img").count(), 0,
    "a cancelled drag must lose its face as soon as the viewer loses the hand card");
  await Promise.all([once(events, "resumed", { signal: AbortSignal.timeout(6000) }),
    socket.close({ code: 1001, reason: "exercise resumption" })]);
  await thumbnail.waitFor();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await ghost.count(), 0, "reconnecting should not replay the server's recent history");
  assert.deepEqual(errors, []);
  console.log("PASS overlapping stack order, exposed-edge preview and targeting, scrolling, centered thumbnails, zone moves, privacy, replay and reduced motion");
} finally {
  await browser.close();
}
