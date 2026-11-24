// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"testing"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/room"
	"hexproof/server/internal/rulesengine/forge"
)

func TestShouldDelegatePriorityPass(t *testing.T) {
	pass := forge.PromptView{Kind: "chooseAction", Supported: true, AutoPassEligible: true,
		Options: []forge.PromptOption{{ResponseID: "$pass"}}}
	prefs := priorityPreference{}
	if !shouldDelegatePriorityPass(prefs, true, pass, "main1", true) {
		t.Fatal("smart priority did not pass an eligible prompt")
	}
	prefs.fullControl = true
	if shouldDelegatePriorityPass(prefs, true, pass, "main1", true) {
		t.Fatal("full control was passed by the hub")
	}
	prefs = priorityPreference{stops: map[string]bool{"own:main1": true}}
	if shouldDelegatePriorityPass(prefs, true, pass, "main1", true) {
		t.Fatal("an owned phase stop was passed")
	}
	if !shouldDelegatePriorityPass(prefs, true, pass, "main1", false) {
		t.Fatal("another player's main phase was held by an owned stop")
	}
	prefs.hold = true
	if shouldDelegatePriorityPass(prefs, true, pass, "draw", false) {
		t.Fatal("a held prompt was passed")
	}
	if shouldDelegatePriorityPass(priorityPreference{}, false, pass, "draw", false) {
		t.Fatal("a seat without published preferences was passed")
	}
}

func TestAdvanceRulesPrioritySkipsEngineWithoutDelegatedSeats(t *testing.T) {
	h := &Handler{}
	r := &room.Room{ID: "ROOM01"}
	h.setPriorityPreference(r.ID, 0, priorityPreference{fullControl: true})
	h.setPriorityPreference(r.ID, 1, priorityPreference{hold: true})
	// With no runtime attached, any attempt at an engine RPC fails.
	if err := h.advanceRulesPriority(r, forgeRoomGame{}); err != nil {
		t.Fatal(err)
	}
	h.setPriorityPreference(r.ID, 1, priorityPreference{})
	if !h.hasDelegatedPriority(r.ID) {
		t.Fatal("a seat that enables smart passing must still be delegated")
	}
}

func TestPairRulesPrompts(t *testing.T) {
	snapshot, err := protocol.NewEnvelope(protocol.TypeRulesSnapshot, protocol.RulesGameSnapshot{
		RoomID: "ROOM01", GameID: "game", Step: "main1", Players: []protocol.RulesPlayerState{},
		Zones: []protocol.RulesZoneState{}, Stack: []protocol.RulesStackObject{},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot = snapshot.WithSeq(4)
	prompt, err := protocol.NewEnvelope(protocol.TypeRulesPrompt, protocol.RulesPrompt{
		RoomID: "ROOM01", GameID: "game", Pending: true, PromptID: 3, Kind: "chooseAction", Supported: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	projections := map[string]protocol.Envelope{"c1": snapshot}
	prompts := map[string]protocol.Envelope{"c1": prompt}
	pairRulesPrompts(projections, prompts)
	assertRulesSnapshotPromptPair(t, projections["c1"], prompts["c1"])
	var decoded protocol.RulesGameSnapshot
	if err := projections["c1"].DecodePayload(&decoded); err != nil || !decoded.PromptFollows || projections["c1"].SeqValue() != 4 {
		t.Fatalf("snapshot = %+v seq %d err %v", decoded, projections["c1"].SeqValue(), err)
	}
}
