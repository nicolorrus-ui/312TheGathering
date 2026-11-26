// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package forge

import (
	"errors"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validCardName(name string) bool {
	return name != "" && utf8.ValidString(name) && utf8.RuneCountInString(name) <= 256 && !strings.ContainsFunc(name, unicode.IsControl)
}

// Older controllers supply only free text. Current controllers also expose their
// legal face names to the deciding player; Forge rechecks membership on submission.
func cardNameOutput(view PromptView, answer PromptResponse) (any, error) {
	otherSelections := answer
	otherSelections.Name = ""
	if !otherSelections.emptySelections() {
		return nil, errors.New("card-name response contains unexpected selections")
	}
	if answer.ResponseID == "$cancel" && answer.Name == "" && view.Cancellable {
		return map[string]any{"type": "cancel"}, nil
	}
	name := strings.TrimSpace(answer.Name)
	if answer.ResponseID != "$submit" || !validCardName(name) {
		return nil, errors.New("invalid card-name response")
	}
	if len(view.LegalNames) > 0 && !slices.ContainsFunc(view.LegalNames, func(candidate string) bool { return strings.EqualFold(name, candidate) }) {
		return nil, errors.New("name is outside the current Forge candidate set")
	}
	return map[string]any{"type": "cardName", "name": name}, nil
}
