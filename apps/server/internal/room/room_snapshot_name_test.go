// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package room

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"hexproof/server/internal/protocol"
)

func TestRoomSnapshotDeckNameIsOwnerPrivateAndResumesWithoutLocalCache(t *testing.T) {
	r := newTestRoom(t, 4, true)
	if _, err := r.Join("guest-conn", "Guest", false, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Join("watcher-conn", "Watcher", true, ""); err != nil {
		t.Fatal(err)
	}
	for index, conn := range []string{"host-conn", "guest-conn"} {
		deck := testDeck(protocol.FormatEDH)
		deck.Name = []string{"Private host registration", "Private guest registration"}[index]
		if _, err := r.SelectDeck(conn, deck); err != nil {
			t.Fatal(err)
		}
	}
	public := r.Snapshot()
	// Even a reused recipient envelope must lose its previous private metadata.
	public.OwnDeckName = "Injected previous recipient name"
	for _, test := range []struct{ conn, want string }{
		{"host-conn", "Private host registration"}, {"guest-conn", "Private guest registration"},
		{"watcher-conn", ""}, {"unrelated-conn", ""},
	} {
		projected := r.ProjectRoomSnapshot(test.conn, public)
		if projected.OwnDeckName != test.want {
			t.Errorf("%s deck name %q, want %q", test.conn, projected.OwnDeckName, test.want)
		}
		projected.OwnDeckName = public.OwnDeckName
		if !reflect.DeepEqual(projected, public) {
			t.Errorf("%s projection changed public room state", test.conn)
		}
	}
	if r.Snapshot().OwnDeckName != "" {
		t.Fatal("public snapshot acquired owner metadata")
	}
	if _, err := r.Reconnect("host-conn", "resumed-host"); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ conn, want string }{
		{"resumed-host", "Private host registration"}, {"watcher-conn", ""},
	} {
		envelopes, err := r.ResumeEnvelopes(test.conn)
		if err != nil {
			t.Fatal(err)
		}
		var snapshot protocol.RoomSnapshot
		if len(envelopes) != 1 || envelopes[0].DecodePayload(&snapshot) != nil ||
			!envelopes[0].HasSeq() || snapshot.OwnDeckName != test.want {
			t.Fatalf("%s resume lost private selected name: %+v", test.conn, envelopes)
		}
		encoded, _ := json.Marshal(snapshot)
		for _, secret := range []string{"Private guest registration", "Injected previous recipient name", "Sol Ring", "mainboard", "sideboard"} {
			if strings.Contains(string(encoded), secret) {
				t.Errorf("%s resume exposed %q", test.conn, secret)
			}
		}
	}
	if r.ProjectRoomSnapshot("host-conn", public).OwnDeckName != "" {
		t.Fatal("replaced connection retained owner display metadata")
	}
}

func TestRoomSnapshotDeckNameRequiresCurrentHumanSelectionAndMatchingPublicSeat(t *testing.T) {
	for _, scenario := range []string{"changed-selection", "cleared-selection", "automated-controller", "unoccupied-seat", "foreign-room", "missing-seat", "public-unselected"} {
		t.Run(scenario, func(t *testing.T) {
			r := newTestRoom(t, 4, true)
			deck := testDeck(protocol.FormatEDH)
			deck.Name = "Original private name"
			if _, err := r.SelectDeck("host-conn", deck); err != nil {
				t.Fatal(err)
			}
			snapshot := r.Snapshot()
			snapshot.OwnDeckName = "Another recipient's stale name"
			want := ""
			switch scenario {
			case "changed-selection":
				deck.Name = "New <literal> deck name"
				if _, err := r.SelectDeck("host-conn", deck); err != nil {
					t.Fatal(err)
				}
				want = deck.Name
			case "cleared-selection":
				r.Seats[0].Deck = nil
			case "automated-controller":
				r.Seats[0].Controller = "forge"
			case "unoccupied-seat":
				r.Seats[0].Occupied = false
			case "foreign-room":
				snapshot.RoomID = "OTHER1"
			case "missing-seat":
				snapshot.Seats = nil
			case "public-unselected":
				snapshot.Seats[0].DeckSelected = false
			}
			projected := r.ProjectRoomSnapshot("host-conn", snapshot)
			if projected.OwnDeckName != want {
				t.Fatalf("private name = %q, want %q", projected.OwnDeckName, want)
			}
			projected.OwnDeckName = snapshot.OwnDeckName
			if !reflect.DeepEqual(projected, snapshot) {
				t.Fatal("private projection changed public state")
			}
		})
	}
}

func TestClubLiveDeckListsFollowRegistrationAndViewerRole(t *testing.T) {
	r, err := NewWithRulesMode("LIVE01", "Club", protocol.FormatModern, protocol.MatchBO3,
		protocol.CardLoadBackground, protocol.RulesModeForge, 2, true, true, "Host", "host", testNow)
	if err != nil {
		t.Fatal(err)
	}
	r.ClubDuel, r.SpectatorsSeeHands = true, true
	if _, err = r.Join("guest", "Guest", false, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = r.Join("watch", "Viewer", true, ""); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []string{"host", "guest"} {
		list := testDeck(protocol.FormatModern)
		list.Name = conn + "'s deck"
		list.Sideboard = []protocol.DeckCard{{Name: "Island", Count: 1, SetCode: "M21", CollectorNumber: "265"}}
		if _, err := r.SelectDeck(conn, list); err != nil {
			t.Fatal(err)
		}
	}
	project := func(conn string) []protocol.LiveDeckList {
		return r.ProjectRoomSnapshot(conn, r.Snapshot()).LiveDeckLists
	}
	if project("watch") != nil {
		t.Fatal("registration published before the match")
	}
	r.Phase, r.LoadID = protocol.RoomPhaseStarted, 1
	// Sideboarding may replace the current game partition, leaving registration fixed.
	r.Seats[1].Deck.Mainboard, r.Seats[1].Deck.Sideboard = r.Seats[1].Deck.Sideboard, r.Seats[1].Deck.Mainboard
	for seat, conn := range []string{"host", "guest"} {
		lists := project("watch")
		if len(lists) != 2 || lists[seat].Seat != seat || lists[seat].Name != conn+"'s deck" ||
			!reflect.DeepEqual(lists[seat].Mainboard, r.Seats[seat].RegisteredDeck.Mainboard) ||
			!reflect.DeepEqual(lists[seat].Sideboard, r.Seats[seat].RegisteredDeck.Sideboard) {
			t.Fatalf("wrong registration: %+v", lists)
		}
		lists[seat].Sideboard[0].Name = "mutated"
		if r.Seats[seat].RegisteredDeck.Sideboard[0].Name != "Island" {
			t.Fatal("viewer can mutate the registration")
		}
	}
	viewerSnapshot := r.ProjectRoomSnapshot("watch", r.Snapshot())
	for _, conn := range []string{"host", "guest", "unrelated", ""} {
		if len(r.ProjectRoomSnapshot(conn, viewerSnapshot).LiveDeckLists) != 0 {
			t.Fatalf("%q received a viewer's decklists", conn)
		}
	}
	if _, err := r.Reconnect("watch", "resumed"); err != nil {
		t.Fatal(err)
	}
	frames, err := r.ResumeEnvelopes("resumed")
	var restored protocol.RoomSnapshot
	if err != nil || frames[0].DecodePayload(&restored) != nil || len(restored.LiveDeckLists) != 2 || project("watch") != nil {
		t.Fatal("registered lists did not follow the resumed viewer")
	}
	r.TournamentID = "event"
	if project("resumed") != nil {
		t.Fatal("tournament viewer received registrations")
	}
	r.TournamentID = ""
	r.SpectatorsSeeHands = false
	if project("resumed") != nil {
		t.Fatal("private viewer received registrations")
	}
	r.SpectatorsSeeHands, r.ClubDuel = true, false
	if project("resumed") != nil {
		t.Fatal("non-Club hand viewer received registrations")
	}
}
