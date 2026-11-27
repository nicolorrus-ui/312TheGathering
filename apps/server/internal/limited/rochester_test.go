// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package limited

import (
	"fmt"
	"reflect"
	"testing"

	"hexproof/server/internal/protocol"
)

func cubeModeEvent(t *testing.T, seats int, mode string) *Event {
	t.Helper()
	event, err := New(Config{TournamentID: "cube", EventType: protocol.LimitedEventCubeDraft,
		Product: commanderCubeProduct(CubeDraftCardsRequired(seats)), Participants: testParticipants(seats),
		DraftSettings: &protocol.LimitedDraftSettings{Mode: mode},
	}, 42)
	if err != nil {
		t.Fatal(err)
	}
	return event
}

func TestRochesterRotationAndPublicPack(t *testing.T) {
	for seats := 4; seats <= 8; seats++ {
		t.Run(fmt.Sprint(seats), func(t *testing.T) {
			event := cubeModeEvent(t, seats, protocol.LimitedDraftModeRochester)
			for round := 1; round <= 3; round++ {
				step := 1
				if round == 2 {
					step = -1
				}
				for pack := 0; pack < seats; pack++ {
					opener := pack
					if step == -1 {
						opener = seats - 1 - pack
					}
					// Write the seating order as full passes in each direction.
					pickers := make([]int, 0, 4*seats)
					for len(pickers) < 15 {
						for i := 0; i < seats; i++ {
							pickers = append(pickers, (opener+i*step+seats)%seats)
						}
						for i := seats - 1; i >= 0; i-- {
							pickers = append(pickers, (opener+i*step+seats)%seats)
						}
					}
					history := []protocol.LimitedRochesterPick{}
					for pick, seat := range pickers[:15] {
						id := event.Players[seat].ID
						public := event.Snapshot("")
						table := public.Rochester
						if public.PackRound != round || table == nil || table.PackNumber != (round-1)*seats+pack+1 ||
							table.OpenerID != event.Players[opener].ID || table.ActiveParticipantID != id ||
							len(table.Cards) != 15-pick || !reflect.DeepEqual(table.Picks, history) {
							t.Fatalf("wrong public table at round %d, pack %d, pick %d: %+v", round, pack, pick, table)
						}
						if len(public.Pool) != 0 || len(public.CurrentPack) != 0 {
							t.Fatal("observer received a private pool or actionable pack")
						}
						owner := event.Snapshot(id)
						otherID := event.Players[(seat+1)%seats].ID
						if !reflect.DeepEqual(owner.CurrentPack, table.Cards) || len(event.Snapshot(otherID).CurrentPack) != 0 {
							t.Fatal("only the current seat should have the actionable pack")
						}
						card := table.Cards[0]
						if _, err := event.Pick(otherID, card.InstanceID); ErrorCode(err) != ErrPickUnavailable {
							t.Fatal("public card could be taken out of turn")
						}
						if _, err := event.Pick(id, card.InstanceID); err != nil {
							t.Fatal(err)
						}
						history = append(history, protocol.LimitedRochesterPick{ParticipantID: id, Card: card})
					}
				}
			}
			if event.Stage != protocol.LimitedStageDeckBuilding || event.Snapshot("").Rochester != nil {
				t.Fatal("last Rochester pack did not end the draft")
			}
			assertAutoDraftPoolConservation(t, event)
		})
	}
}

func TestExpiredClubCubePickKeepsManualControl(t *testing.T) {
	for _, mode := range []string{protocol.LimitedDraftModeBooster, protocol.LimitedDraftModeRochester} {
		t.Run(mode, func(t *testing.T) {
			event := cubeModeEvent(t, 4, mode)
			seat := event.Players[0]
			if _, err := event.AutoPick(seat.ID); err != nil {
				t.Fatal(err)
			}
			if seat.AutoDraft || len(seat.Pool) != 1 {
				t.Fatal("expiry handed the entire seat to automatic control")
			}
			if mode == protocol.LimitedDraftModeBooster && len(event.Snapshot("").CurrentPack) != 0 {
				t.Fatal("private booster visible to observers")
			}
			for _, p := range event.Players {
				if err := event.SetAutoDraft(p.ID, true); err != nil {
					t.Fatal(err)
				}
			}
			assertAutoDraftPoolConservation(t, event)
		})
	}
}
