// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type cardSearchPrinting struct {
	Name            string `json:"name"`
	SetCode         string `json:"setCode"`
	CollectorNumber string `json:"collectorNumber"`
	SetName         string `json:"setName"`
}

type cardSearchPage struct {
	Cards   []cardSearchPrinting `json:"cards"`
	HasMore bool                 `json:"hasMore"`
}

type cardSearchEntry struct {
	page    cardSearchPage
	expires time.Time
}

type clubSearchFunc func(context.Context, string, bool, int) (cardSearchPage, bool)

func (search clubSearchFunc) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	text, name := strings.TrimSpace(query.Get("q")), strings.TrimSpace(query.Get("name"))
	if (text == "") == (name == "") {
		http.Error(w, "Supply one card name or search term", http.StatusBadRequest)
		return
	}
	exact := name != ""
	if exact {
		text = name
	}
	if len(text) > 200 || strings.ContainsFunc(text, unicode.IsControl) {
		http.Error(w, "Invalid card name", http.StatusBadRequest)
		return
	}
	page := 1
	if value := query.Get("page"); value != "" {
		var err error
		page, err = strconv.Atoi(value)
		if err != nil || page < 1 || page > 1000 {
			http.Error(w, "Invalid page", http.StatusBadRequest)
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	result, ok := search(ctx, text, exact, page)
	if !ok {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Card search is temporarily unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=600")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func (a *clubCardArt) search(ctx context.Context, text string, exact bool, page int) (cardSearchPage, bool) {
	term := strconv.Quote(strings.ToLower(text))
	params := url.Values{"unique": {"cards"}, "order": {"name"}, "page": {strconv.Itoa(page)}}
	var name string
	if exact {
		name = text
		term = "!" + term
		params.Set("unique", "prints")
		params.Set("order", "released")
		params.Set("dir", "desc")
	}
	params.Set("q", term)
	return a.searchPage(ctx, params.Encode(), name)
}

func (a *clubCardArt) searchPage(ctx context.Context, key, name string) (cardSearchPage, bool) {
	a.mu.Lock()
	entry, hit := a.searches[key]
	a.mu.Unlock()
	if hit && time.Now().Before(entry.expires) {
		return entry.page, true
	}

	var list struct {
		Data    []scryfallCard `json:"data"`
		HasMore bool           `json:"has_more"`
	}
	status := a.requestJSON(ctx, "https://api.scryfall.com/cards/search?"+key, 4<<20, &list)
	if status != http.StatusOK && status != http.StatusNotFound {
		return cardSearchPage{}, false
	}

	result := cardSearchPage{Cards: make([]cardSearchPrinting, 0, len(list.Data)), HasMore: list.HasMore}
	expires := time.Now().Add(24 * time.Hour)
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, card := range list.Data {
		if card.Name == "" || card.Set == "" || card.CollectorNumber == "" {
			continue
		}
		// Scryfall's exact-name operator also matches a back face. A different
		// card with this spell on its back is not a printing of the spell.
		front, _, _ := strings.Cut(card.Name, " // ")
		if name != "" && !strings.EqualFold(name, card.Name) && !strings.EqualFold(name, front) {
			continue
		}
		result.Cards = append(result.Cards, cardSearchPrinting{
			Name: card.Name, SetCode: strings.ToUpper(card.Set), CollectorNumber: card.CollectorNumber, SetName: card.SetName,
		})
		// The search response includes artwork. Reuse it when the grid displays a printing.
		if urls := card.images(card.Name); urls.Normal != "" {
			if len(a.cache) >= 1024 {
				clear(a.cache)
			}
			a.cache[clubImageID{artKey: artKey{strings.ToLower(card.Name), card.Set, strings.ToLower(card.CollectorNumber)}}] = artEntry{urls, expires}
		}
	}
	if len(a.searches) >= 128 {
		clear(a.searches)
	}
	a.searches[key] = cardSearchEntry{result, time.Now().Add(10 * time.Minute)}
	return result, true
}
