// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"bytes"
	"encoding/xml"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func offlineTestJPEG(t *testing.T, shade uint8) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 2, 3))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.Gray{Y: shade}), image.Point{}, draw.Src)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestOfflineArtHonorsRequestedPrinting(t *testing.T) {
	const front = "004c709b-d53d-4691-bbc8-2438fb8847e0.jpg"
	const back = "004c709b-d53d-4691-bbc8-2438fb8847e0-b.jpg"
	const other = "de75a2a6-9b0f-4b23-b400-9ea0d4d18310.jpg"
	const index = `{"version":1,"printings":{"neo/266":{"front":"` + front + `","faces":{"vessel":"` + back + `"}}},"names":{"vessel":"` + other + `"}}`
	files := fstest.MapFS{
		"assets/cards/index.json": {Data: []byte(index)},
		"assets/cards/" + front:   {Data: offlineTestJPEG(t, 60)},
		"assets/cards/" + back:    {Data: offlineTestJPEG(t, 120)},
		"assets/cards/" + other:   {Data: offlineTestJPEG(t, 200)},
	}
	art, err := newClubOfflineArt(files, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ query, image string }{
		{"name=Vessel&set=NEO&number=266", back},
		{"name=Front&set=NEO&number=266", front},
		{"name=Vessel", other},
	} {
		w := httptest.NewRecorder()
		art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?"+tc.query, nil))
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" ||
			!bytes.Equal(w.Body.Bytes(), files["assets/cards/"+tc.image].Data) {
			t.Fatalf("%s: expected JPEG %s, got %d %s", tc.query, tc.image, w.Code, w.Header().Get("Content-Type"))
		}
	}
	delete(files, "assets/cards/"+front)
	delete(files, "assets/cards/"+back)
	w := httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=Vessel&set=NEO&number=266", nil))
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "image/svg+xml") || !strings.Contains(w.Body.String(), "NEO 266") {
		t.Fatal("missing exact printing should show a text card with the requested printing")
	}
	w = httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=Vessel&set=OTH&number="+url.QueryEscape("9∞"), nil))
	if !strings.HasPrefix(w.Header().Get("Content-Type"), "image/svg+xml") || !strings.Contains(w.Body.String(), "OTH 9∞") {
		t.Fatal("explicit collector number with special characters incorrectly matched the name-only image")
	}
	files["assets/cards/"+other] = &fstest.MapFile{Data: []byte("truncated JPEG")}
	w = httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=Vessel", nil))
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "image/svg+xml") || w.Header().Get("Location") != "" {
		t.Fatalf("unreadable image should give SVG, got %d %v", w.Code, w.Header())
	}
}

func TestOfflineArtWithoutPackRendersEscapedMetadata(t *testing.T) {
	const title = "Fire & Ice <Test>"
	const typeLine = "Artifact Creature — Golem"
	const oracle = "Flying\n{T}: Add {U/R}.\nDraw <two> & discard one."
	art, err := newClubOfflineArt(fstest.MapFS{}, func(name string) *offlineCardInfo {
		if name != "fire & ice" {
			t.Fatalf("unexpected lookup %q", name)
		}
		return &offlineCardInfo{Name: title, ManaCost: "{2}{U/R}", TypeLine: typeLine, Oracle: oracle, Power: "*", Toughness: "1+*"}
	})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=fire+%26+ice&set=APC&number=128", nil))
	var svg struct {
		XMLName xml.Name `xml:"svg"`
		Title   string   `xml:"title"`
		Desc    string   `xml:"desc"`
	}
	if err := xml.Unmarshal(w.Body.Bytes(), &svg); err != nil || svg.Title != title || svg.Desc != oracle {
		t.Fatalf("invalid placeholder SVG, title %q, error %v", svg.Title, err)
	}
	for _, want := range []string{"Fire &amp; Ice &lt;Test&gt;", typeLine, "{2}{U/R}", "APC 128", "Flying</tspan>", "{T}: Add {U/R}.</tspan>", "Draw &lt;two&gt; &amp; discard one.</tspan>", "*/1&#43;*"} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("placeholder lacks %q", want)
		}
	}

	art, err = newClubOfflineArt(fstest.MapFS{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name="+url.QueryEscape("<unknown>"), nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "&lt;unknown&gt;") {
		t.Fatalf("unknown card has no escaped fallback name: %s", w.Body)
	}
	w = httptest.NewRecorder()
	art.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=%00", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid name status %d", w.Code)
	}
}

func TestOfflineArtRejectsMalformedManifest(t *testing.T) {
	for _, content := range []string{`{`, `{"version":2}`, `{}`} {
		files := fstest.MapFS{"assets/cards/index.json": {Data: []byte(content)}}
		if _, err := newClubOfflineArt(files, nil); err == nil {
			t.Fatalf("accepted %s", content)
		}
	}
}

func TestOfflineArtFitsRulesAndKeepsParagraphs(t *testing.T) {
	symbols := wrapArtText("{W}{U}{B}{R}{G}", 8)
	if strings.Join(symbols, " ") != "{W}{U} {B}{R} {G}" {
		t.Fatalf("split mana symbol: %v", symbols)
	}
	info := offlineCardInfo{Name: "Test", TypeLine: "Creature", Oracle: "First ability.\n\n{W}{U}: Draw a card."}
	face := offlineCardLayout(info, "")
	if len(face.Rules) != 3 || face.Rules[1].Text != "" || face.Rules[2].Text != "{W}{U}: Draw a card." {
		t.Fatalf("paragraphs were lost: %+v", face.Rules)
	}
	initialSize := face.RulesFontSize
	info.Oracle = strings.Repeat("Draw a card. ", 100)
	face = offlineCardLayout(info, "")
	last := face.Rules[len(face.Rules)-1]
	if face.RulesFontSize >= initialSize || !strings.HasSuffix(last.Text, "…") || last.Y >= face.RulesTop+face.RulesHeight {
		t.Fatalf("long Oracle text should fit the frame and show truncation: %+v", face)
	}
}
