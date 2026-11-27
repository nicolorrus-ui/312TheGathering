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

func TestClubBroadcastEnglishArtwork(t *testing.T) {
	art := newClubCardArt()
	var requests []string
	art.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		requests = append(requests, r.URL.RequestURI())
		status, body := http.StatusOK, ""
		switch r.URL.Path {
		case "/cards/sta/90":
			body = `{"name":"Demonic Tutor","lang":"ja","image_uris":{"normal":"https://cards.scryfall.io/ja.jpg"}}`
		case "/cards/sta/90/en":
			status = http.StatusNotFound
		case "/cards/named":
			if r.URL.Query().Get("set") != "sta" || r.URL.Query().Get("exact") != "demonic tutor" {
				t.Fatalf("unexpected lookup %s", r.URL)
			}
			body = `{"name":"Demonic Tutor","lang":"en","image_uris":{"normal":"https://cards.scryfall.io/en.jpg"}}`
		case "/cards/neo/9∞/en":
			body = `{"name":"Front // Back","lang":"en","card_faces":[
				{"name":"Front","image_uris":{"normal":"https://cards.scryfall.io/front.jpg"}},
				{"name":"Back","image_uris":{"normal":"https://cards.scryfall.io/back.jpg"}}]}`
		default:
			t.Fatalf("unexpected URL %s", r.URL)
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	for _, tt := range []struct{ query, want string }{
		{"name=Demonic+Tutor&set=sta&number=90", "ja.jpg"},
		{"name=Demonic+Tutor&set=sta&number=90&lang=en", "en.jpg"},
		{"name=Demonic+Tutor&set=sta&number=90&lang=en", "en.jpg"},
		{"name=Demonic+Tutor&set=STA&lang=en", "en.jpg"},
		{"name=Back&set=neo&number=9%E2%88%9E&lang=en", "back.jpg"},
	} {
		w := httptest.NewRecorder()
		art.ServeHTTP(w, httptest.NewRequest("GET", "/card-art?"+tt.query, nil))
		if w.Code != http.StatusFound || w.Header().Get("Location") != "https://cards.scryfall.io/"+tt.want {
			t.Fatalf("%s got %d %s", tt.query, w.Code, w.Header().Get("Location"))
		}
	}
	if len(requests) != 5 {
		t.Fatalf("unexpected requests %v", requests)
	}
}
