"use client";
// 「情報不足」の項目に、その場で答えを残す入力（請求ごとに確かめた事実。POST /api/claims/[claimId]/facts）と、残した答えの一覧。
// 入るのは、人が確かめて残した値だけ。医師あての項目は医師の役割だけが残せる（医療事務には「医師に確認が要ります」と出す）。
// 患者パネルで残す項目（PATIENT_FACT_KEYS）は、入力を作らず患者情報の欄へ誘導する。入力では消えない情報不足（カルテの記録がない・対象外の行・施設の設定）には何も出さない
import { useEffect, useState } from "react";
import { CLAIM_FACT_SOURCES, DEATH_PLACES, MAX_MAIN_DISEASE, RESIDENCES, inputKindOf, isClaimFactKey, type ClaimFact, type ClaimFactKey } from "../src/claim/facts";
import type { Finding } from "../src/engine/types";
import { FACT_LABEL } from "../src/messages";
import { PATIENT_FACT_KEYS } from "../src/patient/facts";
import type { Role } from "../src/server/roles";

type Saved = ClaimFact & { target: "doctor" | "clerk"; checkedByName: string };

const dayText = (date: string | null) => (date ? `（${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日）` : "");
const show = (v: boolean | string) => (typeof v === "boolean" ? (v ? "はい" : "いいえ") : v);
/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

/** いまの役割（同じ画面の入力で 1 回だけ取る） */
let roleOnce: Promise<Role | null> | null = null;
function useRole(): Role | null {
  const [role, setRole] = useState<Role | null>(null);
  useEffect(() => {
    roleOnce ??= fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)).then((me: { role: Role } | null) => me?.role ?? null).catch(() => null);
    void roleOnce.then(setRole);
  }, []);
  return role;
}
/** その役割が、その宛先の項目を残せるか（サーバーも同じ決まりで断る） */
const canSave = (role: Role | null, target: "doctor" | "clerk") => (target === "doctor" ? role === "doctor" : role === "clerk" || role === "veteran");

function FactForm(props: { claimId: string; factKey: ClaimFactKey; date: string | null; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [source, setSource] = useState<string>(CLAIM_FACT_SOURCES[0]);
  const [err, setErr] = useState("");
  const kind = inputKindOf(props.factKey);
  async function save() {
    setErr("");
    const fact = { key: props.factKey, date: props.date, value: kind === "boolean" ? value === "true" : value, source };
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    setValue("");
    props.onSaved();
  }
  const options = kind === "boolean" ? [["true", "はい"], ["false", "いいえ"]] : kind === "residence" ? RESIDENCES.map((x) => [x, x]) : DEATH_PLACES.map((x) => [x, x]);
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {kind === "text" ? (
        <input aria-label={FACT_LABEL[props.factKey]} value={value} maxLength={MAX_MAIN_DISEASE} onChange={(e) => setValue(e.target.value)} style={{ width: 200, maxWidth: "100%" }} />
      ) : (
        <select aria-label={`${FACT_LABEL[props.factKey]}${dayText(props.date)}`} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">選ぶ</option>
          {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      )}
      <select aria-label="確かめ方" value={source} onChange={(e) => setSource(e.target.value)}>
        {CLAIM_FACT_SOURCES.map((s) => <option key={s} value={s}>{how(s)}</option>)}
      </select>
      <button disabled={value.trim() === ""} onClick={() => void save()}>残す</button>
      {err && <span className="notice warn">{err}</span>}
    </span>
  );
}

/** 情報不足の 1 項目に添える入力。日付ごとの事実は、聞かれている日の答えを残す。patientHref は、患者情報の欄への行き先 */
export function FactInput(props: { claimId: string; finding: Finding; patientHref: string; onSaved: () => void }) {
  const role = useRole();
  const m = props.finding.missing;
  if (!m) return null;
  if ((PATIENT_FACT_KEYS as readonly string[]).includes(m.field)) return <div className="muted">この項目は、月末の点検の「患者情報」の欄で、確定の前に残します。<a href={props.patientHref}>患者情報の欄へ</a></div>;
  if (!isClaimFactKey(m.field) || role === null) return null;
  if (!canSave(role, m.target)) return m.target === "doctor" ? <div className="muted">医師に確認が要ります。医師の役割の利用者が、確かめた答えを残します。</div> : null;
  return <div style={{ marginTop: 6 }}><FactForm claimId={props.claimId} factKey={m.field} date={m.date ?? null} onSaved={props.onSaved} /></div>;
}

/** この請求について残した答えの一覧（誰が・いつ・どう確かめたか）。直すときは、同じ入力でもう一度残す。tick が変わると読み直す */
export function CheckedFacts(props: { claimId: string; tick: number; onSaved: () => void; note?: string }) {
  const role = useRole();
  const [facts, setFacts] = useState<Saved[]>([]);
  const [editing, setEditing] = useState("");
  useEffect(() => {
    fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { facts?: Saved[] } | null) => setFacts(d?.facts ?? []))
      .catch(() => setFacts([]));
  }, [props.claimId, props.tick]);
  if (facts.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {facts.map((f) => {
        const id = `${f.key}|${f.date ?? ""}`;
        return (
          <div key={id} className="notice ok">
            確かめた：{FACT_LABEL[f.key]}{dayText(f.date)}＝{show(f.value)}
            <span className="muted">（{f.checkedByName || f.checkedBy}・{f.checkedAt.slice(0, 10)}・{how(f.source)}）</span>
            {canSave(role, f.target) && (editing === id
              ? <div style={{ marginTop: 6 }}><FactForm claimId={props.claimId} factKey={f.key} date={f.date} onSaved={() => { setEditing(""); props.onSaved(); }} /></div>
              : <> <button onClick={() => setEditing(id)}>直す</button></>)}
          </div>
        );
      })}
      {props.note && <p className="muted" style={{ margin: 0 }}>{props.note}</p>}
    </div>
  );
}
