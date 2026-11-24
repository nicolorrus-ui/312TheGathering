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
		protocol.TypeSideboardMove, protocol.TypeSideboardReady, protocol.TypeSideboardChooseStartingPlayer:
		return true
	default:
		return false
	}
}

func validClubRoom(room protocol.RoomCreate) bool {
	if room.Format != protocol.FormatModern || room.RulesMode != protocol.RulesModeForge ||
		(room.MaxSeats != 0 && room.MaxSeats != 2) ||
		(room.HostingMode != "" && room.HostingMode != "server") ||
		room.Playtest || room.AllowSpectators || room.SpectatorsSeeHands ||
		room.AISource != "" || room.AIDifficulty != "" || strings.TrimSpace(room.Password) == "" {
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
