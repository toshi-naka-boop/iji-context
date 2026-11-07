"use client";
// 算定画面の「患者情報」欄：判定に使う値と、医療事務が確かめた記録（いつ・何で）。保存すると患者ごとに残る
import { useEffect, useState } from "react";
import type { Facts } from "../../src/engine/types";
import { FACT_SOURCES, PATIENT_FACT_KEYS, type PatientFact, type PatientFactKey } from "../../src/patient/facts";

type Row = PatientFact & { expired: boolean };

const LABEL: Record<PatientFactKey, string> = { careLevel: "要介護度", table7: "別表第七", table8_2: "別表第八の二", homeOxygen: "在宅酸素療法" };

/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

function show(key: PatientFactKey, v: number | boolean): string {
  if (key === "careLevel") return v === 0 ? "要支援・非該当" : `要介護${v}`;
  if (key === "homeOxygen") return v ? "している" : "していない";
  return v ? "当たる" : "当たらない";
}

export function PatientPanel(props: { claimId: string; clerkId: string; facts: Facts; editable: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [key, setKey] = useState<PatientFactKey>("careLevel");
  const [value, setValue] = useState("");
  const [source, setSource] = useState<string>(FACT_SOURCES[0]);
  const [validUntil, setValidUntil] = useState("");
  const [err, setErr] = useState("");

  const load = () =>
    fetch(`/api/patients/${props.claimId}/facts`)
      .then((r) => r.json())
      .then((d: { facts?: Row[] }) => setRows(d.facts ?? []))
      .catch(() => setRows([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.claimId]);

  async function save() {
    setErr("");
    const fact = { key, value: key === "careLevel" ? Number(value) : value === "true", source, validUntil: key === "careLevel" ? validUntil || null : null };
    const r = await fetch(`/api/patients/${props.claimId}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clerkId: props.clerkId, fact }) });
    const d = await r.json();
    if (!r.ok) return setErr(d.error ?? "エラー");
    setRows(d.facts);
    setValue("");
    setValidUntil("");
    props.onSaved();
  }

  return (
    <div>
      <h3>患者情報</h3>
      <table>
        <tbody>
          {PATIENT_FACT_KEYS.map((k) => {
            const f = props.facts[k];
            const rec = rows.find((r) => r.key === k);
            return (
              <tr key={k}>
                <td>{LABEL[k]}</td>
                <td>{f.known ? show(k, f.value as number | boolean) : "分からない"}</td>
                <td className="muted">
                  {rec
                    ? `${rec.checkedAt.slice(0, 10)} に${how(rec.source)}（${show(k, rec.value)}）${rec.validUntil ? `・${rec.validUntil} まで` : ""}`
                    : "カルテの値"}
                  {rec?.expired && <span className="notice warn">　有効期間が切れています。確かめ直してください</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {props.editable && (
        <p>
          <select value={key} onChange={(e) => { setKey(e.target.value as PatientFactKey); setValue(""); }}>
            {PATIENT_FACT_KEYS.map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
          </select>
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">選ぶ</option>
            {key === "careLevel"
              ? [0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{show(key, n)}</option>)
              : [true, false].map((b) => <option key={String(b)} value={String(b)}>{show(key, b)}</option>)}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {FACT_SOURCES.map((s) => <option key={s} value={s}>{how(s)}</option>)}
          </select>
          {key === "careLevel" && (
            <label>　有効期間の終わり <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
          )}
          <button disabled={value === ""} onClick={() => void save()}>残す</button>
          {err && <span className="notice warn">{err}</span>}
        </p>
      )}
    </div>
  );
}
