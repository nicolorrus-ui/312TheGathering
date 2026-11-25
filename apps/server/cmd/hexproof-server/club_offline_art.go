// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type offlineArtPack struct {
	Version   int `json:"version"`
	Printings map[string]struct {
		Front string            `json:"front"`
		Faces map[string]string `json:"faces"`
	} `json:"printings"`
	Names map[string]string `json:"names"`
}

var packJPEG = regexp.MustCompile(`^[0-9a-f-]{36}(-b)?\.jpg$`)

func newClubOfflineArt(files fs.FS, lookup func(string) *offlineCardInfo, artwork *clubImageCache) (http.Handler, error) {
	var pack offlineArtPack
	data, err := fs.ReadFile(files, "assets/cards/index.json")
	switch {
	case err == nil:
		if err := json.Unmarshal(data, &pack); err != nil {
			return nil, fmt.Errorf("read card image pack: %w", err)
		}
		if pack.Version != 1 || pack.Printings == nil || pack.Names == nil {
			return nil, errors.New("unsupported card image pack index")
		}
	case !errors.Is(err, fs.ErrNotExist):
		return nil, fmt.Errorf("read card image pack: %w", err)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		name := strings.TrimSpace(query.Get("name"))
		if name == "" || len(name) > 200 || !utf8.ValidString(name) || strings.ContainsFunc(name, unicode.IsControl) {
			http.Error(w, "Invalid card name", http.StatusBadRequest)
			return
		}
		set := strings.ToLower(strings.TrimSpace(query.Get("set")))
		number := strings.TrimSpace(query.Get("number"))
		if len(set) > 32 || len(number) > 64 || strings.ContainsFunc(set+number, unicode.IsControl) || !utf8.ValidString(set+number) {
			http.Error(w, "Invalid printing", http.StatusBadRequest)
			return
		}
		prefix := ""
		if query.Get("token") == "1" || query.Get("token") == "true" {
			prefix = "token:"
		}
		key := strings.ToLower(name)
		image := pack.Names[prefix+key]
		if set != "" || number != "" {
			version := pack.Printings[prefix+set+"/"+strings.ToLower(number)]
			image = version.Faces[key]
			if len(version.Faces) == 0 {
				image = version.Front
			}
		}
		if packJPEG.MatchString(image) {
			if file, err := files.Open("assets/cards/" + image); err == nil {
				data := readClubJPEG(file)
				file.Close()
				if data != nil {
					serveClubJPEG(w, r, data)
					return
				}
			}
		}
		if artwork != nil {
			id := clubImageID{artKey{key, set, strings.ToLower(number)}, prefix != ""}
			if data := artwork.image(r.Context(), id); data != nil {
				serveClubJPEG(w, r, data)
				return
			}
		}

		info := offlineCardInfo{Name: name}
		if lookup != nil {
			if match := lookup(name); match != nil {
				info = *match
			}
		}
		printing := strings.TrimSpace(strings.ToUpper(set) + " " + number)
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method != http.MethodHead {
			_ = offlineCardSVG.Execute(w, offlineCardLayout(info, printing))
		}
	}), nil
}

func serveClubJPEG(w http.ResponseWriter, r *http.Request, data []byte) {
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeContent(w, r, "card.jpg", time.Time{}, bytes.NewReader(data))
}

type artLine struct {
	Y    int
	Text string
}

type offlineFace struct {
	offlineCardInfo
	Printing                             string
	Title, Mana, Types, Rules            []artLine
	RulesTop, RulesHeight, RulesFontSize int
}

func positionArtLines(lines []string, first, step int) []artLine {
	positioned := make([]artLine, len(lines))
	for i, text := range lines {
		positioned[i] = artLine{Y: first + i*step, Text: text}
	}
	return positioned
}

func offlineCardLayout(info offlineCardInfo, printing string) offlineFace {
	face := offlineFace{offlineCardInfo: info, Printing: printing}
	face.Title = positionArtLines(truncateArtLines(wrapArtText(info.Name, 23), 3, 23), 46, 24)
	y := 47 + 24*len(face.Title)
	face.Mana = positionArtLines(truncateArtLines(wrapArtText(info.ManaCost, 32), 2, 32), y, 20)
	y += 20 * len(face.Mana)
	face.Types = positionArtLines(truncateArtLines(wrapArtText(info.TypeLine, 32), 3, 32), y, 20)
	face.RulesTop = y + 20*len(face.Types) - 6
	face.RulesHeight = 441 - face.RulesTop
	// A monospace rules font makes the line budget predictable even for mana
	// symbols. Use the largest legible size that fits all lines in the frame.
	for _, size := range []int{19, 17, 15, 14} {
		width := 292 * 10 / (size * 6)
		lineHeight := size + 4
		limit := (face.RulesHeight - 16) / lineHeight
		rules := wrapArtText(info.Oracle, width)
		if len(rules) <= limit || size == 14 {
			face.RulesFontSize = size
			face.Rules = positionArtLines(truncateArtLines(rules, limit, width), face.RulesTop+9+size, lineHeight)
			break
		}
	}
	return face
}

// Keep explicit paragraph breaks while wrapping words and unusually long names.
func wrapArtText(text string, width int) []string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if text == "" {
		return nil
	}
	var lines []string
	for _, paragraph := range strings.Split(text, "\n") {
		var line []rune
		for _, word := range strings.Fields(paragraph) {
			token := []rune(word)
			if len(line) > 0 && len(line)+1+len(token) > width {
				lines = append(lines, string(line))
				line = nil
			}
			for len(token) > width {
				cut := width
				// Keep a brace-delimited mana symbol together at a line break.
				for i := cut - 1; i > 0 && token[i] != '}'; i-- {
					if token[i] == '{' {
						cut = i
						break
					}
				}
				lines = append(lines, string(token[:cut]))
				token = token[cut:]
			}
			if len(line) > 0 {
				line = append(line, ' ')
			}
			line = append(line, token...)
		}
		lines = append(lines, string(line))
	}
	return lines
}

func truncateArtLines(lines []string, maxLines, width int) []string {
	if len(lines) > maxLines {
		lines = lines[:maxLines]
		last := []rune(lines[maxLines-1])
		if len(last) == width {
			last = last[:width-1]
		}
		lines[maxLines-1] = string(last) + "…"
	}
	return lines
}

var offlineCardSVG = template.Must(template.New("offline-card").Parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 500" width="360" height="500">
<title>{{.Name}}</title><desc>{{.Oracle}}</desc>
<rect width="360" height="500" rx="20" fill="#151c18"/>
<rect x="9" y="9" width="342" height="482" rx="14" fill="#233229" stroke="#7d956f" stroke-width="2"/>
<text fill="#eff2e6" font-family="Georgia,serif" font-size="22" font-weight="bold">{{range .Title}}<tspan x="25" y="{{.Y}}">{{.Text}}</tspan>{{end}}</text>
<text fill="#e7ce95" font-family="monospace" font-size="16">{{range .Mana}}<tspan x="25" y="{{.Y}}">{{.Text}}</tspan>{{end}}</text>
<text fill="#d2dfd1" font-family="sans-serif" font-size="17">{{range .Types}}<tspan x="25" y="{{.Y}}">{{.Text}}</tspan>{{end}}</text>
<rect x="23" y="{{.RulesTop}}" width="314" height="{{.RulesHeight}}" rx="6" fill="#19271f" stroke="#546d58"/>
<text fill="#f1f2e8" font-family="monospace" font-size="{{.RulesFontSize}}">{{range .Rules}}<tspan x="34" y="{{.Y}}">{{.Text}}</tspan>{{end}}</text>
<text x="25" y="472" fill="#b1beaf" font-family="monospace" font-size="14">{{.Printing}}</text>
{{if and .Power .Toughness}}<text x="334" y="473" text-anchor="end" fill="#f3dcac" font-family="Georgia,serif" font-size="24" font-weight="bold">{{.Power}}/{{.Toughness}}</text>{{end}}
</svg>`))
