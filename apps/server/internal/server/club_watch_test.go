// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"net/http/httptest"
	"testing"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/rulesengine/forge"
)

func TestClubWatchRequiresRoomOptInAndIsReadOnly(t *testing.T) {
	handler := NewHandler()
	t.Cleanup(func() { _ = handler.Close() })
	// Room creation only checks runtime availability; this test does not start a game.
	handler.config.ClubMode = true
	handler.forge.config = &forge.ProcessConfig{}
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	host := dial(t, srv)
	defer host.close()
	host.hello("Alice")
	privateHost := dial(t, srv)
	defer privateHost.close()
	privateHost.hello("Bob")
	viewer := dial(t, srv)
	defer viewer.close()
	viewer.hello("Spectator")
	secondViewer := dial(t, srv)
	defer secondViewer.close()
	secondViewer.hello("Spectator")

	create := func(client *wsClient, live bool) string {
		t.Helper()
		sendClubWatchCommand(t, client, protocol.TypeRoomCreate, protocol.RoomCreate{
			Name: "Club room", Format: protocol.FormatModern, DeckFormat: protocol.DeckFormatModern,
			RulesMode: protocol.RulesModeForge, MatchMode: protocol.MatchBO1,
			AllowSpectators: live, SpectatorsSeeHands: live, Password: "seat-password",
		})
		var created protocol.RoomCreated
		if err := client.recvType(protocol.TypeRoomCreated).DecodePayload(&created); err != nil {
			t.Fatal(err)
		}
		client.recvType(protocol.TypeRoomSnapshot)
		return created.RoomID
	}
	liveID, privateID := create(host, true), create(privateHost, false)
	sendClubWatchCommand(t, viewer, protocol.TypeRoomJoin, protocol.RoomJoin{
		RoomID: privateID, AsSpectator: true, Password: "seat-password",
	})
	assertClubWatchError(t, viewer, protocol.ErrSpectatorsNotAllowed)
	sendClubWatchCommand(t, viewer, protocol.TypeRoomJoin, protocol.RoomJoin{RoomID: liveID})
	assertClubWatchError(t, viewer, protocol.ErrInvalidMessage)
	sendClubWatchCommand(t, viewer, protocol.TypeRoomJoin, protocol.RoomJoin{
		RoomID: liveID, Password: "wrong",
	})
	assertClubWatchError(t, viewer, protocol.ErrWrongPassword)

	for _, watcher := range []*wsClient{viewer, secondViewer} {
		sendClubWatchCommand(t, watcher, protocol.TypeRoomJoin, protocol.RoomJoin{RoomID: liveID, AsSpectator: true})
		reply := watcher.recv()
		var joined protocol.RoomJoined
		if reply.Type != protocol.TypeRoomJoined || reply.DecodePayload(&joined) != nil ||
			joined.Role != protocol.RoleSpectator || joined.Seat != nil {
			t.Fatalf("unexpected watch reply: %+v", reply)
		}
		var room protocol.RoomSnapshot
		if err := watcher.recvType(protocol.TypeRoomSnapshot).DecodePayload(&room); err != nil {
			t.Fatal(err)
		}
		if !room.AllowSpectators || !room.SpectatorsSeeHands || !room.HasPassword || room.Seats[1].Occupied {
			t.Fatalf("watch changed player access or consumed a seat: %+v", room)
		}
	}

	for _, kind := range []string{
		protocol.TypeDeckSelect, protocol.TypePlayerReady, protocol.TypeRulesPriority,
		protocol.TypeRulesRespond, protocol.TypeGameConcede, protocol.TypeTournamentEnter,
	} {
		sendClubWatchCommand(t, viewer, kind, struct{}{})
		assertClubWatchError(t, viewer, protocol.ErrNotPlayer)
	}

	// The preload manifest contains full deck-printing hints, beyond the hands
	// a live viewer is authorized to see. Confirm the next message is the ping
	// reply while the seated player still receives the manifest.
	manifest, _ := protocol.NewEnvelope(protocol.TypeMatchLoadRequired, protocol.MatchLoadRequired{LoadID: 1})
	handler.fanout(handler.hub.FindRoom(liveID), []protocol.Envelope{manifest})
	host.recvType(protocol.TypeMatchLoadRequired)
	sendClubWatchCommand(t, secondViewer, protocol.TypeSessionPing, struct{}{})
	if reply := secondViewer.recv(); reply.Type != protocol.TypeSessionPong {
		t.Fatalf("spectator received %q instead of ping reply", reply.Type)
	}
	sendClubWatchCommand(t, secondViewer, protocol.TypeRoomLeave, struct{}{})
	secondViewer.recvType(protocol.TypeRoomLeft)
	sendClubWatchCommand(t, secondViewer, protocol.TypeRoomJoin, protocol.RoomJoin{
		RoomID: liveID, Password: "seat-password",
	})
	var joined protocol.RoomJoined
	if err := secondViewer.recvType(protocol.TypeRoomJoined).DecodePayload(&joined); err != nil {
		t.Fatal(err)
	}
	if joined.Role != protocol.RolePlayer || joined.Seat == nil || *joined.Seat != 1 {
		t.Fatalf("password-protected player join = %+v", joined)
	}
}

func sendClubWatchCommand(t *testing.T, client *wsClient, kind string, payload any) {
	t.Helper()
	env, err := protocol.NewEnvelope(kind, payload)
	if err != nil {
		t.Fatal(err)
	}
	env.ID = kind
	client.send(env)
}

func assertClubWatchError(t *testing.T, client *wsClient, code string) {
	t.Helper()
	var payload protocol.ErrorPayload
	if err := client.recvType(protocol.TypeError).DecodePayload(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != code {
		t.Fatalf("error code = %q, want %q", payload.Code, code)
	}
}
