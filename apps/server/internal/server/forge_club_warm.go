// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"hexproof/server/internal/rulesengine/forge"
)

var errForgeWarming = errors.New("Forge instance is warming")

// prepareClubWarm reserves one process launch. The same process that
// answers the readiness probe becomes the next match's engine.
func (f *forgeRuntimeLifecycle) prepareClubWarm(onExit func(forge.Runtime)) {
	f.mu.Lock()
	if !f.clubWarm || f.closed || f.config == nil || f.idle != nil ||
		f.starting != nil || time.Now().Before(f.retryAfter) || !f.canWarmClubLocked() {
		f.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	starting, config := make(chan struct{}), *f.config
	f.starting, f.startCancel = starting, cancel
	f.mu.Unlock()

	go func() {
		client, err := forge.Start(ctx, config)
		cancel()
		f.mu.Lock()
		if !f.closed && err == nil && client.Healthy() {
			f.idle = client
			f.trackLocked(client)
			go onExit(client)
		} else {
			if !f.closed {
				f.retryAfter = time.Now().Add(5 * time.Second)
				if err != nil {
					log.Printf("club Forge prewarm failed: %v", err)
				}
			}
			if client != nil {
				f.mu.Unlock()
				_ = client.Close()
				f.mu.Lock()
			}
		}
		f.starting, f.startCancel = nil, nil
		close(starting)
		f.mu.Unlock()
	}()
}

func (f *forgeRuntimeLifecycle) canWarmClubLocked() bool {
	occupied := f.occupiedLocked()
	if occupied < f.maxGames {
		return true
	}
	if occupied == f.maxGames {
		// A between-games reservation still counts as a match slot. It
		// can warm its replacement as soon as the prior child is reaped.
		for _, previous := range f.reservations {
			select {
			case <-previous.Done():
				return true
			default:
			}
		}
	}
	return false
}

func (f *forgeRuntimeLifecycle) clubMatchState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	occupied := f.occupiedLocked()
	if f.starting != nil {
		occupied--
	}
	if occupied >= f.maxGames {
		return "busy"
	}
	if !f.closed && f.idle != nil && f.idle.Healthy() {
		return "ready"
	}
	return "warming"
}

// ValidateDecks does not create a game. Park its JVM for another request.
func (f *forgeRuntimeLifecycle) returnClubValidationWorker(client *forge.Client) {
	f.mu.Lock()
	if f.clubWarm && f.idle == nil && f.starting == nil && f.acceptsGameLocked(client) {
		f.idle = client
		f.mu.Unlock()
		return
	}
	f.mu.Unlock()
	_ = client.Close()
}

func (h *Handler) ServeClubForgeAvailability(w http.ResponseWriter, _ *http.Request) {
	h.forge.prepareClubWarm(h.watchForgeRuntime)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": h.forge.clubMatchState()})
}
