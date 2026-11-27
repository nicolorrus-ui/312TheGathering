// SPDX-License-Identifier: GPL-3.0-or-later

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const base = process.env.CLUB_TEST_URL ?? "http://127.0.0.1:57320";
const data = (slug) => readFile(new URL(`../../server/cmd/hexproof-server/cube-presets/${slug}.json`, import.meta.url), "utf8").then(JSON.parse);
const vintage = await data("modovintage"), thopters = await data("100-ornithopters");
const ornithopter = thopters.cards.find((card) => card.name === "Ornithopter");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const sent = [], imports = [];
  let success = false, badImport = false;
  await page.routeWebSocket("**/ws", (ws) => {
    ws.onMessage((raw) => {
      const { type, payload } = JSON.parse(raw);
      sent.push({ type, payload });
      if (type === "session.hello") ws.send(JSON.stringify({ type: "session.welcome",
        payload: { displayName: "Drafter", resumeToken: "cube-user", forgeRulesAvailable: true } }));
    });
  });
  await page.route("**/club-cubes/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/resolve")) {
      const { cards } = route.request().postDataJSON();
      imports.push(cards);
      if (badImport) return route.fulfill({ status: 422, body: "Unknown card: No such card." });
      return route.fulfill({ json: { cards: cards.map((entry) => ({ ...ornithopter, ...entry,
        setCode: entry.setCode || ornithopter.setCode, collectorNumber: entry.collectorNumber || ornithopter.collectorNumber })) } });
    }
    const chosen = url.pathname.includes("modovintage") ? vintage : thopters;
    if (url.pathname.endsWith("/refresh")) {
      assert.equal(route.request().method(), "POST");
      if (!success) return route.fulfill({ status: 502, body: "Cube Cobra unavailable." });
      return route.fulfill({ json: { ...chosen, name: "Updated cube" } });
    }
    assert.equal(route.request().method(), "GET");
    return route.fulfill({ json: chosen });
  });
  await page.goto(base);
  await page.getByLabel("Player name").fill("Drafter");
  await button("Enter club").click();
  await button("Cube").click();
  await page.getByRole("heading", { name: vintage.name, exact: true }).waitFor();
  const list = page.getByRole("region", { name: "Cube card list" });
  async function checkColumnBounds() {
    const escaped = await list.evaluate((root) => [...root.querySelectorAll(".cube-list-column")].flatMap((column) => {
      const bounds = column.getBoundingClientRect();
      return [...column.querySelectorAll("li, .deck-pip")].filter((item) => {
        const rect = item.getBoundingClientRect();
        return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
      }).map((item) => [column.dataset.category, item.textContent]);
    }));
    assert.deepEqual(escaped, []);
  }
  assert.equal(await list.locator(".cube-list-column").count(), 9);
  await checkColumnBounds();
  await button("100 Ornithopters").click();
  await list.getByText("×100").waitFor();
  assert.ok(await list.locator('.cube-list-cost .deck-pip[data-color="W"]').count());
  await button("Update list").click();
  await page.getByRole("alert").getByText("Cube Cobra unavailable.").waitFor();
  await list.getByText("×100").waitFor();
  success = true;
  await button("Update list").click();
  await page.getByRole("heading", { name: "Updated cube" }).waitFor();
  await page.getByLabel("Players", { exact: true }).selectOption("5");
  await page.getByLabel("Draft format").selectOption("rochester");
  await button("Start cube").click();
  await page.waitForFunction(() => document.activeElement?.textContent === "Start cube");
  const request = sent.findLast((message) => message.type === "tournament.create")?.payload;
  assert.deepEqual([request.maxPlayers, request.draftSettings.mode, request.product.name], [5, "rochester", "Updated cube"]);
  assert.equal(request.product.sheets[0].cards.reduce((total, card) => total + card.weight, 0), 360);
  await button("Customed").click();
  assert.equal(await button("Update list").count(), 0);
  assert.equal(await button("Start cube").isDisabled(), true);
  await page.getByLabel("Cube name").fill("My draft night");
  const input = page.getByLabel("Import cube list");
  async function upload(name, text) {
    await input.setInputFiles({ name, mimeType: name.endsWith(".csv") ? "text/csv" : "text/plain", buffer: Buffer.from(text) });
    await page.getByText(`Imported ${name}.`, { exact: true }).waitFor();
  }
  await upload("sample.txt", "179 Ornithopter (MRD) 225\nOrnithopter\nSideboard\n4 Forest");
  assert.deepEqual(imports.at(-1).map((entry) => [entry.name, entry.count]), [["Ornithopter", 179], ["Ornithopter", 1]]);
  assert.equal(await button("Start cube").isDisabled(), true);
  await page.getByLabel("Players", { exact: true }).selectOption("4");
  assert.equal(await button("Start cube").isEnabled(), true);
  await upload("export.csv", 'Name,Set,Collector Number,Quantity,Notes,Maybeboard\r\n"Karn, Scion of Urza",DOM,1,360,"note, with comma",false\r\nSwamp,M11,238,1,,true\r\n');
  assert.deepEqual(imports.at(-1), [{ name: "Karn, Scion of Urza", setCode: "DOM", collectorNumber: "1", count: 360 }]);
  badImport = true;
  await input.setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("No such card") });
  await page.getByRole("alert").getByText("Unknown card: No such card.").waitFor();
  await list.getByText("Karn, Scion of Urza", { exact: true }).waitFor();
  await button("100 Ornithopters").click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await list.evaluate((element) => element.scrollWidth > element.clientWidth));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await checkColumnBounds();
  await page.getByLabel("Draft format").selectOption("rochester");
  assert.ok(await page.getByLabel("Draft format").evaluate((select) => {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    context.font = getComputedStyle(select).font;
    return context.measureText(select.selectedOptions[0].text).width + 38 <= select.clientWidth;
  }));
  await button("Customed").click();
  assert.equal(await page.getByLabel("Cube name").inputValue(), "My draft night");
  await list.getByText("Karn, Scion of Urza", { exact: true }).waitFor();
  await button("Join cube").click();
  await page.getByLabel("Cube code").fill("abcdef");
  await button("Join room").click();
  assert.equal(sent.findLast((message) => message.type === "tournament.enter").payload.tournamentId, "ABCDEF");
  console.log("Verified both Cube Cobra lists, refresh and failure, custom TXT/CSV import, seat and draft settings, persistence, join and mobile overflow.");
} finally { await browser.close(); }
