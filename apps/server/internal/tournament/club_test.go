// SPDX-License-Identifier: GPL-3.0-or-later

package tournament

import (
	"fmt"
	"testing"
	"time"

	"hexproof/server/internal/protocol"
)

func clubEvent(t *testing.T, style string, topEight bool, count int) (*Tournament, Actor, time.Time) {
	t.Helper()
	now := time.Now().UTC()
	actor := Actor{Role: RoleOrganizer, ConnectionID: "organizer"}
	mode := protocol.MatchBO1
	if style == ClubConquest {
		mode = protocol.MatchBO3
	}
	event, err := New("CLUBTEST", Config{Name: "Club event", Format: "modern",
		ClubStyle: style, TopEight: topEight, MaxPlayers: count, PlannedRounds: 1,
		RulesMode: protocol.RulesModeForge, MatchMode: mode}, "Organizer", actor.ConnectionID, [32]byte{}, now)
	if err != nil {
		t.Fatal(err)
	}
	for i := range count {
		conn := fmt.Sprintf("player%d", i)
		p, err := event.Register(conn, conn, CredentialHash(conn), now)
		if err != nil {
			t.Fatal(err)
		}
		p.CheckedIn = true
		if style == ClubConquest {
			p.Lineup = []protocol.DeckSelect{{Name: "Deck A"}, {Name: "Deck B"}, {Name: "Deck C"}}
		}
	}
	if err := event.Start(actor, 1, now); err != nil {
		t.Fatal(err)
	}
	return event, actor, now
}

func TestClubSwissTopEightSeedsAndCompletesBracket(t *testing.T) {
	event, organizer, now := clubEvent(t, ClubSwiss, true, 8)
	for i := range event.CurrentRound().Pairings {
		p := &event.CurrentRound().Pairings[i]
		p.RoomID = p.ID
		if !event.RecordForgeResult(p.ID, p.RoomID, MatchScore{PlayerAWins: 1}, now) {
			t.Fatal("failed to report a Swiss match")
		}
	}
	seeds := event.Standings()
	if err := event.Advance(organizer, now); err != nil {
		t.Fatal(err)
	}
	order := [][2]int{{0, 7}, {3, 4}, {1, 6}, {2, 5}}
	for i, pair := range event.CurrentRound().Pairings {
		if pair.PlayerAID != seeds[order[i][0]].ParticipantID || pair.PlayerBID != seeds[order[i][1]].ParticipantID {
			t.Fatalf("invalid quarterfinal seeds: %+v", pair)
		}
	}
	for _, count := range []int{4, 2, 1} {
		round := event.CurrentRound()
		if !round.Elimination || len(round.Pairings) != count || event.MatchMode != protocol.MatchBO3 {
			t.Fatalf("unexpected playoff round: %+v", round)
		}
		for i := range round.Pairings {
			p := &round.Pairings[i]
			p.RoomID = p.ID
			if !event.RecordForgeResult(p.ID, p.RoomID, MatchScore{PlayerAWins: 2, PlayerBWins: 1}, now) {
				t.Fatal("failed to report a playoff match")
			}
		}
		if err := event.Advance(organizer, now); err != nil {
			t.Fatal(err)
		}
	}
	if event.Champion != seeds[0].ParticipantID || event.Status != StatusCompleted {
		t.Fatalf("wrong playoff winner: %q", event.Champion)
	}
	if event.Standings()[0] != seeds[0] {
		t.Fatal("elimination results changed Swiss standings")
	}
}

func TestClubSwissWithoutTopEightFinishesFromPoints(t *testing.T) {
	event, organizer, now := clubEvent(t, ClubSwiss, false, 4)
	round := event.CurrentRound()
	for i, score := range []MatchScore{{PlayerAWins: 1}, {DrawnGames: 1}} {
		p := &round.Pairings[i]
		p.RoomID = p.ID
		if !event.RecordForgeResult(p.ID, p.RoomID, score, now) {
			t.Fatal("failed to record Swiss match")
		}
	}
	for index, points := range []int{3, 1, 1, 0} {
		if event.Standings()[index].MatchPoints != points {
			t.Fatal("incorrect Swiss match points")
		}
	}
	if err := event.Advance(organizer, now); err != nil {
		t.Fatal(err)
	}
	if event.Status != StatusCompleted || event.Champion != round.Pairings[0].PlayerAID || len(event.Rounds) != 1 {
		t.Fatal("Swiss without Top 8 did not finish after its last round")
	}
}

func TestClubConquestLocksOnlyTheWinningDeck(t *testing.T) {
	event, _, now := clubEvent(t, ClubConquest, false, 2)
	champion := event.CurrentRound().Pairings[0].PlayerAID
	other := event.CurrentRound().Pairings[0].PlayerBID
	zero := 0
	for deckIndex := range 3 {
		p := &event.CurrentRound().Pairings[0]
		p.RoomID = p.ID
		if _, _, err := event.LineupDeck(p, other, &zero); err != nil {
			t.Fatal("a losing deck must remain available", err)
		}
		if deckIndex > 0 {
			if _, _, err := event.LineupDeck(p, champion, &zero); err == nil {
				t.Fatal("a winning deck was accepted again")
			}
		}
		if _, _, err := event.LineupDeck(p, champion, &deckIndex); err != nil {
			t.Fatal(err)
		}
		p.ChooseLineupDeck(champion, deckIndex)
		p.ChooseLineupDeck(other, zero)
		score := MatchScore{PlayerAWins: 2}
		if p.PlayerAID != champion {
			score = MatchScore{PlayerBWins: 2}
		}
		if event.RecordForgeResult(p.ID, "wrong room", score, now) ||
			!event.RecordForgeResult(p.ID, p.RoomID, score, now) ||
			event.RecordForgeResult(p.ID, p.RoomID, score, now) {
			t.Fatal("Forge result handling did not enforce the room or idempotence")
		}
	}
	if event.Status != StatusCompleted || event.Champion != champion ||
		event.Participant(champion).LockedDecks != [3]bool{true, true, true} ||
		event.Participant(other).LockedDecks != [3]bool{} {
		t.Fatal("conquest completion or lineup locks are incorrect")
	}
}
