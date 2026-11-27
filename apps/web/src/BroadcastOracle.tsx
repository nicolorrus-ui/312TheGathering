// SPDX-License-Identifier: GPL-3.0-or-later

import { useEffect, useState } from "react";
import type { Identity } from "./protocol";

type OracleFace = { name: string; zhName?: string; text: string | null };
type OracleResult = { faces: OracleFace[] } | "missing" | "failed";

export function BroadcastOracle({ card }: { card: Identity }) {
  const [result, setResult] = useState<OracleResult>();
  const { name, setCode, collectorNumber } = card;
  useEffect(() => {
    const controller = new AbortController();
    // Moving across a deck list should only fetch rules for cards the viewer pauses on.
    const timer = window.setTimeout(async () => {
      try {
        const query = new URLSearchParams({ name });
        if (setCode) query.set("set", setCode);
        if (collectorNumber) query.set("number", collectorNumber);
        const response = await fetch("/card-oracle-zh?" + query, { signal: controller.signal });
        let value: OracleResult = "missing";
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.faces) && data.faces.length) value = { faces: data.faces };
        } else if (response.status !== 404) {
          value = "failed";
        }
        if (!controller.signal.aborted) setResult(value);
      } catch {
        if (!controller.signal.aborted) setResult("failed");
      }
    }, 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [name, setCode, collectorNumber]);
  return <div className="broadcast-oracle" lang="zh-Hans" aria-label="中文 Oracle">
    {result && typeof result === "object"
      ? result.faces.map((face) => <section key={face.name}>
          <strong>{face.zhName || face.name}</strong>
          <p>{face.text ?? "暂无中文 Oracle 译文。"}{face.text === "" && "无规则文字。"}</p>
        </section>)
      : <p className="oracle-status">{result === "failed" ? "中文 Oracle 暂时无法加载。" :
          result === "missing" ? "暂无中文 Oracle 译文。" : "正在读取中文 Oracle…"}</p>}
  </div>;
}
