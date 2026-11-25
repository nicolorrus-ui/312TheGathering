// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type cardArtTransport func(*http.Request) (*http.Response, error)

func (transport cardArtTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return transport(r)
}

func TestClubCardArtPrefersPrintingAndCachesBothSizes(t *testing.T) {
	art := newClubCardArt()
	requests := 0
	art.client.Transport = cardArtTransport(func(req *http.Request) (*http.Response, error) {
		requests++
		if req.URL.String() != "https://api.scryfall.com/cards/neo/266" ||
			req.Header.Get("User-Agent") != "Hexproof-Club-CardArt/1.0" ||
			req.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected Scryfall metadata request: %s", req.URL)
		}
		return &http.Response{StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(`{"card_faces":[
				{"name":"Hidetsugu Consumes All","image_uris":{"normal":"https://cards.scryfall.io/normal/front.jpg"}},
				{"name":"Vessel of the All-Consuming","image_uris":{"normal":"https://cards.scryfall.io/normal/back.jpg","small":"https://cards.scryfall.io/small/back.jpg"}}
			]}`))}, nil
	})
	for _, size := range []string{"small", "normal"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/card-art?set=neo&number=266&name=Vessel+of+the+All-Consuming&size="+size, nil)
		art.ServeHTTP(w, r)
		if w.Code != http.StatusFound || w.Header().Get("Location") != "https://cards.scryfall.io/"+size+"/back.jpg" {
			t.Fatalf("%s response = %d %q", size, w.Code, w.Header().Get("Location"))
		}
	}
	if requests != 1 {
		t.Fatalf("Scryfall requests = %d, want 1", requests)
	}
}

func TestScryfallImageURLRejectsOtherOrigins(t *testing.T) {
	for _, raw := range []string{"http://cards.scryfall.io/a", "https://cards.scryfall.io.evil.test/a", "https://evil.test/a"} {
		if scryfallImageURL(raw) != "" {
			t.Errorf("accepted %s", raw)
		}
	}
}
