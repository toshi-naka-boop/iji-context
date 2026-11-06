"use client";
// 医師画面（F1・FR-30〜34）：質問・カルテ等の記載（臨床指標）・選択肢・確認ボタン。点数・金額は出さない
import { useEffect, useState } from "react";
import type { DoctorQuery } from "../../src/query/types";
import { TopBar } from "../nav";

const DOCTOR = "院長";

export default function Doctor() {
  const [qs, setQs] = useState<DoctorQuery[]>([]);
  const [pick, setPick] = useState<Record<string, { option: string; freeText: string }>>({});
  const [err, setErr] = useState("");
  const load = () => fetch("/api/doctor").then((r) => r.json()).then(setQs);
  useEffect(() => { load(); }, []);

  async function post(url: string, body: unknown) {
    setErr("");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) setErr(d.error);
    load();
  }

  return (
    <main className="shell">
      <TopBar />
      {err && <div className="notice warn">{err}</div>}
      <h2>医師確認</h2>
      {qs.length === 0 && <div className="panel muted">確認の依頼はありません。</div>}
      {qs.map((q) => {
        const p = pick[q.id] ?? { option: "", freeText: "" };
        return (
          <div key={q.id} className="panel" style={{ marginBottom: 12 }}>
            <div className="muted">{q.claimId}・{q.status}{q.remindedAt ? "・リマインド済み" : ""}{q.heldAt ? "・保留（算定しない）" : ""}</div>
            <p><strong>{q.question}</strong></p>
            <div className="muted">カルテ等の記載</div>
            <ul>{q.indicators.map((i, k) => <li key={k}>{i.source}：{i.text}</li>)}</ul>
            {(q.status === "未回答" || q.status === "保留") && (
              <div>
                {q.options.map((o) => (
                  <label key={o} style={{ display: "block" }}>
                    <input type="radio" name={q.id} checked={p.option === o} onChange={() => setPick({ ...pick, [q.id]: { ...p, option: o } })} /> {o}
                  </label>
                ))}
                {p.option === "その他" && <input placeholder="具体的に" value={p.freeText} onChange={(e) => setPick({ ...pick, [q.id]: { ...p, freeText: e.target.value } })} />}
                <p><button className="primary" disabled={!p.option} onClick={() => post(`/api/doctor/${q.id}/answer`, { option: p.option, freeText: p.freeText || undefined, answeredBy: DOCTOR })}>回答する</button></p>
              </div>
            )}
            {q.status === "回答済み" && q.answer && (
              <div>
                <p>回答：{q.answer.option}{q.answer.freeText ? `（${q.answer.freeText}）` : ""}</p>
                <button className="primary" onClick={() => post(`/api/doctor/${q.id}/approve`, { approver: DOCTOR })}>内容を確認して承認する</button>
              </div>
            )}
            {q.status === "承認済み" && q.approval && <div className="notice ok">承認：{q.approval.approver}　{q.approval.at}</div>}
          </div>
        );
      })}
    </main>
  );
}
