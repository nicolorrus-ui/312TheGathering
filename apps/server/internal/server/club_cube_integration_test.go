// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"fmt"
	"testing"
	"time"

	"hexproof/server/internal/protocol"
	"hexproof/server/internal/rulesengine/forge"
	"hexproof/server/internal/tournament"
)

func TestClubCubeWebSocketSetupSavedDeckAndPairing(t *testing.T) {
	config := DefaultConfig()
	config.MessagesPerSecond = 10000
	srv, h := newConfiguredTestServer(t, config)
	// The room needs only advertised Forge availability up to table Ready.
	h.config.ClubMode = true
	h.forge.mu.Lock()
	h.forge.config = &forge.ProcessConfig{}
	h.forge.mu.Unlock()
	peers := make([]*casualCubePeer, 5)
	for i := range peers {
		c := dial(t, srv)
		t.Cleanup(c.close)
		c.hello(fmt.Sprintf("Cube WS %d", i))
		peers[i] = &casualCubePeer{client: c}
	}
	host := peers[0]
	cmd := func(p *casualCubePeer, kind string, payload any, want string) {
		casualCubeCommand(t, peers, p, kind, payload, want)
	}
	req := protocol.TournamentCreate{
		ClubStyle: tournament.ClubCube, Format: protocol.DeckFormatLimited, EventType: protocol.LimitedEventCubeDraft, Coordinator: protocol.LimitedCoordinatorSwiss,
		Name: "Web Cube", RulesMode: protocol.RulesModeForge, MatchMode: protocol.MatchBO3, MaxPlayers: 4, OperationID: "cube-create",
		Product: &protocol.LimitedProductDefinition{ID: "web", Name: "Web Cube", ProductType: "cube", Sheets: []protocol.LimitedSheetDefinition{
			{Name: "cube", Cards: []protocol.LimitedCardDefinition{{Name: "Grizzly Bears", SetCode: "M10", CollectorNumber: "189", Weight: 180, TypeLine: "Creature — Bear"}}},
		}}, DraftSettings: &protocol.LimitedDraftSettings{Mode: protocol.LimitedDraftModeBooster},
	}
	cmd(host, protocol.TypeTournamentCreate, req, protocol.TypeTournamentCreated)
	id := host.event.TournamentID
	if id == "" || host.credential == "" || host.event.ParticipantID == "" {
		t.Fatal("creator seat missing")
	}
	for i, p := range peers[1:] {
		cmd(p, protocol.TypeTournamentEnter, protocol.TournamentEnter{TournamentID: id}, protocol.TypeTournamentEntered)
		if i == 3 {
			break
		}
		cmd(p, protocol.TypeTournamentRegister, protocol.TournamentRegister{TournamentID: id}, protocol.TypeTournamentRegistered)
	}
	// A seat can be vacated during registration. Other guests cannot evict the host.
	cmd(peers[1], protocol.TypeTournamentUnregister, protocol.TournamentParticipantCommand{ParticipantID: host.event.ParticipantID}, protocol.TypeError)
	cmd(peers[1], protocol.TypeTournamentUnregister, protocol.TournamentParticipantCommand{}, protocol.TypeTournamentUnregistered)
	cmd(peers[1], protocol.TypeTournamentRegister, protocol.TournamentRegister{TournamentID: id}, protocol.TypeTournamentRegistered)
	for _, p := range peers[:4] {
		cmd(p, protocol.TypeTournamentCheckIn, protocol.TournamentCheckIn{CheckedIn: true}, protocol.TypeTournamentCheckInSet)
	}
	cmd(host, protocol.TypeTournamentStart, protocol.TournamentStart{OperationID: "start-cube", ExpectedStage: protocol.LimitedStageRegistration}, protocol.TypeTournamentStarted)
	if len(host.pool.CurrentPack) != 15 || host.pool.PickDeadline == "" || len(peers[4].pool.CurrentPack) != 0 {
		t.Fatal("wrong private pack/clock")
	}
	cmd(host, protocol.TypeLimitedPick, protocol.LimitedPick{InstanceID: host.pool.CurrentPack[0].InstanceID}, protocol.TypeLimitedPicked)
	entry, err := h.tournaments.lockOperation(id)
	if err != nil {
		t.Fatal(err)
	}
	entry.mu.Lock()
	if entry.cubeTimer == nil {
		t.Fatal("draft timer was never scheduled")
	}
	// Fast-forward each pack deadline under the ordinary reducer.
	for entry.event.Stage == protocol.LimitedStageDraft {
		if _, err = entry.event.ExpireClubCube(entry.event.ClubCubeDeadline()); err != nil {
			t.Fatal(err)
		}
	}
	entry.mu.Unlock()
	h.fanoutTournament(id)
	entry.opMu.Unlock()
	for _, p := range peers {
		sendTournamentCommand(t, p.client, protocol.TypeSessionPing, "construct", protocol.EmptyPayload{})
		p.receive(t, "construct")
	}
	if peers[4].pool.BuildDeadline == "" || len(peers[4].pool.Pool) != 0 || len(host.pool.Pool) != 45 {
		t.Fatal("wrong construction projection")
	}
	draft := protocol.LimitedSubmitDeck{DraftOnly: true, Name: "My cube deck", MainboardInstanceIDs: []string{host.pool.Pool[0].InstanceID}, BasicLands: []protocol.LimitedBasicLand{{Name: "Forest", Count: 16}}}
	cmd(host, protocol.TypeLimitedSubmitDeck, draft, protocol.TypeLimitedDeckSubmitted)
	saved := &casualCubePeer{client: dial(t, srv)}
	t.Cleanup(saved.client.close)
	saved.client.hello("Reconnected host")
	cmd(saved, protocol.TypeTournamentEnter, protocol.TournamentEnter{TournamentID: id, Credential: host.credential}, protocol.TypeTournamentEntered)
	if saved.pool.DeckSubmitted || len(saved.pool.MainboardInstanceIDs) != 1 || saved.pool.BasicLands[0].Count != 16 {
		t.Fatal("private work not restored")
	}
	ready := protocol.LimitedSubmitDeck{Name: "Ready deck", BasicLands: []protocol.LimitedBasicLand{{Name: "Forest", Count: 40}}}
	for _, p := range append([]*casualCubePeer{saved}, peers[1:4]...) {
		cmd(p, protocol.TypeLimitedSubmitDeck, ready, protocol.TypeLimitedDeckSubmitted)
	}
	sendTournamentCommand(t, saved.client, protocol.TypeSessionPing, "all-ready", protocol.EmptyPayload{})
	saved.receive(t, "all-ready")
	if saved.event.CurrentRound != 1 || len(saved.event.Pairings) != 2 || saved.pool.Stage != protocol.LimitedStageCompetition {
		t.Fatal("initial pairings not published")
	}
	entry.mu.Lock()
	if entry.cubeTimer != nil {
		t.Fatal("construction timer still armed")
	}
	entry.mu.Unlock()
	pair := saved.event.Pairings[0]
	if pair.PlayerAID != saved.event.ParticipantID && pair.PlayerBID != saved.event.ParticipantID {
		pair = saved.event.Pairings[1]
	}
	cmd(saved, protocol.TypeTournamentOpenMatch, protocol.TournamentOpenMatch{PairingID: pair.PairingID}, protocol.TypeTournamentMatchOpened)
	if saved.room.RulesMode != protocol.RulesModeForge || saved.room.DeckFormat != protocol.DeckFormatLimited {
		t.Fatal("pairing did not open a Limited Forge table")
	}
}

func newClubCubeClockEvent(t *testing.T, mode string, now time.Time) *tournament.Tournament {
	t.Helper()
	event, err := tournament.New("timer", tournament.Config{Name: "Clock", Format: "limited", ClubStyle: tournament.ClubCube, EventType: "cube_draft", Coordinator: "swiss", MatchMode: "bo3", RulesMode: "forge", MaxPlayers: 4,
		DraftSettings: &protocol.LimitedDraftSettings{Mode: mode}, Product: &protocol.LimitedProductDefinition{ID: "cube", Name: "Cube", ProductType: "cube", Sheets: []protocol.LimitedSheetDefinition{
			{Name: "cards", Cards: []protocol.LimitedCardDefinition{{Name: "Forest", SetCode: "M10", CollectorNumber: "248", Weight: 180}}}}}}, "Host", "host", tournament.CredentialHash("host"), now)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		id := fmt.Sprint(i)
		p, err := event.Register(id, id, tournament.CredentialHash(id), now)
		if err != nil {
			t.Fatal(err)
		}
		p.CheckedIn = true
	}
	if err := event.Start(tournament.Actor{Role: tournament.RoleOrganizer, ConnectionID: "host"}, 123, now); err != nil {
		t.Fatal(err)
	}
	return event
}

func TestClubCubeClockRunsWithoutConnectedClients(t *testing.T) {
	h := NewHandler()
	t.Cleanup(func() { _ = h.Close() })
	event := newClubCubeClockEvent(t, protocol.LimitedDraftModeBooster, time.Now().UTC().Add(-time.Minute))
	entry, err := h.tournaments.create(event)
	if err != nil {
		t.Fatal(err)
	}
	entry.mu.Lock()
	h.scheduleClubCubeLocked(entry)
	entry.mu.Unlock()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		entry.mu.Lock()
		picked := len(event.Limited.Players[0].Pool)
		entry.mu.Unlock()
		if picked == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("unattended timer did not pick")
}

func TestClubCubeStaleRochesterPickAtDoubleTurn(t *testing.T) {
	for _, timerFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("timer_first_%t", timerFirst), func(t *testing.T) {
			h := NewHandler()
			t.Cleanup(func() { _ = h.Close() })
			event := newClubCubeClockEvent(t, protocol.LimitedDraftModeRochester, time.Now().UTC().Add(-4*time.Minute))
			for range 3 {
				if _, err := event.ExpireClubCube(event.ClubCubeDeadline()); err != nil {
					t.Fatal(err)
				}
			}
			seat := event.Limited.Players[3]
			offer := event.LimitedSnapshot(seat.ID)
			if offer.Rochester.ActiveParticipantID != seat.ID {
				t.Fatal("expected the first pick at the end of the line")
			}
			if timerFirst {
				if changed, err := event.ExpireClubCube(event.ClubCubeDeadline()); err != nil || !changed {
					t.Fatal("timer failed to advance the first pick", err)
				}
			}
			entry, err := h.tournaments.create(event)
			if err != nil {
				t.Fatal(err)
			}
			sess := &Session{ConnectionID: event.Participant(seat.ID).ConnectionID, Send: make(chan []byte, 8)}
			sess.setTournament(tournamentBinding{TournamentID: event.ID, Role: tournament.RoleParticipant, ParticipantID: seat.ID})
			env, _ := protocol.NewEnvelope(protocol.TypeLimitedPick, protocol.LimitedPick{InstanceID: offer.CurrentPack[0].InstanceID, PickDeadline: offer.PickDeadline})
			if err := h.handleLimitedPick(sess, env); err != nil {
				t.Fatal(err)
			}
			if err := readWireError(t, sess); err.Code != protocol.ErrTournamentNotReady {
				t.Fatalf("stale offer was not rejected: %+v", err)
			}
			entry.mu.Lock()
			fresh := event.LimitedSnapshot(seat.ID)
			entry.mu.Unlock()
			if fresh.PickDeadline == offer.PickDeadline || fresh.Rochester.ActiveParticipantID != seat.ID || len(fresh.Pool) != 1 {
				t.Fatal("stale click consumed the second consecutive pick")
			}
			env, _ = protocol.NewEnvelope(protocol.TypeLimitedPick, protocol.LimitedPick{InstanceID: fresh.CurrentPack[0].InstanceID, PickDeadline: fresh.PickDeadline})
			if err := h.handleLimitedPick(sess, env); err != nil {
				t.Fatal(err)
			}
			reply, err := protocol.ParseEnvelope(<-sess.Send)
			if err != nil || reply.Type != protocol.TypeLimitedPicked {
				t.Fatal("fresh offer failed", reply, err)
			}
		})
	}
}

func TestClubCubeConstructionSurvivesUnattendedRetention(t *testing.T) {
	h := NewHandler()
	t.Cleanup(func() { _ = h.Close() })
	event := newClubCubeClockEvent(t, protocol.LimitedDraftModeBooster, time.Now().UTC())
	entry, err := h.tournaments.create(event)
	if err != nil {
		t.Fatal(err)
	}
	for event.Stage == protocol.LimitedStageDraft {
		if changed, err := event.ExpireClubCube(event.ClubCubeDeadline()); err != nil || !changed {
			t.Fatal("draft timeout", err)
		}
	}
	deadline := event.ClubCubeDeadline()
	if h.tryEvictTournament(event.ID, entry, deadline.Add(-time.Second)) || h.tournaments.entry(event.ID) != entry {
		t.Fatal("unattended seats lost their draft before the build deadline")
	}
	if changed, err := event.ExpireClubCube(deadline); err != nil || !changed {
		t.Fatal("build timeout", err)
	}
	if h.tryEvictTournament(event.ID, entry, deadline) {
		t.Fatal("competition evicted immediately")
	}
	if !h.tryEvictTournament(event.ID, entry, deadline.Add(h.config.TournamentAbandonedTTL)) {
		t.Fatal("empty competition failed to expire after the normal grace period")
	}
}
