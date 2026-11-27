// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"log"
	"time"
)

// Scheduled under the event state lock. A stale callback cannot affect a
// resumed, cancelled or removed event, or consume the next player's pick.
func (h *Handler) scheduleClubCubeLocked(entry *tournamentEntry) {
	deadline := entry.event.ClubCubeDeadline()
	if entry.cubeClockClosed || deadline.Equal(entry.cubeDeadline) {
		return
	}
	if entry.cubeTimer != nil {
		entry.cubeTimer.Stop()
		entry.cubeTimer = nil
	}
	entry.cubeDeadline = deadline
	if deadline.IsZero() {
		return
	}
	id := entry.event.ID
	entry.cubeTimer = time.AfterFunc(time.Until(deadline), func() {
		current, err := h.tournaments.lockOperation(id)
		if err != nil {
			return
		}
		defer current.opMu.Unlock()
		current.mu.Lock()
		if current != entry || current.cubeClockClosed || !current.cubeDeadline.Equal(deadline) {
			current.mu.Unlock()
			return
		}
		current.cubeDeadline = time.Time{}
		current.cubeTimer = nil
		changed, err := current.event.ExpireClubCube(time.Now().UTC())
		if err == nil {
			h.scheduleClubCubeLocked(current)
		}
		current.mu.Unlock()
		if err != nil {
			log.Printf("club cube %s clock: %v", id, err)
			return
		}
		if changed {
			h.fanoutTournament(id)
		}
	})
}

func stopClubCubeLocked(entry *tournamentEntry) {
	entry.cubeClockClosed = true
	if entry.cubeTimer != nil {
		entry.cubeTimer.Stop()
		entry.cubeTimer = nil
	}
	entry.cubeDeadline = time.Time{}
}
