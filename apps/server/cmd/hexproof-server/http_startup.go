// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"io"
	"net/http"
	"sync/atomic"
)

// startupHTTPHandler lets cloud ingress detect the port while Forge initializes.
// Publish the service mux only after the real runtime has passed its probe.
type startupHTTPHandler struct {
	ready atomic.Pointer[http.ServeMux]
}

func (h *startupHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if mux := h.ready.Load(); mux != nil {
		mux.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Retry-After", "5")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = io.WriteString(w, "{\"ready\":false,\"status\":\"starting\"}\n")
}
