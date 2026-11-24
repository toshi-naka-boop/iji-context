"use client";
// 要介護・要支援の認定の入力（design.md §18-1。C-510）：要介護（1〜5）／要支援（1・2）／認定なし（確かめた）／分からない。
// 要介護・要支援は有効期間の始まりと終わりの日が要る。月の途中で区分が変わったときは、続いた 2 つの認定を 1 つずつ残す。
// 残し先は患者ごとの事実（POST /api/patients/[claimId]/facts。キー careCert）。患者情報の欄・情報不足の入力・聞き取りの画面が同じ部品を使う
import { useState } from "react";
import { FACT_SOURCES, type CareCertValue } from "../src/patient/facts";

/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

/** 選択肢（値は "要介護:3" のような文字） */
export const CARE_CERT_CHOICES: [string, string][] = [
  ...[1, 2, 3, 4, 5].map((n): [string, string] => [`要介護:${n}`, `要介護${n}`]),
  ...[1, 2].map((n): [string, string] => [`要支援:${n}`, `要支援${n}`]),
  ["認定なし", "認定なし（確かめた）"],
  ["申請中", "申請中（この月だけ。翌月にまた確かめる）"],
  ["分からない", "分からない"],
];

/** 残した認定の言い方 */
export function careCertText(v: CareCertValue | { kind: string; level?: number; validFrom?: string }, validUntil: string | null): string {
  if (v.kind === "要介護" || v.kind === "要支援") return `${v.kind}${(v as { level: number }).level}（${(v as { validFrom: string }).validFrom}〜${validUntil ?? ""}）`;
  return v.kind === "認定なし" ? "認定なし（確かめた）" : v.kind === "申請中" ? "申請中" : "分からない";
}

/** 選択肢の文字と日付を、残す値にする */
export function careCertValueOf(choice: string, validFrom: string): CareCertValue {
  const [kind, level] = choice.split(":");
  if (kind === "要介護" || kind === "要支援") return { kind, level: Number(level), validFrom };
  return { kind: kind as "認定なし" | "申請中" | "分からない" };
}

export function CareCertForm(props: { claimId: string; onSaved: (facts: unknown) => void }) {
  const [choice, setChoice] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [source, setSource] = useState<string>(FACT_SOURCES[0]);
  const [err, setErr] = useState("");
  const dated = choice.startsWith("要介護") || choice.startsWith("要支援");
  async function save() {
    setErr("");
    const fact = { key: "careCert", value: careCertValueOf(choice, validFrom), source, validUntil: dated ? validUntil || null : null };
    const r = await fetch(`/api/patients/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    setChoice("");
    setValidFrom("");
    setValidUntil("");
    props.onSaved(d?.facts);
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <select aria-label="要介護・要支援の認定" value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">選ぶ</option>
        {CARE_CERT_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      {dated && <label>有効期間 <input type="date" aria-label="有効期間の始まり" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></label>}
      {dated && <label>〜 <input type="date" aria-label="有効期間の終わり" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>}
      <select aria-label="確かめ方" value={source} onChange={(e) => setSource(e.target.value)}>
        {FACT_SOURCES.map((s) => <option key={s} value={s}>{how(s)}</option>)}
      </select>
      <button disabled={choice === "" || (dated && (validFrom === "" || validUntil === ""))} onClick={() => void save()}>残す</button>
      {dated && <span className="muted">月の途中で区分が変わったときは、前の認定と新しい認定を 1 つずつ残します。</span>}
      {err && <span className="notice warn">{err}</span>}
    </span>
  );
}
