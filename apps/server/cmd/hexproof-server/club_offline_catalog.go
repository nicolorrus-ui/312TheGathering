// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"slices"
	"strings"
)

const offlineCatalogPath = "assets/offline-cards.json"
const offlinePageSize = 75

type offlinePrinting struct {
	SetCode         string `json:"setCode"`
	CollectorNumber string `json:"collectorNumber"`
}

type offlineCardInfo struct {
	Name      string `json:"name"`
	ManaCost  string `json:"manaCost"`
	TypeLine  string `json:"typeLine"`
	Oracle    string `json:"oracle"`
	Power     string `json:"power,omitempty"`
	Toughness string `json:"toughness,omitempty"`
}

type offlineCard struct {
	offlineCardInfo
	Printings []offlinePrinting `json:"printings"`
	Faces     []offlineCardInfo `json:"faces,omitempty"`
	key       string
}

type offlineCatalog struct {
	Version int               `json:"version"`
	Sets    map[string]string `json:"sets"`
	Cards   []offlineCard     `json:"cards"`

	byName map[string]*offlineCard
	faces  map[string]*offlineCardInfo
}

func registerClubCardRoutes(mux *http.ServeMux, files fs.FS, offline bool, artwork *clubImageCache) error {
	if !offline {
		cards := newClubCardArt()
		mux.Handle("GET /card-search", clubSearchFunc(cards.search))
		mux.Handle("GET /card-art", cards)
		return nil
	}
	catalog, err := loadOfflineCatalog(files)
	if err != nil {
		return err
	}
	art, err := newClubOfflineArt(files, catalog.cardInfo, artwork)
	if err != nil {
		return err
	}
	mux.Handle("GET /card-search", clubSearchFunc(catalog.search))
	mux.Handle("GET /card-art", art)
	return nil
}

func loadOfflineCatalog(files fs.FS) (*offlineCatalog, error) {
	file, err := files.Open(offlineCatalogPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var catalog offlineCatalog
	if err := json.NewDecoder(file).Decode(&catalog); err != nil {
		return nil, fmt.Errorf("%s: %w", offlineCatalogPath, err)
	}
	if catalog.Version != 1 || len(catalog.Cards) == 0 {
		return nil, fmt.Errorf("%s: expected a non-empty version 1 catalog", offlineCatalogPath)
	}
	for i := range catalog.Cards {
		card := &catalog.Cards[i]
		card.key = strings.ToLower(card.Name)
		if strings.TrimSpace(card.key) == "" {
			return nil, fmt.Errorf("%s: missing card name at index %d", offlineCatalogPath, i)
		}
	}
	slices.SortFunc(catalog.Cards, func(a, b offlineCard) int { return strings.Compare(a.key, b.key) })
	catalog.byName = make(map[string]*offlineCard, len(catalog.Cards))
	catalog.faces = make(map[string]*offlineCardInfo)
	for i := range catalog.Cards {
		card := &catalog.Cards[i]
		catalog.byName[card.key] = card
		for j := range card.Faces {
			face := &card.Faces[j]
			catalog.faces[strings.ToLower(face.Name)] = face
		}
		// An imported list can use just the front face of a double-faced card.
		if front, _, multi := strings.Cut(card.key, " // "); multi && catalog.byName[front] == nil {
			catalog.byName[front] = card
		}
	}
	return &catalog, nil
}

func (c *offlineCatalog) cardInfo(name string) *offlineCardInfo {
	key := strings.ToLower(name)
	card := c.byName[key]
	if card != nil && card.key == key {
		return &card.offlineCardInfo
	}
	if face := c.faces[key]; face != nil {
		return face
	}
	if card != nil {
		return &card.offlineCardInfo
	}
	return nil
}

func (c *offlineCatalog) printing(card *offlineCard, index int) cardSearchPrinting {
	result := cardSearchPrinting{Name: card.Name}
	if len(card.Printings) > 0 {
		printing := card.Printings[index]
		result.SetCode = printing.SetCode
		result.CollectorNumber = printing.CollectorNumber
		result.SetName = c.Sets[printing.SetCode]
	}
	return result
}

func (c *offlineCatalog) search(_ context.Context, text string, exact bool, page int) (cardSearchPage, bool) {
	key := strings.ToLower(text)
	skip := (page - 1) * offlinePageSize
	result := cardSearchPage{Cards: []cardSearchPrinting{}}
	if exact {
		card := c.byName[key]
		if card == nil {
			return result, true
		}
		end := min(skip+offlinePageSize, len(card.Printings))
		for i := skip; i < end; i++ {
			result.Cards = append(result.Cards, c.printing(card, i))
		}
		result.HasMore = end < len(card.Printings)
		return result, true
	}
	for i := range c.Cards {
		card := &c.Cards[i]
		if !strings.Contains(card.key, key) {
			continue
		}
		if skip > 0 {
			skip--
			continue
		}
		if len(result.Cards) == offlinePageSize {
			result.HasMore = true
			break
		}
		result.Cards = append(result.Cards, c.printing(card, 0))
	}
	return result, true
}
