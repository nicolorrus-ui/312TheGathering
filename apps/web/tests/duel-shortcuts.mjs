// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { game, room } from "./design-cases.mjs";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const fixture = async (name) => JSON.parse(await readFile(new URL(
  "../../../testdata/protocol/v3/rules-prompt-" + name + ".json", import.meta.url), "utf8")).payload;

async function duel(spectator = false) {
  const page = await browser.newPage();
  const responses = [], preferences = [], errors = [];
  const events = new EventEmitter();
  let socket, promptId = 0;
  const send = (type, payload) => socket.send(JSON.stringify({ type, payload }));
  const snapshot = (overrides = {}) => send("rules.snapshot", { ...game, promptFollows: true, ...overrides });
  const prompt = async (name, overrides = {}) => send("rules.prompt", { ...await fixture(name),
    autoPassEligible: false, ...overrides, promptId: ++promptId });
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/card-art?**", (route) => route.abort());
  await page.routeWebSocket("**/ws", (route) => {
    socket = route;
    route.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw);
      if (type === "rules.respond") { responses.push(payload); events.emit("response"); }
      if (type === "rules.priority") preferences.push(payload);
      if (type === "session.hello") {
        send("session.welcome", { roomId: room.roomId, seat: spectator ? null : 0, role: spectator ? "spectator" : "player",
          resumeToken: "shortcut-seat", forgeRulesAvailable: true });
      }
      if (type === (spectator ? "room.join" : "session.hello")) {
        if (spectator) send("room.joined", { roomId: room.roomId, role: "spectator" });
        send("room.snapshot", room);
        snapshot();
      }
    });
  });
  await page.goto(spectator ? url + "?watch=" + room.roomId : url);
  if (!spectator) {
    await page.getByLabel("Player name").fill(game.players[0].name);
    await page.getByRole("button", { name: "Enter club" }).click();
  }
  await page.getByRole("region", { name: "Duel table" }).waitFor();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const press = (key) => page.keyboard.press(key);
  const answer = async (action, expected) => {
    const start = responses.length;
    try {
      await Promise.all([once(events, "response", { signal: AbortSignal.timeout(5000) }), action()]);
    } catch (error) {
      throw new Error("No reply for " + JSON.stringify({ promptId, ...expected }), { cause: error });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(responses.slice(start), [{ promptId, ...expected }]);
  };
  const silent = async (action) => {
    const start = responses.length;
    await action();
    // Wait past the auto-pass timer so an unwanted delayed reply also fails the test.
    await delay(500);
    assert.deepEqual(responses.slice(start), []);
  };
  const close = async () => { assert.deepEqual(errors, []); await page.close(); };
  return { page, prompt, snapshot, button, press, answer, silent, close, preferences };
}

async function confirmShortcuts() {
  const { page, prompt, button, press, answer, silent, close } = await duel();
  await prompt("auto-pass");
  await button("Pass priority").waitFor();
  await silent(() => press("Alt+e"));
  await answer(() => page.keyboard.down("Space"), { responseId: "$pass" });
  await prompt("acknowledge");
  await button("Continue").waitFor();
  await silent(() => page.keyboard.down("Space")); // OS autorepeat across prompts
  await page.keyboard.up("Space");
  await answer(() => press("Space"), { responseId: "$ack" });

  await prompt("card-name");
  const confirm = button("Confirm");
  await confirm.waitFor();
  assert.ok(await confirm.isDisabled());
  await silent(() => press("Space"));
  const input = page.getByRole("searchbox", { name: "Card name" });
  await input.fill("Black Lotus");
  await silent(async () => { await press("Space"); await press("e"); });
  assert.equal(await input.inputValue(), "Black Lotus e");
  await input.fill("");
  await page.getByRole("group", { name: "Matching legal card names" }).getByRole("button", { name: "Lightning Bolt" }).click();
  await answer(() => press("Space"), { responseId: "$submit", name: "Lightning Bolt" });

  await prompt("attack-defenders");
  await button("All Strike").click();
  await answer(() => press("Space"), { responseId: "$submit",
    assignments: [{ sourceId: "combat-source:0", targetId: "combat-target:0" }] });
  await prompt("payment", { options: [{ responseId: "$auto-pay", kind: "autoPay", label: "Auto Pay" }] });
  await button("Auto Pay").waitFor();
  await answer(() => press("Space"), { responseId: "$auto-pay" });
  await prompt("replacement");
  await button("Pay").waitFor();
  await answer(() => press("Space"), { responseId: "$submit", choiceIds: ["choice:1"] });

  await prompt("replacement");
  await button("Pay").and(page.locator(":enabled")).waitFor();
  await button("Pay").focus();
  await press("Shift+Tab");
  assert.ok(await button("Decline").evaluate((element) => element === document.activeElement));
  await answer(() => press("Space"), { responseId: "$submit", choiceIds: ["choice:0"] });
  await close();
}

async function endStepShortcut() {
  const { page, prompt, snapshot, button, press, answer, silent, close, preferences } = await duel();
  const pass = { responseId: "$pass" };
  await prompt("auto-pass");
  await button("Pass priority").waitFor();
  const hold = page.getByRole("switch", { name: "Hold priority" });
  await hold.click();
  await silent(() => press("e"));
  await hold.click();
  const endStop = button("My turn · End step stop");
  await endStop.click();
  assert.equal(await endStop.getAttribute("aria-pressed"), "false");
  await answer(() => press("e"), pass);
  assert.ok(preferences.at(-1).stops.includes("own:end"), "E requests a temporary end stop when the saved one is off");
  await answer(async () => {
    snapshot({ step: "combatBegin", stack: [{ id: "on-stack", controllerSeat: 1, text: "Lightning Bolt", identity: { name: "Lightning Bolt" } }] });
    await prompt("auto-pass");
  }, pass);
  await silent(async () => { await prompt("replacement"); await button("Pay").waitFor(); });
  await answer(() => press("Space"), { responseId: "$submit", choiceIds: ["choice:1"] });
  await answer(async () => { snapshot({ step: "main2" }); await prompt("auto-pass"); }, pass);
  for (const step of ["end", "endOfTurn"]) {
    if (step === "endOfTurn") {
      snapshot({ step: "main2" });
      await prompt("auto-pass");
      await button("Pass priority").and(page.locator(":enabled")).waitFor();
      await answer(() => press("e"), pass);
    }
    if (step === "end") {
      // Forge may publish the opponent's end-step snapshot while our answered main-phase prompt is still visible.
      await silent(() => snapshot({ step, prioritySeat: 1, promptFollows: false }));
      assert.ok(preferences.at(-1).stops.includes("own:end"), "the opponent receiving end-step priority keeps our stop");
      await silent(async () => { snapshot({ step }); await prompt("replacement"); });
      assert.ok(preferences.at(-1).stops.includes("own:end"), "the first mandatory end-step choice must preserve the stop");
      await answer(() => press("Space"), { responseId: "$submit", choiceIds: ["choice:1"] });
    }
    await silent(async () => { snapshot({ step }); await prompt("auto-pass"); });
    assert.ok(!preferences.at(-1).stops.includes("own:end"), "reaching end-step priority restores the saved stops");
    await silent(() => press("e"));
    await answer(() => press("Space"), pass);
  }
  snapshot({ step: "main2" });
  await prompt("auto-pass");
  await button("Pass priority").and(page.locator(":enabled")).waitFor();
  await answer(() => press("e"), pass);
  await silent(async () => { snapshot({ turn: game.turn + 1, step: "upkeep", activeSeat: 1 }); await prompt("auto-pass"); });

  const waitForOpponent = async () => {
    snapshot({ turn: game.turn + 1, activeSeat: 0, prioritySeat: 1 });
    await page.locator(".priority-actions button.primary:disabled").waitFor();
    await silent(() => press("e"));
    await button("Cancel auto-pass").waitFor();
    assert.ok(preferences.at(-1).stops.includes("own:end"));
    assert.equal(await endStop.getAttribute("aria-pressed"), "false");
  };
  const myPriority = async () => {
    snapshot({ turn: game.turn + 1, activeSeat: 0, prioritySeat: 0 });
    await prompt("auto-pass");
  };
  await waitForOpponent();
  await button("Cancel auto-pass").click();
  await silent(myPriority);
  assert.ok(!preferences.at(-1).stops.includes("own:end"));
  await waitForOpponent();
  await answer(myPriority, pass);
  await close();
}

try {
  await confirmShortcuts();
  await endStepShortcut();
  const viewer = await duel(true);
  await viewer.silent(async () => { await viewer.prompt("auto-pass"); await viewer.press("Space"); await viewer.press("e"); });
  await viewer.close();
  console.log("PASS duel keyboard confirmation, end-step passing, input and spectator guards.");
} finally { await browser.close(); }
