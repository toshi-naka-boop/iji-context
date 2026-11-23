"use client";
// 施設の申告と設定（spec FR-148・FR-188〜191。design.md §2-7・§15-2・§15-9）。
// 申告：施設の種別・注16・院内／院外処方・施設基準コードごとの届出を、確かめた日と確かめ直す日つきで残す（追記。前の申告は変更の記録に残る）。読むのはどのロールも、残すのは事務長と責任者。
// 設定：申告に移さない項目（物価対応料・同じ日の重ね）を、今までどおり 1 項目ずつ残す。残した操作は監査ログに項目の名前で残る（値は残さない）
import { useEffect, useState } from "react";
import type { FacilityFactKey } from "../../src/engine/types";
import { changeNotices, NOTE14_LABEL, prevMonthOf, valueLabel, type DeclarationRow, type RecheckNotice } from "../../src/facility/declaration";
import { NOTE14_OVERRIDE_REASONS, NOTE14_TEXT } from "../../src/facility/note14";
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

type Row = DeclarationRow;
type Item = { key: string; code: string | null; name: string | null; abbrev: string | null; row: Row | null; later: Row[]; noFromMonth: boolean; status: { v: "held" | "not" | "unknown"; reason: string | null }; history: number };
export type Declarations = {
  today: string;
  gradeChoices: { id: string; label: string }[];
  items: Item[];
  unlisted: { code: string; count: number }[];
  recheck: { rows: RecheckNotice[]; noFromMonth: string[] };
  recheckNoticeDays: number;
  recheckDefaultMonths: Record<string, number>;
  selectable: Row[];
  initialSelection: number[];
  mismatches: string[];
  /** 注14 の道具の結果との比べ（L-160。段 17h。道具の結果の表は段 17i） */
  note14: { month: string | null; state: "none" | "same" | "differs" | "block"; managerLine?: string; note?: string };
  /** 注14 の確かめ直す日の既定（今日の次の確認月の末日） */
  note14RecheckDefault: string;
};

const STATUS_LABEL = { held: "持つ", not: "持たない", unknown: "分からない" } as const;
const NOTIFIED: [string, string][] = [["yes", "届出あり"], ["no", "届出なし"], ["unknown", "分からない"]];
const REQUIREMENT: [string, string][] = [["met", "満たす"], ["not_met", "満たさない"], ["unknown", "分からない"]];
const DISPENSING: [string, string][] = [["outside", "院外処方だけ"], ["inside", "院内処方もある"], ["unknown", "分からない"]];
const BUILDING: [string, string][] = [["none", "ない"], ["some", "ある"], ["unknown", "分からない"]];
/** 注14 は結果の側の言い方（design.md §15-2） */
const NOTE14: [string, string][] = Object.entries(NOTE14_LABEL);
const OVERRIDE: [string, string][] = [["", "理由を選ぶ"], ...Object.entries(NOTE14_OVERRIDE_REASONS)];
const SOURCE: Record<string, string> = { input: "入力", seed: "デモの初期値", migrated: "前の設定から移した値" };

/** 申告の項目の名前（画面の見出し） */
export function itemLabel(it: Pick<Item, "key" | "code" | "name" | "abbrev">): string {
  if (it.key === "grade") return "施設の種別";
  if (it.key === "note16") return "在医総管 注16 の基準";
  if (it.key === "dispensing") return "院内処方か院外処方か";
  if (it.key === "building") return "同じ建物で同じ月に 2 人以上を診ている建物があるか";
  if (it.key === "note14") return "在医総管・施医総管 注14（10 人以上の区分の点数）";
  const name = it.name ?? "（名称は別紙7-8 の一覧で確かめてください）";
  return `コード ${it.code} ${name}${it.abbrev ? `　厚生局の略称 ${it.abbrev}（推測）` : ""}`;
}

/** 確かめ直す日の既定：確かめた日の n か月後（n は項目ごと。注16 は 3 か月、ほかは 1 年。設計の値。変えてよい。docs M-5） */
function recheckDefault(months: Record<string, number>, key: string, day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + (months[key] ?? months.default));
  return d.toISOString().slice(0, 10);
}

/** 今の申告を短く */
const rowSummary = (it: Item): string => (it.row ? valueLabel(it.row) : it.noFromMonth ? "いつの診療月からが入っていません" : "申告なし");

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
function MonthInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {props.label}
      <input type="month" aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
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

/** 1 項目の行（変更の記録。古い順）を読む */
function useHistory(item: string): Row[] | null {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    getJson<{ rows: Row[] }>(`/api/facility/declaration/history?item=${encodeURIComponent(item)}`).then((d) => setRows([...d.rows].reverse())).catch(() => setRows([]));
  }, [item]);
  return rows;
}

/**
 * 1 項目を残す欄。mode が change（変更）なら、いつの診療月からは前の行があれば空（選ばせる）、なければ今日の前の月。
 * recheck（確かめ直し）なら、前の行の from_month・算定開始年月日・値を初期値にする（確かめ直しで前の月を落とさないように。docs L-1）
 */
function DeclForm(props: { item: Item; data: Declarations; mode: "change" | "recheck"; onSaved: (d: Declarations) => void; onCancel: () => void }) {
  const { item, data, mode } = props;
  const history = useHistory(item.key);
  const r = item.row;
  const kind = item.key === "grade" || item.key === "note16" || item.key === "dispensing" || item.key === "building" || item.key === "note14" ? item.key : "code";
  const [override, setOverride] = useState("");
  // 道具の結果（減算になる）と違う「通常」を残すとき（L-160）：警告を出し、理由を必ず 1 つ選ばせる
  const warnNote14 = kind === "note14" && data.note14.state === "block" && data.note14.month !== null;
  const [fromMonth, setFromMonth] = useState(mode === "recheck" ? (r?.fromMonth ?? "") : r || item.noFromMonth ? "" : prevMonthOf(data.today));
  const [choice, setChoice] = useState(r?.choice ?? (kind === "code" ? "" : UNKNOWN));
  const [notified, setNotified] = useState<string>(r?.notified && r.notified !== "na" ? r.notified : UNKNOWN);
  const [requirement, setRequirement] = useState<string>(r?.requirement ?? UNKNOWN);
  const [startOn, setStartOn] = useState(r?.startOn ?? "");
  const [notifiedOn, setNotifiedOn] = useState(r?.notifiedOn ?? "");
  const [checkedOn, setCheckedOn] = useState(data.today);
  const [recheckOn, setRecheckOn] = useState(item.key === "note14" ? data.note14RecheckDefault : recheckDefault(data.recheckDefaultMonths, item.key, data.today));
  const [err, setErr] = useState("");
  const orNull = (s: string) => (s === "" ? null : s);
  // 届出ありの行では、いつの診療月からの初期値を算定開始年月日の月にする（同じにしなくてよい）
  function changeStartOn(v: string) {
    setStartOn(v);
    if (fromMonth === "" && v !== "") setFromMonth(v.slice(0, 7));
  }
  const notices = fromMonth !== "" && history ? changeNotices(history, item.key, fromMonth, data.today) : [];
  const retro = fromMonth !== "" && fromMonth < prevMonthOf(data.today);
  async function save() {
    setErr("");
    const dates = { fromMonth, checkedOn: orNull(checkedOn), recheckOn: orNull(recheckOn) };
    const body =
      kind === "grade"
        ? { item: "grade", choice, requirement, startOn: orNull(startOn), notifiedOn: orNull(notifiedOn), ...dates }
        : kind === "note16"
          ? { item: "note16", requirement, ...dates }
          : kind === "dispensing" || kind === "building"
            ? { item: kind, choice, ...dates }
            : kind === "note14"
              ? { item: "note14", choice, notifiedOn: choice === "reduced" ? orNull(notifiedOn) : null, startOn: choice === "reduced" ? orNull(startOn) : null, ...(warnNote14 && choice === "normal" && override !== "" ? { override: { reason: override, month: data.note14.month } } : {}), ...dates }
            : { item: item.key, notified, requirement, startOn: orNull(startOn), notifiedOn: orNull(notifiedOn), choice: item.code === "4100" && choice !== "" ? choice : null, ...dates };
    try {
      props.onSaved(await postJson<Declarations>("/api/facility/declaration", body));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", margin: "6px 0" }}>
      <MonthInput label="いつの診療月から" value={fromMonth} onChange={setFromMonth} />
      {kind === "grade" && <Select label="種別" value={choice} options={[...data.gradeChoices.map((c): [string, string] => [c.id, c.label]), [UNKNOWN, "分からない"]]} onChange={setChoice} />}
      {kind === "dispensing" && <Select label="処方" value={choice} options={DISPENSING} onChange={setChoice} />}
      {kind === "building" && <Select label="2 人以上の建物" value={choice} options={BUILDING} onChange={setChoice} />}
      {kind === "note14" && <Select label="10 人以上の区分の点数" value={choice} options={NOTE14} onChange={setChoice} />}
      {kind === "note14" && choice === "reduced" && <DayInput label="届出日（任意）" value={notifiedOn} onChange={setNotifiedOn} />}
      {kind === "note14" && choice === "reduced" && <DayInput label="算定開始年月日（任意。判定には使いません）" value={startOn} onChange={setStartOn} />}
      {warnNote14 && choice === "normal" && (
        <div className="notice warn">
          {NOTE14_TEXT.overrideWarning(data.note14.month!)}。<Select label="通常で残す理由" value={override} options={OVERRIDE} onChange={setOverride} />
        </div>
      )}
      {kind === "code" && <Select label="届出" value={notified} options={NOTIFIED} onChange={setNotified} />}
      {kind === "code" && item.code === "4100" && <Select label="区分" value={choice} options={[["", "選ぶ"], ["1", "加算1"], ["2", "加算2"]]} onChange={setChoice} />}
      {kind !== "dispensing" && kind !== "building" && kind !== "note14" && <Select label="要件" value={requirement} options={REQUIREMENT} onChange={setRequirement} />}
      {(kind === "grade" || kind === "code") && <DayInput label="算定開始年月日" value={startOn} onChange={changeStartOn} />}
      {(kind === "grade" || kind === "code") && <DayInput label="届出日" value={notifiedOn} onChange={setNotifiedOn} />}
      <DayInput label="確かめた日" value={checkedOn} onChange={setCheckedOn} />
      <DayInput label="次に確かめ直す日" value={recheckOn} onChange={setRecheckOn} />
      {fromMonth === "" && <div className="notice warn">いつの診療月からの値かを選んでください。</div>}
      {kind === "building" && <div className="muted">「ない」なら、どの患者も単一建物 1 人の区分として点検し、患者ごとには聞きません。「ある」「分からない」なら、医療事務が患者ごとの人数の区分を、変わったときに入れます（施設基準ではないので、届出の欄は対象外）。</div>}
      {kind === "note16" && <div className="muted">注16 の基準を変更したときは様式 19 で届け出ます（マスターにコードがないので、届出の欄は対象外）。いつの診療月から効くかは、通知で確かめてください。</div>}
      {notices.map((n) => <div key={n} className="notice">{n}</div>)}
      <button className="primary" disabled={fromMonth === "" || (warnNote14 && choice === "normal" && override === "")} onClick={() => void save()}>{retro || notices.length > 0 ? "確かめて残す" : "残す"}</button>
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
          {r.checkedOn ?? "確かめた日なし"}　{r.checkedBy}（{SOURCE[r.source] ?? r.source}）：{r.fromMonth ? `${r.fromMonth} から` : "いつの診療月からなし"}・届出 {r.notified}・要件 {r.requirement}{r.choice ? `・${r.choice}` : ""}・算定開始 {r.startOn ?? "—"}・確かめ直す日 {r.recheckOn ?? "—"}
        </li>
      ))}
    </ul>
  );
}

function DeclItem(props: { item: Item; data: Declarations; canEdit: boolean; onSaved: (d: Declarations) => void }) {
  const { item, data } = props;
  const [editing, setEditing] = useState<"change" | "recheck" | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const r = item.row;
  return (
    <li id={`declaration-${item.key}`} style={{ marginBottom: 10 }}>
      <div>{itemLabel(item)}</div>
      <div className="muted">
        いまの申告：{rowSummary(item)}{r?.fromMonth ? `（${r.fromMonth} から）` : ""}　判定：{STATUS_LABEL[item.status.v]}{item.status.reason ? `（${item.status.reason}）` : ""}
        {r && `　確かめた日 ${r.checkedOn ?? "なし"}・次に確かめ直す日 ${r.recheckOn ?? "なし"}`}
        {r?.source === "migrated" && "　前の設定から移しました。確かめた日と確かめ直す日を入れてください"}
        {item.later.map((l) => `　${l.fromMonth} から：${valueLabel(l)}`).join("")}
      </div>
      {item.noFromMonth && <div className="notice warn">いつの診療月からを入れてください（入れるまで、この項目は「分からない」として判定します）。</div>}
      {item.key === "grade" && <div className="muted">令和8年5月以前に連携型（機能強化型）を届け出た施設は、(2)ア か (2)イ かをご自身で選んでください（扱いは未確認です）。</div>}
      {item.key === "grade" && item.status.v === "unknown" && r?.requirement === "not_met" && <div className="notice warn">種別を直してください（要件を満たさない種別のままでは、種別を「分からない」として判定します）。</div>}
      <span style={{ display: "inline-flex", gap: 6 }}>
        {props.canEdit && !editing && <button onClick={() => setEditing("change")}>申告を変える</button>}
        {props.canEdit && !editing && (r || item.noFromMonth) && <button onClick={() => setEditing("recheck")}>確かめ直す</button>}
        {item.history > 0 && <button onClick={() => setShowHistory((v) => !v)}>{showHistory ? "記録を閉じる" : `変更の記録（${item.history} 件）`}</button>}
      </span>
      {editing && <DeclForm item={item} data={data} mode={editing} onCancel={() => setEditing(null)} onSaved={(d) => { setEditing(null); props.onSaved(d); }} />}
      {showHistory && <History item={item.key} />}
    </li>
  );
}

/**
 * まとめて「変わりなし」（docs M-5・round-52 X-150・round-53 C-274）：選んだ申告の行（項目と from_month）ごとに、同じ中身で確かめた日と確かめ直す日だけを新しくする。
 * 初期の選択は、申告の画面からは今日の前の月で効く行、知らせ（?confirm=行の id）からは知らせの行、判定の画面の理由（?confirmMonth=年月&item=項目）からはその診療月で効く行
 */
function ConfirmUnchanged(props: { data: Declarations; onSaved: (d: Declarations) => void }) {
  const { data } = props;
  const [picked, setPicked] = useState<number[]>(data.initialSelection);
  const [err, setErr] = useState("");
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const notice = q.get("confirm");
    const month = q.get("confirmMonth");
    const item = q.get("item");
    const url = notice ? `/api/facility/declaration/confirm?notice=${encodeURIComponent(notice)}` : month ? `/api/facility/declaration/confirm?month=${encodeURIComponent(month)}${item ? `&item=${encodeURIComponent(item)}` : ""}` : null;
    if (!url) return;
    getJson<{ ids: number[] }>(url).then((d) => { setPicked(d.ids); document.getElementById("declaration-confirm")?.scrollIntoView(); }).catch((e: Error) => setErr(e.message));
  }, []);
  const labelOf = (key: string) => {
    const it = data.items.find((x) => x.key === key);
    return it ? itemLabel(it) : key;
  };
  async function save() {
    setErr("");
    try {
      props.onSaved(await postJson<Declarations>("/api/facility/declaration/confirm", { ids: picked }));
      setPicked([]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  if (data.selectable.length === 0) return null;
  return (
    <div id="declaration-confirm">
      <h4>選んだ申告を、変わりなしとして確かめ直す</h4>
      <p className="muted">選んだ行と同じ中身で、確かめた日（今日）と次に確かめ直す日（項目ごとの既定）だけを新しくします。いつの診療月からは変わりません。選ばなかった行はそのまま残ります。</p>
      <ul style={{ paddingLeft: 18, listStyle: "none" }}>
        {data.selectable.map((r) => {
          // 道具の結果（減算になる）のまま「通常」の注14 の行は選べない（理由を添える。API も行ごとに断る。round-58 C-331）
          const blocked = r.itemKey === "note14" && r.choice === "normal" && data.note14.state === "block";
          return (
            <li key={r.id}>
              <label>
                <input type="checkbox" disabled={blocked} checked={!blocked && picked.includes(r.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} />
                {labelOf(r.itemKey)}　{r.fromMonth} から：{valueLabel(r)}（確かめ直す日 {r.recheckOn ?? "なし"}）
                {blocked && <span className="notice warn">　{NOTE14_TEXT.differs}。申告の画面で値を選び直して残してください</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {data.recheck.noFromMonth.length > 0 && <p className="muted">いつの診療月からが入っていない申告は選べません。先に、その申告の「確かめ直す」でいつの診療月からを入れてください。</p>}
      <button className="primary" disabled={picked.length === 0} onClick={() => void save()}>選んだ {picked.length} 件を、変わりなしとして確かめ直す</button>
      {err && <span className="notice warn">{err}</span>}
    </div>
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
      <p className="muted">施設基準ごとに、いつの診療月からの値かと、届出と算定開始年月日（地方厚生局の受理の通知か届出受理医療機関名簿の日）、要件を満たしているか、確かめた日と次に確かめ直す日を残します。確かめ直す日を過ぎた申告や、日付のない申告は「分からない」として判定します。前の申告は変更の記録に残ります。</p>
      {err && <div className="notice warn">{err}</div>}
      {data?.mismatches.map((m) => <div key={m} className="notice warn">{m}（判定には申告をそのまま使います）</div>)}
      {data && (
        <ul style={{ paddingLeft: 18 }}>
          {data.items.map((it) => <DeclItem key={`${it.key}-${it.row?.id ?? 0}`} item={it} data={data} canEdit={props.canEdit} onSaved={setData} />)}
        </ul>
      )}
      {data && props.canEdit && <ConfirmUnchanged key={data.selectable.map((r) => r.id).join(",")} data={data} onSaved={setData} />}
      {data && data.unlisted.length > 0 && (
        <>
          <h4>請求に出てきたのに申告にないコード</h4>
          <ul style={{ paddingLeft: 18 }}>
            {data.unlisted.map((u) => {
              const item: Item = { key: `code:${u.code}`, code: u.code, name: null, abbrev: null, row: null, later: [], noFromMonth: false, status: { v: "unknown", reason: null }, history: 0 };
              return (
                <li key={u.code}>
                  {itemLabel(item)}　請求の行 {u.count} 件
                  {props.canEdit && adding !== u.code && <button style={{ marginLeft: 6 }} onClick={() => setAdding(u.code)}>申告に足す</button>}
                  {adding === u.code && <DeclForm item={item} data={data} mode="change" onCancel={() => setAdding(null)} onSaved={(d) => { setAdding(null); setData(d); }} />}
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
