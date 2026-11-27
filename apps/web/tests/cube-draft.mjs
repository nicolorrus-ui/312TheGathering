// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chromium } from "playwright-core";

const base = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const code = "CUBE42";
const people = ["Alice", "Bob", "Cara", "Dan"].map((displayName, index) =>
  ({ participantId: "p" + index, displayName, online: true, checkedIn: true }));
const seats = people.map((player) => ({ ...player, picked: 0, packCards: 3, queuedPacks: 1, deckSubmitted: false }));
const card = (instanceId, name) => ({ instanceId, name, setCode: "M11", collectorNumber: "149" });
const bolt = card("i-1", "Lightning Bolt"), opt = card("i-2", "Opt"), island = card("i-3", "Island");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });

async function check(width, mode) {
  const page = await browser.newPage({ viewport: { width, height: 880 }, reducedMotion: "reduce" });
  const errors = [], records = [], received = new EventEmitter();
  let socket, initialBinding = true;
  const send = (type, payload, id) => socket.send(JSON.stringify({ type, payload, id }));
  const room = { tournamentId: code, name: "Test cube", format: "limited", clubStyle: "cube", eventType: "cube_draft",
    stage: "draft", status: "running", currentRound: 0, plannedRounds: 3, role: "participant", participantId: "p0",
    maxPlayers: 4, registered: 4, checkedIn: 4, participants: people, pairings: [], standings: [],
    draftSettings: { mode, packsPerPlayer: 3, packsPerBatch: 1, cardsPerPack: 15 } };
  const isOpen = mode === "rochester";
  let limited = { tournamentId: code, stage: "draft", packRound: 1, direction: 1, currentPack: [bolt, opt, island],
    pool: [card("old1", "Ornithopter"), card("old2", "Ornithopter")], mainboardInstanceIds: [], basicLands: [], participants: seats,
    pickDeadline: new Date(Date.now() + 60000).toISOString(),
    ...(isOpen ? { rochester: { activeParticipantId: "p0", openerId: "p0", packNumber: 1, cards: [bolt, opt, island], picks: [] } } : {}) };

  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/card-art?**", (route) => route.fulfill({ contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"/>' }));
  await page.routeWebSocket("**/ws", (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(raw.toString()); records.push(msg); received.emit(msg.type, msg);
      if (msg.type === "session.hello") {
        send("session.welcome", { resumeToken: "resume-token", forgeRulesAvailable: true });
        if (initialBinding) {
          // Initial server attachment is furnished by the fixture. A reload must enter using the saved credential.
          initialBinding = false;
          send("tournament.registered", { tournamentId: code, participantToken: "owner-token" });
          send("tournament.snapshot", room); send("limited.snapshot", limited);
        }
      }
      if (msg.type === "tournament.enter") {
        assert.equal(msg.payload.credential, "owner-token");
        send("tournament.entered", { tournamentId: code, participantId: "p0" });
        send("tournament.snapshot", room); send("limited.snapshot", limited);
      }
    });
  });
  await page.goto(base);
  await page.getByLabel("Player name").fill("Alice");
  await page.getByRole("button", { name: "Enter club" }).click();
  const pack = page.getByRole("group", { name: "Draft pack" });
  const pool = page.getByRole("region", { name: "Your picks" });
  await pool.getByText("×2").waitFor();
  assert.equal(await pool.locator(".cube-image-choice").count(), 1);
  await pack.getByRole("button", { name: "Pick Lightning Bolt" }).hover();
  await page.locator(".card-hover-preview").waitFor();
  const pick = pack.getByRole("button", { name: "Pick Lightning Bolt" });
  const [stale] = await Promise.all([once(received, "limited.pick"), pick.click()]);
  send("error", { code: "limited_pick_unavailable", message: "Pick has expired" }, stale[0].id);
  await page.getByText("Pick has expired", { exact: false }).waitFor();
  const [answer] = await Promise.all([once(received, "limited.pick"), pick.click()]);
  assert.deepEqual(answer[0].payload, { instanceId: bolt.instanceId, pickDeadline: limited.pickDeadline });
  await page.waitForFunction(() => [...document.querySelectorAll(".cube-pack button")].every((button) => button.disabled));
  // Public progress and the acknowledgement alone leave the previous pack locked.
  send("limited.progress", { tournamentId: code, participants: seats });
  send("limited.picked", { tournamentId: code, remaining: 0 }, answer[0].id);
  assert.equal(await pick.isDisabled(), true);

  limited = { ...limited, currentPack: [], pickDeadline: undefined, pool: [...limited.pool, bolt],
    ...(isOpen ? { rochester: { ...limited.rochester, cards: [opt, island], activeParticipantId: "p1",
      picks: [{ participantId: "p0", card: bolt }] } } : {}) };
  send("limited.snapshot", limited);
  await pool.getByLabel("Lightning Bolt", { exact: true }).waitFor();
  if (isOpen) {
    await page.getByRole("status").filter({ hasText: "Bob is picking" }).waitFor();
    assert.equal(await pack.getByRole("button").count(), 0);
    assert.equal(await pack.locator(".decision-art").count(), 2);
    await page.getByRole("heading", { name: "Picks from this pack" }).waitFor();
  } else {
    await page.getByRole("status").filter({ hasText: "Waiting for your next pack" }).waitFor();
    assert.equal(await pack.count(), 0);
  }
  await page.reload();
  await pool.getByText("×2").waitFor();
  await pool.getByLabel("Lightning Bolt", { exact: true }).waitFor();
  assert.equal(records.filter((m) => m.type === "tournament.enter").length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // A new role in the same event loses its former private pool even before the companion limited snapshot.
  send("tournament.snapshot", { ...room, participantId: undefined, role: "viewer" });
  await pool.waitFor({ state: "detached" });
  send("limited.snapshot", { ...limited, currentPack: [], pool: [] });
  await page.getByRole("region", { name: "Cube draft" }).waitFor();
  assert.equal(await pool.count(), 0);
  send("tournament.snapshot", { ...room, stage: "competition", currentRound: 1,
    pairings: [{ pairingId: "r1t1", playerAId: "p0", playerBId: "p1", playerAName: "Alice", playerBName: "Bob", status: "open" }],
    standings: [{ ...people[0], rank: 1, wins: 0, losses: 0, draws: 0, matchPoints: 0, oppMatchWin: 0, gameWin: 0, oppGameWin: 0 }] });
  await page.getByRole("heading", { name: "Round-robin standings" }).waitFor();
  const [opened] = await Promise.all([once(received, "tournament.open_match"), page.getByRole("button", { name: "Open match" }).click()]);
  assert.deepEqual(opened[0].payload, { pairingId: "r1t1" });
  assert.deepEqual(errors, []);
  await page.close();
}

async function checkSeatRecovery() {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => {
    sessionStorage.setItem("hexproof-club.identity.v1", JSON.stringify({ name: "Alice" }));
    localStorage.setItem("hexproof-club.active-event:Alice", "OLD111");
    localStorage.setItem("hexproof-club.event-token:Alice:CUBE42", "released-token");
  });
  const attempts = [];
  let registrations = 0;
  await page.routeWebSocket("**/ws", (ws) => {
    const send = (type, payload, id) => ws.send(JSON.stringify({ type, payload, id }));
    const snapshot = (seated) => send("tournament.snapshot", { tournamentId: code, clubStyle: "cube", name: "Current cube",
      status: "registration", stage: "registration", role: seated ? "participant" : "viewer", canRegister: !seated,
      participantId: seated ? "p0" : undefined, maxPlayers: 4, participants: seated ? [people[0]] : [], checkedIn: seated ? 1 : 0,
      pairings: [], standings: [], currentRound: 0 });
    ws.onMessage((raw) => {
      const { type, payload, id } = JSON.parse(raw);
      if (type === "session.hello") send("session.welcome", { resumeToken: "welcome", forgeRulesAvailable: true });
      if (type === "tournament.enter") {
        attempts.push(payload);
        if (payload.credential) send("error", { code: "tournament_forbidden", message: "invalid tournament credential" }, id);
        else { send("tournament.entered", { tournamentId: code, role: "viewer" }, id); snapshot(false); }
      }
      if (type === "tournament.register") {
        send("tournament.registered", { tournamentId: code, participantId: "p0", participantToken: "token-" + (++registrations) }, id);
        snapshot(true);
      }
      if (type === "tournament.unregister") { send("tournament.unregistered", { tournamentId: code }, id); snapshot(false); }
    });
  });
  await page.goto(new URL("?cube=" + code, base).href);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await page.getByRole("button", { name: "Join seat" }).click();
  await page.getByRole("button", { name: "Leave seat" }).click();
  await page.getByRole("button", { name: "Join seat" }).click();
  await page.getByRole("button", { name: "Leave seat" }).waitFor();
  assert.deepEqual(attempts, [{ tournamentId: code, credential: "released-token" }, { tournamentId: code }]);
  assert.equal(await page.evaluate(() => localStorage.getItem("hexproof-club.event-token:Alice:CUBE42")), "token-2");
  await page.close();
}

try {
  await check(1440, "booster"); await check(390, "rochester"); await checkSeatRecovery();
  console.log("Desktop booster and mobile Rochester passed private progress, pick submission, visibility, invite recovery, seat release and pairing checks.");
} finally { await browser.close(); }
