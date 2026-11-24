// SPDX-License-Identifier: GPL-3.0-or-later

package tournament

import (
	"fmt"
	"time"

	"hexproof/server/internal/protocol"
)

const (
	ClubSwiss    = "swiss"
	ClubConquest = "conquest"
)

// LineupDeck returns only an available deck from an authenticated player's
// lineup. The selected index becomes fixed once the table is opened.
func (t *Tournament) LineupDeck(p *Pairing, participantID string, requested *int) (protocol.DeckSelect, int, error) {
	player := t.Participant(participantID)
	index, selected := p.LineupChoices[participantID]
	if !selected {
		if requested == nil {
			return protocol.DeckSelect{}, 0, fail(ErrNotReady, "choose an unlocked deck for this match")
		}
		index = *requested
	}
	if player == nil || index < 0 || index >= len(player.Lineup) || index >= len(player.LockedDecks) || player.LockedDecks[index] {
		return protocol.DeckSelect{}, 0, fail(ErrInvalid, "this deck is unavailable")
	}
	return player.Lineup[index], index, nil
}

func (p *Pairing) ChooseLineupDeck(participantID string, index int) {
	if p.LineupChoices == nil {
		p.LineupChoices = make(map[string]int)
	}
	p.LineupChoices[participantID] = index
}

func pairingWinner(p Pairing) string {
	if p.Result == nil {
		return ""
	}
	score := p.Result.Score
	if p.Bye() || score.PlayerAWins > score.PlayerBWins {
		return p.PlayerAID
	}
	if score.PlayerBWins > score.PlayerAWins {
		return p.PlayerBID
	}
	return ""
}

// RecordForgeResult accepts an engine result once, from the exact room bound
// to the current pairing. Wins in individual games never lock a lineup deck.
func (t *Tournament) RecordForgeResult(pairingID, roomID string, score MatchScore, now time.Time) bool {
	round := t.CurrentRound()
	if t.ClubStyle == "" || t.Status != StatusRunning || round == nil {
		return false
	}
	for index := range round.Pairings {
		p := &round.Pairings[index]
		if p.ID != pairingID || p.RoomID != roomID || p.Result != nil || p.Bye() || t.validateScore(score) != nil {
			continue
		}
		result := &ConfirmedResult{Score: score, ConfirmedBy: "forge", ConfirmedAt: now}
		if t.ClubStyle == ClubConquest {
			if len(p.LineupChoices) != 2 {
				return false
			}
			p.Result = result
			winner := pairingWinner(*p)
			if player := t.Participant(winner); player != nil {
				player.LockedDecks[p.LineupChoices[winner]] = true
				if player.LockedDecks == [3]bool{true, true, true} {
					t.completeClubEvent(winner, now)
					return true
				}
			}
			t.Rounds = append(t.Rounds, t.buildRound(t.activeParticipants(), now))
		} else {
			p.Result = result
		}
		return true
	}
	return false
}

func (t *Tournament) completeClubEvent(champion string, now time.Time) {
	t.Champion, t.Status, t.Stage, t.ClosedAt = champion, StatusCompleted, protocol.LimitedStageCompleted, now
}

func (t *Tournament) advanceElimination(now time.Time) error {
	previous := t.CurrentRound()
	var seeds []string
	if !previous.Elimination {
		seeds = make([]string, 8)
		var count int
		for _, standing := range t.Standings() {
			if !standing.Dropped && count < len(seeds) {
				seeds[count] = standing.ParticipantID
				count++
			}
		}
		if count < 2 {
			t.completeClubEvent(seeds[0], now)
			return nil
		}
		seeds = []string{seeds[0], seeds[7], seeds[3], seeds[4], seeds[1], seeds[6], seeds[2], seeds[5]}
		t.MatchMode = protocol.MatchBO3
	} else {
		seeds = make([]string, 0, len(previous.Pairings))
		for _, p := range previous.Pairings {
			winner := pairingWinner(p)
			if winner == "" {
				if p.PlayerAID == "" && p.PlayerBID == "" {
					seeds = append(seeds, "")
					continue
				}
				return fail(ErrResultInvalid, "the elimination round must have a winner at each table")
			}
			seeds = append(seeds, winner)
		}
		if len(seeds) == 1 {
			t.completeClubEvent(seeds[0], now)
			return nil
		}
	}
	round := Round{Number: previous.Number + 1, StartedAt: now, Elimination: true}
	for index := 0; index < len(seeds); index += 2 {
		left, right := seeds[index], seeds[index+1]
		if left == "" {
			left, right = right, left
		}
		t.nextPairing++
		p := Pairing{ID: fmt.Sprintf("r%d-m%d", round.Number, t.nextPairing),
			Table: len(round.Pairings) + 1, PlayerAID: left, PlayerBID: right}
		if p.Bye() {
			p.Result = &ConfirmedResult{Score: MatchScore{PlayerAWins: 2}, ConfirmedBy: "bye", ConfirmedAt: now}
		}
		round.Pairings = append(round.Pairings, p)
	}
	t.Rounds = append(t.Rounds, round)
	return nil
}
