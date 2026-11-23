"use client";
// 訪問の開始・終了の時刻を入れる欄（design.md §16-6。案内の出た日だけ。POST /api/chart/structured/visit-time。入れた値は「医療事務が入れた」の印で残る）。
// その日の電子カルテの訪問の記録があれば、どの訪問の時刻かを選んで ref を送る（サーバーがその日の記録と照らす。C-442）。G11 の結果とカルテの確かめる画面が使う
import { useState } from "react";
import { postJson } from "./get-json";

export type VisitRef = { ref: string; kind: "訪問診療" | "往診" | null };

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function VisitTimeInput({ claimId, date, visits = [] }: { claimId: string; date: string; visits?: VisitRef[] }) {
  const [ref, setRef] = useState(visits.length === 1 ? visits[0].ref : "");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [msg, setMsg] = useState("");
  async function save() {
    setMsg("");
    try {
      await postJson("/api/chart/structured/visit-time", { claimId, date, start, end, ...(ref ? { ref } : {}) });
      setMsg("残しました。点検を開き直すと、患家診療時間加算を見ます");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="notice">
      <div className="chips">
        <span>{md(date)} の訪問</span>
        {visits.length >= 2 && (
          <select value={ref} aria-label="どの訪問か" onChange={(e) => setRef(e.target.value)}>
            <option value="">どの訪問かを選ぶ</option>
            {visits.map((v, i) => <option key={v.ref} value={v.ref}>{`${i + 1} 件目${v.kind ? `（${v.kind}）` : ""}`}</option>)}
          </select>
        )}
        <label>開始 <input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label>終了 <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <button disabled={start === "" || end === "" || (visits.length >= 2 && ref === "")} onClick={save}>時刻を残す</button>
      </div>
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}
