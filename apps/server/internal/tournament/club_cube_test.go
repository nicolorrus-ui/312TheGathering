// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package tournament

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"hexproof/server/internal/protocol"
)

func newClubCubeDraft(t *testing.T, seats int, mode string) *Tournament {
	t.Helper()
	product := protocol.LimitedProductDefinition{ID: "club-cube", Name: "Club cube", ProductType: "cube", Sheets: []protocol.LimitedSheetDefinition{{Name: "cube", Cards: []protocol.LimitedCardDefinition{
		{Name: "Grizzly Bears", SetCode: "M10", CollectorNumber: "189", TypeLine: "Creature — Bear", Weight: 360},
	}}}}
	event, err := New("CUBETEST", Config{Name: "Club cube", Format: protocol.DeckFormatLimited, EventType: protocol.LimitedEventCubeDraft, ClubStyle: ClubCube, Coordinator: protocol.LimitedCoordinatorSwiss, RulesMode: protocol.RulesModeForge, MatchMode: protocol.MatchBO3, MaxPlayers: seats, Product: &product, DraftSettings: &protocol.LimitedDraftSettings{Mode: mode}}, "Host", "host", CredentialHash("host-token"), testNow)
	if err != nil {
		t.Fatal(err)
	}
	host := Actor{Role: RoleOrganizer, ConnectionID: "host"}
	for i := 0; i < seats; i++ {
		if i == seats-1 {
			if err := event.Start(host, 41, testNow); err == nil {
				t.Fatal("started without all seats")
			}
		}
		name := fmt.Sprintf("Player %d", i+1)
		p, err := event.Register(name, name, CredentialHash(name), testNow)
		if err != nil {
			t.Fatal(err)
		}
		p.CheckedIn = true
	}
	if err = event.Start(host, 41, testNow); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestClubCubeTimeoutAndPrivateDrafts(t *testing.T) {
	event := newClubCubeDraft(t, 4, protocol.LimitedDraftModeBooster)
	if event.LimitedSnapshot("").PickDeadline != "" {
		t.Fatal("private booster deadline disclosed")
	}
	now := testNow
	for i := 0; event.Stage == protocol.LimitedStageDraft && i < 200; i++ {
		now = event.ClubCubeDeadline()
		changed, err := event.ExpireClubCube(now.Add(-time.Nanosecond))
		if err != nil || changed {
			t.Fatal("early expiration", err)
		}
		changed, err = event.ExpireClubCube(now)
		if err != nil || !changed {
			t.Fatal("timeout did not auto pick", err)
		}
	}
	if event.Stage != protocol.LimitedStageDeckBuilding || event.ClubCubeDeadline() != now.Add(30*time.Minute) {
		t.Fatal("wrong build clock")
	}
	p := event.Participants[0]
	actor := Actor{Role: RoleParticipant, ConnectionID: p.ConnectionID, ParticipantID: p.ID}
	pool := event.Limited.Player(p.ID).Pool
	req := protocol.LimitedSubmitDeck{DraftOnly: true, Name: "Deck", MainboardInstanceIDs: []string{pool[1].ID}, BasicLands: []protocol.LimitedBasicLand{{Name: "Forest", Count: 4}}}
	for i := 0; i < 2; i++ {
		if _, err := event.SubmitLimitedDeck(actor, req); err != nil {
			t.Fatal(err)
		}
	}
	// A reclaimed credential moves the editable draft to the new session.
	role, id, ok := event.BindCredential(CredentialHash(p.DisplayName), "again", now)
	if !ok || role != RoleParticipant || id != p.ID {
		t.Fatal("reconnect")
	}
	if _, err := event.SubmitLimitedDeck(actor, req); err == nil {
		t.Fatal("displaced session edited a draft")
	}
	actor.ConnectionID = "again"
	snapshot := event.LimitedSnapshot(p.ID)
	if snapshot.DeckSubmitted || !slices.Equal(snapshot.MainboardInstanceIDs, req.MainboardInstanceIDs) || len(snapshot.BasicLands) != 1 || snapshot.BasicLands[0].Count != 4 {
		t.Fatal("private draft lost on reconnect")
	}
	if other := event.LimitedSnapshot(""); len(other.Pool) != 0 || len(other.BasicLands) != 0 || len(other.MainboardInstanceIDs) != 0 || other.BuildDeadline != snapshot.BuildDeadline {
		t.Fatal("draft privacy/common deadline")
	}
	req.DraftOnly = false
	if _, err := event.SubmitLimitedDeck(actor, req); err == nil {
		t.Fatal("undersized ready accepted")
	}
	req.DraftOnly = true
	req.MainboardInstanceIDs = []string{event.Limited.Player(event.Participants[1].ID).Pool[0].ID}
	if _, err := event.SubmitLimitedDeck(actor, req); err == nil {
		t.Fatal("opponent's card accepted")
	}
	changed, err := event.ExpireClubCube(now.Add(30 * time.Minute))
	if err != nil || !changed || event.Stage != protocol.LimitedStageCompetition || event.CurrentRound() == nil || event.CurrentRound().Number != 1 {
		t.Fatal("deadline did not pair players", err)
	}
	final := event.LimitedSnapshot(p.ID)
	if !final.DeckSubmitted || !slices.Contains(final.MainboardInstanceIDs, pool[1].ID) || len(final.MainboardInstanceIDs) != 23 {
		t.Fatal("timeout overwrote saved cards")
	}
	basics := 0
	for _, land := range final.BasicLands {
		if land.Name != "Forest" {
			t.Fatal("saved mana base lost")
		}
		basics += land.Count
	}
	if basics != 17 {
		t.Fatal("deck not completed with 17 lands")
	}
	if _, err := event.SubmitLimitedDeck(actor, req); err == nil {
		t.Fatal("late draft replaced locked deck")
	}
}

func TestClubCubeAutoPairings(t *testing.T) {
	for _, seats := range []int{4, 5, 6, 8} {
		t.Run(fmt.Sprint(seats), func(t *testing.T) {
			event := newClubCubeDraft(t, seats, protocol.LimitedDraftModeBooster)
			for event.Stage == protocol.LimitedStageDraft {
				if _, err := event.ExpireClubCube(event.ClubCubeDeadline()); err != nil {
					t.Fatal(err)
				}
			}
			for i, p := range event.Participants {
				req := protocol.LimitedSubmitDeck{Name: p.DisplayName, BasicLands: []protocol.LimitedBasicLand{{Name: "Forest", Count: 40}}}
				if _, err := event.SubmitLimitedDeck(Actor{Role: RoleParticipant, ParticipantID: p.ID, ConnectionID: p.ConnectionID}, req); err != nil {
					t.Fatal(err)
				}
				if i+1 < seats && event.CurrentRound() != nil {
					t.Fatal("pairing before all ready")
				}
			}
			if event.Stage != protocol.LimitedStageCompetition || !event.ClubCubeDeadline().IsZero() {
				t.Fatal("did not finish construction early")
			}
			pairs := map[[2]string]bool{}
			byes := map[string]bool{}
			for number := 1; number <= 3; number++ {
				r := event.CurrentRound()
				if r == nil || r.Number != number || len(r.Pairings) != (seats+1)/2 {
					t.Fatalf("wrong round %d: %#v", number, r)
				}
				for i := range r.Pairings {
					pairing := &r.Pairings[i]
					if pairing.Bye() {
						if byes[pairing.PlayerAID] {
							t.Fatal("duplicate bye")
						}
						byes[pairing.PlayerAID] = true
						continue
					}
					key := [2]string{pairing.PlayerAID, pairing.PlayerBID}
					slices.Sort(key[:])
					if pairs[key] {
						t.Fatal("repeat opponent", key)
					}
					pairs[key] = true
					pairing.RoomID = pairing.ID + "-table"
					if seats == 4 && i == len(r.Pairings)-1 {
						if err := event.ApplyTimeout(pairing.ID, pairing.PlayerBID, 2, 0, testNow); err != nil {
							t.Fatal("timeout result rejected", err)
						}
					} else if !event.RecordForgeResult(pairing.ID, pairing.RoomID, MatchScore{PlayerAWins: 2}, testNow) {
						t.Fatal("result rejected")
					}
					if event.RecordForgeResult(pairing.ID, pairing.RoomID, MatchScore{PlayerBWins: 2}, testNow) {
						t.Fatal("duplicate result accepted")
					}
				}
			}
			if event.Status != StatusCompleted || event.Champion == "" || len(event.Rounds) != 3 || len(byes) != 3*(seats%2) {
				t.Fatal("wrong final standings")
			}
			if seats == 4 && len(pairs) != 6 {
				t.Fatal("incomplete round robin")
			}
		})
	}
}
