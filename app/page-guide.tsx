"use client";
// 画面ごとの案内役（2026-11-08 ユーザー判断）：画面の上にレセメンが立ち、その画面でできることを短く話す。
// 文は固定（AI は呼ばない）。案内役は画面ごとに決め、設定の画面だけは本人が選んだメンター
import { useEffect, useState } from "react";

export type Guide = "makki" | "black-hair" | "bob" | "suit" | "yusti" | "mine";
const NAMES: Record<Exclude<Guide, "mine">, string> = { makki: "マッキー", "black-hair": "ナツ", bob: "ユキ", suit: "ハル", yusti: "ユスティ" };
const imageOf = (g: Exclude<Guide, "mine">) => (g === "yusti" ? "/characters/yusti.png" : `/characters/${g}-select.png`);

export function PageGuide({ who, title, tag, children }: { who: Guide; title: string; tag?: string; children: React.ReactNode }) {
  const [mine, setMine] = useState<{ image: string; name: string } | null>(null);
  useEffect(() => {
    if (who !== "mine") return;
    fetch("/api/character").then((r) => (r.ok ? r.json() : null)).then((c) => c?.current?.image && setMine({ image: `/characters/${c.current.image}-select.png`, name: c.current.name })).catch(() => {});
  }, [who]);
  const img = who === "mine" ? mine?.image : imageOf(who);
  const name = who === "mine" ? mine?.name ?? "" : NAMES[who];
  return (
    <section className={`page-guide${who === "yusti" ? " rule" : ""}`} aria-label={`${title}の案内`}>
      <div className="page-guide-figure">{img && <img src={img} alt={name} />}</div>
      <div className="page-guide-body">
        {tag && <div className="hud-tag">{tag}</div>}
        <h1>{title}</h1>
        <div className="page-guide-say">
          {name && <span className="page-guide-name">{name}</span>}
          <p>{children}</p>
        </div>
      </div>
    </section>
  );
}
