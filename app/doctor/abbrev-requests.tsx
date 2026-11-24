"use client";
// 医師確認の「確かめてほしい項目」の中の、略語の問いのカード（spec FR-211。GET・POST /api/doctor/abbrevs）。医師の役割の利用者が答える。
// 問いは定型文 1 つ、選択肢は固定の 4 つ（同じ大きさのボタン。「その他」「判定不能」も小さくしない）。引用は請求の番号と日付ごとに並べ、患者の氏名は出さない。
// 点数・金額は出さない（引用の該当の語はサーバーが伏せる）。答えは、いま並んでいる記載にだけ効く（記載の参照をそのまま送る）
import { useEffect, useState } from "react";
import type { AbbrevRequest } from "../../src/server/app/doctor-abbrevs";
import { getJson } from "../get-json";

const OTHER = "その他";
const WRITE_IN = "指すものを記入する";
const VARIES = "記載によって違う";
const keyOf = (q: AbbrevRequest) => `${q.yearMonth}|${q.token}|${q.split ? q.quotes[0]?.ref : ""}`;
const monthLabel = (yearMonth: string) => `${yearMonth.slice(0, 4)}年${Number(yearMonth.slice(5, 7))}月`;
const dayLabel = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** onCount：いま出ている問いの数（呼び出し側の「ありません」の文に使う） */
export function AbbrevRequests({ onCount }: { onCount: (n: number) => void }) {
  const [items, setItems] = useState<AbbrevRequest[]>([]);
  const [pick, setPick] = useState<Record<string, { option: string; text: string }>>({});
  const [err, setErr] = useState("");
  const load = () =>
    getJson<AbbrevRequest[]>("/api/doctor/abbrevs")
      .then((list) => {
        setItems(list);
        onCount(list.length);
      })
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);

  async function answer(q: AbbrevRequest, p: { option: string; text: string }) {
    setErr("");
    const needsText = p.option === OTHER || p.option === WRITE_IN;
    const r = await fetch("/api/doctor/abbrevs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ yearMonth: q.yearMonth, token: q.token, refs: q.quotes.map((x) => x.ref), option: p.option, ...(needsText ? { freeText: p.text } : {}) }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "残せませんでした");
    setPick((cur) => ({ ...cur, [keyOf(q)]: { option: "", text: "" } }));
    void load();
  }

  if (items.length === 0 && !err) return null;
  return (
    <>
      {err && <div className="notice warn">{err}</div>}
      <div className="card-list">
        {items.map((q) => {
          const k = keyOf(q);
          const p = pick[k] ?? { option: "", text: "" };
          const needsText = p.option === OTHER || p.option === WRITE_IN;
          return (
            <article key={k} className="card">
              <div className="card-band" style={{ background: "var(--warn-mark)" }} />
              <div className="card-body">
                <div className="chips" style={{ alignItems: "center" }}>
                  <span className="badge">略語</span>
                  <span className="badge">{monthLabel(q.yearMonth)}</span>
                  <span className="badge">{q.quotes.length} 件</span>
                  {q.split && <span className="badge sky">記載ごと</span>}
                  {q.held ? <span className="badge">保留（3 営業日たちました）</span> : q.reminded ? <span className="badge">1 営業日たちました</span> : null}
                </div>
                <p style={{ fontSize: 17, fontWeight: 700, margin: "12px 0" }}>{q.question}</p>
                <ul style={{ margin: "0 0 12px", paddingLeft: 20 }}>
                  {q.quotes.map((x) => (
                    <li key={x.ref}>
                      {x.claimId}　{dayLabel(x.date)}：「{x.quote}」{x.masked && <span className="muted">（伏せた語があります）</span>}
                    </li>
                  ))}
                </ul>
                <div className="options" role="radiogroup" aria-label={q.question}>
                  {q.options.map((o) => (
                    <button key={o} role="radio" aria-checked={p.option === o} className={`option${p.option === o ? " on" : ""}`} disabled={o === VARIES && q.quotes.length < 2} onClick={() => setPick({ ...pick, [k]: { option: o, text: "" } })}>
                      {o}
                    </button>
                  ))}
                </div>
                {needsText && (
                  <p>
                    <input aria-label={p.option === OTHER ? "具体的に" : "指すもの"} placeholder={p.option === OTHER ? "具体的に" : "指すもの（例：検査や処置の名前）"} value={p.text} maxLength={p.option === OTHER ? 200 : 100} onChange={(e) => setPick({ ...pick, [k]: { ...p, text: e.target.value } })} style={{ width: "100%" }} />
                  </p>
                )}
                <button className="primary" disabled={!p.option || (needsText && p.text.trim() === "")} onClick={() => void answer(q, p)}>
                  回答する
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
