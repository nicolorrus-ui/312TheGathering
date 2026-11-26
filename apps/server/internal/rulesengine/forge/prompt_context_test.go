// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forge

import (
	"encoding/json"
	"testing"
)

func TestNormalizePromptContext(t *testing.T) {
	raw := json.RawMessage(`{"promptId":91,"decidingPlayerId":"player-0",
      "sourceCard":{"id":"secret-source","identity":{"name":"Circle of Protection: Red","setCode":"4ED","cardNumber":"17"}},
      "input":{"type":"chooseBoolean","presentation":{
        "title":"Pay {1} to prevent damage?","description":"Choose whether to pay.",
        "text":"otherwise: \"3 damage is dealt.\"","targets":[
          {"kind":"card","id":"secret-target"},{"kind":"player","id":"player-0"}]},
        "confirmLabel":"Pay","denyLabel":"Decline"}}`)
	view, err := NormalizePrompt(raw)
	if err != nil || len(view.ContextCards) != 1 ||
		view.ContextCards[0].ID != "context-card:0" ||
		view.ContextCards[0].Name != "Circle of Protection: Red" ||
		len(view.ContextTargets) != 2 ||
		view.ContextTargets[1].ResponseID != "context-target:1" ||
		view.ContextText != `otherwise: "3 damage is dealt."` {
		t.Fatalf("prompt context = %+v, %v", view, err)
	}
	response, err := BuildPromptResponse(raw, 0, 91, PromptResponse{
		ResponseID: "$submit", ChoiceIDs: []string{"choice:1"},
	})
	if err != nil || string(response) !=
		`{"output":{"type":"decision","value":true},"type":"chooseBoolean"}` {
		t.Fatalf("contextual boolean response = %s, %v", response, err)
	}
}

func TestNormalizePromptContextRejectsMalformedDisplayState(t *testing.T) {
	for _, fragment := range []string{
		`"sourceCard":{"id":"","identity":{"name":"Source"}},`,
		`"sourceCard":{"id":"source","identity":{"name":""}},`,
		``,
	} {
		targets := `[{"kind":"card","id":"target"}]`
		if fragment == "" {
			targets = `[{"kind":"card","id":"same"},{"kind":"card","id":"same"}]`
		}
		raw := json.RawMessage(`{"promptId":92,"decidingPlayerId":"player-0",` + fragment +
			`"input":{"type":"chooseBoolean","presentation":{"targets":` + targets +
			`},"confirmLabel":"Yes","denyLabel":"No"}}`)
		if _, err := NormalizePrompt(raw); err == nil {
			t.Fatalf("invalid prompt context unexpectedly normalized: %s", raw)
		}
	}
}

func TestRevealedHandBesideFiniteNames(t *testing.T) {
	raw := json.RawMessage(`{"promptId":2,"decidingPlayerId":"player-0","input":{"type":"chooseFromSelection","searchKind":"name","minTotal":1,"maxTotal":1,"options":[{"label":"Ponder","weight":1}],"presentation":{"title":"Choose a card name","shownCards":[{"id":"card-4","identity":{"name":"Forest"}},{"id":"card-5","identity":{"name":"Ponder","setCode":"LRW","cardNumber":"79"}}]}}}`)
	view, err := NormalizePrompt(raw)
	if err != nil || len(view.ContextCards) != 2 || len(view.Choices) != 1 || view.SearchKind != "name" {
		t.Fatalf("name choice/hand = %+v, %v", view, err)
	}
	for i, name := range []string{"Forest", "Ponder"} {
		card := view.ContextCards[i]
		if card.Name != name || !card.ReadOnly || card.ID == "card-4" || card.ID == "card-5" {
			t.Fatalf("revealed card %d = %+v", i, card)
		}
	}
	if view.ContextCards[1].SetCode != "LRW" || view.ContextCards[1].CollectorNumber != "79" {
		t.Fatalf("revealed printing = %+v", view.ContextCards[1])
	}
	if _, err = BuildPromptResponse(raw, 0, 2, PromptResponse{ResponseID: "$submit", ChoiceIDs: []string{view.ContextCards[0].ID}}); err == nil {
		t.Fatal("display-only land was accepted as a legal name")
	}
}
