// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Identity } from "./protocol";

const directory = "/assets/cards/";
type Printing = { front: string; faces: Record<string, string> };
type ImagePack = { version: 1; printings: Record<string, Printing>; names: Record<string, string> };
const ImagePackContext = createContext<ImagePack | null | undefined>(undefined);

export function CardImages({ children }: { children: ReactNode }) {
  const [pack, setPack] = useState<ImagePack | null>();
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
  return <ImagePackContext.Provider value={pack}>{children}</ImagePackContext.Provider>;
}

export function CardImage({ identity, className, decorative = false, eager = false, compact = false }: {
  identity?: Identity; className: string; decorative?: boolean; eager?: boolean; compact?: boolean;
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
  const files = [printing?.faces?.[name], printing?.front, pack?.names[prefix + name]];
  const sources = files.filter((file): file is string =>
    typeof file === "string" && /^[0-9a-f-]{36}(?:-b)?\.jpg$/.test(file)).map((file) => directory + file);
  const query = new URLSearchParams({ name, set, number, size: compact ? "small" : "normal" });
  sources.push(`/card-art?${query}`);
  const src = sources.find((source) => !failed.includes(source));
  if (!src) return null;

  return <img key={src} className={className} src={src} alt={decorative ? "" : identity.name}
    draggable={false} decoding="async" loading={eager ? "eager" : "lazy"} referrerPolicy="no-referrer"
    onError={() => setFailed((previous) => [...previous.slice(-7), src])} />;
}
