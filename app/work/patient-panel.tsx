"use client";
// 算定画面の「患者情報」欄：判定に使う値と、医療事務が確かめた記録（いつ・何で）。保存すると患者ごとに残る。
// 「患者情報の確認」欄：患者情報チェック（P01〜P08）の指摘と、保険・公費の確認入力。ユスティの判定とは別の欄で、宛先は医療事務
import { useEffect, useState } from "react";
import { BUILDING_BANDS, type Facts } from "../../src/engine/types";
import { BUILDING_BAND_GUIDE } from "../../src/messages";
import type { PatientFinding } from "../../src/patient/checks";
import { FACT_SOURCES, PATIENT_FACT_KEYS, RESIDENCES, type BuildingBandValue, type PatientFact, type PatientFactKey } from "../../src/patient/facts";
import { BURDEN_RATIOS, COVERAGE_SOURCES, type Coverage } from "../../src/patient/profile";
import { DevicePanel } from "./device-panel";

type Row = PatientFact & { expired: boolean };
type Profile = { coverages: Coverage[]; caseBurdenRatio: number | null; findings: (PatientFinding & { text: string })[] };

export const LABEL: Record<PatientFactKey, string> = {
  careLevel: "要介護度",
  disabilitySupportLevel: "障害支援区分",
  table7: "別表第七",
  table8_2: "別表第八の二",
  table8_3Other: "別表第八の三（要介護度・障害支援区分以外）",
  homeOxygen: "在宅酸素療法",
  residence: "居住の場所",
  contactDocProvided: "連絡担当者・往診担当医などの文書の提供",
  emergencyEligible: "緊急往診の対象患者か",
  comprehensiveCare: "管理料（在医総管・施設総管）を算定する患者か",
  buildingBand: "単一建物診療患者の人数の区分（みなしを当てたあとの、請求に使う区分）",
};

/** 人数の区分の言い方（EM R8-94） */
export const BAND_LABEL: Record<string, string> = { "1": "1 人", "2-9": "2〜9 人", "10-19": "10〜19 人", "20-49": "20〜49 人", "50+": "50 人以上" };

/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

export function show(key: PatientFactKey, v: number | boolean | string | BuildingBandValue): string {
  if (key === "buildingBand") return typeof v === "object" ? `${BAND_LABEL[v.band] ?? v.band}（${v.fromMonth} の診療月から）` : (BAND_LABEL[String(v)] ?? String(v));
  if (typeof v === "object") return "";
  if (key === "careLevel") return v === 0 ? "要支援・非該当" : `要介護${v}`;
  if (key === "disabilitySupportLevel") return v === 0 ? "認定なし" : `区分${v}`;
  if (key === "residence") return String(v);
  if (key === "homeOxygen") return v ? "している" : "していない";
  if (key === "contactDocProvided") return v ? "提供している" : "提供していない";
  if (key === "emergencyEligible") return v ? "対象" : "対象でない";
  if (key === "comprehensiveCare") return v ? "算定する患者" : "算定しない患者";
  return v ? "当たる" : "当たらない";
}
/** その項目で選べる値 */
export const choicesOf = (key: PatientFactKey): (number | boolean | string)[] =>
  key === "careLevel" ? [0, 1, 2, 3, 4, 5] : key === "disabilitySupportLevel" ? [0, 1, 2, 3, 4, 5, 6] : key === "residence" ? RESIDENCES : key === "buildingBand" ? [...BUILDING_BANDS] : [true, false];
/** 選択肢の文字（select の value）を、残す値に戻す */
export const valueOf = (key: PatientFactKey, raw: string): number | boolean | string =>
  key === "careLevel" || key === "disabilitySupportLevel" ? Number(raw) : key === "residence" || key === "buildingBand" ? raw : raw === "true";

/** 残す値：人数の区分は「いつの診療月から」と組にする（design.md §15-4） */
export const factValueOf = (key: PatientFactKey, raw: string, fromMonth: string): number | boolean | string | BuildingBandValue =>
  key === "buildingBand" ? { band: raw as BuildingBandValue["band"], fromMonth } : valueOf(key, raw);

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
  const [fromMonth, setFromMonth] = useState("");
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
    const fact = { key, value: factValueOf(key, value, fromMonth), source, validUntil: key === "careLevel" ? validUntil || null : null };
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
    <div id="patient-info">
      <h3>患者情報</h3>
      <table>
        <tbody>
          {PATIENT_FACT_KEYS.map((k) => {
            const f = props.facts[k] ?? { known: false };
            const rec = rows.filter((r) => r.key === k).at(-1);
            return (
              <tr key={k}>
                <td>{LABEL[k]}</td>
                <td>{f.known ? show(k, f.value as number | boolean | string) : "分からない"}</td>
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
            {choicesOf(key).map((v) => <option key={String(v)} value={String(v)}>{show(key, v)}</option>)}
          </select>
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {FACT_SOURCES.map((s) => <option key={s} value={s}>{how(s)}</option>)}
          </select>
          {key === "careLevel" && (
            <label>　有効期間の終わり <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
          )}
          {key === "buildingBand" && (
            <label>　いつの診療月から <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} /></label>
          )}
          <button disabled={value === "" || (key === "buildingBand" && fromMonth === "")} onClick={() => void save()}>残す</button>
          {key === "buildingBand" && <span className="muted">　{BUILDING_BAND_GUIDE}</span>}
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
                    <td>
                      {c.kind !== "医保"
                        ? ""
                        : c.burdenRatio === null && profile.caseBurdenRatio !== null
                          ? `${ratioText(profile.caseBurdenRatio)}（カルテの値）`
                          : ratioText(c.burdenRatio)}
                    </td>
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
      <DevicePanel claimId={props.claimId} editable={props.editable} />
    </div>
  );
}
