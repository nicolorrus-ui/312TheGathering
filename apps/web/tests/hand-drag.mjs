// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const roomId = "CARDQA", gameId = "hand-drag";
const players = ["Alice", "Bob"].map((name, seat) => ({ name, seat, life: 20, status: "playing", manaPool: [] }));
const card = (id, name, ownerSeat = 0) => ({ id, ownerSeat, controllerSeat: ownerSeat, visible: true, identity: { name } });
const spell = card("bolt", "Lightning Bolt"), creature = card("bear", "Grizzly Bears", 1);
const hand = [card("forest", "Forest"), card("island", "Island"), card("mountain", "Mountain"), spell];
const zone = (name, ownerSeat, cards) => ({ zone: name, ownerSeat, count: cards.length, cards });
const game = { roomId, gameId, players, turn: 1, step: "main1", activeSeat: 0, prioritySeat: 0, gameOver: false,
  stack: [], zones: [zone("hand", 0, hand), zone("battlefield", 0, []), zone("battlefield", 1, [creature])] };
const cast = { responseId: "cast-bolt", cardId: spell.id, kind: "cast", label: "Cast Lightning Bolt" };

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], responses = [], events = new EventEmitter();
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  const prompt = (kind, fields) => send("rules.prompt", { roomId, gameId, promptId: ++promptId, kind, title: kind,
    pending: true, supported: true, cards: [], options: [], targets: [], choices: [], contextCards: [],
    orderItems: [], combatSources: [], combatTargets: [], damageTargets: [], scryDestinations: [], ...fields });
  const play = () => prompt("chooseAction", { options: [cast] });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("**/assets/cards/index.json", (route) => route.fulfill({ json: { version: 1, names: {}, printings: {} } }));
  await page.route("**/card-art?**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw.toString());
      if (type === "rules.respond") { responses.push(payload); events.emit("answer", payload); }
      if (type !== "session.hello") return;
      send("session.welcome", { roomId, seat: 0, resumeToken: "hand-seat", forgeRulesAvailable: true });
      send("room.snapshot", { roomId, phase: "started", seats: players.map((p) => ({ occupied: true, displayName: p.name })) });
      send("rules.snapshot", game);
      play();
    });
  });
  await page.goto(process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320");
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  const source = page.locator('.own-hand [data-card-id="bolt"]'), floating = page.locator(".floating-hand-card");
  const home = page.getByRole("region", { name: "Your battlefield" });
  await source.waitFor();

  async function frame() { await page.evaluate(() => new Promise(requestAnimationFrame)); }
  // A zero-size, non-interactive marker measures the *projected* point on the
  // painted face, including its fan rotation, scale, perspective and tilt.
  const anchor = (element) => element.evaluate((face) => {
    let mark = face.querySelector("[data-measure-grip]");
    if (!mark) {
      mark = document.createElement("span");
      mark.setAttribute("data-measure-grip", "");
      mark.style.cssText = "position:absolute;left:78%;top:74%;width:0;height:0;pointer-events:none";
      face.append(mark);
    }
    const { x, y } = mark.getBoundingClientRect();
    return { x, y };
  });
  const tilt = () => floating.evaluate((face) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(face).transform);
    return { x: Math.atan2(matrix.m23, matrix.m33) * 180 / Math.PI, y: Math.atan2(matrix.m13, matrix.m33) * 180 / Math.PI };
  });
  const point = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
  const move = ({ x, y }) => page.mouse.move(x, y);
  let maxGripError = 0;
  async function checkGrip(pointer) {
    const projected = await anchor(floating);
    const error = Math.hypot(projected.x - pointer.x, projected.y - pointer.y);
    maxGripError = Math.max(error, maxGripError);
    assert.ok(error <= 2.5, `grip drifted ${error.toFixed(2)}px at ${JSON.stringify(pointer)}`);
  }
  async function grab() {
    await source.hover();
    await source.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))));
    const at = await anchor(source);
    await move(at);
    await page.mouse.down();
    await move(point(at.x + 2, at.y));
    assert.equal(await floating.count(), 0, "a short movement must remain a click");
    const raised = point(at.x + 15, at.y - 1);
    await move(raised);
    await floating.waitFor();
    await frame();
    await checkGrip(raised);
  }
  const field = await home.boundingBox();
  const center = point(field.x + field.width / 2, field.y + field.height / 2);
  async function stroke(start, dx, dy, steps) {
    let p = start;
    const angles = [];
    for (let i = 0; i < steps; i++) {
      p = point(p.x + dx, p.y + dy);
      await move(p);
      await frame();
      await checkGrip(p);
      angles.push(await tilt());
    }
    return { point: p, angle: angles.at(-1).y, pitch: angles.at(-1).x, firstAngle: angles[0].y };
  }
  async function settleTilt() {
    await page.waitForFunction(() => {
      const el = document.querySelector(".floating-hand-card");
      if (!el) return false;
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return Math.hypot(m.m13, m.m23) < .004;
    }, undefined, { timeout: 2000 });
  }
  async function answer(action, expected) {
    const count = responses.length;
    const [[reply]] = await Promise.all([once(events, "answer", { signal: AbortSignal.timeout(5000) }), action()]);
    assert.deepEqual(reply, { promptId, ...expected });
    await frame(); await frame();
    assert.equal(responses.length, count + 1, "a gesture sent a second decision");
  }

  const fanTransform = () => source.evaluate((el) => getComputedStyle(el).transform);
  const restingFan = await fanTransform();
  await grab();
  await move(center);
  await settleTilt();
  const slow = await stroke(center, 2, 0, 9);
  const fast = await stroke(slow.point, 36, -5, 7);
  const reversed = await stroke(fast.point, -36, 5, 10);
  assert.ok(Math.abs(fast.angle) > Math.abs(slow.angle) + .5, `slow ${slow.angle}, fast ${fast.angle}`);
  assert.ok(fast.angle * reversed.angle < 0, "fast reversal must change the tilt direction");
  assert.ok(fast.pitch * reversed.pitch < 0, "vertical motion must tilt about the other axis");
  assert.ok(Math.abs(reversed.firstAngle - reversed.angle) > .4, "orientation must ease through a reversal");
  assert.ok(Math.max(Math.abs(fast.angle), Math.abs(reversed.angle)) <= 12, "the face must remain readable");
  await settleTilt();
  await checkGrip(reversed.point);
  // Both releases are close enough to the boundary for the floating card to
  // straddle it. Only the real pointer location should decide legality.
  const edge = point(center.x, field.y);
  const above = { x: edge.x, y: edge.y - 2 };
  await move(above);
  await frame();
  const inside = (p) => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".battlefield.home"), p);
  assert.equal(await inside(above), false);
  const over = await floating.boundingBox();
  assert.ok(over.y + over.height > field.y);
  await page.mouse.up();
  await source.locator("..").locator("[data-returning]").waitFor();
  await floating.waitFor({ state: "detached" });
  await page.waitForFunction(() => !document.querySelector(".own-hand [data-returning]"));
  assert.equal(await fanTransform(), restingFan, "an invalid drop must restore the original fan angle");
  assert.equal(responses.length, 0);

  await grab();
  const below = { x: edge.x, y: edge.y + 2 };
  await move(below);
  await frame();
  assert.equal(await inside(below), true);
  assert.ok((await floating.boundingBox()).y < field.y);
  await Promise.all([source.locator("..").locator("[data-landing]").waitFor({ state: "attached" }),
    answer(() => page.mouse.up(), { responseId: cast.responseId })]);
  await floating.waitFor({ state: "detached" });
  prompt("chooseBoardTargets", { minSelections: 1, maxSelections: 1,
    targets: [{ kind: "card", objectId: creature.id, responseId: "target-bear", label: creature.identity.name }] });
  const bear = page.locator('.away [data-card-id="bear"][data-actionable="true"]');
  await bear.waitFor();
  await answer(() => bear.click(), { responseId: "$submit", targetIds: ["target-bear"] });

  play();
  await page.locator('.own-hand [data-card-id="bolt"][data-actionable="true"]').waitFor();
  await answer(() => source.click(), { responseId: cast.responseId });
  prompt("payManaCost", { options: [{ responseId: "$auto-pay", label: "Auto Pay" }] });
  const autoPay = page.getByRole("button", { name: "Auto Pay" });
  await autoPay.waitFor();
  await answer(() => autoPay.click(), { responseId: "$auto-pay" });
  play();
  await page.locator('.own-hand [data-card-id="bolt"][data-actionable="true"]').waitFor();
  await page.locator('.own-hand [data-card-id="mountain"]').click();
  await frame();
  assert.equal(responses.length, 4, "a card without a play option must not cast");
  assert.deepEqual(errors, []);
  console.log(`PASS actual pointer input, maximum grip error ${maxGripError.toFixed(2)}px; ` +
    `tilt slow ${slow.angle.toFixed(2)}°, fast ${fast.angle.toFixed(2)}°, reversal ${reversed.angle.toFixed(2)}°; ` +
    "rest, return, edge hit tests, click, Forge target and payment decisions");
} finally { await browser.close(); }
