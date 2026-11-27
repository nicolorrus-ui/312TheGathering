// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { readFile } from "node:fs/promises";
import { enterGame, game, metadata } from "./design-cases.mjs";

export async function captureCore({page,capture,send,goto,click,login}) {
  await goto();
  await capture("sign-in", "main.intro");
  await login();
  await capture("duels", ".lobby-content form");
  await click("Join room");
  await capture("join-duel", page.getByLabel("Room code"));
  await click("Create room");
  await click("Deck builder");
  await capture("deck-empty", ".builder-workspace");
  await click("Import decklist");
  await page.getByLabel("Deck name").fill("River's Izzet");
  await page.getByLabel("MTGA or MTGO decklist").fill("4 Lightning Bolt (M11) 146\n4 Counterspell\n4 Brainstorm\n10 Island\n10 Mountain\n\nSideboard\n2 Abrade");
  await capture("deck-import", page.getByRole("button",{name:/4 × Lightning Bolt/}));
  await click("Save deck");
  await click("Card search");
  await page.getByLabel("Search cards").fill("lightning");
  await capture("deck-builder", ".catalog-results button");
  await page.getByRole("button",{name:/4 × Lightning Bolt/}).click();
  await page.getByRole("dialog").locator("select option").nth(1).waitFor({state:"attached"});
  await capture("deck-printing-dialog", ".deck-card-dialog");
  await click("Close");
  await click("Duels");
  await send("error",{code:"invalid_request",message:"That room is no longer available."});
  await capture("error-notice", ".app-error");
  await click("Dismiss");
  await send("error",{code:"forge_failed",message:"Forge stopped",rulesCrashReport:{schemaVersion:1,reportId:"mock-1",revision:1,
    failure:{code:"worker_exit",stage:"match"},collectionState:"complete"}});
  await page.getByText("View crash report",{exact:true}).click();
  await capture("forge-report", ".crash-notice pre");
  await click("Dismiss");
  const room={roomId:"WIND42",name:"Friday draft table",deckFormat:"modern",matchMode:"bo3",phase:"waiting",allowSpectators:true,spectatorsSeeHands:true,
    seats:[{occupied:true,displayName:"River",deckSelected:true,ready:false},{occupied:true,displayName:"Ember",deckSelected:true,ready:true}],ownDeckName:"River's Izzet"};
  await send("room.joined",{roomId:room.roomId,seat:0});
  await send("room.snapshot",room);
  await capture("duel-room", page.getByText("Friday draft table"));
  await send("game.snapshot",{gameNumber:1,result:{matchFinished:false},score:[1,0],sideboard:{canChooseStartingPlayer:true,
    seats:[{seat:0,ready:false},{seat:1,ready:false}],mainboard:[{name:"Lightning Bolt",count:4,setCode:"M11",collectorNumber:"146"},
    {name:"Island",count:10,setCode:"M11",collectorNumber:"235"}],sideboard:[{name:"Abrade",count:2}]}});
  await capture("sideboarding", ".sideboard");
  await send("room.left",{});
  await enterGame({page,send});
  const template = JSON.parse(await readFile(new URL("../../../testdata/protocol/v3/rules-prompt-auto-pass.json", import.meta.url), "utf8")).payload;
  await send("rules.prompt", {...template,autoPassEligible:false});
  await capture("duel-board", ".table");
  await page.locator(".auto-pass summary").click();
  await capture("duel-auto-pass", ".auto-pass[open]");
  await page.locator(".auto-pass summary").click();
  await send("rules.prompt",{...template,kind:"chooseNumber",title:"Choose a number",minNumber:0,maxNumber:10,promptId:12});
  await capture("duel-choose-number", ".decision input[type=number]");
  await send("rules.prompt",{...template,kind:"mulligan",title:"Opening hand",options:[{kind:"keep",responseId:"keep",label:"Keep this hand"},{kind:"mulligan",responseId:"mulligan",label:"Mulligan"}],promptId:13});
  await capture("duel-opening-hand",page.getByRole("heading",{name:"Opening hand"}));
  await send("rules.snapshot",{...game,gameOver:true,winnerSeat:0});
  await send("game.snapshot",{...metadata,result:{matchFinished:true},score:[2,0]});
  await capture("duel-complete",page.getByText("You won",{exact:true}));

}
