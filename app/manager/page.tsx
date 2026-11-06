"use client";
// 事務長レポート（F9・FR-54〜58）：月次の集計だけ（個人別に分けない）。金額は常に「推定」
import { useEffect, useState } from "react";
import { TopBar } from "../nav";

type Report = {
  label: string;
  取りこぼし: { count: number; yen: number };
  差し戻し: { count: number; yen: number };
  医師記載起因: { count: number; yen: number };
  見逃し: { count: number; yen: number };
};

export default function Manager() {
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => { fetch("/api/manager").then((x) => x.json()).then(setR); }, []);
  const row = (name: string, v: { count: number; yen: number }) => (
    <tr key={name}><td>{name}</td><td>{v.count} 件</td><td>{v.yen.toLocaleString()} 円（{r?.label}）</td></tr>
  );
  return (
    <main className="shell">
      <TopBar />
      <h2>事務長レポート</h2>
      {r && (
        <div className="panel">
          <table>
            <thead><tr><th>項目</th><th>件数</th><th>金額</th></tr></thead>
            <tbody>
              {row("取りこぼしを防いだ", r.取りこぼし)}
              {row("差し戻しを防いだ", r.差し戻し)}
              {row("医師記載起因（医師確認で算定できた）", r.医師記載起因)}
              {row("見逃し（返戻・査定になった）", r.見逃し)}
            </tbody>
          </table>
          <p className="muted">金額は点数×10円の推定です。正しく算定する・取りこぼさないための集計で、個人別には分けません。</p>
        </div>
      )}
    </main>
  );
}
