"use client";
// 算定画面の「患者情報」欄：判定に使う値と、医療事務が確かめた記録（いつ・何で）。保存すると患者ごとに残る。
// 「患者情報の確認」欄：患者情報チェック（P01〜P08）の指摘と、保険・公費の確認入力。ユスティの判定とは別の欄で、宛先は医療事務
import { useEffect, useState } from "react";
import type { Facts } from "../../src/engine/types";
import type { PatientFinding } from "../../src/patient/checks";
import { FACT_SOURCES, PATIENT_FACT_KEYS, type PatientFact, type PatientFactKey } from "../../src/patient/facts";
import { BURDEN_RATIOS, COVERAGE_SOURCES, type Coverage } from "../../src/patient/profile";

type Row = PatientFact & { expired: boolean };
type Profile = { coverages: Coverage[]; findings: (PatientFinding & { text: string })[] };

const LABEL: Record<PatientFactKey, string> = { careLevel: "要介護度", table7: "別表第七", table8_2: "別表第八の二", homeOxygen: "在宅酸素療法" };

/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

function show(key: PatientFactKey, v: number | boolean): string {
  if (key === "careLevel") return v === 0 ? "要支援・非該当" : `要介護${v}`;
  if (key === "homeOxygen") return v ? "している" : "していない";
  return v ? "当たる" : "当たらない";
}

/** 加入情報の呼び名（医保／公費1…） */
const coverageName = (c: Coverage) => (c.kind === "医保" ? "医保" : `公費${c.position}`);
const ratioText = (r: number | null) => (r === null ? "分からない" : `${Math.round(r * 10)} 割`);
const periodText = (c: Coverage) =>
  c.validFrom || c.validUntil ? `${c.validFrom ?? ""}〜${c.validUntil ?? "（定めなし）"}` : c.checkedAt ? "期限の定めなし" : "分からない";

export function PatientPanel(props: { claimId: string; facts: Facts; editable: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [key, setKey] = useState<PatientFactKey>("careLevel");
  const [value, setValue] = useState("");
  const [source, setSource] = useState<string>(FACT_SOURCES[0]);
  const [validUntil, setValidUntil] = useState("");
  const [err, setErr] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  // 保険・公費の確認入力（どの加入情報か・番号・負担割合・有効期間・確かめた根拠）
  const [cov, setCov] = useState("");
  const [payerNumber, setPayerNumber] = useState("");
  const [memberNo, setMemberNo] = useState("");
  const [ratio, setRatio] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [noExpiry, setNoExpiry] = useState(false);
  const [covSource, setCovSource] = useState<string>(COVERAGE_SOURCES[0]);
  const [covErr, setCovErr] = useState("");

  const load = () =>
    fetch(`/api/patients/${props.claimId}/facts`)
      .then((r) => r.json())
      .then((d: { facts?: Row[] }) => setRows(d.facts ?? []))
      .catch(() => setRows([]));
  /** 入力欄を、選んだ加入情報の今の値で埋める */
  function pick(c: Coverage | undefined) {
    setCov(c?.coverageId ?? "");
    setPayerNumber(c?.payerNumber ?? "");
    setMemberNo(c?.memberNo ?? "");
    setRatio(c?.burdenRatio == null ? "" : String(c.burdenRatio));
    setFrom(c?.validFrom ?? "");
    setUntil(c?.validUntil ?? "");
    setNoExpiry(false);
    setCovErr("");
  }
  /** 取り直した内容を出す。keep は、選んだままにする加入情報の id */
  function showProfile(d: Profile, keep: string) {
    setProfile(d);
    pick(d.coverages.find((c) => c.coverageId === keep) ?? d.coverages[0]);
  }
  const loadProfile = (keep: string) =>
    fetch(`/api/patients/${props.claimId}/profile`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Profile | null) => (d ? showProfile(d, keep) : setProfile(null)))
      .catch(() => setProfile(null));
  useEffect(() => {
    void load();
    void loadProfile("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.claimId]);

  async function save() {
    setErr("");
    const fact = { key, value: key === "careLevel" ? Number(value) : value === "true", source, validUntil: key === "careLevel" ? validUntil || null : null };
    const r = await fetch(`/api/patients/${props.claimId}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json();
    if (!r.ok) return setErr(d.error ?? "エラー");
    setRows(d.facts);
    setValue("");
    setValidUntil("");
    // 要介護認定の期限の指摘を出し直す
    void loadProfile(cov);
    props.onSaved();
  }

  const selected = profile?.coverages.find((c) => c.coverageId === cov);
  async function saveCoverage() {
    if (!selected) return;
    setCovErr("");
    const coverage = {
      coverageId: selected.coverageId,
      source: covSource,
      ...(payerNumber !== selected.payerNumber ? { payerNumber } : {}),
      ...(selected.kind === "公費" && memberNo !== selected.memberNo ? { memberNo } : {}),
      ...(selected.kind === "医保" && ratio !== "" ? { burdenRatio: Number(ratio) } : {}),
      validFrom: from || null,
      validUntil: noExpiry ? null : until || null,
    };
    const r = await fetch(`/api/patients/${props.claimId}/coverages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coverage }) });
    const d = await r.json();
    if (!r.ok) return setCovErr(d.error ?? "エラー");
    showProfile(d, selected.coverageId);
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
      {profile && (
        <div>
          <h3>患者情報の確認</h3>
          <p className="muted">保険・公費・期限について、医療事務が確かめる点です（ユスティの判定とは別です）</p>
          {profile.findings.length === 0 && <p className="muted">確かめる点はありません</p>}
          {profile.findings.map((f, i) => {
            const c = profile.coverages.find((x) => x.coverageId === f.coverageId);
            return (
              <div key={i} className="notice warn">
                <span className="badge warn">{f.kind}</span>　{c ? `${coverageName(c)}：` : ""}{f.text}
              </div>
            );
          })}
          <div style={{ overflowX: "auto" }}>
            <table>
              <tbody>
                {profile.coverages.map((c) => (
                  <tr key={c.coverageId}>
                    <td>{coverageName(c)}</td>
                    <td>{c.payerNumber}{c.kind === "公費" ? `／${c.memberNo}` : ""}</td>
                    <td>{c.kind === "医保" ? ratioText(c.burdenRatio) : ""}</td>
                    <td>{periodText(c)}</td>
                    <td className="muted">{c.checkedAt ? `${c.checkedAt.slice(0, 10)} に${c.source}で確かめた` : "取り込んだ値"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {props.editable && selected && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "8px 0" }}>
              <select value={cov} onChange={(e) => pick(profile.coverages.find((c) => c.coverageId === e.target.value))}>
                {profile.coverages.map((c) => <option key={c.coverageId} value={c.coverageId}>{coverageName(c)}</option>)}
              </select>
              <label>{selected.kind === "医保" ? "保険者番号" : "公費負担者番号"} <input inputMode="numeric" maxLength={12} value={payerNumber} onChange={(e) => setPayerNumber(e.target.value)} style={{ width: 110, maxWidth: "100%" }} /></label>
              {selected.kind === "公費" && (
                <label>受給者番号 <input inputMode="numeric" maxLength={12} value={memberNo} onChange={(e) => setMemberNo(e.target.value)} style={{ width: 100, maxWidth: "100%" }} /></label>
              )}
              {selected.kind === "医保" && (
                <label>負担割合{" "}
                  <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
                    <option value="">選ぶ</option>
                    {BURDEN_RATIOS.map((b) => <option key={b} value={b}>{ratioText(b)}</option>)}
                  </select>
                </label>
              )}
              <label>有効期間 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label>〜 <input type="date" value={until} disabled={noExpiry} onChange={(e) => setUntil(e.target.value)} /></label>
              <label><input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> 期限の定めなし</label>
              <select value={covSource} onChange={(e) => setCovSource(e.target.value)}>
                {COVERAGE_SOURCES.map((s) => <option key={s} value={s}>{s}で確かめた</option>)}
              </select>
              <button disabled={!noExpiry && until === ""} onClick={() => void saveCoverage()}>残す</button>
              {covErr && <span className="notice warn">{covErr}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
