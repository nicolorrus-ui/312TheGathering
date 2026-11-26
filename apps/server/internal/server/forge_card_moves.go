// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors
package server

import (
	"strconv"
	"strings"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/rulesengine/forge"
)

func projectedPendingCast(raw *forge.PendingCastView, viewerSeat int, seatForID func(string) (int, error)) *protocol.RulesPendingCast {
	if raw == nil || validatedCastID(raw.ID) == "" {
		return nil
	}
	controller, err := seatForID(raw.ControllerID)
	from, ok := projectedMoveEnd(raw.From, viewerSeat, seatForID)
	if err != nil || !ok || from.Zone == "stack" {
		return nil
	}
	cast := &protocol.RulesPendingCast{ID: raw.ID, ControllerSeat: controller, From: from}
	if !raw.FaceDown && raw.Identity.Name != "" {
		cast.Identity = rulesIdentity(raw.Identity)
	}
	return cast
}

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
		projected := protocol.RulesCardMove{ID: move.ID, From: from, To: to}
		if to.Zone == "stack" {
			projected.CastID = validatedCastID(move.CastID)
		}
		result = append(result, projected)
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
	if validMoveObject(raw.ObjectID, prefix) {
		end.ObjectID = raw.ObjectID
	}
	return end, end.Zone != "stack" || end.ObjectID != ""
}

func validMoveObject(id, prefix string) bool {
	suffix, ok := strings.CutPrefix(id, prefix)
	n, err := strconv.ParseUint(suffix, 10, 31)
	return ok && err == nil && strconv.FormatUint(n, 10) == suffix
}

func validatedCastID(id string) string {
	if validMoveObject(id, "casting-") {
		return id
	}
	return ""
}
