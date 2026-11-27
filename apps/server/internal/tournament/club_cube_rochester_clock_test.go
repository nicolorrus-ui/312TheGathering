// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package tournament

import (
	"testing"
	"time"

	"hexproof/server/internal/protocol"
)

func TestClubRochesterTimeoutFollowsSnake(t *testing.T) {
	event := newClubCubeDraft(t, 4, protocol.LimitedDraftModeRochester)
	seats := event.Limited.Players
	for pick, seat := range []int{0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 1} {
		public := event.LimitedSnapshot("")
		deadline := event.ClubCubeDeadline()
		if public.Rochester.ActiveParticipantID != seats[seat].ID ||
			public.PickDeadline != deadline.Format(time.RFC3339Nano) {
			t.Fatalf("pick %d belongs to another seat or timer", pick+1)
		}
		if changed, err := event.ExpireClubCube(deadline.Add(-time.Nanosecond)); err != nil || changed {
			t.Fatal("acted before the deadline", changed, err)
		}
		before := make([]int, len(seats))
		for index, player := range seats {
			before[index] = len(player.Pool)
		}
		if changed, err := event.ExpireClubCube(deadline); err != nil || !changed {
			t.Fatal("deadline failed to advance one pick", changed, err)
		}
		for index, player := range seats {
			want := before[index]
			if index == seat {
				want++
			}
			if len(player.Pool) != want || player.AutoDraft {
				t.Fatal("expiry picked for a different seat or gave away seat control")
			}
		}
		if !event.ClubCubeDeadline().Equal(deadline.Add(cubePickDuration)) {
			t.Fatal("timer was not renewed at the crossover")
		}
		if changed, err := event.ExpireClubCube(deadline); err != nil || changed {
			t.Fatal("stale expiry advanced the next decision", changed, err)
		}
	}
}
