// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// MTGCH's atomic translation follows the latest Oracle wording across printings.
// The separate zhs_text and printed_text fields describe individual printings.
type mtgchFace struct {
	Name       string  `json:"name"`
	FaceName   string  `json:"face_name"`
	FlavorName string  `json:"flavor_name"`
	PrintName  string  `json:"printed_name"`
	Official   string  `json:"atomic_official_name"`
	Translated string  `json:"atomic_translated_name"`
	Oracle     string  `json:"oracle_text"`
	ZHOracle   *string `json:"atomic_translated_text"`
}

type mtgchCard struct {
	mtgchFace
	Other []mtgchFace `json:"other_faces"`
}

type clubOracleFace struct {
	Name   string  `json:"name"`
	ZHName string  `json:"zhName"`
	Text   *string `json:"text"` // nil means untranslated; "" means that the card has no rules text.
}

type clubOracleCard struct {
	Faces []clubOracleFace `json:"faces"`
}

func (f mtgchFace) face() clubOracleFace {
	name := f.FaceName
	if name == "" {
		name = f.Name
	}
	zhName := f.Official
	if zhName == "" {
		zhName = f.Translated
	}
	text := f.ZHOracle
	if text == nil || strings.TrimSpace(*text) == "" {
		text = nil
		if strings.TrimSpace(f.Oracle) == "" {
			text = new(string)
		}
	}
	return clubOracleFace{name, zhName, text}
}

// Prefer a whole-card name before a face of a different card with the same name
// (for example, Lightning Bolt and the prepared spell on Emeritus of Conflict).
func mtgchMatch(cards []mtgchCard, name string) (clubOracleCard, int) {
	for _, card := range cards {
		if offlineCardNameKey(card.Name) == name {
			faces := []clubOracleFace{card.face()}
			for _, face := range card.Other {
				faces = append(faces, face.face())
			}
			return clubOracleCard{faces}, http.StatusOK
		}
	}
	for _, card := range cards {
		for _, face := range append([]mtgchFace{card.mtgchFace}, card.Other...) {
			if name == offlineCardNameKey(face.FaceName) || name == offlineCardNameKey(face.FlavorName) ||
				name == offlineCardNameKey(face.PrintName) {
				return clubOracleCard{[]clubOracleFace{face.face()}}, http.StatusOK
			}
		}
	}
	return clubOracleCard{}, http.StatusNotFound
}

type oracleEntry struct {
	card    clubOracleCard
	status  int
	expires time.Time
}

type oracleRequest struct {
	done   chan struct{}
	result oracleEntry
}

type clubOracleZH struct {
	client  *http.Client
	mu      sync.Mutex
	cache   map[artKey]oracleEntry
	pending map[artKey]*oracleRequest
	backoff time.Time
}

func newClubOracleZH() *clubOracleZH {
	return &clubOracleZH{
		client: &http.Client{Timeout: 6 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		cache: make(map[artKey]oracleEntry), pending: make(map[artKey]*oracleRequest),
	}
}

func (o *clubOracleZH) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	name := offlineCardNameKey(query.Get("name"))
	if name == "" || len(name) > 200 || strings.ContainsFunc(name, unicode.IsControl) {
		http.Error(w, "Invalid card name", http.StatusBadRequest)
		return
	}
	set, number := strings.ToLower(strings.TrimSpace(query.Get("set"))), strings.TrimSpace(query.Get("number"))
	if !cardArtSet.MatchString(set) || !cardArtNumber.MatchString(number) {
		set, number = "", ""
	}
	result := o.resolve(r.Context(), artKey{name, set, number})
	switch result.status {
	case http.StatusOK:
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(result.card)
	case http.StatusNotFound:
		w.Header().Set("Cache-Control", "public, max-age=300")
		http.NotFound(w, r)
	default:
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Chinese Oracle text temporarily unavailable", http.StatusServiceUnavailable)
	}
}

func (o *clubOracleZH) resolve(ctx context.Context, key artKey) oracleEntry {
	o.mu.Lock()
	if entry, ok := o.cache[key]; ok && time.Now().Before(entry.expires) {
		o.mu.Unlock()
		return entry
	}
	call := o.pending[key]
	if call == nil {
		if len(o.pending) >= 8 || time.Now().Before(o.backoff) {
			o.mu.Unlock()
			return oracleEntry{status: http.StatusServiceUnavailable}
		}
		call = &oracleRequest{done: make(chan struct{})}
		o.pending[key] = call
		go o.lookup(key, call)
	}
	o.mu.Unlock()
	select {
	case <-call.done:
		return call.result
	case <-ctx.Done():
		return oracleEntry{status: http.StatusServiceUnavailable}
	}
}

func (o *clubOracleZH) lookup(key artKey, call *oracleRequest) {
	// Hovering away should not cancel a lookup shared with another spectator.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	card, status := o.fetch(ctx, key)
	o.mu.Lock()
	defer o.mu.Unlock()
	call.result = oracleEntry{card: card, status: status}
	if status == http.StatusOK || status == http.StatusNotFound {
		ttl := time.Hour
		if status == http.StatusNotFound {
			ttl = 5 * time.Minute
		}
		call.result.expires = time.Now().Add(ttl)
		if len(o.cache) >= 2048 {
			clear(o.cache)
		}
		o.cache[key] = call.result
	}
	if status == http.StatusTooManyRequests {
		o.backoff = time.Now().Add(time.Minute)
	}
	delete(o.pending, key)
	close(call.done)
}

func (o *clubOracleZH) fetch(ctx context.Context, key artKey) (clubOracleCard, int) {
	const api = "https://mtgch.com/api/v1/"
	if key.set != "" {
		var printing mtgchCard
		status := o.get(ctx, api+"card/"+key.set+"/"+url.PathEscape(key.number)+"/?view=0", &printing)
		if status == http.StatusOK {
			if result, matched := mtgchMatch([]mtgchCard{printing}, key.name); matched == http.StatusOK {
				return result, matched
			}
		} else if status != http.StatusNotFound {
			return clubOracleCard{}, status
		}
	}
	// The search API accepts name="..." and returns Oracle-deduplicated cards.
	query := url.Values{
		"q": {"name=" + strconv.Quote(key.name)}, "unique": {"oracle_id"}, "view": {"0"}, "page_size": {"12"},
	}
	var matches struct {
		Items []mtgchCard `json:"items"`
	}
	if status := o.get(ctx, api+"result?"+query.Encode(), &matches); status != http.StatusOK {
		return clubOracleCard{}, status
	}
	return mtgchMatch(matches.Items, key.name)
}

func (o *clubOracleZH) get(ctx context.Context, address string, target any) int {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return http.StatusBadGateway
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "312TheGathering/1.0")
	response, err := o.client.Do(request)
	if err != nil {
		return http.StatusBadGateway
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return response.StatusCode
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target); err != nil {
		return http.StatusBadGateway
	}
	return http.StatusOK
}
