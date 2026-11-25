// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/room"
	"hexproof/server/internal/rulesengine/forge"
	"hexproof/server/internal/tournament"
)

func (h *Handler) validateClubLineup(entry *tournamentEntry, lineup []protocol.DeckSelect) error {
	entry.mu.Lock()
	conquest := entry.event.ClubStyle == tournament.ClubConquest
	format := strings.ToLower(entry.event.Format)
	registrationOpen := entry.event.Status == tournament.StatusRegistration &&
		len(entry.event.Participants) < entry.event.MaxPlayers
	entry.mu.Unlock()
	if !conquest {
		if len(lineup) != 0 {
			return &protocolError{code: protocol.ErrInvalidMessage, message: "Only Conquest accepts lineups"}
		}
		return nil
	}
	if !registrationOpen || len(lineup) != 3 {
		return &protocolError{code: protocol.ErrInvalidMessage, message: "Conquest requires three decks while registration is open"}
	}
	players := make([]forge.PlayerConfig, 0, 3)
	seenDecks := make(map[string]bool, 3)
	for index, deck := range lineup {
		if err := room.ValidateClubDeck(deck, format); err != nil {
			return &protocolError{code: protocol.ErrInvalidDeck, message: fmt.Sprintf("Deck %d does not have a valid deck structure for %s", index+1, format)}
		}
		player := forge.PlayerConfig{Name: deck.Name, Deck: expandDeckCards(deck.Mainboard), Sideboard: expandDeckCards(deck.Sideboard)}
		main, side := clubDeckNames(player.Deck), clubDeckNames(player.Sideboard)
		key := strings.Join(main, "\x00") + "\x01" + strings.Join(side, "\x00")
		if seenDecks[key] {
			return &protocolError{code: protocol.ErrInvalidDeck, message: "Conquest requires three different decklists"}
		}
		seenDecks[key] = true
		players = append(players, player)
	}
	timeout := forgeGameStartTimeout
	if runtime := h.config.ForgeRuntime; runtime != nil {
		timeout += runtime.StartTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	client, err := h.startForgeRuntime(ctx, "", true)
	if err != nil {
		if errors.Is(err, errForgeCapacity) {
			return &protocolError{code: protocol.ErrServerLimit,
				message: "Forge is busy. Wait for the current match or deck validation to finish, then submit your lineup again."}
		}
		code, message := forgeStartFailure(err)
		return &protocolError{code: code, message: message}
	}
	defer h.forge.returnClubValidationWorker(client)
	if err := client.ValidateDecks(ctx, format, players); err != nil {
		var rejected *forge.StartError
		if errors.As(err, &rejected) && len(rejected.Issues()) != 0 {
			issue := rejected.Issues()[0]
			return &protocolError{code: protocol.ErrInvalidDeck,
				message: fmt.Sprintf("Forge rejected deck %d (%s): %s %s", issue.PlayerIndex+1,
					lineup[issue.PlayerIndex].Name, issue.Card.Name, issue.Code)}
		}
		code, message := forgeStartFailure(err)
		return &protocolError{code: code, message: message}
	}
	return nil
}

func clubDeckNames(cards []forge.CardIdentity) []string {
	names := make([]string, 0, len(cards))
	for _, card := range cards {
		names = append(names, strings.ToLower(strings.TrimSpace(card.Name)))
	}
	slices.Sort(names)
	return names
}

// A completed result is immutable in a club event. This guard also prevents a
// finished table that is still open in another tab from starting a new game.
func (h *Handler) clubPairingOpen(r *room.Room) bool {
	if !h.config.ClubMode || r.TournamentID == "" {
		return true
	}
	entry := h.tournaments.entry(r.TournamentID)
	if entry == nil {
		return false
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	pairing, err := entry.event.Pairing(r.TournamentPairingID)
	return err == nil && entry.event.Status == tournament.StatusRunning && pairing.Result == nil && pairing.RoomID == r.ID
}

// The room operation lock serializes results with leave/reset. Only the event
// state mutex is acquired here, since match opening takes event opMu first.
func (h *Handler) recordClubForgeResult(r *room.Room) {
	if !h.config.ClubMode || r.TournamentID == "" {
		return
	}
	entry := h.tournaments.entry(r.TournamentID)
	roomEntry := h.hub.roomEntryFor(r.ID)
	if entry == nil || roomEntry == nil {
		return
	}
	roomEntry.mu.Lock()
	if r.Game == nil || r.Game.Result == nil || !r.Game.Result.MatchFinished || len(r.Score) != 2 {
		roomEntry.mu.Unlock()
		return
	}
	left := r.Seats[0].TournamentParticipantID
	score := tournament.MatchScore{PlayerAWins: r.Score[0], PlayerBWins: r.Score[1], DrawnGames: r.DrawnGames}
	roomEntry.mu.Unlock()
	entry.mu.Lock()
	pairing, err := entry.event.Pairing(r.TournamentPairingID)
	changed := false
	if err == nil {
		if pairing.PlayerAID != left {
			score.PlayerAWins, score.PlayerBWins = score.PlayerBWins, score.PlayerAWins
		}
		changed = entry.event.RecordForgeResult(r.TournamentPairingID, r.ID, score, time.Now().UTC())
	}
	entry.mu.Unlock()
	if changed {
		go h.refreshTournament(r.TournamentID)
	}
}

func clubLineupView(player *tournament.Participant) []protocol.TournamentLineupDeck {
	if player == nil || len(player.Lineup) != 3 {
		return nil
	}
	view := make([]protocol.TournamentLineupDeck, 0, len(player.Lineup))
	for index, deck := range player.Lineup {
		view = append(view, protocol.TournamentLineupDeck{Name: deck.Name, Locked: player.LockedDecks[index]})
	}
	return view
}

func clubLineupChoice(pairing *tournament.Pairing, participantID string) *int {
	if pairing != nil {
		if chosen, ok := pairing.LineupChoices[participantID]; ok {
			return &chosen
		}
	}
	return nil
}
