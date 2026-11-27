// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

//go:embed cube-presets/*.json
var bundledClubCubes embed.FS

type cubePreset struct {
	refresh   sync.Mutex
	mu        sync.RWMutex
	data      []byte
	updatedAt time.Time
}

type clubCubes struct {
	presets map[string]*cubePreset
	catalog func() (*offlineCatalog, error)
	dir     string
	client  *http.Client
}

func newClubCubes(dir string, catalog func() (*offlineCatalog, error)) *clubCubes {
	c := &clubCubes{dir: dir, catalog: catalog, presets: make(map[string]*cubePreset), client: &http.Client{Timeout: 20 * time.Second}}
	for _, slug := range []string{"modovintage", "100-ornithopters"} {
		data, err := bundledClubCubes.ReadFile("cube-presets/" + slug + ".json")
		if err != nil {
			panic(err)
		} // embedded at build time
		var version struct {
			UpdatedAt time.Time `json:"updatedAt"`
		}
		if err := json.Unmarshal(data, &version); err != nil {
			panic(err)
		}
		if dir != "" {
			saved, err := os.ReadFile(filepath.Join(dir, slug+".json"))
			if err == nil {
				var stored cubeList
				if json.Unmarshal(saved, &stored) == nil && stored.Slug == slug && stored.Name != "" && len(stored.Cards) > 0 {
					if !stored.UpdatedAt.Before(version.UpdatedAt) {
						data = saved
						version.UpdatedAt = stored.UpdatedAt
					}
				} else {
					log.Printf("Club Cube: ignoring invalid saved %s", slug)
				}
			} else if !os.IsNotExist(err) {
				log.Printf("Club Cube: cannot read saved %s: %v", slug, err)
			}
		}
		c.presets[slug] = &cubePreset{data: data, updatedAt: version.UpdatedAt}
	}
	return c
}

func (c *clubCubes) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /club-cubes/{slug}", c.show)
	// A cross-origin page should not be able to initiate a refresh on the local debug server.
	mux.Handle("POST /club-cubes/{slug}/refresh", http.NewCrossOriginProtection().Handler(http.HandlerFunc(c.refresh)))
	mux.HandleFunc("POST /club-cubes/resolve", c.resolve)
}

func (c *clubCubes) show(w http.ResponseWriter, r *http.Request) {
	p := c.presets[r.PathValue("slug")]
	if p == nil {
		http.NotFound(w, r)
		return
	}
	p.mu.RLock()
	data := p.data
	p.mu.RUnlock()
	writeCubeJSON(w, data)
}

func writeCubeJSON(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func (c *clubCubes) refresh(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	p := c.presets[slug]
	if p == nil {
		http.NotFound(w, r)
		return
	}
	if !p.refresh.TryLock() {
		http.Error(w, "This cube is already updating.", http.StatusConflict)
		return
	}
	defer p.refresh.Unlock()
	catalog, err := c.catalog()
	if err != nil {
		http.Error(w, "The Forge card catalog is unavailable.", http.StatusServiceUnavailable)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, "https://cubecobra.com/cube/api/cubeJSON/"+slug, nil)
	if err != nil {
		http.Error(w, "Cube Cobra request failed.", http.StatusBadGateway)
		return
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("User-Agent", "Hexproof-Club-Cube/1.0")
	resp, err := c.client.Do(req)
	if err != nil {
		http.Error(w, "Could not reach Cube Cobra. The saved list is still available.", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("Cube Cobra returned HTTP %d.", resp.StatusCode), http.StatusBadGateway)
		return
	}
	const limit = 32 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || len(data) > limit {
		http.Error(w, "Could not read the complete Cube Cobra list.", http.StatusBadGateway)
		return
	}
	list, err := readCubeCobra(bytes.NewReader(data), slug, catalog)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	// A stale intermediary response must not revert a more recent local list.
	if list.UpdatedAt.Before(p.updatedAt) {
		http.Error(w, "Cube Cobra returned an older revision. The newer saved list is still available.", http.StatusConflict)
		return
	}
	data, err = json.Marshal(list)
	if err != nil {
		http.Error(w, "Could not encode the cube list.", http.StatusInternalServerError)
		return
	}
	if c.dir != "" {
		if err := storeClubFile(filepath.Join(c.dir, slug+".json"), data); err != nil {
			log.Printf("Club Cube: cannot save %s: %v", slug, err)
			http.Error(w, "Could not save the updated cube list.", http.StatusInternalServerError)
			return
		}
	}
	p.mu.Lock()
	p.data = data
	p.updatedAt = list.UpdatedAt
	p.mu.Unlock()
	writeCubeJSON(w, data)
}

func (c *clubCubes) resolve(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Cards []cubeEntry `json:"cards"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	decoder := json.NewDecoder(r.Body)
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		http.Error(w, "Could not read the cube card list.", http.StatusBadRequest)
		return
	}
	catalog, err := c.catalog()
	if err != nil {
		http.Error(w, "The Forge card catalog is unavailable.", http.StatusServiceUnavailable)
		return
	}
	rows, err := resolveCubeEntries(input.Cards, catalog)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(struct {
		Cards []cubeCard `json:"cards"`
	}{rows})
}
