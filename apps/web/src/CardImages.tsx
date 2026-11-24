// SPDX-License-Identifier: GPL-3.0-or-later

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Identity } from "./protocol";

const directory = "/assets/cards/";
type Printing = { front: string; faces: Record<string, string> };
type ImagePack = { version: 1; printings: Record<string, Printing>; names: Record<string, string> };
const ImagePackContext = createContext<ImagePack | undefined>(undefined);

export function CardImages({ children }: { children: ReactNode }) {
  const [pack, setPack] = useState<ImagePack>();
  useEffect(() => {
    const controller = new AbortController();
    fetch(directory + "index.json", { signal: controller.signal, cache: "no-cache" })
      .then((response) => response.ok ? response.json() : undefined)
      .then((data) => {
        if (data?.version === 1 && data.printings && data.names) setPack(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return <ImagePackContext.Provider value={pack}>{children}</ImagePackContext.Provider>;
}

export function CardImage({ identity, className, decorative = false }: {
  identity?: Identity; className: string; decorative?: boolean;
}) {
  const pack = useContext(ImagePackContext);
  const [failedImage, setFailedImage] = useState<string>();
  if (!identity || !pack || !identity.name) return null;

  const name = identity.name.trim().normalize("NFC").toLowerCase();
  const printing = pack.printings[`${identity.token ? "token:" : ""}${identity.setCode.toLowerCase()}/${identity.collectorNumber.toLowerCase()}`];
  const file = printing?.faces?.[name] ?? printing?.front ?? pack.names[`${identity.token ? "token:" : ""}${name}`];
  if (typeof file !== "string" || !/^[0-9a-f-]{36}(?:-b)?\.jpg$/.test(file) || file === failedImage) return null;

  return <img key={file} className={className} src={directory + file} alt={decorative ? "" : identity.name}
    draggable={false} decoding="async" loading="lazy" onError={() => setFailedImage(file)} />;
}
