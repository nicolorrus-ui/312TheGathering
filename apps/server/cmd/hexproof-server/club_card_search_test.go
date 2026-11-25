// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClubCardSearch(t *testing.T) {
	for _, tc := range []struct {
		name, path, query, unique, page string
	}{
		{"search", "/card-search?q=Urza%27s", `"urza's"`, "cards", "1"},
		{"printings", "/card-search?name=Urza%27s+Mine&page=2", `!"urza's mine"`, "prints", "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog := newClubCardArt()
			calls := 0
			catalog.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				q := r.URL.Query()
				if r.URL.Host != "api.scryfall.com" || r.URL.Path != "/cards/search" || q.Get("q") != tc.query ||
					q.Get("unique") != tc.unique || q.Get("page") != tc.page {
					t.Fatalf("unexpected search request %s", r.URL)
				}
				return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[
					{"name":"Urza's Mine","set":"2xm","collector_number":"329","set_name":"Double Masters",
					"image_uris":{"normal":"https://cards.scryfall.io/normal/mine.jpg"}}],"has_more":true}`))}, nil
			})
			for i := 0; i < 2; i++ {
				w := httptest.NewRecorder()
				catalog.serveSearch(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
				var result cardSearchPage
				want := cardSearchPrinting{"Urza's Mine", "2XM", "329", "Double Masters"}
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != http.StatusOK || !result.HasMore ||
					len(result.Cards) != 1 || result.Cards[0] != want {
					t.Fatalf("unexpected response: %d %s", w.Code, w.Body)
				}
			}
			w := httptest.NewRecorder()
			catalog.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=Urza%27s+Mine&set=2xm&number=329", nil))
			if w.Header().Get("Location") != "https://cards.scryfall.io/normal/mine.jpg" || calls != 1 {
				t.Fatalf("image redirect %q after %d upstream requests", w.Header().Get("Location"), calls)
			}
		})
	}
}

func TestClubPrintingSearchDoesNotOfferOtherCardsWithMatchingBack(t *testing.T) {
	catalog := newClubCardArt()
	catalog.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[
			{"name":"Lightning Bolt","set":"m11","collector_number":"146"},
			{"name":"Emeritus of Conflict // Lightning Bolt","set":"sos","collector_number":"105"}
		]}`))}, nil
	})
	w := httptest.NewRecorder()
	catalog.serveSearch(w, httptest.NewRequest(http.MethodGet, "/card-search?name=Lightning+Bolt", nil))
	var result cardSearchPage
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Cards) != 1 || result.Cards[0].Name != "Lightning Bolt" {
		t.Fatalf("unexpected printings: %s", w.Body)
	}
}

func TestClubCardSearchHandlesEmptyAndUnavailable(t *testing.T) {
	catalog := newClubCardArt()
	upstream := http.StatusNotFound
	catalog.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: upstream, Body: http.NoBody}, nil
	})
	for _, query := range []string{"q=&name=", "q=a&name=b", "q=name&page=0", "name=un%00safe"} {
		w := httptest.NewRecorder()
		catalog.serveSearch(w, httptest.NewRequest(http.MethodGet, "/card-search?"+query, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("invalid query %s returned %d", query, w.Code)
		}
	}
	w := httptest.NewRecorder()
	catalog.serveSearch(w, httptest.NewRequest(http.MethodGet, "/card-search?q=no-match", nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"cards":[]`) {
		t.Fatalf("expected empty list, got %d %s", w.Code, w.Body)
	}
	upstream = http.StatusTooManyRequests
	w = httptest.NewRecorder()
	catalog.serveSearch(w, httptest.NewRequest(http.MethodGet, "/card-search?q=throttled", nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expected retryable failure, got %d", w.Code)
	}
}
