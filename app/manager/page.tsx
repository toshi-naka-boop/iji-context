"use client";
// 事務長レポート（F9・FR-54〜58）：月ごとの集計だけ（個人別に分けない）。月は確定した月で、全期間の累計も選べる。金額は常に「推定」
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";
import { NoteList } from "../chart/note-list";
import { AuditLog } from "./audit-log";
import { RecheckNotice } from "./recheck";

type Report = {
  /** 数えた月（"YYYY-MM"）。null は全期間の累計 */
  month: string | null;
  /** 確定した問題のある月（新しい順） */
  months: string[];
  label: string;
  取りこぼし: { count: number; yen: number };
  差し戻し: { count: number; yen: number };
  医師記載起因: { count: number; yen: number };
  見逃し: { counted: false } | { counted: true; missed: number; judged: number; notYet: number };
};

const ROWS: [Exclude<keyof Report, "label" | "見逃し" | "month" | "months">, string, string][] = [
  ["取りこぼし", "指摘のあと直した（算定の足りない分）", "var(--accent)"],
  ["差し戻し", "指摘のあと直した（返戻・査定のおそれ）", "var(--sky)"],
  ["医師記載起因", "医師確認の答えで直した", "#5a4632"],
];

export default function Manager() {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  /** 選んだ月。"" は全期間の累計。undefined はまだ選んでいない（はじめは、確定した問題のある一番新しい月にする） */
  const [month, setMonth] = useState<string | undefined>(undefined);
  useEffect(() => {
    // 事務長の役割でなければ 403 が返る。応答の本文をそのまま描かない
    fetch(month ? `/api/manager?month=${month}` : "/api/manager")
      .then(async (x) => {
        if (!x.ok) return setErr(x.status === 403 ? "この画面は、事務長の役割の人が見られます。" : "読み込めませんでした。時間をおいて、もう一度試してください。");
        const d = (await x.json()) as Report;
        if (month === undefined && d.months.length > 0) return setMonth(d.months[0]);
        setR(d);
      })
      .catch(() => setErr("読み込めませんでした。時間をおいて、もう一度試してください。"));
  }, [month]);
  const period = (x: Report) => (x.month ? `${x.month.slice(0, 4)}年${Number(x.month.slice(5))}月に確定した分` : "全期間の累計");
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="suit" title="事務長レポート">
        クリニック全体で、提出前にレセメンが指摘し、確定までに直した件数を、確定した月（問題を確定した日の月。診療年月ではありません）ごとにまとめています（全期間の累計も選べます）。指摘がなくても直していた分と分けていないので、レセメンの効果の大きさとしては読めません。個人ごとには分けません。金額は直した行の点数×10 円の推定です。医師確認の答えで直した件数は、カルテの書き方を相談するときの手がかりで、医師に金額を示す材料や、医師を評価する材料ではありません（医師確認では点数・金額に触れません）。下には、カルテを書く画面から入れた訪問カルテの一覧（消す操作）と、操作の記録（監査ログ）を新しい順に並べています。
      </PageGuide>
      {err && <p className="muted">{err}</p>}
      {r && (
        <p>
          <label>
            期間：{" "}
            <select value={r.month ?? ""} onChange={(e) => setMonth(e.target.value)}>
              {r.months.map((m) => <option key={m} value={m}>{`${m.slice(0, 4)}年${Number(m.slice(5))}月に確定した分`}</option>)}
              <option value="">全期間の累計</option>
            </select>
          </label>
        </p>
      )}
      {r && (
        <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {ROWS.map(([k, label, color]) => (
            <div key={k} className="stat" style={{ ["--stat-color" as string]: color }}>
              <div className="label">{label}</div>
              <span className="value">{r[k].count}</span><span className="unit">件</span>
              <div className="muted" style={{ marginTop: 4 }}>{r[k].yen.toLocaleString()} 円（{r.label}・{period(r)}）</div>
            </div>
          ))}
          <div className="stat" style={{ ["--stat-color" as string]: "var(--warn-mark)" }}>
            <div className="label">見逃し（返戻・査定になった）</div>
            {r.見逃し.counted ? (
              <>
                <span className="value">{r.見逃し.missed}</span><span className="unit">件</span>
                <div className="muted" style={{ marginTop: 4 }}>
                  査定・返戻の突き合わせで判定した明細 {r.見逃し.judged} 件のうち、レセメンが同じ論点では指摘していなかったもの（別の論点の指摘・指摘なし）。まだ判定していない明細が {r.見逃し.notYet} 件あります。円は出していません。見逃しは月で分けず、全期間の累計です。
                </div>
              </>
            ) : (
              <div className="muted" style={{ marginTop: 4 }}>査定・返戻の突き合わせの記録がないので、見逃しは数えていません。</div>
            )}
          </div>
        </div>
      )}
      {r && <RecheckNotice />}
      {r && <NoteList />}
      {r && <AuditLog />}
    </main>
  );
}
