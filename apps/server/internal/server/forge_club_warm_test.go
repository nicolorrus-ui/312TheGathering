// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"hexproof/server/internal/rulesengine/forge"
)

func TestClubKeepsTheProbedForgeWorkerAndWarmsTheNextGame(t *testing.T) {
	dir := t.TempDir()
	config := DefaultConfig()
	config.ClubMode, config.MaxForgeGames, config.ForgeGamesPerJVM = true, 1, 1
	config.ForgeRuntime = &forge.ProcessConfig{
		Command: os.Args[0], Args: []string{"-test.run=^TestForgeSupervisionHelper$"},
		Env: []string{supervisionHelperEnv + "=" + dir}, StartTimeout: 5 * time.Second,
	}
	h, err := NewHandlerWithConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	if h.forge.clubMatchState() != "ready" || supervisionStartCount(t, dir) != 1 {
		t.Fatal("the first worker must be probed and ready before the service opens")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	validator, err := h.startForgeRuntime(ctx, "", true)
	if err != nil {
		t.Fatal(err)
	}
	h.forge.returnClubValidationWorker(validator)
	game, err := h.startForgeRuntime(ctx, "reserved", true)
	if err != nil || game != validator || supervisionStartCount(t, dir) != 1 {
		t.Fatalf("first match did not reuse the probed worker: %v", err)
	}
	if h.forge.clubMatchState() != "busy" {
		t.Fatal("a claimed worker must occupy its slot")
	}
	if _, err := h.startForgeRuntime(ctx, "other", true); !errors.Is(err, errForgeCapacity) {
		t.Fatalf("another room bypassed the match cap: %v", err)
	}

	h.forge.mu.Lock()
	h.forge.reserveLocked("reserved", game)
	h.forge.mu.Unlock()
	if err := game.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := h.startForgeRuntime(ctx, "reserved", true)
	if err != nil || next == game || supervisionStartCount(t, dir) != 2 {
		t.Fatalf("BO3 did not reuse its reserved slot with a fresh worker: %v", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
	waitForgeCapacityCondition(t, func() bool { return h.forge.clubMatchState() == "ready" })
	if supervisionStartCount(t, dir) != 3 {
		t.Fatal("the slot should become ready with exactly one replacement")
	}
}
