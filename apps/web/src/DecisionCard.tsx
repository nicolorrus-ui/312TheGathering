// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Hexproof contributors

import { CardImage, useCardHover } from "./CardImages";
import type { Identity } from "./protocol";

export function DecisionCard({ card, label, className = "choice-card-image", focusable = false }: {
  card?: Partial<Identity>; label?: string; className?: string; focusable?: boolean;
}) {
  const hover = useCardHover();
  // The engine may return only a redacted placeholder for a face-down choice.
  // Only a printed identity supplied to this viewer can enter the art loader.
  const face = card?.name && !["Face-down card", "Hidden card", "Unknown card"].includes(card.name)
    ? { name: card.name, setCode: card.setCode || "", collectorNumber: card.collectorNumber || "", token: card.token } : undefined;
  if (!face) return <span className={`${className} card-back choice-card-back`} role="img" aria-label={label || "Face-down card"} />;
  return <span key={JSON.stringify(face)} className="decision-art" tabIndex={focusable ? 0 : undefined}
    data-art-name={face.name} data-art-set={face.setCode} data-art-number={face.collectorNumber} data-art-token={face.token || undefined}
    onMouseEnter={(event) => hover(face, event.currentTarget)} onMouseLeave={() => hover()}>
    <CardImage identity={face} className={className} fallbackName />
  </span>;
}
