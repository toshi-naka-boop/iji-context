"use client";
// 医師画面（F1・FR-30〜34）：質問・カルテ等の記載（臨床指標）・選択肢・確認ボタン。点数・金額は出さない。
// 選択肢は同じ大きさのボタンで並べ、「その他」「判定不能」も小さくしない（AHIMA/ACDIS の要件）
import { useEffect, useState } from "react";
import type { DoctorQuery } from "../../src/query/types";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";

const DOCTOR = "院長";
const STATUS_BADGE: Record<string, string> = { 未回答: "warn", 保留: "warn", 回答済み: "sky", 承認済み: "ok" };

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
  const open = qs.filter((q) => q.status !== "承認済み").length;

  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="suit" title="医師確認">
        カルテに書かれていないことを、ここで医師に確かめます。医師の役になって選択肢から答え、内容を確かめて承認してください。点数や金額はここには出しません。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="stats">
        <div className="stat" style={{ ["--stat-color" as string]: "var(--warn-mark)" }}><div className="label">確かめ待ち</div><span className="value">{open}</span><span className="unit">件</span></div>
        <div className="stat"><div className="label">承認済み</div><span className="value">{qs.length - open}</span><span className="unit">件</span></div>
      </div>
      {qs.length === 0 && <div className="panel muted">確認の依頼はありません。算定画面の「医師確認用練習」から送ると、ここに届きます。</div>}
      <div className="card-list">
        {qs.map((q) => {
          const p = pick[q.id] ?? { option: "", freeText: "" };
          return (
            <article key={q.id} className="card">
              <div className="card-band" style={{ background: q.status === "承認済み" ? "var(--accent)" : "var(--warn-mark)" }} />
              <div className="card-body">
                <div className="chips" style={{ alignItems: "center" }}>
                  <span className="badge">{q.claimId}</span>
                  <span className={`badge ${STATUS_BADGE[q.status] ?? ""}`}>{q.status}</span>
                  {q.remindedAt && <span className="badge">リマインド済み</span>}
                  {q.heldAt && <span className="badge warn">保留（算定しない）</span>}
                </div>
                <p style={{ fontSize: 17, fontWeight: 700, margin: "12px 0" }}>{q.question}</p>
                <div className="bubble">
                  <div className="muted" style={{ marginBottom: 4 }}>カルテ等の記載</div>
                  {q.indicators.map((i, k) => <div key={k}>{i.source}：{i.text}</div>)}
                </div>
                {(q.status === "未回答" || q.status === "保留") && (
                  <div>
                    <div className="options" role="radiogroup" aria-label="回答">
                      {q.options.map((o) => (
                        <button key={o} role="radio" aria-checked={p.option === o} className={`option${p.option === o ? " on" : ""}`} onClick={() => setPick({ ...pick, [q.id]: { ...p, option: o } })}>{o}</button>
                      ))}
                    </div>
                    {p.option === "その他" && <p><input placeholder="具体的に" value={p.freeText} onChange={(e) => setPick({ ...pick, [q.id]: { ...p, freeText: e.target.value } })} style={{ width: "100%" }} /></p>}
                    <button className="primary" disabled={!p.option} onClick={() => post(`/api/doctor/${q.id}/answer`, { option: p.option, freeText: p.freeText || undefined, answeredBy: DOCTOR })}>回答する</button>
                  </div>
                )}
                {q.status === "回答済み" && q.answer && (
                  <div style={{ marginTop: 12 }}>
                    <p>回答：<strong>{q.answer.option}</strong>{q.answer.freeText ? `（${q.answer.freeText}）` : ""}</p>
                    <button className="primary" onClick={() => post(`/api/doctor/${q.id}/approve`, { approver: DOCTOR })}>内容を確認して承認する</button>
                  </div>
                )}
                {q.status === "承認済み" && q.approval && <div className="notice ok">承認：{q.approval.approver}　{q.approval.at}</div>}
              </div>
            </article>
          );
        })}
      </div>
    </main>
  );
}
