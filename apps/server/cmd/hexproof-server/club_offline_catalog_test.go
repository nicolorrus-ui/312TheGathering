// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestClubOfflineCatalogRoutes(t *testing.T) {
	fixture := offlineCatalog{
		Version: 1,
		Sets:    map[string]string{"M11": "Magic 2011", "TRK": "Star Trek"},
		Cards: []offlineCard{
			{offlineCardInfo: offlineCardInfo{Name: "Fire // Ice", TypeLine: "Instant", ManaCost: "1 R // 1 U"}, Faces: []offlineCardInfo{{Name: "Fire", Oracle: "Front text."}, {Name: "Ice", Oracle: "Tap target permanent."}}, Printings: []offlinePrinting{{"M11", "12"}}},
			{offlineCardInfo: offlineCardInfo{Name: "Unprinted"}},
		},
	}
	for i := 0; i <= offlinePageSize; i++ {
		fixture.Cards = append(fixture.Cards, offlineCard{offlineCardInfo: offlineCardInfo{Name: fmt.Sprintf("Test %03d", i)}})
		fixture.Cards[1].Printings = append(fixture.Cards[1].Printings, offlinePrinting{"M11", fmt.Sprint(i)})
	}
	fixture.Cards = append(fixture.Cards, offlineCard{offlineCardInfo: offlineCardInfo{Name: "No editions"}})
	fixture.Cards = append(fixture.Cards, offlineCard{offlineCardInfo: offlineCardInfo{Name: "All Good Things..."},
		Printings: []offlinePrinting{{"TRK", "226"}}})
	fixture.Cards = append(fixture.Cards, offlineCard{offlineCardInfo: offlineCardInfo{Name: "Set Phasers to . . ."},
		Printings: []offlinePrinting{{"TRK", "34"}}})
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := registerClubCardRoutes(mux, fstest.MapFS{offlineCatalogPath: {Data: data}}, true, nil, ""); err != nil {
		t.Fatal(err)
	}
	image := httptest.NewRecorder()
	mux.ServeHTTP(image, httptest.NewRequest(http.MethodGet, "/card-art?name=Ice", nil))
	if image.Code != http.StatusOK || !strings.Contains(image.Body.String(), "Tap target permanent.") {
		t.Fatalf("back-face rules text missing from local image: %s", image.Body)
	}
	for _, tc := range []struct {
		query, firstName, firstNumber string
		count                         int
		more                          bool
	}{
		{"name=fIrE", "Fire // Ice", "12", 1, false},
		{"name=Fire+%2F%2F+Ice", "Fire // Ice", "12", 1, false},
		{"q=ICE", "Fire // Ice", "12", 1, false},
		{"q=test", "Test 000", "", offlinePageSize, true},
		{"q=test&page=2", fmt.Sprintf("Test %03d", offlinePageSize), "", 1, false},
		{"name=unprinted", "Unprinted", "0", offlinePageSize, true},
		{"name=unprinted&page=2", "Unprinted", fmt.Sprint(offlinePageSize), 1, false},
		{"q=no+editions", "No editions", "", 1, false},
		{"name=no+editions", "", "", 0, false},
		{"q=test&page=3", "", "", 0, false},
		{"name=All+Good+Things+.+.+.", "All Good Things...", "226", 1, false},
		{"q=things...", "All Good Things...", "226", 1, false},
		{"name=Set+Phasers+to...", "", "", 0, false},
	} {
		t.Run(tc.query, func(t *testing.T) {
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/card-search?"+tc.query, nil))
			var page cardSearchPage
			if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK {
				t.Fatalf("invalid response: %d %s", response.Code, response.Body)
			}
			if page.Cards == nil || len(page.Cards) != tc.count || page.HasMore != tc.more {
				t.Fatalf("cards: %v, more: %v", page.Cards, page.HasMore)
			}
			if len(page.Cards) > 0 {
				card := page.Cards[0]
				if card.Name != tc.firstName || card.CollectorNumber != tc.firstNumber || card.SetName != fixture.Sets[card.SetCode] {
					t.Errorf("unexpected printing: %+v", card)
				}
			}
		})
	}
}

func TestClubOfflineRequiresCatalogAndOnlineDoesNot(t *testing.T) {
	for _, data := range []string{"", "invalid", `{"version":2,"cards":[{"name":"Lightning Bolt"}]}`, `{"version":1,"cards":[]}`} {
		files := fstest.MapFS{}
		if data != "" {
			files[offlineCatalogPath] = &fstest.MapFile{Data: []byte(data)}
		}
		if err := registerClubCardRoutes(http.NewServeMux(), files, true, nil, ""); err == nil {
			t.Fatalf("accepted broken offline catalog %q", data)
		}
		if err := registerClubCardRoutes(http.NewServeMux(), files, false, nil, ""); err != nil {
			t.Fatalf("online mode requires offline catalog: %v", err)
		}
	}
}
