// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { captureCore } from "./design-core.mjs";

const mode = process.argv[2];
if (!["baseline", "verify", "after"].includes(mode)) throw new Error("Usage: node apps/web/tests/design-audit.mjs baseline|verify|after");
const web = fileURLToPath(new URL("../", import.meta.url));
const project = resolve(web, "../..");
const dist = resolve(process.env.DESIGN_DIST || join(web, "dist"));
const widthHeights = {390: 844, 768: 1024, 1440: 900, 1920: 1080};
const widths = (process.env.DESIGN_WIDTHS || "390,768,1440").split(",").map(Number);
const groups = (process.env.DESIGN_GROUPS || "core,events,extra").split(",");
const baseline = join(project, "design-baseline");
const output = mode === "after" ? join(project, "design-after") : baseline;
if (!process.env.DESIGN_DIST) {
  const build = spawnSync("npm", ["run", "build"], { cwd: web, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status || 1);
}

const mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".ttf": "font/ttf", ".jpg": "image/jpeg"};
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = resolve(dist, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(dist + sep)) { res.writeHead(404).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, {"Content-Type": mime[extname(file)] || "application/octet-stream"}).end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]});
const catalog = [
  {name: "Lightning Bolt", setCode: "M11", collectorNumber: "146", setName: "Magic 2011"},
  {name: "Lightning Bolt", setCode: "LEA", collectorNumber: "161", setName: "Limited Edition Alpha"},
  {name: "Island", setCode: "M11", collectorNumber: "235", setName: "Magic 2011"},
  {name: "Forest", setCode: "M11", collectorNumber: "246", setName: "Magic 2011"},
];
const catalogIndex = {"lightning bolt": ["R","red"], counterspell: ["U U","blue"], brainstorm: ["U","blue"],
  forest: ["","land"], island: ["","land"], plains: ["","land"], ornithopter: ["0","colorless"]};
const failures = [];
async function put(file, data) { await mkdir(dirname(file), {recursive:true}); await writeFile(file, data); }

// Synthetic art keeps screenshots repeatable without redistributing third-party card images.
function sampleCard(name) {
  const colors = [["slateblue","lavender"],["darkslategray","aquamarine"],["sienna","wheat"],["steelblue","lightblue"]];
  const [shadow, light] = colors[Buffer.from(name).reduce((a,b) => a+b,0) % colors.length];
  const label = name.replace(/[<>&"']/g,"").slice(0,34);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 252"><rect width="180" height="252" rx="10" fill="#202028"/><rect x="7" y="7" width="166" height="238" rx="6" fill="${shadow}"/><rect x="12" y="14" width="156" height="19" rx="5" fill="${light}"/><text x="17" y="27" font-size="9" font-family="sans-serif" fill="#222">${label}</text><svg x="12" y="35" width="156" height="117" viewBox="0 0 156 117"><rect width="156" height="117" fill="${light}"/><circle cx="108" cy="34" r="18" fill="white" opacity=".8"/><path d="M0 93L42 60 61 72 99 29 156 92V117H0Z" fill="${shadow}" opacity=".65"/><path d="M0 105L32 80 60 94 92 68 156 89V117H0Z" fill="${shadow}"/></svg><rect x="12" y="157" width="156" height="70" rx="3" fill="${light}"/><path d="M22 169h104m-104 8h124m-124 8h90" stroke="${shadow}" opacity=".4" stroke-width="2"/></svg>`;
}

async function suite(width, group) {
  const height = widthHeights[width];
  assert.ok(height, "Unsupported viewport width " + width);
  const context = await browser.newContext({viewport:{width,height}, reducedMotion:"reduce", locale:"en-US", timezoneId:"UTC", deviceScaleFactor:1});
  const page = await context.newPage();
  page.setDefaultTimeout(7500);
  const cdp = await context.newCDPSession(page);
  let socket;
  const renderErrors = [];
  page.on("pageerror", error => renderErrors.push(error.message));
  await page.routeWebSocket("**/ws", ws => {
    socket = ws;
    ws.onMessage(raw => {
      const {type,id} = JSON.parse(raw.toString());
      if (type === "session.hello") ws.send(JSON.stringify({type:"session.welcome", id,
        payload:{resumed:false, resumeToken:"review-session", forgeRulesAvailable:true}}));
      if (type === "room.join" && new URL(page.url()).searchParams.has("watch")) ws.send(JSON.stringify({type:"room.joined", payload:{}}));
    });
  });
  await page.route("**/assets/cards/index.json", route => route.fulfill({json: {version:1, printings:{}, names:{}}}));
  await page.route("**/assets/deck-cards.json", route => route.fulfill({json: catalogIndex}));
  await page.route("**/forge-ready", route => route.fulfill({json:{status:"ready"}}));
  await page.route("**/live-rooms", route => route.fulfill({json:[]}));
  await page.route("**/card-search?**", route => {
    const p = new URL(route.request().url()).searchParams;
    const name = (p.get("name") || p.get("q") || "").toLowerCase();
    return route.fulfill({json: {cards:catalog.filter(c => c.name.toLowerCase().includes(name)), hasMore:false}});
  });
  await page.route("**/card-art?**", route => route.fulfill({contentType:"image/svg+xml",
    body: sampleCard(new URL(route.request().url()).searchParams.get("name") || "Sample card")}));
  await page.route("**/club-cubes/*", async route => {
    const slug = new URL(route.request().url()).pathname.split("/").at(-1);
    if (!["modovintage","100-ornithopters"].includes(slug)) return route.fulfill({status:404,body:""});
    return route.fulfill({contentType:"application/json", body:await readFile(join(project,"apps/server/cmd/hexproof-server/cube-presets",slug+".json"))});
  });

  async function goto(path="/") { socket=undefined; await page.goto(new URL(path, origin).href); }
  async function send(type,payload,id) {
    for (let i=0; !socket && i<100; i++) await new Promise(r=>setTimeout(r,20));
    if (!socket) throw new Error("No connected fixture socket for " + type);
    socket.send(JSON.stringify({type,payload,id}));
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  }
  async function click(name) { await page.getByRole("button", {name,exact:true}).click(); }
  async function login() {
    const input = page.getByLabel("Player name");
    if (await input.isVisible()) { await input.fill("River"); await input.locator("xpath=ancestor::form").getByRole("button").click(); }
    await page.getByText("online", {exact:true}).first().waitFor();
  }
  const manifest = {};
  async function capture(name, selector) {
    assert.match(name,/^[a-z0-9-]+$/);
    if (selector) await (typeof selector === "string" ? page.locator(selector).first() : selector).waitFor();
    await page.mouse.move(0,0);
    await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0,0);
      await Promise.all(Array.from(document.images).filter(x=>x.loading!=="lazy" || x.getBoundingClientRect().top < innerHeight).map(i=>i.decode().catch(()=>{})));
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); });
    const {tree,scroll} = await page.evaluate(() => {
      const lines=[];
      function walk(el, depth, index) {
        const attributes = Array.from(el.attributes).filter(a=>a.name==="id" || a.name==="role" || a.name.startsWith("aria-") || a.name.startsWith("data-"))
          .map(a=>[a.name,a.value]).sort(([a],[b])=>a<b?-1:a>b?1:0);
        lines.push([depth,index,el.tagName.toLowerCase(),...attributes]);
        Array.from(el.children).forEach((child,i)=>walk(child,depth+1,i));
      }
      walk(document.documentElement,0,0);
      return {tree:lines.map(line=>JSON.stringify(line)).join("\n")+"\n",scroll:document.documentElement.scrollWidth-innerWidth};
    });
    if (mode !== "baseline" && process.env.DESIGN_BASELINE_REPLAY !== "1") {
      assert.equal(await page.title(), "312TheGathering", name + " page title");
      const brand = page.locator(".topbar .brand");
      assert.equal((await brand.textContent()).trim(), "312TheGathering", name + " wordmark");
    }
    const hash=createHash("sha256").update(tree).digest("hex");
    manifest[name]=hash;

    const structuralFile=join(baseline,"dom",hash+".jsonl");
    if (mode==="baseline") await put(structuralFile,tree);
    if (mode!=="verify") {
      const {data}=await cdp.send("Page.captureScreenshot",{format:"webp",quality:76,fromSurface:true,captureBeyondViewport:false});
      await put(join(output,String(width),name+".webp"),Buffer.from(data,"base64"));
    }
    if (process.env.DESIGN_ACCESSIBILITY_DIR) {
      const {auditScene} = await import("./design-accessibility.mjs");
      await auditScene(page, name, width, resolve(process.env.DESIGN_ACCESSIBILITY_DIR));
    }
    if (mode==="after" && scroll>1) failures.push(`Page overflows by ${scroll}px at ${width}: ${name}`);
  }
  const api={page,capture,send,goto,click,login};
  try {
    if(group==="core") await captureCore(api);
    else if(group==="events") await (await import("./design-events.mjs")).captureEvents(api);
    else if(group==="extra") await (await import("./design-cases.mjs")).captureExtra(api);
    else throw new Error("Unknown suite "+group);
    assert.deepEqual(renderErrors,[],"Uncaught page errors in "+group);
    const file=join(baseline,"dom",width+"-"+group+".json");
    if(mode==="baseline") await put(file,JSON.stringify(manifest,null,2)+"\n");
    else {
      const expected=JSON.parse(await readFile(file,"utf8"));
      for(const name of new Set([...Object.keys(expected),...Object.keys(manifest)])) if(expected[name]!==manifest[name])
        failures.push(`DOM mismatch ${width}/${name}: expected ${expected[name]}, saw ${manifest[name]}`);
    }
    console.log(mode, width, group, Object.keys(manifest).length+" states");
  } finally { await context.close(); }
}
try {
  for (const group of groups) await Promise.all(widths.map(width=>suite(width,group)));
  if (failures.length) throw new Error(failures.join("\n"));
} finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
