// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Identity } from "./protocol";

export type CardHover = (identity?: Identity, source?: Element) => void;
const CardHoverContext = createContext<CardHover>(() => {});
export const useCardHover = () => useContext(CardHoverContext);

const directory = "/assets/cards/";
type Printing = { front: string; faces: Record<string, string> };
type ImagePack = { version: 1; printings: Record<string, Printing>; names: Record<string, string> };
const ImagePackContext = createContext<ImagePack | null | undefined>(undefined);

export function cardArtURL(card: Identity, compact = false, revision = 0) {
  const query = new URLSearchParams({ name: card.name.trim().normalize("NFC").toLowerCase(),
    set: card.setCode?.trim().toLowerCase() ?? "", number: card.collectorNumber?.trim().toLowerCase() ?? "",
    size: compact ? "small" : "normal" });
  if (card.token) query.set("token", "1");
  if (revision) query.set("refresh", String(revision));
  return "/card-art?" + query;
}

export function CardImages({ children }: { children: ReactNode }) {
  const [pack, setPack] = useState<ImagePack | null>();
  const [preview, setPreview] = useState<{ identity: Identity; source: Element }>();
  const hoverCard = useCallback<CardHover>((identity, source) => {
    setPreview(identity?.name && source ? { identity, source } : undefined);
  }, []);
  useEffect(() => {
    if (!preview) return;
    // A new seat, zone or prompt can remove the source without a mouseleave.
    const dismiss = () => setPreview((current) => current === preview ? undefined : current);
    const checkSource = () => {
      if (!preview.source.isConnected || !preview.source.matches(":hover, :focus-visible")) dismiss();
    };
    checkSource();
    const observer = new MutationObserver(checkSource);
    observer.observe(document.body, { subtree: true, childList: true });
    window.addEventListener("blur", dismiss);
    return () => { observer.disconnect(); window.removeEventListener("blur", dismiss); };
  }, [preview]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(directory + "index.json", { signal: controller.signal, cache: "no-cache" })
      .then((response) => response.ok ? response.json() : undefined)
      .then((data) => {
        if (!controller.signal.aborted) setPack(data?.version === 1 && data.printings && data.names ? data : null);
      })
      .catch(() => { if (!controller.signal.aborted) setPack(null); });
    return () => controller.abort();
  }, []);
  return <ImagePackContext.Provider value={pack}><CardHoverContext.Provider value={hoverCard}>
    {children}
    {preview && <CardHoverPreview identity={preview.identity} />}
  </CardHoverContext.Provider></ImagePackContext.Provider>;
}

export function CardImage({ identity, className, decorative = false, eager = false, compact = false, revision }: {
  identity?: Identity; className: string; decorative?: boolean; eager?: boolean; compact?: boolean; revision?: number;
}) {
  const pack = useContext(ImagePackContext);
  const [failed, setFailed] = useState<string[]>([]);
  if (!identity?.name || pack === undefined) return null;

  const name = identity.name.trim().normalize("NFC").toLowerCase();
  if (!name) return null;
  const prefix = identity.token ? "token:" : "";
  const set = identity.setCode?.trim().toLowerCase() ?? "";
  const number = identity.collectorNumber?.trim().toLowerCase() ?? "";
  const printing = pack?.printings[`${prefix}${set}/${number}`];
  const remote = cardArtURL(identity, compact, revision);
  const local = (file?: string) => file && /^[0-9a-f-]{36}(?:-b)?\.jpg$/.test(file) ? directory + file : undefined;
  const named = local(pack?.names[prefix + name]);
  const printedFace = local(printing?.faces?.[name]);
  const printedFront = local(printing?.front);
  const sources = import.meta.env.MODE === "club-debug" && (set || number)
    ? [printing?.faces && Object.keys(printing.faces).length ? printedFace : printedFront, remote]
    : [printedFace, printedFront, ...(set && number ? [remote, named] : [named, remote])];
  const src = sources.find((source) => source && !failed.includes(source));
  if (!src) return null;

  return <img key={src} className={className} src={src} alt={decorative ? "" : identity.name}
    draggable={false} decoding="async" loading={eager ? "eager" : "lazy"} referrerPolicy="no-referrer"
    onError={() => setFailed((previous) => [...previous.slice(-7), src])} />;
}

export function CardHoverPreview({ identity }: { identity: Identity }) {
  return <div className="card-hover-preview" aria-hidden="true">
    <strong>{identity.name}</strong>
    <CardImage identity={identity} className="card-hover-preview-image" decorative eager />
  </div>;
}
