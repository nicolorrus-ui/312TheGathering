// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"image/jpeg"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const maxClubJPEG = 2 << 20

type clubImageID struct {
	artKey
	token bool
}

type clubImageDownload struct {
	done chan struct{}
	jpeg []byte
}

type clubImageCache struct {
	directory  string
	source     *clubCardArt
	mu         sync.Mutex
	pending    map[clubImageID]*clubImageDownload
	retryAfter map[clubImageID]time.Time
}

func newClubImageCache(directory string) *clubImageCache {
	return &clubImageCache{directory: directory, source: newClubCardArt(),
		pending: make(map[clubImageID]*clubImageDownload), retryAfter: make(map[clubImageID]time.Time)}
}

func (c *clubImageCache) path(id clubImageID) string {
	identity := fmt.Sprintf("%t\x00%s\x00%s\x00%s", id.token, id.name, id.set, id.number)
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(identity)))
	return filepath.Join(c.directory, digest[:2], digest+".jpg")
}

func readClubJPEG(reader io.Reader) []byte {
	data, err := io.ReadAll(io.LimitReader(reader, maxClubJPEG+1))
	if err != nil || len(data) > maxClubJPEG || !bytes.HasSuffix(data, []byte{0xff, 0xd9}) {
		return nil
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || int64(cfg.Width)*int64(cfg.Height) > 4_000_000 {
		return nil
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return nil
	}
	return data
}

func cachedClubJPEG(path string) []byte {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	return readClubJPEG(file)
}

func (c *clubImageCache) image(ctx context.Context, id clubImageID) []byte {
	// Scryfall displays the front for a combined card name. Share that exact printing
	// with Forge's front-face request while keeping the reverse face independent.
	if id.set != "" && id.number != "" {
		id.name, _, _ = strings.Cut(id.name, " // ")
	}
	path := c.path(id)
	if data := cachedClubJPEG(path); data != nil {
		return data
	}
	c.mu.Lock()
	call := c.pending[id]
	if call == nil {
		if len(c.pending) >= 40 || time.Now().Before(c.retryAfter[id]) {
			c.mu.Unlock()
			return nil
		}
		call = &clubImageDownload{done: make(chan struct{})}
		c.pending[id] = call
		go c.download(id, path, call)
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil
	case <-call.done:
		return call.jpeg
	}
}

func (c *clubImageCache) download(id clubImageID, path string, call *clubImageDownload) {
	// A cancelled thumbnail request should not cancel the preview or another tab's download.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	// A previous request may have published its image since this caller's disk lookup.
	image := cachedClubJPEG(path)
	status := http.StatusOK
	if image == nil {
		image, status = c.fetch(ctx, id)
		if image != nil {
			if err := storeClubJPEG(path, image); err != nil {
				log.Printf("Club artwork cache: %v", err)
				image = nil
			}
		}
	}
	c.mu.Lock()
	if image == nil {
		delay := 3 * time.Second
		if status == http.StatusNotFound {
			delay = 5 * time.Minute
		}
		if len(c.retryAfter) >= 1024 {
			clear(c.retryAfter)
		}
		c.retryAfter[id] = time.Now().Add(delay)
	} else {
		delete(c.retryAfter, id)
	}
	call.jpeg = image
	delete(c.pending, id)
	close(call.done)
	c.mu.Unlock()
}

func storeClubJPEG(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".card-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if closeErr := tmp.Close(); err != nil {
		return err
	} else if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), path)
}

func (c *clubImageCache) fetch(ctx context.Context, id clubImageID) ([]byte, int) {
	params := url.Values{"exact": {id.name}}
	if id.set != "" {
		if !cardArtSet.MatchString(id.set) {
			return nil, http.StatusNotFound
		}
		params.Set("set", id.set)
	}
	address := "https://api.scryfall.com/cards/named?" + params.Encode()
	if id.number != "" {
		// Collector numbers may include Unicode. Never interpret them as a URL path.
		if id.set == "" || id.number == "." || id.number == ".." || strings.ContainsAny(id.number, "/\\") {
			return nil, http.StatusNotFound
		}
		address = "https://api.scryfall.com/cards/" + id.set + "/" + url.PathEscape(id.number)
	}
	var card scryfallCard
	status := c.source.requestJSON(ctx, address, 128<<10, &card)
	if status != http.StatusOK {
		return nil, status
	}
	token := card.Layout == "token" || card.Layout == "double_faced_token" || card.Layout == "emblem"
	if token != id.token || (id.set != "" && !strings.EqualFold(card.Set, id.set)) ||
		(id.number != "" && !strings.EqualFold(card.CollectorNumber, id.number)) {
		return nil, http.StatusNotFound
	}
	matches := func(name, printed, flavor string) bool {
		return strings.EqualFold(name, id.name) || strings.EqualFold(printed, id.name) || strings.EqualFold(flavor, id.name)
	}
	face := ""
	if matches(card.Name, card.PrintedName, card.FlavorName) {
		face = card.Name
	} else {
		for _, part := range card.Faces {
			if matches(part.Name, part.PrintedName, part.FlavorName) {
				face = part.Name
				break
			}
		}
	}
	if face == "" {
		return nil, http.StatusNotFound
	}
	images := card.images(face)
	imageURL := images.Normal
	if imageURL == "" {
		imageURL = images.Small
	}
	if imageURL == "" {
		return nil, http.StatusNotFound
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, 0
	}
	req.Header.Set("User-Agent", "Hexproof-Club-CardArt/1.0")
	req.Header.Set("Accept", "image/jpeg")
	response, err := c.source.client.Do(req)
	if err != nil {
		return nil, 0
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maxClubJPEG {
		return nil, response.StatusCode
	}
	return readClubJPEG(response.Body), http.StatusOK
}
