// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

package limited

import "hexproof/server/internal/protocol"

type rochesterDraft struct {
	opened int
	opener int
	pack   *Pack
	picks  []protocol.LimitedRochesterPick
}

func (e *Event) openRochesterPack() error {
	table := e.rochester
	seats := len(e.Players)
	if table.opened == e.packCount*seats {
		e.Stage = protocol.LimitedStageDeckBuilding
		return nil
	}
	cards, err := e.nextPack()
	if err != nil {
		return err
	}
	e.packRound = table.opened/seats + 1
	e.packsThisBatch = 1
	table.opener = table.opened % seats
	if e.Direction() < 0 {
		table.opener = seats - 1 - table.opener
	}
	table.opened++
	e.packSeq++
	table.pack = &Pack{ID: "pack-" + itoa(e.packSeq), Cards: cards}
	table.picks = nil
	e.Players[table.opener].Inbox = append(e.Players[table.opener].Inbox, table.pack)
	return e.advanceDraft()
}

// The opener picks first. Each end of a pass picks twice before the order
// reverses, including at four- to seven-seat tables where a pack lasts longer.
func (e *Event) rochesterPicker() *PlayerState {
	seats := len(e.Players)
	offset := len(e.rochester.picks) % (2 * seats)
	if offset >= seats {
		offset = 2*seats - 1 - offset
	}
	index := (e.rochester.opener + e.Direction()*offset + seats) % seats
	return e.Players[index]
}

func (e *Event) rochesterView() *protocol.LimitedRochesterView {
	table := e.rochester
	return &protocol.LimitedRochesterView{
		PackNumber: table.opened, OpenerID: e.Players[table.opener].ID,
		ActiveParticipantID: e.rochesterPicker().ID, Cards: cardViews(table.pack.Cards),
		Picks: append([]protocol.LimitedRochesterPick{}, table.picks...),
	}
}
