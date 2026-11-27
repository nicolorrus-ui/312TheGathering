// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// This function runs in Chromium, so CSS Color 4 values resolve through the same
// paint engine as the page. Text over artwork or gradients needs image inspection.
function measureScene() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgbaCache = new Map();
  function rgba(value) {
    if (!rgbaCache.has(value)) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      rgbaCache.set(value, [r, g, b, a / 255]);
    }
    return rgbaCache.get(value);
  }
  const rgb = ([r, g, b]) => [r, g, b].map(Math.round).join(",");
  const transparent = [0, 0, 0, 0];
  function over(front, back) {
    const a = front[3] + back[3] * (1 - front[3]);
    return a ? [...[0, 1, 2].map(i => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / a), a] : transparent;
  }
  function luminance(color) {
    const [r, g, b] = color.map(v => {
      const c = v / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    });
    return .2126 * r + .7152 * g + .0722 * b;
  }
  const styles = new Map();
  function style(el) {
    if (!styles.has(el)) styles.set(el, getComputedStyle(el));
    return styles.get(el);
  }
  function paint(el, layer) {
    const imageLayers = [];
    for (let node = el; node; node = node.parentElement) {
      const css = style(node);
      if (layer[3] < 1) {
        if (css.backgroundImage !== "none") imageLayers.push(node.className || node.localName);
        layer = over(layer, rgba(css.backgroundColor));
      }
      // Group opacity composites the foreground with the layers outside the
      // element, even when a glyph or an inner background is fully opaque.
      layer = [...layer.slice(0, 3), layer[3] * Number(css.opacity)];
    }
    return { color: over(layer, [255, 255, 255, 1]), imageLayers };
  }
  function visible(el) {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length > 0;
  }
  function key(el) {
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : Array.from(el.classList, c => "." + c).join(""));
  }
  function label(el) {
    return (el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.textContent || el.title || el.name || "")
      .trim().replace(/\s+/g, " ").slice(0, 70);
  }
  const groups = new Map();
  function record(kind, identity, detail, sample) {
    const key = kind + "\n" + identity;
    if (!groups.has(key)) groups.set(key, { kind, ...detail, count: 0, examples: [] });
    const group = groups.get(key);
    group.count++;
    if (sample && group.examples.length < 3 && !group.examples.includes(sample)) group.examples.push(sample);
  }
  const modal = document.querySelector("dialog:modal");
  const scope = modal || document.body;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
  const layout = [], controls = [], tabStops = [];
  const focusable = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,[contenteditable="true"],[tabindex]';
  let inspectedText = 0, inspectedControls = 0;
  function measureText(el, text, css, pseudo = "") {
    if (!text.trim()) return;
    const target = key(el) + pseudo;
    const sample = text.trim().replace(/\s+/g, " ").slice(0, 70);
    const size = parseFloat(css.fontSize);
    const disabled = !!el.closest(":disabled,[aria-disabled=true]");
    if (size < 12 && !(el.closest('[aria-hidden="true"]') || /mana/i.test(css.fontFamily))) {
      record("small-text", target + size, { element: target, fontSize: size }, sample);
    }
    inspectedText++;
    const bg = paint(el, transparent);
    const ink = rgba(css.color);
    const inkOpacity = pseudo ? Number(css.opacity) : 1;
    const fg = paint(el, [...ink.slice(0, 3), ink[3] * inkOpacity]);
    if (bg.imageLayers.length) {
      const image = bg.imageLayers.join("/");
      record("image-background", target + image, { element: target, image }, sample);
      return;
    }
    const [lo, hi] = [luminance(fg.color), luminance(bg.color)].sort((a, b) => a - b);
    const ratio = (hi + .05) / (lo + .05);
    const detail = { foreground: rgb(fg.color), background: rgb(bg.color), ratio: Number(ratio.toFixed(2)), disabled };
    record(ratio < 4.5 ? (disabled ? "disabled-contrast" : "low-contrast") : "contrast",
      [detail.foreground, detail.background, disabled].join(";"), detail, target + " " + sample);
  }
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!(el instanceof HTMLElement) || !visible(el)) continue;
    const css = style(el);
    if (el.matches("option,script,style,noscript")) continue;
    const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ");
    measureText(el, text, css);
    if (el.matches("select")) measureText(el, el.selectedOptions[0]?.textContent || "", css);
    if (el.matches('textarea,input:not([type="checkbox"],[type="radio"],[type="file"])')) {
      if (el.value) measureText(el, el.value, css);
      else if (el.placeholder) measureText(el, el.placeholder, getComputedStyle(el, "::placeholder"), "::placeholder");
    }
    for (const pseudo of ["::before", "::after"]) {
      const generated = getComputedStyle(el, pseudo);
      // Include generated copy such as the fan-content notice. Icon fonts and
      // decorative boxes with empty content do not contain legible text.
      if (generated.content.startsWith('"') && generated.content.length > 2 && generated.display !== "none" &&
          !el.closest('[aria-hidden="true"]') && !/mana/i.test(generated.fontFamily)) {
        measureText(el, generated.content.slice(1, -1), generated, pseudo);
      }
    }
    if (el.matches('button,input:not([type="hidden"]),select,textarea')) {
      inspectedControls++;
      const rect = el.getBoundingClientRect();
      const associated = el.matches('[type="checkbox"],[type="radio"]') ? [...el.labels] : [];
      const height = Math.max(rect.height, ...associated.map(l => l.getBoundingClientRect().height));
      if (height < 43.99) record("short-control", key(el) + Math.round(height),
        { element: key(el), height: Number(height.toFixed(1)), disabled: el.matches(":disabled") }, label(el));
    }
    if (el.matches(focusable) && !el.matches(":disabled") && !el.closest("[inert]")) {
      if (el.tabIndex >= 0) tabStops.push(el);
      else if (el.matches("a[href],button,input,select,textarea") &&
          !el.closest('[role="tablist"],[role="grid"],[role="listbox"],[data-choice-index]')) {
        const kind = el.matches('.table-card[aria-disabled="true"]') ? "hover-only-card" : "negative-tabindex";
        record(kind, key(el), { element: key(el) }, label(el));
      }
    }
  }
  // Native radio groups have a single stop, usually the checked radio.
  const stops = tabStops.filter(el => !el.matches('input[type="radio"][name]') ||
    el === (tabStops.find(other => other.type === "radio" && other.form === el.form && other.name === el.name && other.checked)
      || tabStops.find(other => other.type === "radio" && other.form === el.form && other.name === el.name)));
  for (const el of stops) {
    controls.push({ element: key(el), label: label(el) });
    layout.push({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y });
  }
  // Compare sibling groups in a shared layout, never infer row-major reading
  // order between independent columns such as a form rail and a deck list.
  const stopSet = new Set(stops);
  for (const parent of scope.querySelectorAll("*")) {
    const css = style(parent);
    if (!css.display.includes("flex") && !css.display.includes("grid")) continue;
    const groups = [...parent.children].filter(child => visible(child) &&
      (stopSet.has(child) || [...child.querySelectorAll(focusable)].some(el => stopSet.has(el))));
    for (let i = 1; i < groups.length; i++) {
      const before = groups[i - 1], after = groups[i];
      const left = before.getBoundingClientRect(), next = after.getBoundingClientRect();
      const sameRow = Math.min(left.bottom, next.bottom) - Math.max(left.top, next.top) > 4;
      const nextOnLeft = next.right <= left.left + 2;
      const nextAbove = next.bottom <= left.top + 2;
      const reversedInline = css.direction === "rtl" ? next.left >= left.right - 2 : nextOnLeft;
      if (sameRow && reversedInline || !sameRow && nextAbove) {
        const desc = key(parent);
        record("visual-order-review", desc + key(before) + key(after), { element: desc },
          (label(before) || key(before)) + " → " + (label(after) || key(after)));
      }
    }
  }
  const originalFocus = document.activeElement;
  const scroll = [document.scrollingElement, ...document.querySelectorAll("body *")].filter(el =>
    el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)).map(el => [el, el.scrollLeft, el.scrollTop]);
  const seen = new Set();
  const outlineIssues = new Set();
  const sequentialOrder = [];
  function readFocus() {
    const el = document.activeElement;
    if (!el || el === document.body) return;
    const index = stops.indexOf(el);
    if (index < 0) return; // Chromium also makes some scroll regions implicit tab stops.
    seen.add(index);
    if (sequentialOrder.at(-1) !== index) sequentialOrder.push(index);
    const css = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    let clipper;
    for (let parent = el.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const parentCSS = style(parent);
      if (parentCSS.overflowX === "visible" && parentCSS.overflowY === "visible") continue;
      const bounds = parent.getBoundingClientRect();
      if (parentCSS.overflowX !== "visible") {
        left = Math.max(left, bounds.left + parent.clientLeft);
        right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (parentCSS.overflowY !== "visible") {
        top = Math.max(top, bounds.top + parent.clientTop);
        bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
      clipper = parent;
    }
    if (rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) {
      record("hidden-focused-control", key(el), { element: key(el) }, label(el));
    } else if (rect.left <= left + 2 && rect.right >= right - 2 && rect.top <= top + 2 && rect.bottom >= bottom - 2) {
      record("clipped-focus-ring", key(el) + (clipper ? key(clipper) : ""),
        { element: key(el), boundary: clipper ? key(clipper) : "viewport" }, label(el));
    }
    if (!outlineIssues.has(index) && (!el.matches(":focus-visible") || css.outlineStyle === "none" ||
      parseFloat(css.outlineWidth) < 2 || parseFloat(css.outlineOffset) < 2 || rgb(rgba(css.outlineColor)) !== "242,184,75")) {
      outlineIssues.add(index);
      record("focus-ring", key(el), { element: key(el), outline: css.outline, offset: css.outlineOffset }, label(el));
    }
  }
  return {
    count: stops.length,
    begin() { if (stops.length) stops[0].focus({ preventScroll: true }); },
    readFocus,
    get ended() { return seen.size === stops.length; },
    finish(keyboard) {
      if (keyboard) {
        stops.forEach((el, i) => {
          if (!seen.has(i)) record("unreached-tab-stop", key(el), { element: key(el) }, label(el));
        });
      }
      return { inspectedText, inspectedControls, checkedKeyboard: keyboard, tabStops: stops.length, reached: seen.size,
        sequentialOrder, controls, layout, groups: [...groups.values()] };
    },
    restore() {
      if (originalFocus?.isConnected && originalFocus !== document.body) originalFocus.focus({ preventScroll: true });
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      for (const [el, x, y] of scroll) el.scrollTo(x, y);
    },
  };
}

export async function auditScene(page, scene, width, outDir) {
  const handle = await page.evaluateHandle(measureScene);
  try {
    const count = await handle.evaluate(a => a.count);
    // Run the complete keyboard route at desktop width. The compact layouts
    // can reveal their own controls, so repeat their routes as well.
    await handle.evaluate(a => a.begin());
    if (count) {
      await page.keyboard.press("Shift+Tab");
      for (let i = 0; i < count + 12; i++) {
        await page.keyboard.press("Tab");
        const done = await handle.evaluate(a => { a.readFocus(); return a.ended; });
        if (done) break;
      }
    }
    const report = await handle.evaluate(a => a.finish(true));
    report.composites = [];
    for (const group of await page.locator('[role="tablist"]:visible,.choice-grid:has([data-choice-index]):visible').all()) {
      const tabs = await group.getAttribute("role") === "tablist";
      const cells = group.locator(tabs ? '[role="tab"]' : ':scope > [data-choice-index]');
      const total = await cells.count();
      const position = () => cells.evaluateAll(items => items.findIndex(el => el.contains(document.activeElement)));
      const entry = group.locator('[tabindex="0"]').first();
      if (!total || !await entry.count()) continue;
      await entry.focus();
      const restoreIndex = await position();
      await page.keyboard.press("Home");
      const visited = new Set([await position()]);
      for (let i = 1; i < total; i++) {
        await page.keyboard.press("ArrowRight");
        visited.add(await position());
      }
      await page.keyboard.press("Home");
      for (let i = 0; i < restoreIndex; i++) await page.keyboard.press("ArrowRight");
      const name = await group.getAttribute("aria-label");
      report.composites.push({ name, total, reached: [...visited].filter(i => i >= 0).length });
      if (visited.has(-1) || visited.size !== total) report.groups.push({ kind: "unreached-arrow-stop",
        element: name, count: 1, examples: [Array.from(visited).join(", ")] });
    }
    const path = join(outDir, String(width));
    await mkdir(path, { recursive: true });
    await writeFile(join(path, scene + ".json"), JSON.stringify({ scene, width, ...report }) + "\n");
  } finally {
    await handle.evaluate(a => a.restore());
    await handle.dispose();
  }
}

// Summarize the per-scene evidence without discarding the full tab sequences.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) throw new Error("Usage: node apps/web/tests/design-accessibility.mjs audit-directory");
  const all = [];
  for (const width of await readdir(dir, { withFileTypes: true })) {
    if (!width.isDirectory() || !/^\d+$/.test(width.name)) continue;
    for (const file of await readdir(join(dir, width.name))) {
      if (file.endsWith(".json")) all.push(JSON.parse(await readFile(join(dir, width.name, file), "utf8")));
    }
  }
  if (!all.length) throw new Error("No audit scenes found");
  const issues = new Map();
  let passRatio = Infinity, reached = 0, stops = 0, texts = 0, controls = 0, arrowStops = 0, arrowReached = 0;
  const pairings = new Set();
  for (const scene of all) {
    reached += scene.reached;
    for (const composite of scene.composites || []) {
      arrowStops += composite.total;
      arrowReached += composite.reached;
    }
    stops += scene.tabStops;
    texts += scene.inspectedText;
    controls += scene.inspectedControls;
    for (const item of scene.groups) {
      if (item.ratio) {
        pairings.add([item.foreground, item.background].join("/"));
        if (!item.disabled) passRatio = Math.min(passRatio, item.ratio);
      }
      if (item.kind === "contrast") continue;
      // Keep class, state and color together so CSS fixes can be traced to a selector.
      const { count, examples, ...detail } = item;
      const key = JSON.stringify(detail);
      if (!issues.has(key)) issues.set(key, { ...detail, count: 0, examples: new Set(), scenes: new Set() });
      const issue = issues.get(key);
      issue.count += count;
      issue.scenes.add(scene.width + "/" + scene.scene);
      examples.forEach(example => { if (issue.examples.size < 3) issue.examples.add(example); });
    }
  }
  const items = [...issues.values()].map(i => ({ ...i, scenes: [...i.scenes].sort(), examples: [...i.examples] }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count);
  console.log(JSON.stringify({ scenes: all.length, textSamples: texts, controls, focusStops: stops, reached, arrowStops, arrowReached,
    distinctColorPairs: pairings.size, minimumActiveContrast: Number.isFinite(passRatio) ? passRatio : null, issues: items }, null, 2));
}
