"use client";
// 事務長レポート（F9・FR-54〜58）：月次の集計だけ（個人別に分けない）。金額は常に「推定」
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";

type Report = {
  label: string;
  取りこぼし: { count: number; yen: number };
  差し戻し: { count: number; yen: number };
  医師記載起因: { count: number; yen: number };
  見逃し: { count: number; yen: number };
};

const ROWS: [keyof Omit<Report, "label">, string, string][] = [
  ["取りこぼし", "取りこぼしを防いだ", "var(--accent)"],
  ["差し戻し", "差し戻しを防いだ", "var(--sky)"],
  ["医師記載起因", "医師確認で算定できた", "#5a4632"],
  ["見逃し", "見逃し（返戻・査定になった）", "var(--warn-mark)"],
];

export default function Manager() {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => { fetch("/api/manager").then((x) => x.json()).then(setR); }, []);
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="suit" title="事務長レポート">
        クリニック全体で、提出前に防げた件数をまとめています。正しく算定する・取りこぼさないための集計で、個人ごとには分けません。金額は点数×10 円の推定です。
      </PageGuide>
      {r && (
        <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {ROWS.map(([k, label, color]) => (
            <div key={k} className="stat" style={{ ["--stat-color" as string]: color }}>
              <div className="label">{label}</div>
              <span className="value">{r[k].count}</span><span className="unit">件</span>
              <div className="muted" style={{ marginTop: 4 }}>{r[k].yen.toLocaleString()} 円（{r.label}）</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
