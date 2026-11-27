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
	"testing/fstest"
)

func testCubeCatalog(t *testing.T) *offlineCatalog {
	t.Helper()
	data := []byte(`{"version":1,"sets":{"MRD":"Mirrodin","NMS":"Nemesis"},"setAliases":{"NEM":"NMS"},"cards":[
		{"name":"Ornithopter","manaCost":"0","typeLine":"Artifact Creature Thopter","colors":[],"printings":[{"setCode":"MRD","collectorNumber":"224"}]},
		{"name":"Daze","manaCost":"1 U","typeLine":"Instant","colors":["U"],"printings":[{"setCode":"NMS","collectorNumber":"30"}]},
		{"name":"Flooded Strand","manaCost":"","typeLine":"Land","oracle":"Search your library for a Plains or Island card.","printings":[{"setCode":"KTK","collectorNumber":"233"}]},
		{"name":"Fire // Ice","manaCost":"1 R // 1 U","typeLine":"Instant","printings":[{"setCode":"APC","collectorNumber":"128"}]}]}`)
	catalog, err := loadOfflineCatalog(fstest.MapFS{offlineCatalogPath: {Data: data}})
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestBundledCubesStartWithoutNetworkOrCatalog(t *testing.T) {
	c := newClubCubes("", func() (*offlineCatalog, error) { t.Fatal("read-only preset opened the catalog"); return nil, nil })
	mux := http.NewServeMux()
	c.register(mux)
	for slug, want := range map[string]int{"modovintage": 540, "100-ornithopters": 360} {
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/club-cubes/"+slug, nil))
		var list cubeList
		if res.Code != http.StatusOK || json.Unmarshal(res.Body.Bytes(), &list) != nil || list.Name == "" || list.Slug != slug {
			t.Fatalf("invalid %s preset", slug)
		}
		total, ornithopters := 0, 0
		for _, row := range list.Cards {
			if row.Name == "" || row.SetCode == "" || row.CollectorNumber == "" || row.Count <= 0 || row.ColorCategory == "" || row.TypeLine == "" {
				t.Fatalf("incomplete entry %v", row)
			}
			total += row.Count
			if row.Name == "Ornithopter" {
				ornithopters += row.Count
			}
		}
		if total != want || (slug == "100-ornithopters" && ornithopters != 100) {
			t.Fatalf("%s has %d cards and %d Ornithopters", slug, total, ornithopters)
		}
	}
}

type cubeTransport func(*http.Request) (*http.Response, error)

func (rt cubeTransport) RoundTrip(req *http.Request) (*http.Response, error) { return rt(req) }

func TestClubCubeRefreshRetainsLastCompleteList(t *testing.T) {
	dir := t.TempDir()
	catalog := testCubeCatalog(t)
	get := func() (*offlineCatalog, error) { return catalog, nil }
	c := newClubCubes(dir, get)
	card := `{"quantity":100,"details":{"name":"Ornithopter","set":"MRD","collector_number":"224","type":"Artifact Creature — Thopter","colorcategory":"Colorless","color_identity":[],"rarity":"common"}}`
	spell := `{"colorCategory":"Hybrid","colors":["W","U"],"details":{"name":"Daze","set":"NEM","collector_number":"30","rarity":"common","colorcategory":"Blue"}}`
	body := `{"name":"Latest cube","dateLastUpdated":2000000000000,"cardCount":3,"cards":{"mainboard":[` + card + "," + card + "," + spell + `],"maybeboard":[{}]}}`
	c.client = &http.Client{Transport: cubeTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://cubecobra.com/cube/api/cubeJSON/modovintage" {
			t.Fatalf("upstream %s", req.URL)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	request := func(service *clubCubes, method, path string, input string) *httptest.ResponseRecorder {
		t.Helper()
		mux := http.NewServeMux()
		service.register(mux)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest(method, path, strings.NewReader(input)))
		return out
	}
	update := request(c, "POST", "/club-cubes/modovintage/refresh", "")
	var list cubeList
	if update.Code != 200 || json.Unmarshal(update.Body.Bytes(), &list) != nil || len(list.Cards) != 2 || list.Cards[0].Count != 2 || list.Cards[1].SetCode != "NMS" || list.Cards[1].ColorCategory != "Hybrid" || strings.Join(list.Cards[1].Colors, "") != "WU" {
		t.Fatalf("invalid refresh %d %s", update.Code, update.Body)
	}
	body = strings.Replace(body, "2000000000000", "1700000000000", 1)
	if older := request(c, "POST", "/club-cubes/modovintage/refresh", ""); older.Code != http.StatusConflict {
		t.Fatalf("accepted stale update: %d", older.Code)
	}
	// An invalid response must never replace yesterday's usable draft.
	body = strings.Replace(body, `"cardCount":3`, `"cardCount":19`, 1)
	failed := request(c, "POST", "/club-cubes/modovintage/refresh", "")
	if failed.Code == 200 || request(c, "GET", "/club-cubes/modovintage", "").Body.String() != update.Body.String() ||
		request(newClubCubes(dir, get), "GET", "/club-cubes/modovintage", "").Body.String() != update.Body.String() {
		t.Fatal("lost complete preset after failed refresh or restart")
	}
	if request(c, "POST", "/club-cubes/unlisted/refresh", "").Code != 404 {
		t.Fatal("unexpected preset accepted")
	}
}

func TestClubCustomCubeResolve(t *testing.T) {
	catalog := testCubeCatalog(t)
	mux := http.NewServeMux()
	newClubCubes("", func() (*offlineCatalog, error) { return catalog, nil }).register(mux)
	request := func(body string) *httptest.ResponseRecorder {
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest(http.MethodPost, "/club-cubes/resolve", strings.NewReader(body)))
		return out
	}
	reply := request(`{"cards":[{"name":"fire","count":1},{"name":"Fire // Ice","count":2},{"name":"Ornithopter","count":100},{"name":"Flooded Strand","count":1}]}`)
	var list struct{ Cards []cubeCard }
	if err := json.Unmarshal(reply.Body.Bytes(), &list); err != nil || reply.Code != 200 || len(list.Cards) != 3 {
		t.Fatalf("resolve response %s", reply.Body)
	}
	if row := list.Cards[0]; row.Name != "Fire // Ice" || row.Count != 3 || row.ColorCategory != "Multicolored" || row.SetCode != "APC" {
		t.Fatalf("lost printing or duplicate: %+v", row)
	}
	if row := list.Cards[2]; row.ColorCategory != "Lands" || strings.Join(row.Colors, "") != "WU" {
		t.Fatalf("lost land grouping: %+v", row)
	}
	for _, invalid := range []string{`{"name":"Unknown card","count":1}`, `{"name":"Ornithopter","count":10001}`, `{"name":"Ornithopter","count":1,"setCode":"MRD","collectorNumber":"999"}`} {
		if out := request(`{"cards":[` + invalid + `]}`); out.Code != http.StatusUnprocessableEntity {
			t.Fatalf("accepted %s", invalid)
		}
	}
}
