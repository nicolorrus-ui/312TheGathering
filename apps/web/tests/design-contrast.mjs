// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { auditScene } from "./design-accessibility.mjs";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const dir = await mkdtemp(join(tmpdir(), "contrast-fixture-"));
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<style>
    body { background: white; color: black; }
    .faded { opacity: .5; }
    .dark { background: black; }
    .light, input { background: white; }
    input::placeholder { color: black; opacity: .5; }
  </style>
  <span class="faded">Single opacity</span>
  <div class="dark faded"><span class="light faded">Nested opacity</span></div>
  <input class="faded" placeholder="Placeholder opacity">`);
  await auditScene(page, "contrast-fixture", 390, dir);
  const { groups } = JSON.parse(await readFile(join(dir, "390", "contrast-fixture.json"), "utf8"));
  // Black at 50% over white is 127.5 gray. In the nested case the white local
  // background first blends over black, then the parent blends over white.
  // Placeholder ink passes through both its own opacity and the input opacity.
  for (const [label, foreground, background, expected] of [
    ["Single opacity", "128,128,128", "255,255,255", 3.98],
    ["Nested opacity", "128,128,128", "191,191,191", 2.17],
    ["Placeholder opacity", "191,191,191", "255,255,255", 1.83],
  ]) {
    const sample = groups.find(g => g.kind === "low-contrast" && g.examples.some(e => e.endsWith(label)));
    assert.ok(sample, label + " must be reported below 4.5:1");
    assert.equal(sample.foreground, foreground);
    assert.equal(sample.background, background);
    assert.ok(Math.abs(sample.ratio - expected) <= .02, label + " ratio: " + sample.ratio);
  }
  console.log("Passed single and nested foreground/background opacity, including placeholder text.");
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
