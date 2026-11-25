"use client";
// 「情報不足」の項目に、その場で答えを残す入力（請求ごとに確かめた事実。POST /api/claims/[claimId]/facts）と、残した答えの一覧。
// 入るのは、人が確かめて残した値だけ。医師あての項目は医師の役割だけが残せる（医療事務には「医師に確認が要ります」と出す）。
// 患者ごとに残す項目（PATIENT_FACT_KEYS。要介護度・居住の場所など。月をまたいで残る）は、患者情報の欄へ誘導する。patientInline の画面（取り込んだレセプトの点検）では、同じ入力をその場にも出す（POST /api/patients/[claimId]/facts）。
// 施設の設定の情報不足は、事務長なら設定の画面の該当の項目へ、ほかの役割なら「事務長が設定の画面で残します」と案内する（FR-148）。
// 入力では消えない情報不足（カルテの記録がない・対象外の行）には何も出さない。
// 背反の特例条件の例外の問い（design.md §13-3）は、同じ入口に選択肢の文字列を残す（AskInput。取り込んだレセプトの点検の画面で、問いのついた指摘の下に出す）
import { useEffect, useState } from "react";
import { CLAIM_FACT_SOURCES, DEATH_PLACES, MAX_MAIN_DISEASE, inputKindOf, isClaimFactKey, type ClaimFact, type ClaimFactKey, type HaihanFactKey } from "../src/claim/facts";
import type { Finding } from "../src/engine/types";
import { exceptionOf, parseHaihanKey, sharedExceptionOf, sharedFactOf } from "../src/generic/haihan";
import type { GenericAsk, GenericDeclaration } from "../src/generic/view";
import { FACT_LABEL, fillLocal, LOCAL_PAIR_TEXT } from "../src/messages";
import { parseLocalKey } from "../src/generic/local-pair";
import { ROLE_LABELS } from "../src/server/roles";
import { FACT_SOURCES, PATIENT_FACT_KEYS, type PatientFactKey } from "../src/patient/facts";
import { BUILDING_BAND_GUIDE } from "../src/messages";
import { LABEL as PATIENT_LABEL, choicesOf, factValueOf, show as showPatientFact } from "./work/patient-panel";
import { CareCertForm } from "./care-cert-input";
import type { Role } from "../src/server/roles";

/** checkedByRole は、院内の知識で押した事実（local:*）だけが持つ（押した人の役割。名前は返らない） */
type Saved = ClaimFact & { target: "doctor" | "clerk"; checkedByName: string; checkedByRole?: string };

const dayText = (date: string | null) => (date ? `（${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日）` : "");
const show = (v: boolean | string) => (typeof v === "boolean" ? (v ? "はい" : "いいえ") : v);
/** 確かめ方の言い方（「医師に確認で確かめた」とならないように） */
const how = (s: string) => (s === "医師に確認" ? "医師に確認した" : `${s}で確かめた`);

/** いまの役割（同じ画面の入力で 1 回だけ取る） */
let roleOnce: Promise<Role | null> | null = null;
export function useRole(): Role | null {
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
  const shared = sharedExceptionOf(props.factKey)?.ask?.choices.map((c) => c.label);
  async function save() {
    setErr("");
    const fact = { key: props.factKey, date: props.date, value: kind === "boolean" && !shared ? value === "true" : value, source };
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    setValue("");
    props.onSaved();
  }
  // 例外の問いと共有する事実（sameDayOushinAfterVisit）は、その例外の問いと同じ選択肢（「その他」「判定不能」を含む）で答える（利用者の判断 2026-11-22）
  const options = shared ? shared.map((c) => [c, c]) : kind === "boolean" ? [["true", "はい"], ["false", "いいえ"]] : DEATH_PLACES.map((x) => [x, x]);
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

/** 例外の問いの答えの入力：選択肢（「その他」「判定不能」を含む）から 1 つと、確かめ方。日ごとの問いは、聞かれている日の答えを残す */
function ChoiceForm(props: { claimId: string; factKey: HaihanFactKey; date: string | null; question: string; choices: string[]; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [source, setSource] = useState<string>(CLAIM_FACT_SOURCES[0]);
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    const fact = { key: props.factKey, date: props.date, value, source };
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    setValue("");
    props.onSaved();
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <select aria-label={`${props.question}${dayText(props.date)}`} value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: "100%" }}>
        <option value="">選ぶ</option>
        {props.choices.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select aria-label="確かめ方" value={source} onChange={(e) => setSource(e.target.value)}>
        {CLAIM_FACT_SOURCES.map((x) => <option key={x} value={x}>{how(x)}</option>)}
      </select>
      <button disabled={value === ""} onClick={() => void save()}>残す</button>
      {err && <span className="notice warn">{err}</span>}
    </span>
  );
}

/**
 * 背反の特例条件の例外の問い（データで動く点検の G05.exception_ask の下に出す）。残せるのは算定の仕事をする人（医療事務あて）。
 * 例外の問いは選択肢から、R10 と同じ「別々の診療か」は、はい・いいえで残す。日ごとの問いは、聞かれている日ごとに 1 つ
 */
export function AskInput(props: { claimId: string; ask: GenericAsk; onSaved: () => void; handAsked?: { field: string; date: string | null }[] }) {
  const role = useRole();
  const { ask } = props;
  if (!canSave(role, "clerk")) return role === null ? null : <div className="muted">医療事務が答えを残します。</div>;
  // 同じ日の同じ事実を、手書きのルール（R10）の情報不足が聞いているときは、ここでは選択肢を出さず、そちらへ案内する（同じ問いを 2 つ出さない。利用者の判断 2026-11-22）
  const x = exceptionOf(ask.hx);
  const field = ask.kind === "fact" ? ask.key : x ? sharedFactOf(x) : null;
  const byHand = (d: string | null) => field !== null && (props.handAsked ?? []).some((m) => m.field === field && m.date === d);
  const dates: (string | null)[] = (ask.dates.length > 0 ? ask.dates : [null]).filter((d) => !byHand(d));
  const handed = ask.dates.filter((d) => byHand(d));
  if (dates.length === 0) return <div className="muted" style={{ marginTop: 6 }}>下の「情報不足」にある R10 の問い{handed.map(dayText).join("")}に答えると、この指摘も決まります。</div>;
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
      <div>{ask.question}</div>
      {dates.map((d) => (
        <div key={d ?? ""}>
          {d && <span className="muted">{dayText(d)} </span>}
          {ask.kind === "fact"
            ? <FactForm claimId={props.claimId} factKey={ask.key} date={d} onSaved={props.onSaved} />
            : <ChoiceForm claimId={props.claimId} factKey={ask.key as HaihanFactKey} date={d} question={ask.question} choices={ask.choices} onSaved={props.onSaved} />}
        </div>
      ))}
      {handed.length > 0 && <div className="muted">{handed.map(dayText).join("")}は、下の「情報不足」にある R10 の問いに答えると、この指摘も決まります。</div>}
    </div>
  );
}

/** 患者ごとに残す項目の入力（患者パネルと同じ項目・同じ API）。残した値は、同じ患者のほかの月の請求にも使う */
function PatientFactForm(props: { claimId: string; factKey: PatientFactKey; onSaved: () => void }) {
  // 要介護度は認定（careCert）で入れる（design.md §18-1）
  if (props.factKey === "careLevel" || props.factKey === "careCert") return <CareCertForm claimId={props.claimId} onSaved={() => props.onSaved()} />;
  return <PlainPatientFactForm {...props} />;
}

function PlainPatientFactForm(props: { claimId: string; factKey: PatientFactKey; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [source, setSource] = useState<string>(FACT_SOURCES[0]);
  const [fromMonth, setFromMonth] = useState("");
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    const fact = { key: props.factKey, value: factValueOf(props.factKey, value, fromMonth), source, validUntil: null };
    const r = await fetch(`/api/patients/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    setValue("");
    props.onSaved();
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <select aria-label={PATIENT_LABEL[props.factKey]} value={value} onChange={(e) => setValue(e.target.value)}>
        <option value="">選ぶ</option>
        {choicesOf(props.factKey).map((v) => <option key={String(v)} value={String(v)}>{showPatientFact(props.factKey, v)}</option>)}
      </select>
      <select aria-label="確かめ方" value={source} onChange={(e) => setSource(e.target.value)}>
        {FACT_SOURCES.map((s) => <option key={s} value={s}>{how(s)}</option>)}
      </select>
      {props.factKey === "buildingBand" && <label>いつの診療月から <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} /></label>}
      <button disabled={value === "" || (props.factKey === "buildingBand" && fromMonth === "")} onClick={() => void save()}>残す</button>
      {props.factKey === "buildingBand" && <span className="muted">{BUILDING_BAND_GUIDE}</span>}
      {err && <span className="notice warn">{err}</span>}
    </span>
  );
}

/**
 * 情報不足の 1 項目に添える入力。日付ごとの事実は、聞かれている日の答えを残す。patientHref は、患者情報の欄への行き先。
 * patientInline：患者ごとに残す項目の入力を、その場にも出す（算定の仕事をする人にだけ）
 */
export function FactInput(props: { claimId: string; finding: Finding; patientHref: string; onSaved: () => void; patientInline?: boolean }) {
  const role = useRole();
  const m = props.finding.missing;
  if (!m) return null;
  // 住まいの種別は聞き取りの画面で答える（design.md §18-2・§18-5。C-494）
  if (m.field === "residenceType") return <div className="muted">住まいの種別は「点検の前に確かめること」の画面で残します。<a href="/uke/care-check">聞き取りの画面へ</a></div>;
  if ((PATIENT_FACT_KEYS as readonly string[]).includes(m.field)) {
    return (
      <div className="muted">
        この項目は患者ごとに残します（同じ患者のほかの月の請求にも使います）。月末の点検の「患者情報」の欄で、確定の前に残せます。<a href={props.patientHref}>患者情報の欄へ</a>
        {props.patientInline && (role === "clerk" || role === "veteran") && <div style={{ marginTop: 6 }}><PatientFactForm claimId={props.claimId} factKey={m.field as PatientFactKey} onSaved={props.onSaved} /></div>}
      </div>
    );
  }
  // 施設の設定（field が facility. で始まる。design.md §6-1・spec FR-148）：残すのは事務長と責任者（ベテラン）。設定の画面の、その項目へ案内する
  if (m.field.startsWith("facility.")) {
    if (role === null) return null;
    return role === "manager" || role === "veteran"
      ? <div className="muted">この項目は施設の設定です。<a href={`/settings#facility-${m.field.slice("facility.".length)}`}>設定の画面で残す</a></div>
      : <div className="muted">この項目は施設の設定です。事務長か責任者（ベテラン）が設定の画面で残します。</div>;
  }
  if (!isClaimFactKey(m.field) || role === null) return null;
  if (!canSave(role, m.target)) return m.target === "doctor" ? <div className="muted">医師に確認が要ります。医師確認の画面の「確かめてほしい項目」に出ています。医師の役割の利用者が、確かめた答えを残します。</div> : null;
  return <div style={{ marginTop: 6 }}><FactForm claimId={props.claimId} factKey={m.field} date={m.date ?? null} onSaved={props.onSaved} /></div>;
}

/**
 * 施設基準（G10）の指摘から施設の申告の画面へつなぐ入口（design.md §15-9）。申告を残せるのは事務長と責任者（ベテラン）で、ほかの役割には頼む先を出す。
 * 確かめ直す日を過ぎた項目は、その診療月で効く行を選んだ「変わりなし」を開ける（round-53 C-274）
 */
export function DeclarationLink(props: { declaration: GenericDeclaration }) {
  const role = useRole();
  const { month, items } = props.declaration;
  if (role === null || items.length === 0) return null;
  const canEdit = role === "manager" || role === "veteran";
  return (
    <div className="muted">
      {items.map(({ item, reconfirm }) => (
        <span key={item} style={{ marginRight: 12 }}>
          <a href={`/settings#declaration-${item}`}>施設の申告を見る</a>
          {canEdit && reconfirm && <>　<a href={`/settings?confirmMonth=${encodeURIComponent(month)}&item=${encodeURIComponent(item)}#declaration-confirm`}>変わりなしとして確かめ直す</a></>}
        </span>
      ))}
      {!canEdit && "事務長に施設の申告を頼んでください"}
    </div>
  );
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
  /** 院内の知識で押した「条件に当たる」を取り消す（値を偽で送る。サーバーが取り消しの行を足す） */
  async function unpress(f: Saved) {
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: { key: f.key, date: f.date, value: false, source: f.source } }) });
    if (r.ok) props.onSaved();
  }
  if (facts.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {facts.map((f) => {
        const id = `${f.key}|${f.date ?? ""}`;
        // 院内の知識で「この請求も条件に当たる」と押した事実（design.md §14-3）：押した人の役割だけを出す（名前・レベルは出さない）。直す入力はない
        const local = parseLocalKey(f.key);
        if (local) return (
          <div key={id} className="notice ok">
            確かめた：{fillLocal(LOCAL_PAIR_TEXT.pressedFact, { id: local.id, a: local.codes[0], b: local.codes[1] })}{dayText(f.date)}
            <span className="muted">（{ROLE_LABELS[f.checkedByRole as Role] ?? ""}・{f.checkedAt.slice(0, 10)}・{how(f.source)}）</span>
            {/* 押し間違いを取り消す（round-43 codex #4）。知識は要再検証にしない */}
            {canSave(role, "clerk") && <> <button onClick={() => void unpress(f)}>{LOCAL_PAIR_TEXT.unpress}</button></>}
          </div>
        );
        // 例外の問いの答え（haihan:*）は、問いの文と、どの組（コード）の答えかを出す。直すときは同じ選択肢から（答えを変えれば問い直す）
        const k = isClaimFactKey(f.key) ? null : parseHaihanKey(f.key);
        const ask = k ? exceptionOf(k.hx)?.ask : undefined;
        const label = k ? `特例の例外の問い（${k.hx}・コード ${k.codes.join(" と ")}）「${ask?.question ?? ""}」` : FACT_LABEL[f.key as ClaimFactKey];
        const done = () => { setEditing(""); props.onSaved(); };
        return (
          <div key={id} className="notice ok">
            確かめた：{label}{dayText(f.date)}＝{show(f.value)}
            <span className="muted">（{f.checkedByName || f.checkedBy}・{f.checkedAt.slice(0, 10)}・{how(f.source)}）</span>
            {canSave(role, f.target) && (editing === id
              ? <div style={{ marginTop: 6 }}>{k ? <ChoiceForm claimId={props.claimId} factKey={f.key as HaihanFactKey} date={f.date} question={ask?.question ?? ""} choices={ask?.choices.map((c) => c.label) ?? []} onSaved={done} /> : <FactForm claimId={props.claimId} factKey={f.key as ClaimFactKey} date={f.date} onSaved={done} />}</div>
              : <> <button onClick={() => setEditing(id)}>直す</button></>)}
          </div>
        );
      })}
      {props.note && <p className="muted" style={{ margin: 0 }}>{props.note}</p>}
    </div>
  );
}
