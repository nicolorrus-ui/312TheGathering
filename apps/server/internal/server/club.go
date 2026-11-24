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
		room.Playtest || room.AllowSpectators || room.SpectatorsSeeHands ||
		room.AISource != "" || room.AIDifficulty != "" || (!room.Practice && strings.TrimSpace(room.Password) == "") {
		return false
	}
	if room.Practice && room.MatchMode != protocol.MatchBO1 {
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
