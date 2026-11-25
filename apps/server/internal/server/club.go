// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"strings"

	"hexproof/server/internal/protocol"
)

func clubCommandAllowed(kind string) bool {
	switch kind {
	case protocol.TypeSessionHello, protocol.TypeSessionPing,
		protocol.TypeRoomCreate, protocol.TypeRoomJoin, protocol.TypeRoomLeave,
		protocol.TypeDeckSelect, protocol.TypePlayerReady, protocol.TypeClientLoadComplete,
		protocol.TypeRulesRespond, protocol.TypeRulesPriority,
		protocol.TypeGameConcede, protocol.TypeGameReturnToRoom,
		protocol.TypeTournamentCreate, protocol.TypeTournamentEnter, protocol.TypeTournamentLeave,
		protocol.TypeTournamentRegister, protocol.TypeTournamentCheckIn, protocol.TypeTournamentStart,
		protocol.TypeTournamentOpenMatch, protocol.TypeTournamentNextRound, protocol.TypeTournamentCancel,
		protocol.TypeSideboardMove, protocol.TypeSideboardReady, protocol.TypeSideboardChooseStartingPlayer:
		return true
	default:
		return false
	}
}

func validClubTournament(request protocol.TournamentCreate) bool {
	if request.EventType != "" || request.Coordinator != "" || request.Product != nil ||
		request.Plan != nil || request.DraftSettings != nil || request.RulesMode != protocol.RulesModeForge ||
		(request.MatchMode != protocol.MatchBO1 && request.MatchMode != protocol.MatchBO3) {
		return false
	}
	switch request.Format {
	case protocol.DeckFormatStandard, protocol.DeckFormatPioneer, protocol.DeckFormatModern,
		protocol.DeckFormatLegacy, protocol.DeckFormatVintage, protocol.DeckFormatPauper:
	default:
		return false
	}
	switch request.ClubStyle {
	case "swiss":
		return request.MaxPlayers >= 4 && request.MaxPlayers <= 20
	case "conquest":
		return request.MaxPlayers == 2 && !request.TopEight && request.MatchMode == protocol.MatchBO3
	default:
		return false
	}
}

func validClubRoom(room protocol.RoomCreate) bool {
	if room.Format != protocol.FormatModern || room.RulesMode != protocol.RulesModeForge ||
		(room.MaxSeats != 0 && room.MaxSeats != 2) ||
		(room.HostingMode != "" && room.HostingMode != "server") ||
		room.Playtest || room.AllowSpectators != room.SpectatorsSeeHands ||
		room.AISource != "" || room.AIDifficulty != "" || (!room.Practice && strings.TrimSpace(room.Password) == "") {
		return false
	}
	if room.Practice && (room.MatchMode != protocol.MatchBO1 || room.AllowSpectators) {
		return false
	}
	switch room.DeckFormat {
	case protocol.DeckFormatCustom, protocol.DeckFormatStandard, protocol.DeckFormatPioneer,
		protocol.DeckFormatModern, protocol.DeckFormatLegacy, protocol.DeckFormatVintage, protocol.DeckFormatPauper:
		return true
	default:
		return false
	}
}

// The watch link opens a read-only role in an explicitly public Club duel.
// The player's room password and the normal join path remain independent.
func (h *Hub) beginClubWatch(roomID string) (*roomEntry, error) {
	entry, err := h.lockRoomOperation(roomID)
	if err != nil {
		return nil, err
	}
	entry.mu.Lock()
	r := entry.room
	watchable := r.ClubLiveDuel()
	entry.mu.Unlock()
	if !watchable {
		entry.opMu.Unlock()
		return nil, &protocolError{code: protocol.ErrSpectatorsNotAllowed, message: "live viewing is disabled for this room"}
	}
	return entry, nil
}

func (h *Hub) isClubSpectator(sess *Session) bool {
	r := sess.Room()
	if r == nil {
		return false
	}
	entry := h.roomEntryFor(r.ID)
	if entry == nil {
		return false
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	return entry.room == r && r.IsSpectator(sess.ConnectionID)
}
