"use client";
// 医師確認の画面の「確かめてほしい項目」：点検で、医師に確かめる事実として出ている情報不足の一覧（GET /api/doctor/facts）。医師の役割の利用者が、選択肢から答える。
// 決まった答えは事実として残り（請求ごと：POST /api/claims/[claimId]/facts、患者ごと：POST /api/patients/[claimId]/facts）、点検の判定が変わる。
// 「その他」（自由記述つき）と「判定不能」は、事実を不明のまま残す（POST /api/doctor/facts）。
// 略語の問い（FR-211）は、同じ欄の上にカードで並べる（app/doctor/abbrev-requests.tsx）。
// 問いには、カルテの記載の引用を添える（記録がない請求は「カルテの記録がない請求です」）。
// 医師確認の決まり：点数・金額は出さない。選択肢は同じ大きさのボタンで並べ、「その他」「判定不能」も小さくしない。患者の氏名は出さない（下の確認の依頼と同じく、番号だけ）
import { useEffect, useState } from "react";
import type { DoctorFactItem } from "../../src/server/app/doctor-facts";
import type { Role } from "../../src/server/roles";
import { getJson } from "../get-json";
import { AbbrevRequests } from "./abbrev-requests";

const OTHER = "その他";
const UNDETERMINABLE = "判定不能";
const keyOf = (i: DoctorFactItem) => `${i.claimId}|${i.field}|${i.date ?? ""}`;
const monthLabel = (yearMonth: string) => `${yearMonth.slice(0, 4)}年${Number(yearMonth.slice(5, 7))}月`;

export function FactRequests() {
  const [role, setRole] = useState<Role | null>(null);
  const [items, setItems] = useState<DoctorFactItem[]>([]);
  const [pick, setPick] = useState<Record<string, { option: string; text: string }>>({});
  const [err, setErr] = useState("");
  /** 略語の問い（FR-211。app/doctor/abbrev-requests.tsx）の数 */
  const [abbrevCount, setAbbrevCount] = useState(0);
  const load = () => getJson<DoctorFactItem[]>("/api/doctor/facts").then(setItems).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    getJson<{ role: Role }>("/api/auth/me")
      .then((me) => {
        setRole(me.role);
        if (me.role === "doctor") void load();
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  async function answer(i: DoctorFactItem, p: { option: string; text: string }) {
    setErr("");
    const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const undecided = p.option === OTHER || p.option === UNDETERMINABLE;
    const value = i.input === "boolean" ? p.option === "はい" : i.input === "text" ? p.text : p.option;
    const r = undecided
      ? await post("/api/doctor/facts", { claimId: i.claimId, key: i.field, date: i.date, option: p.option, ...(p.option === OTHER ? { freeText: p.text } : {}) })
      : i.scope === "patient"
        ? await post(`/api/patients/${encodeURIComponent(i.claimId)}/facts`, { fact: { key: i.field, value, source: "医師に確認", validUntil: null } })
        : await post(`/api/claims/${encodeURIComponent(i.claimId)}/facts`, { fact: { key: i.field, date: i.date, value, source: "医師に確認" } });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "残せませんでした");
    setPick((cur) => ({ ...cur, [keyOf(i)]: { option: "", text: "" } }));
    void load();
  }

  return (
    <section aria-label="確かめてほしい項目" style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>確かめてほしい項目</h2>
      {err && <div className="notice warn">{err}</div>}
      {role !== null && role !== "doctor" && <p className="muted" style={{ margin: 0 }}>レセプトの点検で、医師に確かめることになった項目は、医師の役割の利用者の画面に出ます。</p>}
      {role === "doctor" && items.length === 0 && abbrevCount === 0 && <div className="panel muted">いま、確かめてほしい項目はありません。</div>}
      {role === "doctor" && <AbbrevRequests onCount={setAbbrevCount} />}
      {role === "doctor" && (
        <div className="card-list">
          {items.map((i) => {
            const k = keyOf(i);
            const p = pick[k] ?? { option: "", text: "" };
            const needsText = p.option === OTHER || (i.input === "text" && p.option !== "" && p.option !== UNDETERMINABLE);
            return (
              <article key={k} className="card">
                <div className="card-band" style={{ background: "var(--warn-mark)" }} />
                <div className="card-body">
                  <div className="chips" style={{ alignItems: "center" }}>
                    <span className="badge">{i.claimId}</span>
                    <span className="badge">{monthLabel(i.yearMonth)}</span>
                    {i.scope === "patient" && <span className="badge sky">患者ごとに残る</span>}
                  </div>
                  <p style={{ fontSize: 17, fontWeight: 700, margin: "12px 0" }}>{i.question}</p>
                  {/* カルテの記載の引用（医師確認の 7 要件の ①臨床指標。採点 r2 医療事務課長 P1） */}
                  {i.noRecord ? (
                    <p className="muted">カルテの記録がない請求です。</p>
                  ) : (
                    <div>
                      <div className="muted">カルテの記載</div>
                      {i.evidence.map((e, n) => <div key={n}>{e.source}：「{e.text}」</div>)}
                    </div>
                  )}
                  {i.note && <p className="muted">前の回答：{i.note.option}{i.note.freeText ? `（${i.note.freeText}）` : ""}　{i.note.at.slice(0, 10)}。事実は不明のままです。</p>}
                  <div className="options" role="radiogroup" aria-label={i.question}>
                    {i.options.map((o) => (
                      <button key={o} role="radio" aria-checked={p.option === o} className={`option${p.option === o ? " on" : ""}`} onClick={() => setPick({ ...pick, [k]: { option: o, text: "" } })}>{o}</button>
                    ))}
                  </div>
                  {needsText && <p><input aria-label={p.option === OTHER ? "具体的に" : "主病"} placeholder={p.option === OTHER ? "具体的に" : "主病"} value={p.text} maxLength={p.option === OTHER ? 200 : 100} onChange={(e) => setPick({ ...pick, [k]: { ...p, text: e.target.value } })} style={{ width: "100%" }} /></p>}
                  <button className="primary" disabled={!p.option || (needsText && p.text.trim() === "")} onClick={() => void answer(i, p)}>回答する</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
