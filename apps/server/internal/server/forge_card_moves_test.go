// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package server

import (
	"hexproof/server/internal/rulesengine/forge"
	"testing"
)

func TestProjectedCardMovesPreserveStackInstancesAndRedactPrivateEndpoints(t *testing.T) {
	hand := forge.MoveEndView{Zone: "hand", PlayerID: "player-1", ObjectID: "card-4"}
	stack := forge.MoveEndView{Zone: "stack", PlayerID: "player-0", ObjectID: "stack-19"}
	library := forge.MoveEndView{Zone: "library", PlayerID: "player-1", ObjectID: "card-29"}
	public := forge.MoveEndView{Zone: "exile", PlayerID: "player-0", ObjectID: "card-30"}
	view := forge.GameView{GameID: "g", ActivePlayerID: "player-0", PriorityPlayerID: "player-1", CardMoves: []forge.CardMoveView{
		{ID: 1, From: hand, To: stack}, {ID: 2, From: stack, To: library}, {ID: 3, From: stack, To: public},
		{ID: 4, From: stack, To: forge.MoveEndView{Zone: "bogus", PlayerID: "player-0"}},
		{ID: 5, From: stack, To: forge.MoveEndView{Zone: "exile", PlayerID: "player-90"}},
		{ID: 6, From: forge.MoveEndView{Zone: "stack", PlayerID: "player-1", ObjectID: "secret"}, To: public},
		{ID: 7, From: hand, To: library}, {ID: 8, From: library, To: hand},
	}}
	game := forgeRoomGame{gameID: "g", playerToSeat: map[int]int{0: 2, 1: 0}}
	for _, viewer := range []int{-1, 0, 2} {
		snap, err := normalizeForgeSnapshotForSeat("ROOM", game, view, viewer)
		want := 4
		if viewer == 0 {
			want = 5
		}
		if err != nil || len(snap.CardMoves) != want {
			t.Fatalf("seat %d snapshot: %+v %v", viewer, snap.CardMoves, err)
		}
		m := snap.CardMoves
		draw := m[len(m)-1]
		if draw.ID != 8 || draw.From.ObjectID != "" || (draw.To.ObjectID != "") != (viewer == 0) {
			t.Fatalf("unsafe draw for seat %d: %+v", viewer, draw)
		}
		if (viewer == 0) != (m[0].From.ObjectID == "card-4") || m[0].From.Seat != 0 || m[0].To.ObjectID != "stack-19" || m[0].To.Seat != 2 || m[1].To.ObjectID != "" || m[2].To.ObjectID != "card-30" {
			t.Fatalf("seat %d movement: %+v", viewer, m)
		}
	}
}
