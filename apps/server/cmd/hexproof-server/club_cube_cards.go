// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"hexproof/server/internal/protocol"
)

type cubeEntry struct {
	Name string `json:"name"`
	offlinePrinting
	Count int `json:"count"`
}

type cubeCard struct {
	cubeEntry
	TypeLine      string   `json:"typeLine"`
	ManaCost      string   `json:"manaCost"`
	Colors        []string `json:"colors"`
	ColorCategory string   `json:"colorCategory"`
	Rarity        string   `json:"rarity,omitempty"`
}

type cubeList struct {
	Slug      string     `json:"slug"`
	Name      string     `json:"name"`
	UpdatedAt time.Time  `json:"updatedAt"`
	Cards     []cubeCard `json:"cards"`
}

const cubeLimit = 10000

var cubeColors = []string{"W", "U", "B", "R", "G"}
var cubeColorNames = map[string]string{"W": "White", "U": "Blue", "B": "Black", "R": "Red", "G": "Green"}
var basicLandTypes = []string{"Plains", "Island", "Swamp", "Mountain", "Forest"}

func cubePrinting(catalog *offlineCatalog, entry cubeEntry, allowAlternate bool) (*offlineCard, offlinePrinting, error) {
	card := catalog.byName[strings.ToLower(strings.TrimSpace(entry.Name))]
	if card == nil || len(card.Printings) == 0 {
		return nil, offlinePrinting{}, fmt.Errorf("%q has no playable printing in this Forge catalog", entry.Name)
	}
	set := strings.ToUpper(strings.TrimSpace(entry.SetCode))
	number := strings.TrimSpace(entry.CollectorNumber)
	if set == "" && number == "" {
		return card, card.Printings[0], nil
	}
	for _, candidate := range []string{set, catalog.SetAliases[set]} {
		if candidate == "" {
			continue
		}
		for _, p := range card.Printings {
			if p.SetCode == candidate && (number == "" || strings.EqualFold(number, p.CollectorNumber)) {
				return card, p, nil
			}
		}
	}
	if allowAlternate && set != "" {
		// New art can reach Cube Cobra before the bundled rules catalog.
		// Keep the card in the draft using a printing known to this Forge.
		return card, card.Printings[0], nil
	}
	return nil, offlinePrinting{}, fmt.Errorf("%q (%s %s) is not a printing in this Forge catalog", entry.Name, set, number)
}

func displayCubeCard(card *offlineCard, printing offlinePrinting, count int) cubeCard {
	row := cubeCard{cubeEntry: cubeEntry{Name: card.Name, offlinePrinting: printing, Count: count},
		TypeLine: card.TypeLine, ManaCost: card.ManaCost, Colors: []string{}}
	land := slices.Contains(strings.Fields(card.TypeLine), "Land")
	for i, color := range cubeColors {
		inCost := strings.Contains(card.ManaCost, color)
		if card.Colors != nil {
			inCost = slices.Contains(card.Colors, color)
		}
		if land {
			inCost = inCost || strings.Contains(card.TypeLine, basicLandTypes[i]) ||
				strings.Contains(card.Oracle, basicLandTypes[i]) || strings.Contains(card.Oracle, "{"+color+"}")
		}
		if inCost {
			row.Colors = append(row.Colors, color)
		}
	}
	switch {
	case land:
		row.ColorCategory = "Lands"
	case len(row.Colors) == 0:
		row.ColorCategory = "Colorless"
	case len(row.Colors) == 1:
		row.ColorCategory = cubeColorNames[row.Colors[0]]
	default:
		row.ColorCategory = "Multicolored"
		allHybrid := true
		hybrid := false
		for _, symbol := range strings.Fields(row.ManaCost) {
			colors := 0
			for _, c := range cubeColors {
				if strings.Contains(symbol, c) {
					colors++
				}
			}
			if colors == 1 {
				allHybrid = false
			}
			hybrid = hybrid || colors > 1
		}
		if allHybrid && hybrid {
			row.ColorCategory = "Hybrid"
		}
	}
	return row
}

type cubeCobraRow struct {
	Colors        []string `json:"colors"`
	ColorCategory string   `json:"colorCategory"`
	TypeLine      string   `json:"type_line"`
	Details       struct {
		Name     string   `json:"name"`
		Set      string   `json:"set"`
		Number   string   `json:"collector_number"`
		Colors   []string `json:"color_identity"`
		Category string   `json:"colorcategory"`
		Type     string   `json:"type"`
		Rarity   string   `json:"rarity"`
	} `json:"details"`
}

func readCubeCobra(data io.Reader, slug string, catalog *offlineCatalog) (cubeList, error) {
	var source struct {
		Name      string `json:"name"`
		CardCount int    `json:"cardCount"`
		Updated   int64  `json:"dateLastUpdated"`
		Cards     struct {
			Main []cubeCobraRow `json:"mainboard"`
		} `json:"cards"`
	}
	if err := json.NewDecoder(data).Decode(&source); err != nil {
		return cubeList{}, errors.New("Cube Cobra returned unreadable card data")
	}
	if name := strings.TrimSpace(source.Name); name == "" || len([]rune(name)) > 128 || source.Updated <= 0 ||
		len(source.Cards.Main) == 0 || len(source.Cards.Main) > cubeLimit || len(source.Cards.Main) != source.CardCount {
		return cubeList{}, errors.New("Cube Cobra returned an incomplete mainboard")
	}
	cube := cubeList{Slug: slug, Name: strings.TrimSpace(source.Name), UpdatedAt: time.UnixMilli(source.Updated).UTC()}
	for _, raw := range source.Cards.Main {
		d := raw.Details
		if d.Name == "" || d.Set == "" || d.Number == "" {
			return cubeList{}, errors.New("Cube Cobra returned a mainboard entry without a printing")
		}
		entry := cubeEntry{Name: d.Name, offlinePrinting: offlinePrinting{strings.ToUpper(d.Set), d.Number}, Count: 1}
		card, printing, err := cubePrinting(catalog, entry, true)
		if err != nil {
			return cubeList{}, err
		}
		row := displayCubeCard(card, printing, 1)
		if raw.TypeLine != "" {
			row.TypeLine = raw.TypeLine
		} else if d.Type != "" {
			row.TypeLine = d.Type
		}
		colors := raw.Colors
		if colors == nil {
			colors = d.Colors
		}
		if colors != nil {
			row.Colors = []string{}
			for _, color := range cubeColors {
				if slices.Contains(colors, color) {
					row.Colors = append(row.Colors, color)
				}
			}
		}
		category := raw.ColorCategory
		if category == "" {
			category = d.Category
		}
		switch category {
		case "White", "Blue", "Black", "Red", "Green", "Hybrid", "Multicolored", "Colorless", "Lands":
			row.ColorCategory = category
		}
		row.Rarity = d.Rarity
		// The JSON mainboard is already expanded to individual physical cards.
		// Some rows also carry a copy-group quantity, e.g. 100 for Ornithopter.
		cube.Cards = append(cube.Cards, row)
	}
	cube.Cards = aggregateCube(cube.Cards)
	return cube, nil
}

func aggregateCube(rows []cubeCard) []cubeCard {
	type key struct {
		name                  string
		printing              offlinePrinting
		colors, category, typ string
	}
	positions := make(map[key]int, len(rows))
	result := make([]cubeCard, 0, len(rows))
	for _, r := range rows {
		id := key{r.Name, r.offlinePrinting, strings.Join(r.Colors, ""), r.ColorCategory, r.TypeLine}
		if index, ok := positions[id]; ok {
			result[index].Count += r.Count
			continue
		}
		positions[id] = len(result)
		result = append(result, r)
	}
	return result
}

func resolveCubeEntries(entries []cubeEntry, catalog *offlineCatalog) ([]cubeCard, error) {
	if len(entries) == 0 || len(entries) > 5000 {
		return nil, errors.New("Import between 1 and 5,000 card entries")
	}
	rows := make([]cubeCard, 0, len(entries))
	total := 0
	for _, e := range entries {
		if e.Count < 1 || e.Count > cubeLimit-total {
			return nil, errors.New("Each quantity must be positive and the cube may contain at most 10,000 cards")
		}
		if len([]rune(e.Name)) > protocol.MaxCardNameRunes || len([]rune(e.SetCode)) > protocol.MaxSetCodeRunes ||
			len([]rune(e.CollectorNumber)) > protocol.MaxCollectorNumberRunes {
			return nil, errors.New("Invalid card name or printing")
		}
		card, printing, err := cubePrinting(catalog, e, false)
		if err != nil {
			return nil, err
		}
		total += e.Count
		rows = append(rows, displayCubeCard(card, printing, e.Count))
	}
	return aggregateCube(rows), nil
}
