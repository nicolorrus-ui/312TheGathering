// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStartupHTTPHandlerWaitsForReadyMux(t *testing.T) {
	startup := &startupHTTPHandler{}
	request := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	pending := httptest.NewRecorder()
	startup.ServeHTTP(pending, request)
	if pending.Code != http.StatusServiceUnavailable || pending.Body.String() != "{\"ready\":false,\"status\":\"starting\"}\n" {
		t.Fatalf("pending status=%d body=%q", pending.Code, pending.Body.String())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	startup.ready.Store(mux)
	active := httptest.NewRecorder()
	startup.ServeHTTP(active, request)
	if active.Code != http.StatusOK {
		t.Fatalf("ready status=%d", active.Code)
	}
}
