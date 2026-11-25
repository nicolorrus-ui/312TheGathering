// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package server

import (
	"strconv"
	"strings"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/rulesengine/forge"
)

// Movement history includes objects that have already left the current view. The
// native viewer projection records visibility at movement time. Constrain each
// endpoint again at the transport boundary, including private hand seat ownership.
func projectedCardMoves(moves []forge.CardMoveView, viewerSeat int, seatForID func(string) (int, error)) []protocol.RulesCardMove {
	if len(moves) > 32 {
		return nil
	}
	var result []protocol.RulesCardMove
	var previous int64
	for _, move := range moves {
		if move.ID <= previous || (move.From.Zone == move.To.Zone && move.From.PlayerID == move.To.PlayerID) {
			continue
		}
		from, okFrom := projectedMoveEnd(move.From, viewerSeat, seatForID)
		to, okTo := projectedMoveEnd(move.To, viewerSeat, seatForID)
		if !okFrom || !okTo {
			continue
		}
		if from.ObjectID == "" && to.ObjectID == "" && !(from.Zone == "library" && to.Zone == "hand" && from.Seat == to.Seat) {
			continue
		}
		previous = move.ID
		result = append(result, protocol.RulesCardMove{ID: move.ID, From: from, To: to})
	}
	return result
}

func projectedMoveEnd(raw forge.MoveEndView, viewerSeat int, seatForID func(string) (int, error)) (protocol.RulesMoveEnd, bool) {
	seat, err := seatForID(raw.PlayerID)
	if err != nil {
		return protocol.RulesMoveEnd{}, false
	}
	end := protocol.RulesMoveEnd{Seat: seat, Zone: raw.Zone}
	switch raw.Zone {
	case "library":
		return end, true
	case "hand":
		if seat != viewerSeat {
			return end, true
		}
	case "stack", "battlefield", "graveyard", "exile", "command":
	default:
		return protocol.RulesMoveEnd{}, false
	}
	prefix := "card-"
	if end.Zone == "stack" {
		prefix = "stack-"
	}
	suffix, ok := strings.CutPrefix(raw.ObjectID, prefix)
	if n, err := strconv.ParseUint(suffix, 10, 31); ok && err == nil && strconv.FormatUint(n, 10) == suffix {
		end.ObjectID = raw.ObjectID
	}
	return end, end.Zone != "stack" || end.ObjectID != ""
}
