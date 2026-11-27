// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestClubChineseOracleUsesCurrentWordingAndExactIdentity(t *testing.T) {
	oracle := newClubOracleZH()
	var paths []string
	oracle.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		if r.URL.Host != "mtgch.com" || r.URL.Query().Get("view") != "0" {
			t.Errorf("unexpected MTGCH lookup %v", r.URL)
		}
		if r.URL.Path == "/api/v1/card/4ed/208/" {
			return &http.Response{StatusCode: 404, Body: http.NoBody}, nil
		}
		if r.URL.Path != "/api/v1/result" || r.URL.Query().Get("q") != `name="lightning bolt"` {
			t.Errorf("unexpected exact search %v", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"items":[
			{"name":"Emeritus of Conflict // Lightning Bolt","face_name":"Emeritus of Conflict",
			 "other_faces":[{"face_name":"Lightning Bolt","atomic_translated_text":"其他牌的文字"}]},
			{"name":"Lightning Bolt","oracle_text":"Lightning Bolt deals 3 damage to any target.",
			 "atomic_official_name":"闪电击","atomic_translated_text":"闪电击对任意一个目标造成3点伤害。","zhs_text":"旧印刷文字"}
		]}`))}, nil
	})
	for range 2 {
		w := httptest.NewRecorder()
		oracle.ServeHTTP(w, httptest.NewRequest("GET", "/card-oracle-zh?name=Lightning+Bolt&set=4ED&number=208", nil))
		want := `{"faces":[{"name":"Lightning Bolt","zhName":"闪电击","text":"闪电击对任意一个目标造成3点伤害。"}]}`
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != want {
			t.Fatalf("response %d %s", w.Code, w.Body)
		}
	}
	if len(paths) != 2 {
		t.Fatalf("expected one printing request and one name request across repeated hovers: %v", paths)
	}
}

func TestClubChineseOracleUsesRequestedFaceAndReportsMissingTranslation(t *testing.T) {
	oracle := newClubOracleZH()
	oracle.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/api/v1/card/isd/51/" {
			t.Errorf("looked up %v", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{
			"name":"Delver of Secrets // Insectile Aberration","face_name":"Delver of Secrets",
			"oracle_text":"At the beginning of your upkeep ...","atomic_official_name":"掘密师","zhs_text":"旧印刷文字",
			"other_faces":[{"face_name":"Insectile Aberration","atomic_translated_name":"昆虫变体","atomic_translated_text":"飞行"}]
		}`))}, nil
	})
	for _, tc := range []struct{ name, want string }{
		{"Delver of Secrets // Insectile Aberration", `{"faces":[{"name":"Delver of Secrets","zhName":"掘密师","text":null},{"name":"Insectile Aberration","zhName":"昆虫变体","text":"飞行"}]}`},
		{"Insectile Aberration", `{"faces":[{"name":"Insectile Aberration","zhName":"昆虫变体","text":"飞行"}]}`},
	} {
		w := httptest.NewRecorder()
		oracle.ServeHTTP(w, httptest.NewRequest("GET", "/card-oracle-zh?set=isd&number=51&name="+url.QueryEscape(tc.name), nil))
		if w.Code != 200 || strings.TrimSpace(w.Body.String()) != tc.want {
			t.Fatalf("response %d %s", w.Code, w.Body)
		}
	}
	if text := (mtgchFace{Name: "Isamaru, Hound of Konda"}).face().Text; text == nil || *text != "" {
		t.Fatal("a card with no Oracle text should have an empty translation")
	}
}

func TestClubChineseOracleDistinguishesMissingCardsFromServiceOutages(t *testing.T) {
	oracle := newClubOracleZH()
	count := 0
	oracle.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		count++
		if r.URL.Query().Get("q") == `name="missing"` {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"items":[{"name":"Missing Lynx"}]}`))}, nil
		}
		return &http.Response{StatusCode: 429, Body: http.NoBody}, nil
	})
	for _, tc := range []struct {
		name   string
		status int
	}{{"", 400}, {"missing", 404}, {"missing", 404}, {"overload", 503}, {"different", 503}} {
		w := httptest.NewRecorder()
		oracle.ServeHTTP(w, httptest.NewRequest("GET", "/card-oracle-zh?name="+tc.name, nil))
		if w.Code != tc.status {
			t.Fatalf("%s: got %d, want %d", tc.name, w.Code, tc.status)
		}
	}
	if count != 2 {
		t.Fatalf("expected two upstream requests, got %d", count)
	}
}
