// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

const testFaces = `{"name":"Front // Back","set":"neo","collector_number":"9∞","layout":"transform","card_faces":[
	{"name":"Front","image_uris":{"normal":"https://cards.scryfall.io/normal/front.jpg"}},
	{"name":"Back","image_uris":{"normal":"https://cards.scryfall.io/normal/back.jpg"}}]}`

func TestClubImageCacheImportedPackHasPriority(t *testing.T) {
	cache := newClubImageCache(t.TempDir())
	id := clubImageID{artKey{"bolt", "m11", "149"}, false}
	if err := storeClubFile(cache.path(id), offlineTestJPEG(t, 30)); err != nil {
		t.Fatal(err)
	}
	const file = "004c709b-d53d-4691-bbc8-2438fb8847e0.jpg"
	packed := offlineTestJPEG(t, 200)
	files := fstest.MapFS{
		"assets/cards/index.json": {Data: []byte(`{"version":1,"names":{},"printings":{"m11/149":{"front":"` + file + `","faces":{"bolt":"` + file + `"}}}}`)},
		"assets/cards/" + file:    {Data: packed},
	}
	cache.source.client.Transport = cardArtTransport(func(*http.Request) (*http.Response, error) {
		t.Error("imported art triggered a network request")
		return &http.Response{StatusCode: 404, Body: http.NoBody}, nil
	})
	handler, err := newClubOfflineArt(files, nil, cache)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/card-art?name=Bolt&set=M11&number=149", nil))
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), packed) {
		t.Fatal("imported art did not override the downloaded image")
	}
}

func TestClubImageCacheExactFaceSharedAcrossSizesAndRestarts(t *testing.T) {
	cache := newClubImageCache(t.TempDir())
	portrait := offlineTestJPEG(t, 100)
	blocked := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	cache.source.client.Transport = cardArtTransport(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		if req.Header.Get("Cookie") != "" || req.Header.Get("Referer") != "" {
			t.Error("forwarded a browser header")
		}
		switch req.URL.String() {
		case "https://api.scryfall.com/cards/neo/9%E2%88%9E":
			close(blocked)
			<-release
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(testFaces))}, nil
		case "https://cards.scryfall.io/normal/back.jpg":
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(portrait))}, nil
		default:
			t.Errorf("unexpected Scryfall request %s", req.URL)
			return &http.Response{StatusCode: 404, Body: http.NoBody}, nil
		}
	})
	id := clubImageID{artKey{"back", "neo", "9∞"}, false}
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan []byte)
	go func() { first <- cache.image(ctx, id) }()
	<-blocked
	cancel()
	if result := <-first; result != nil {
		t.Fatal("cancelled caller received a result")
	}

	art, err := newClubOfflineArt(fstest.MapFS{}, nil, cache)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	check := func(size string) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/card-art?name=Back&set=NEO&number="+url.QueryEscape("9∞")+"&size="+size, nil)
		req.Header.Set("Cookie", "club-session=private")
		req.Header.Set("Referer", "http://localhost/#private")
		art.ServeHTTP(w, req)
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" || !bytes.Equal(w.Body.Bytes(), portrait) {
			t.Errorf("did not serve exact back JPEG at size %s", size)
		}
	}
	for _, size := range []string{"normal", "small", "small"} {
		wg.Add(1)
		go func() { defer wg.Done(); check(size) }()
	}
	close(release)
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatalf("got %d upstream requests, want one metadata and one image", calls.Load())
	}
	fresh := newClubImageCache(cache.directory)
	fresh.source.client.Transport = cardArtTransport(func(*http.Request) (*http.Response, error) {
		t.Error("contacted Scryfall after restart")
		return &http.Response{StatusCode: 404, Body: http.NoBody}, nil
	})
	if !bytes.Equal(fresh.image(context.Background(), id), portrait) {
		t.Fatal("cached image unavailable with network off")
	}
}

func TestClubImageCacheNeverSubstitutesAnotherPrintingOrFace(t *testing.T) {
	for _, tc := range []struct {
		name     string
		id       clubImageID
		metadata string
		status   int
	}{
		{"missing printing", clubImageID{artKey{"front", "neo", "99"}, false}, "", 404},
		{"wrong issue", clubImageID{artKey{"front", "neo", "10"}, false}, testFaces, 200},
		{"unknown face", clubImageID{artKey{"other", "neo", "9∞"}, false}, testFaces, 200},
		{"token namespace", clubImageID{artKey{"front", "neo", "9∞"}, true}, testFaces, 200},
		{"untrusted image", clubImageID{artKey{"back", "neo", "9∞"}, false}, strings.ReplaceAll(testFaces, "cards.scryfall.io", "other.example"), 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cache := newClubImageCache(t.TempDir())
			var calls atomic.Int32
			cache.source.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if r.URL.Host != "api.scryfall.com" || strings.Contains(r.URL.Path, "named") {
					t.Errorf("unexpected alternate lookup %s", r.URL)
				}
				return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.metadata))}, nil
			})
			if cache.image(context.Background(), tc.id) != nil || calls.Load() != 1 {
				t.Fatalf("wrong art or unexpected number of calls %d", calls.Load())
			}
		})
	}
}

func TestClubImageCacheRepairsDamagedJPEGAndRetries(t *testing.T) {
	cache := newClubImageCache(t.TempDir())
	id := clubImageID{artKey{"front", "neo", "9∞"}, false}
	portrait := offlineTestJPEG(t, 180)
	if err := storeClubFile(cache.path(id), []byte("corrupt file")); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	cache.source.client.Transport = cardArtTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.scryfall.com" {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(testFaces))}, nil
		}
		if r.URL.Path != "/normal/front.jpg" {
			t.Errorf("wrong face %s", r.URL)
		}
		hit := hits.Add(1)
		data := portrait
		if hit == 1 {
			data = portrait[:len(portrait)-3]
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data))}, nil
	})
	if cache.image(context.Background(), id) != nil {
		t.Fatal("accepted truncated upstream image")
	}
	if data, _ := os.ReadFile(cache.path(id)); string(data) != "corrupt file" {
		t.Fatal("published a partial download")
	}
	cache.mu.Lock()
	cache.retryAfter[id] = time.Now().Add(-time.Second)
	cache.mu.Unlock()
	both := clubImageID{artKey{"front // back", "neo", "9∞"}, false}
	if !bytes.Equal(cache.image(context.Background(), both), portrait) {
		t.Fatal("did not recover after transient error")
	}
	if !bytes.Equal(cache.image(context.Background(), id), portrait) || hits.Load() != 2 {
		t.Fatal("front and composite did not reuse the repaired cache")
	}
}
