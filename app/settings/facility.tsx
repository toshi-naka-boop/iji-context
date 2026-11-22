"use client";
// 施設の申告と設定（spec FR-148・FR-188〜191。design.md §2-7・§15-2・§15-9）。
// 申告：施設の種別・注16・院内／院外処方・施設基準コードごとの届出を、確かめた日と確かめ直す日つきで残す（追記。前の申告は変更の記録に残る）。読むのはどのロールも、残すのは事務長と責任者。
// 設定：申告に移さない項目（物価対応料・同じ日の重ね）を、今までどおり 1 項目ずつ残す。残した操作は監査ログに項目の名前で残る（値は残さない）
import { useEffect, useState } from "react";
import type { FacilityFactKey } from "../../src/engine/types";
import { FACILITY_LABEL } from "../../src/messages";
import { getJson, postJson } from "../get-json";

type Value = string | boolean | null;
type Settings = { items: { key: FacilityFactKey; value: Value; saved: boolean }[] };

const YES_NO: [string, string][] = [["true", "はい"], ["false", "いいえ"]];
const UNKNOWN = "unknown";
const toText = (v: Value) => (v === null ? UNKNOWN : String(v));
const fromText = (s: string): Value => (s === UNKNOWN ? null : s === "true");
const labelOf = (v: Value) => (v === null ? "分からない" : (YES_NO.find(([x]) => x === String(v))?.[1] ?? String(v)));

function SettingItem(props: { item: Settings["items"][number]; onSaved: (s: Settings) => void }) {
  const { key, value, saved } = props.item;
  const [pick, setPick] = useState(toText(value));
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    try {
      props.onSaved(await postJson<Settings>("/api/facility", { key, value: fromText(pick) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <li id={`facility-${key}`} style={{ marginBottom: 8 }}>
      <div>{FACILITY_LABEL[key]}</div>
      <div className="muted">いまの値：{labelOf(value)}（{saved ? "このクリニックで残した値" : "既定値のまま"}）</div>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select aria-label={FACILITY_LABEL[key]} value={pick} onChange={(e) => setPick(e.target.value)}>
          {YES_NO.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          <option value={UNKNOWN}>分からない</option>
        </select>
        <button disabled={pick === toText(value)} onClick={() => void save()}>残す</button>
        {err && <span className="notice warn">{err}</span>}
      </span>
    </li>
  );
}

/** 申告に移さない設定（事務長と責任者だけが見る） */
function FacilitySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Settings>("/api/facility").then(setSettings).catch((e: Error) => setErr(e.message));
  }, []);
  useEffect(() => {
    if (settings && location.hash.startsWith("#facility-")) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [settings]);
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>施設の設定（届出ではないもの）</h3>
      <p className="muted">判定に使う、届出ではない設定です。確かめられないものは「分からない」にします（その項目に関わる点検は「情報不足」になります）。</p>
      {err && <div className="notice warn">{err}</div>}
      {settings && (
        <ul style={{ paddingLeft: 18 }}>
          {settings.items.map((it) => <SettingItem key={`${it.key}-${toText(it.value)}-${it.saved}`} item={it} onSaved={setSettings} />)}
        </ul>
      )}
    </div>
  );
}

type Row = { id: number; itemKey: string; notified: string; notifiedOn: string | null; startOn: string | null; requirement: string; choice: string | null; checkedBy: string; checkedOn: string | null; recheckOn: string | null; source: string };
type Item = { key: string; code: string | null; name: string | null; abbrev: string | null; row: Row | null; status: { v: "held" | "not" | "unknown"; reason: string | null }; history: number };
export type Declarations = {
  today: string;
  gradeChoices: { id: string; label: string }[];
  items: Item[];
  unlisted: { code: string; count: number }[];
  recheck: { soon: string[]; overdue: string[]; none: string[] };
  recheckNoticeDays: number;
  mismatches: string[];
};

const STATUS_LABEL = { held: "持つ", not: "持たない", unknown: "分からない" } as const;
const NOTIFIED: [string, string][] = [["yes", "届出あり"], ["no", "届出なし"], ["unknown", "分からない"]];
const REQUIREMENT: [string, string][] = [["met", "満たす"], ["not_met", "満たさない"], ["unknown", "分からない"]];
const DISPENSING: [string, string][] = [["outside", "院外処方だけ"], ["inside", "院内処方もある"], ["unknown", "分からない"]];
const SOURCE: Record<string, string> = { input: "入力", seed: "デモの初期値", migrated: "前の設定から移した値" };

/** 申告の項目の名前（画面の見出し） */
export function itemLabel(it: Pick<Item, "key" | "code" | "name" | "abbrev">): string {
  if (it.key === "grade") return "施設の種別";
  if (it.key === "note16") return "在医総管 注16 の基準";
  if (it.key === "dispensing") return "院内処方か院外処方か";
  const name = it.name ?? "（名称は別紙7-8 の一覧で確かめてください）";
  return `コード ${it.code} ${name}${it.abbrev ? `　厚生局の略称 ${it.abbrev}（推測）` : ""}`;
}

/** 確かめ直す日の既定：確かめた日の 3 か月後（設計の値。変えてよい） */
function plusMonths(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** 今の申告を短く（変更の確かめの文に使う） */
function rowSummary(it: Item, choices: Declarations["gradeChoices"]): string {
  const r = it.row;
  if (!r) return "申告なし";
  if (it.key === "grade") return choices.find((c) => c.id === r.choice)?.label ?? "分からない";
  if (it.key === "note16") return REQUIREMENT.find(([v]) => v === r.requirement)?.[1] ?? r.requirement;
  if (it.key === "dispensing") return DISPENSING.find(([v]) => v === r.choice)?.[1] ?? "分からない";
  return `${NOTIFIED.find(([v]) => v === r.notified)?.[1] ?? r.notified}${r.choice ? `・加算${r.choice}` : ""}`;
}

function Select(props: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {props.label}
      <select aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
function DayInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {props.label}
      <input type="date" aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

/** 1 項目を残す欄 */
function DeclForm(props: { item: Item; data: Declarations; onSaved: (d: Declarations) => void; onCancel: () => void }) {
  const { item, data } = props;
  const r = item.row;
  const kind = item.key === "grade" || item.key === "note16" || item.key === "dispensing" ? item.key : "code";
  const [choice, setChoice] = useState(r?.choice ?? (kind === "code" ? "" : UNKNOWN));
  const [notified, setNotified] = useState(r?.notified && r.notified !== "na" ? r.notified : UNKNOWN);
  const [requirement, setRequirement] = useState(r?.requirement ?? UNKNOWN);
  const [startOn, setStartOn] = useState(r?.startOn ?? "");
  const [notifiedOn, setNotifiedOn] = useState(r?.notifiedOn ?? "");
  const [checkedOn, setCheckedOn] = useState(data.today);
  const [recheckOn, setRecheckOn] = useState(plusMonths(data.today, 3));
  const [err, setErr] = useState("");
  const orNull = (s: string) => (s === "" ? null : s);
  // 先の日付から始まる変更：前の申告は、その前日まで判定に使い続ける（design.md §15-2。C-215）
  const future = r !== null && startOn !== "" && startOn > data.today && (kind === "grade" || kind === "code");
  async function save() {
    setErr("");
    const dates = { checkedOn: orNull(checkedOn), recheckOn: orNull(recheckOn) };
    const body =
      kind === "grade"
        ? { item: "grade", choice, requirement, startOn: orNull(startOn), notifiedOn: orNull(notifiedOn), ...dates }
        : kind === "note16"
          ? { item: "note16", requirement, ...dates }
          : kind === "dispensing"
            ? { item: "dispensing", choice, ...dates }
            : { item: item.key, notified, requirement, startOn: orNull(startOn), notifiedOn: orNull(notifiedOn), choice: item.code === "4100" && choice !== "" ? choice : null, ...dates };
    try {
      props.onSaved(await postJson<Declarations>("/api/facility/declaration", body));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "6px 0" }}>
      {kind === "grade" && <Select label="種別" value={choice} options={[...data.gradeChoices.map((c): [string, string] => [c.id, c.label]), [UNKNOWN, "分からない"]]} onChange={setChoice} />}
      {kind === "dispensing" && <Select label="処方" value={choice} options={DISPENSING} onChange={setChoice} />}
      {kind === "code" && <Select label="届出" value={notified} options={NOTIFIED} onChange={setNotified} />}
      {kind === "code" && item.code === "4100" && <Select label="区分" value={choice} options={[["", "選ぶ"], ["1", "加算1"], ["2", "加算2"]]} onChange={setChoice} />}
      {kind !== "dispensing" && <Select label="要件" value={requirement} options={REQUIREMENT} onChange={setRequirement} />}
      {(kind === "grade" || kind === "code") && <DayInput label="算定開始年月日" value={startOn} onChange={setStartOn} />}
      {(kind === "grade" || kind === "code") && <DayInput label="届出日" value={notifiedOn} onChange={setNotifiedOn} />}
      <DayInput label="確かめた日" value={checkedOn} onChange={setCheckedOn} />
      <DayInput label="次に確かめ直す日" value={recheckOn} onChange={setRecheckOn} />
      {future && <div className="notice">{startOn} の前日までは、前の申告（{rowSummary(item, data.gradeChoices)}）で判定します。</div>}
      <button className="primary" onClick={() => void save()}>{future ? "確かめて残す" : "残す"}</button>
      <button onClick={props.onCancel}>やめる</button>
      {err && <span className="notice warn">{err}</span>}
    </div>
  );
}

/** 1 項目の変更の記録 */
function History(props: { item: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<{ rows: Row[] }>(`/api/facility/declaration/history?item=${encodeURIComponent(props.item)}`).then((d) => setRows(d.rows)).catch((e: Error) => setErr(e.message));
  }, [props.item]);
  if (err) return <div className="notice warn">{err}</div>;
  if (!rows) return null;
  return (
    <ul className="muted" style={{ paddingLeft: 18 }}>
      {rows.map((r) => (
        <li key={r.id}>
          {r.checkedOn ?? "確かめた日なし"}　{r.checkedBy}（{SOURCE[r.source] ?? r.source}）：届出 {r.notified}・要件 {r.requirement}{r.choice ? `・${r.choice}` : ""}・算定開始 {r.startOn ?? "—"}・確かめ直す日 {r.recheckOn ?? "—"}
        </li>
      ))}
    </ul>
  );
}

function DeclItem(props: { item: Item; data: Declarations; canEdit: boolean; onSaved: (d: Declarations) => void }) {
  const { item, data } = props;
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const r = item.row;
  return (
    <li id={`declaration-${item.key}`} style={{ marginBottom: 10 }}>
      <div>{itemLabel(item)}</div>
      <div className="muted">
        いまの申告：{rowSummary(item, data.gradeChoices)}　判定：{STATUS_LABEL[item.status.v]}{item.status.reason ? `（${item.status.reason}）` : ""}
        {r && `　確かめた日 ${r.checkedOn ?? "なし"}・次に確かめ直す日 ${r.recheckOn ?? "なし"}`}
        {r?.source === "migrated" && "　前の設定から移しました。確かめた日と確かめ直す日を入れてください"}
      </div>
      {item.key === "grade" && <div className="muted">令和8年5月以前に連携型（機能強化型）を届け出た施設は、(2)ア か (2)イ かをご自身で選んでください（扱いは未確認です）。</div>}
      {item.key === "grade" && item.status.v === "unknown" && r?.requirement === "not_met" && <div className="notice warn">種別を直してください（要件を満たさない種別のままでは、種別を「分からない」として判定します）。</div>}
      <span style={{ display: "inline-flex", gap: 6 }}>
        {props.canEdit && !editing && <button onClick={() => setEditing(true)}>申告を残す</button>}
        {item.history > 0 && <button onClick={() => setShowHistory((v) => !v)}>{showHistory ? "記録を閉じる" : `変更の記録（${item.history} 件）`}</button>}
      </span>
      {editing && <DeclForm item={item} data={data} onCancel={() => setEditing(false)} onSaved={(d) => { setEditing(false); props.onSaved(d); }} />}
      {showHistory && <History item={item.key} />}
    </li>
  );
}

/** 施設の申告（どのロールも読める。canEdit は事務長と責任者） */
export function Declaration(props: { canEdit: boolean }) {
  const [data, setData] = useState<Declarations | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Declarations>("/api/facility/declaration").then(setData).catch((e: Error) => setErr(e.message));
  }, []);
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>施設の申告（施設基準の届出）</h3>
      <p className="muted">施設基準ごとに、届出と算定開始年月日（地方厚生局の受理の通知か届出受理医療機関名簿の日）、要件を満たしているか、確かめた日と次に確かめ直す日を残します。確かめ直す日を過ぎた申告や、日付のない申告は「分からない」として判定します。前の申告は変更の記録に残ります。</p>
      {err && <div className="notice warn">{err}</div>}
      {data?.mismatches.map((m) => <div key={m} className="notice warn">{m}（判定には申告をそのまま使います）</div>)}
      {data && (
        <ul style={{ paddingLeft: 18 }}>
          {data.items.map((it) => <DeclItem key={`${it.key}-${it.row?.id ?? 0}`} item={it} data={data} canEdit={props.canEdit} onSaved={setData} />)}
        </ul>
      )}
      {data && data.unlisted.length > 0 && (
        <>
          <h4>請求に出てきたのに申告にないコード</h4>
          <ul style={{ paddingLeft: 18 }}>
            {data.unlisted.map((u) => {
              const item: Item = { key: `code:${u.code}`, code: u.code, name: null, abbrev: null, row: null, status: { v: "unknown", reason: null }, history: 0 };
              return (
                <li key={u.code}>
                  {itemLabel(item)}　請求の行 {u.count} 件
                  {props.canEdit && adding !== u.code && <button style={{ marginLeft: 6 }} onClick={() => setAdding(u.code)}>申告に足す</button>}
                  {adding === u.code && <DeclForm item={item} data={data} onCancel={() => setAdding(null)} onSaved={(d) => { setAdding(null); setData(d); }} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** 設定の画面の施設の欄：申告はどのロールも読め、届出ではない設定は事務長と責任者だけ */
export function Facility(props: { canEdit: boolean }) {
  return (
    <>
      <Declaration canEdit={props.canEdit} />
      {props.canEdit && <FacilitySettings />}
    </>
  );
}
