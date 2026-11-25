// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

const cardArtSpacing = 150 * time.Millisecond

var (
	cardArtSet    = regexp.MustCompile(`^[a-z0-9]{2,12}$`)
	cardArtNumber = regexp.MustCompile(`^[[:alnum:]★†*.-]{1,24}$`)
)

type artKey struct{ name, set, number string }
type artURLs struct {
	Small  string `json:"small"`
	Normal string `json:"normal"`
}
type artEntry struct {
	urls    artURLs
	expires time.Time
}
type artLookup struct {
	done chan struct{}
	urls artURLs
}
type clubCardArt struct {
	client   *http.Client
	mu       sync.Mutex
	cache    map[artKey]artEntry
	pending  map[artKey]*artLookup
	searches map[string]cardSearchEntry
	next     time.Time
	cooldown time.Time
}

func newClubCardArt() *clubCardArt {
	return &clubCardArt{
		client: &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}},
		cache: make(map[artKey]artEntry), pending: make(map[artKey]*artLookup),
		searches: make(map[string]cardSearchEntry),
	}
}

func (a *clubCardArt) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	name := strings.ToLower(strings.TrimSpace(query.Get("name")))
	if name == "" || len(name) > 200 || strings.ContainsFunc(name, unicode.IsControl) {
		http.Error(w, "Invalid card name", http.StatusBadRequest)
		return
	}
	set, number := query.Get("set"), query.Get("number")
	if !cardArtSet.MatchString(set) || !cardArtNumber.MatchString(number) {
		set, number = "", ""
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	urls := a.resolve(ctx, artKey{name, set, number})
	image := urls.Normal
	if query.Get("size") == "small" && urls.Small != "" {
		image = urls.Small
	}
	if image == "" {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, image, http.StatusFound)
}

func (a *clubCardArt) resolve(ctx context.Context, key artKey) artURLs {
	a.mu.Lock()
	if hit, ok := a.cache[key]; ok && time.Now().Before(hit.expires) {
		a.mu.Unlock()
		return hit.urls
	}
	if call := a.pending[key]; call != nil {
		a.mu.Unlock()
		select {
		case <-call.done:
			return call.urls
		case <-ctx.Done():
			return artURLs{}
		}
	}
	if len(a.pending) >= 40 || time.Now().Before(a.cooldown) {
		a.mu.Unlock()
		return artURLs{}
	}
	call := &artLookup{done: make(chan struct{})}
	a.pending[key] = call
	a.mu.Unlock()

	lookup := "https://api.scryfall.com/cards/named?" + url.Values{"exact": {key.name}}.Encode()
	address := lookup
	if key.set != "" {
		address = "https://api.scryfall.com/cards/" + key.set + "/" + url.PathEscape(key.number)
	}
	images, status := a.fetch(ctx, address, key.name)
	if status == http.StatusNotFound && address != lookup {
		images, status = a.fetch(ctx, lookup, key.name)
	}
	a.mu.Lock()
	call.urls = images
	delete(a.pending, key)
	if images.Normal != "" || status == http.StatusNotFound {
		if len(a.cache) >= 1024 {
			clear(a.cache)
		}
		ttl := 24 * time.Hour
		if images.Normal == "" {
			ttl = 10 * time.Minute
		}
		a.cache[key] = artEntry{images, time.Now().Add(ttl)}
	}
	close(call.done)
	a.mu.Unlock()
	return images
}

func (a *clubCardArt) requestJSON(ctx context.Context, address string, limit int64, data any) int {
	a.mu.Lock()
	now := time.Now()
	if now.Before(a.cooldown) || a.next.Sub(now) > 6*time.Second {
		a.mu.Unlock()
		return 0
	}
	wait := max(a.next.Sub(now), 0)
	a.next = now.Add(wait + cardArtSpacing)
	a.mu.Unlock()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return 0
	}
	a.mu.Lock()
	cooling := time.Now().Before(a.cooldown)
	a.mu.Unlock()
	if cooling {
		return 0
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return 0
	}
	request.Header.Set("User-Agent", "Hexproof-Club-CardArt/1.0")
	request.Header.Set("Accept", "application/json")
	response, err := a.client.Do(request)
	if err != nil {
		return 0
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		a.mu.Lock()
		a.cooldown = time.Now().Add(time.Minute)
		a.mu.Unlock()
	}
	if response.StatusCode != http.StatusOK {
		return response.StatusCode
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, limit)).Decode(data); err != nil {
		return 0
	}
	return http.StatusOK
}

type scryfallCard struct {
	Name            string  `json:"name"`
	Set             string  `json:"set"`
	SetName         string  `json:"set_name"`
	CollectorNumber string  `json:"collector_number"`
	Images          artURLs `json:"image_uris"`
	Faces           []struct {
		Name   string  `json:"name"`
		Images artURLs `json:"image_uris"`
	} `json:"card_faces"`
}

func (a *clubCardArt) fetch(ctx context.Context, address, face string) (artURLs, int) {
	var card scryfallCard
	status := a.requestJSON(ctx, address, 128<<10, &card)
	if status != http.StatusOK {
		return artURLs{}, status
	}
	return card.images(face), status
}

func (card *scryfallCard) images(face string) artURLs {
	images := card.Images
	if images.Normal == "" && len(card.Faces) != 0 {
		images = card.Faces[0].Images
		for _, candidate := range card.Faces {
			if strings.EqualFold(candidate.Name, face) {
				images = candidate.Images
				break
			}
		}
	}
	return artURLs{Small: scryfallImageURL(images.Small), Normal: scryfallImageURL(images.Normal)}
}

func scryfallImageURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "cards.scryfall.io" || parsed.User != nil {
		return ""
	}
	return parsed.String()
}
