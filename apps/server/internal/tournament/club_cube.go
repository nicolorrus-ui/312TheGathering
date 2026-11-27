// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package tournament

import (
	"slices"
	"strings"
	"time"

	"hexproof/server/internal/limited"
	"hexproof/server/internal/protocol"
)

const cubePickDuration = time.Minute
const cubeBuildDuration = 30 * time.Minute

type cubePickClock struct {
	packID   string
	cards    int
	deadline time.Time
}

func (t *Tournament) syncClubCubeClocks(now time.Time) {
	if t.ClubStyle != ClubCube {
		return
	}
	if t.Stage != protocol.LimitedStageDraft {
		t.cubeClocks = nil
		if t.Stage == protocol.LimitedStageDeckBuilding && t.buildDeadline.IsZero() {
			t.buildDeadline = now.Add(cubeBuildDuration)
		}
		return
	}
	if t.cubeClocks == nil {
		t.cubeClocks = make(map[string]cubePickClock)
	}
	for _, p := range t.Limited.Players {
		if len(p.Inbox) == 0 {
			delete(t.cubeClocks, p.ID)
			continue
		}
		pack := p.Inbox[0]
		old := t.cubeClocks[p.ID]
		if old.packID != pack.ID || old.cards != len(pack.Cards) {
			t.cubeClocks[p.ID] = cubePickClock{pack.ID, len(pack.Cards), now.Add(cubePickDuration)}
		}
	}
}

// ClubCubeDeadline returns the next authoritative draft or construction boundary.
func (t *Tournament) ClubCubeDeadline() time.Time {
	if t.ClubStyle != ClubCube || t.Status != StatusRunning {
		return time.Time{}
	}
	if t.Stage == protocol.LimitedStageDeckBuilding {
		return t.buildDeadline
	}
	var next time.Time
	for _, clock := range t.cubeClocks {
		if next.IsZero() || next.After(clock.deadline) {
			next = clock.deadline
		}
	}
	return next
}

// ExpireClubCube advances all picks that were actually pending at the supplied
// instant. Pack transfers caused by a timeout always receive a fresh deadline.
func (t *Tournament) ExpireClubCube(now time.Time) (bool, error) {
	next := t.ClubCubeDeadline()
	if next.IsZero() || now.Before(next) {
		return false, nil
	}
	if t.Stage == protocol.LimitedStageDeckBuilding {
		for _, p := range t.Limited.Players {
			if p.Deck != nil {
				continue
			}
			deck, err := t.Limited.SubmitDeck(p.ID, t.cubeTimeoutDeck(p))
			if err != nil {
				return false, err
			}
			locked := cloneDeck(*deck)
			t.Participant(p.ID).Deck = &locked
		}
		return true, t.beginClubCubeCompetition(now)
	}
	for _, p := range t.Limited.Players {
		clock, ok := t.cubeClocks[p.ID]
		if !ok || clock.deadline.After(now) || len(p.Inbox) == 0 {
			continue
		}
		pack := p.Inbox[0]
		if pack.ID != clock.packID || len(pack.Cards) != clock.cards {
			continue
		}
		if _, err := t.Limited.AutoPick(p.ID); err != nil {
			return false, err
		}
	}
	t.Stage = t.Limited.Stage
	t.syncClubCubeClocks(now)
	return true, nil
}

func (t *Tournament) beginClubCubeCompetition(now time.Time) error {
	if err := t.Limited.EnterCompetition(); err != nil {
		return err
	}
	t.Stage = protocol.LimitedStageCompetition
	t.buildDeadline = time.Time{}
	t.cubeClocks = nil
	t.Rounds = append(t.Rounds, t.buildRound(t.activeParticipants(), now.UTC()))
	return nil
}

// Keep every saved selection. For an unfinished deck, fill toward 23 spells
// in draft order, then use drafted lands and add basics to reach 40 cards.
func (t *Tournament) cubeTimeoutDeck(p *limited.PlayerState) protocol.LimitedSubmitDeck {
	req := protocol.LimitedSubmitDeck{Name: t.Name, MainboardInstanceIDs: append([]string(nil), p.MainboardInstanceIDs...), BasicLands: append([]protocol.LimitedBasicLand(nil), p.BasicLands...)}
	size := len(req.MainboardInstanceIDs)
	for _, basic := range req.BasicLands {
		size += basic.Count
	}
	minCards := t.Limited.MinimumDeckCards()
	if size >= minCards {
		return req
	}
	selected := make(map[string]bool, len(req.MainboardInstanceIDs))
	for _, id := range req.MainboardInstanceIDs {
		selected[id] = true
	}
	var lands, spells []string
	spellCount := 0
	for _, card := range p.Pool {
		types, _, _ := strings.Cut(card.TypeLine, "—")
		isLand := slices.Contains(strings.Fields(types), "Land")
		if selected[card.ID] {
			if !isLand {
				spellCount++
			}
		} else if isLand {
			lands = append(lands, card.ID)
		} else {
			spells = append(spells, card.ID)
		}
	}
	n := min(len(spells), max(0, 23-spellCount), minCards-size)
	req.MainboardInstanceIDs = append(req.MainboardInstanceIDs, spells[:n]...)
	size += n
	n = min(len(lands), minCards-size)
	req.MainboardInstanceIDs = append(req.MainboardInstanceIDs, lands[:n]...)
	size += n
	types := []string{"Plains", "Island", "Swamp", "Mountain", "Forest"}
	// Prefer the mana base the player already chose when adding more lands.
	if len(req.BasicLands) > 0 {
		types = nil
		seen := map[string]bool{}
		for _, basic := range req.BasicLands {
			name := strings.ToLower(basic.Name)
			if !seen[name] {
				types = append(types, basic.Name)
				seen[name] = true
			}
		}
	}
	missing := minCards - size
	for i, name := range types {
		count := missing / len(types)
		if i < missing%len(types) {
			count++
		}
		if count > 0 {
			req.BasicLands = append(req.BasicLands, protocol.LimitedBasicLand{Name: name, Count: count})
		}
	}
	return req
}
