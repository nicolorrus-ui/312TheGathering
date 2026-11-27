// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const url = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const tournamentId = "CUBE04";
const seats = ["Sam", "Pat", "Jo", "Lee"].map((displayName, seat) => ({
  displayName, participantId: "p" + seat, checkedIn: true, picked: 45, deckSubmitted: false, packCards: 0, queuedPacks: 0,
}));
const card = (instanceId, name, collectorNumber) => ({ instanceId, name, collectorNumber, setCode: "M11" });
const pool = [card("o1", "Ornithopter", "212"), card("o2", "Ornithopter", "212"), card("o3", "Ornithopter", "211"),
  card("i1", "Island", "237"), ...Array.from({ length: 41 }, (_, i) => card("f" + i, "Pool card " + i, String(i + 1)))];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 120; i++) { if (await check()) return; await pause(30); }
  assert.fail("Timed out waiting for a Cube deck update");
}

async function checkBuild(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(6000);
  const issues = [];
  page.on("pageerror", (e) => issues.push(e.message));
  const event = { tournamentId, name: "Local Cube", format: "limited", clubStyle: "cube", status: "running",
    stage: "deck_building", matchMode: "bo3", role: "participant", participantId: "p0", maxPlayers: 4, registered: 4,
    currentRound: 0, plannedRounds: 3, participants: seats, pairings: [], standings: [] };
  const limited = { tournamentId, stage: "deck_building", packRound: 3, direction: 1, currentPack: [], pool,
    participants: seats.map((p) => ({ ...p })), minimumDeckCards: 40, deckSubmitted: false, allDecksSubmitted: false,
    mainboardInstanceIds: [], basicLands: [], buildDeadline: new Date(Date.now() + 1800000).toISOString() };
  const messages = [];
  let socket, hold = false, reject = false;
  const send = (type, payload, id) => socket.send(JSON.stringify({ type, payload, id }));
  function acknowledge(message) {
    if (reject) {
      reject = false;
      send("error", { code: "limited_deck_invalid", message: "Selection was rejected" }, message.id);
      return;
    }
    limited.mainboardInstanceIds = message.payload.mainboardInstanceIds;
    limited.basicLands = message.payload.basicLands;
    limited.deckSubmitted = !message.payload.draftOnly;
    send("limited.deck_submitted", { tournamentId }, message.id);
    if (limited.deckSubmitted) {
      limited.participants[0].deckSubmitted = true;
      send("limited.snapshot", limited);
    }
  }
  await page.route("**/assets/cards/index.json", (route) => route.fulfill({ json: { names: {}, printings: {}, version: 1 } }));
  await page.route("**/assets/deck-cards.json", (route) => route.fulfill({ json: { ornithopter: ["0", "neutral"], island: ["", "land"] } }));
  await page.route("**/card-art?**", (route) => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="teal"/></svg>' }));
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      const msg = JSON.parse(data);
      if (msg.type === "session.hello") {
        send("session.welcome", { resumeToken: "build-token", forgeRulesAvailable: true }, msg.id);
        send("tournament.snapshot", event);
        send("limited.snapshot", limited);
      }
      if (msg.type === "limited.submit_deck") {
        messages.push(msg);
        if (!hold) acknowledge(msg);
      }
    });
  });
  await page.goto(url);
  await page.getByLabel("Player name").fill("Sam");
  await page.getByRole("button", { name: "Enter club" }).click();
  const builder = page.locator(".cube-build");
  const clock = builder.getByRole("timer", { name: "Time remaining" });
  const drafted = builder.getByRole("region", { name: "Drafted cards" });
  const main = builder.getByRole("region", { name: "Main deck" });
  const ready = builder.getByRole("button", { name: "Ready", exact: true });
  const add = (name) => drafted.getByRole("button", { name, exact: true });
  const remove = (name) => main.getByRole("button", { name: "Remove " + name, exact: true });
  const openLands = builder.getByRole("button", { name: "Basic lands", exact: true });
  const modal = page.getByRole("dialog", { name: "Basic lands", exact: true });
  const lands = async (name, count, confirm = true) => {
    await openLands.click();
    assert.equal(await modal.getByRole("spinbutton").count(), 5);
    assert.equal(await modal.locator("img").count(), 5);
    await modal.getByRole("spinbutton", { name, exact: true }).fill(String(count));
    await modal.getByRole("button", { name: confirm ? "Confirm" : "Cancel", exact: true }).click();
    await modal.waitFor({ state: "detached" });
  };
  await clock.waitFor();
  assert.match(await clock.innerText(), /^(30:00|29:5\d)$/);
  assert.ok(await ready.isDisabled());
  assert.equal(await add("Ornithopter").getAttribute("aria-description"), "3 copies");
  assert.ok(await drafted.evaluate((node) => node.scrollHeight > node.clientHeight));
  assert.ok(await builder.evaluate((node) => node.getBoundingClientRect().right <= innerWidth + 1));
  hold = true;
  await add("Ornithopter").click();
  await until(() => messages.length === 1);
  await add("Ornithopter").click();
  assert.equal(await add("Ornithopter").locator(".cube-card-count").count(), 0);
  await add("Ornithopter").click();
  await add("Ornithopter").waitFor({ state: "detached" });
  assert.equal(await remove("Ornithopter").locator(".deck-quantity").innerText(), "3");
  assert.equal(await remove("Ornithopter").locator(".deck-pip").count(), 1);
  assert.equal(messages.length, 1);
  send("limited.progress", { tournamentId, participants: limited.participants });
  hold = false;
  acknowledge(messages[0]);
  await until(() => messages.length === 2);
  assert.deepEqual(messages[1].payload.mainboardInstanceIds, ["o1", "o2", "o3"]);
  await remove("Ornithopter").click();
  await add("Ornithopter").waitFor();
  assert.equal(await add("Ornithopter").locator(".cube-card-count").count(), 0);
  await remove("Ornithopter").click();
  await until(() => limited.mainboardInstanceIds.length === 1);
  assert.equal(await add("Ornithopter").getAttribute("aria-description"), "2 copies");

  await add("Island").click();
  await lands("Island", 2, false);
  assert.equal(await remove("Island").locator(".deck-quantity").innerText(), "1");
  await lands("Island", 2);
  await lands("Island", 1);
  await until(() => limited.basicLands[0]?.count === 3);
  assert.equal(await remove("Island").locator(".deck-quantity").innerText(), "4");
  for (let i = 0; i < 3; i++) await remove("Island").click();
  await until(() => !limited.basicLands.length);
  assert.equal(await add("Island").count(), 0);
  assert.equal(await remove("Island").locator(".deck-quantity").innerText(), "1");
  await remove("Island").click();
  await add("Island").waitFor();
  assert.equal(await remove("Island").count(), 0);

  await lands("Forest", 39);
  await until(() => limited.basicLands[0]?.count === 39);
  await page.reload();
  await ready.waitFor();
  assert.ok(await ready.isEnabled());
  assert.equal(await remove("Forest").locator(".deck-quantity").innerText(), "39");
  reject = true;
  await remove("Ornithopter").click();
  await page.getByRole("alert").waitFor();
  await remove("Ornithopter").waitFor();
  assert.equal(await remove("Ornithopter").locator(".deck-quantity").innerText(), "1");
  await page.getByRole("button", { name: "Dismiss" }).click();

  if (width > 650) {
    await ready.click();
    await until(() => limited.deckSubmitted);
    await builder.getByText("1/4 ready").waitFor();
    assert.ok(await openLands.isDisabled());
    assert.ok(await remove("Forest").isDisabled());
    assert.equal(Object.hasOwn(messages.at(-1).payload, "draftOnly"), false);
    assert.deepEqual(messages.at(-1).payload.mainboardInstanceIds, ["o3"]);
  } else {
    await openLands.click();
    limited.buildDeadline = new Date(Date.now() + 900).toISOString();
    send("limited.snapshot", limited);
    await modal.waitFor({ state: "detached" });
    assert.equal(await clock.innerText(), "0:00");
    assert.ok(await ready.isDisabled());
    assert.ok(await add("Island").isDisabled());
  }
  assert.deepEqual(issues, []);
  await page.close();
}
try {
  for (const width of [1440, 390]) await checkBuild(width);
  console.log("Verified Cube deck construction, grouped printings, incremental lands, draft recovery, readiness and expiry.");
} finally { await browser.close(); }
