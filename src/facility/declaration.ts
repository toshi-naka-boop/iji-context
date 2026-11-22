// 施設の申告を、判定に使う三値にする純関数（design.md §15-2「三値の決め方」「判定に渡す形」。FR-188・190）。
// 申告は追記だけの履歴（facility_declarations）。項目ごとに「効く行」を選び、決まった順（X-141）で「持つ・持たない・分からない」を決める。
// 今日の日付は呼び出し側が時計（§11-7）から渡す。ここでは時計を読まない
import kijun from "../../config/shisetsu-kijun.json";
import type { FacilityJson } from "../engine/facility";
import { GRADE_CHOICES, GRADE_CODES, HOSPITAL_CODES, HOSPITAL_SIDE_CODES } from "./codes";

export type Notified = "yes" | "no" | "unknown" | "na";
export type Requirement = "met" | "not_met" | "unknown";
export type DeclarationSource = "input" | "seed" | "migrated";

/** 申告の 1 行（facility_declarations の 1 行）。日付は "YYYY-MM-DD" */
export type DeclarationRow = {
  id: number;
  itemKey: string;
  /** いつの診療月からの値か（"YYYY-MM"。P-2。マイグレーション 13 より前に残した行は null で、効く行に選ばない） */
  fromMonth: string | null;
  notified: Notified;
  notifiedOn: string | null;
  /** 算定開始年月日（地方厚生局の名簿にある日。C-223） */
  startOn: string | null;
  requirement: Requirement;
  choice: string | null;
  checkedBy: string;
  checkedRole: string;
  checkedOn: string | null;
  recheckOn: string | null;
  source: DeclarationSource;
  createdAt: string;
};

export type UnknownReason =
  | "no_row"
  | "no_month_row"
  | "no_from_month"
  | "no_check_date"
  | "expired"
  | "notified_unknown"
  | "requirement_unknown"
  | "no_start_on"
  | "mid_month_start"
  | "grade_unknown"
  | "grade_requirement_not_met";
export type NotReason = "hospital" | "notified_no" | "requirement_not_met" | "before_start" | "grade_lacks";

/** 三値。before_start のときは算定開始年月日を添える */
export type Tri = { v: "held" } | { v: "not"; reason: NotReason; startOn?: string } | { v: "unknown"; reason: UnknownReason };

/** 比べる日：on.day があれば算定日で、なければ診療年月で比べる（月で決まる値・算定日の分からない単位） */
export type On = { yearMonth: string; day?: string };

/** 画面に出す、三値の理由 */
export const TRI_REASON_LABEL: Record<UnknownReason | NotReason, string> = {
  no_row: "申告がありません",
  no_month_row: "その診療月の申告がありません",
  no_from_month: "その診療月の申告がありません（いつの診療月からを入れてください）",
  no_check_date: "確かめた日か確かめ直す日が入っていません",
  expired: "確かめ直す日を過ぎています",
  notified_unknown: "届出が分からない",
  requirement_unknown: "要件を満たしているかが分からない",
  no_start_on: "届出ありですが、算定開始年月日が入っていません",
  mid_month_start: "月の途中から算定開始です",
  grade_unknown: "施設の種別が分からない",
  grade_requirement_not_met: "種別の要件を満たさないと申告されています。種別を直してください",
  hospital: "病院の施設基準のコードです（診療所は持ちません）",
  notified_no: "届出なし",
  requirement_not_met: "要件を満たさない",
  before_start: "算定日が算定開始年月日より前です",
  grade_lacks: "申告の種別では持たないコードです",
};

export const GRADE_KEY = "grade";
export const NOTE16_KEY = "note16";
export const DISPENSING_KEY = "dispensing";
export const codeKey = (code: string) => `code:${code}`;

type KijunRow = { codes: string[]; name: string; listed: string[] };
const KIJUN = (kijun as { rows: KijunRow[] }).rows;

/** 申告の一覧に出す施設基準コード（表 4 の listed。表の順） */
export const LISTED_CODES: string[] = KIJUN.flatMap((r) => r.listed);

/** 表 4 の名称。表 4 にないコードは null（推測で名前を付けない） */
export const kijunNameOf = (code: string): string | null => KIJUN.find((r) => r.codes.includes(code))?.name ?? null;

const pad = (n: number) => String(n).padStart(2, "0");
const firstDayOf = (ym: string) => `${ym}-01`;
function lastDayOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** 同じ項目の、from_month のある行を、有効月（from_month）ごとの組にする（組の中は id の順。組は有効月の順） */
export function monthGroups(rows: DeclarationRow[], itemKey: string): { fromMonth: string; rows: DeclarationRow[] }[] {
  const by = new Map<string, DeclarationRow[]>();
  for (const r of rows.filter((x) => x.itemKey === itemKey && x.fromMonth !== null).sort((a, b) => a.id - b.id)) by.set(r.fromMonth!, [...(by.get(r.fromMonth!) ?? []), r]);
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([fromMonth, rs]) => ({ fromMonth, rows: rs }));
}

/**
 * 効く行（design.md §15-2。P-2・round-50 C-240）：from_month がその診療年月以前の行のうち、from_month が最大の組の最新（MAX(id)）の行。
 * 行を入れた順は結果に効かない（id は同じ from_month の中の直しにだけ使う）。from_month が空の行は選ばない。
 * nextFirst は直後の組（from_month が診療年月より後で最小の組）で最初に残した行（MIN(id)。round-53 C-271）。効く行の「確かめ直す日」を、その行を確かめた日で比べるのに使う
 */
export function effectiveRow(rows: DeclarationRow[], itemKey: string, yearMonth: string): { row: DeclarationRow; nextFirst: DeclarationRow | null } | null {
  const groups = monthGroups(rows, itemKey);
  const cur = groups.filter((g) => g.fromMonth <= yearMonth).at(-1);
  if (!cur) return null;
  const next = groups.find((g) => g.fromMonth > yearMonth);
  return { row: cur.rows.at(-1)!, nextFirst: next?.rows[0] ?? null };
}

/** 年月を n か月ずらす（"YYYY-MM"） */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

const unknown = (reason: UnknownReason): Tri => ({ v: "unknown", reason });
const not = (reason: NotReason, startOn?: string): Tri => (startOn ? { v: "not", reason, startOn } : { v: "not", reason });
const HELD: Tri = { v: "held" };

/** 決める順の 2 の前半（行がない・その診療月の行がない・日付がない・確かめ直す日を過ぎた） */
function gate(rows: DeclarationRow[], itemKey: string, e: ReturnType<typeof effectiveRow>, today: string): Tri | null {
  if (!e) {
    const mine = rows.filter((r) => r.itemKey === itemKey);
    if (!mine.length) return unknown("no_row");
    return unknown(mine.every((r) => r.fromMonth === null) ? "no_from_month" : "no_month_row");
  }
  const { row, nextFirst } = e;
  if (!row.checkedOn || !row.recheckOn) return unknown("no_check_date");
  // 先の月からの変更を入れたときは、前の行の確かめ直す日を、その変更を入れた日（直後の組の最初の行を確かめた日）で比べる（前の月が期限切れで「分からない」に落ちないように）
  const ref = nextFirst?.checkedOn ?? today;
  if (row.recheckOn < ref) return unknown("expired");
  return null;
}

/** 算定開始年月日の比べ方（決める順の 2 の月の途中と、3 の「算定日が算定開始年月日より前」） */
function startCheck(startOn: string, on: On): { mid: boolean; before: boolean } {
  if (on.day) return { mid: false, before: on.day < startOn };
  return { mid: startOn > firstDayOf(on.yearMonth) && startOn <= lastDayOf(on.yearMonth), before: startOn > lastDayOf(on.yearMonth) };
}

/** 施設基準コードの行（`code:<4 桁>`）の三値 */
function codeTri(rows: DeclarationRow[], code: string, on: On, today: string): Tri {
  const e = effectiveRow(rows, codeKey(code), on.yearMonth);
  const g = gate(rows, codeKey(code), e, today);
  if (g) return g;
  const row = e!.row;
  if (row.notified === "unknown") return unknown("notified_unknown");
  if (row.requirement === "unknown") return unknown("requirement_unknown");
  if (row.notified === "yes" && !row.startOn) return unknown("no_start_on");
  const s = row.notified === "yes" && row.startOn ? startCheck(row.startOn, on) : { mid: false, before: false };
  if (s.mid) return unknown("mid_month_start");
  if (row.notified === "no") return not("notified_no");
  if (row.requirement === "not_met") return not("requirement_not_met");
  if (s.before) return not("before_start", row.startOn!);
  return HELD;
}

/** 種別の行の三値。持つとき、選んだ種別を返す */
function gradeTri(rows: DeclarationRow[], on: On, today: string): { tri: Tri; choice: (typeof GRADE_CHOICES)[number] | null } {
  const e = effectiveRow(rows, GRADE_KEY, on.yearMonth);
  const g = gate(rows, GRADE_KEY, e, today);
  if (g) return { tri: g, choice: null };
  const row = e!.row;
  const choice = GRADE_CHOICES.find((c) => c.id === row.choice) ?? null;
  if (!choice) return { tri: unknown("grade_unknown"), choice: null };
  if (row.requirement === "unknown") return { tri: unknown("requirement_unknown"), choice: null };
  // 種別の要件を満たさないと申告されたら、在支診以外と推し量らず「分からない」
  if (row.requirement === "not_met") return { tri: unknown("grade_requirement_not_met"), choice: null };
  // 在支診以外は届出がないので、算定開始年月日を見ない
  if (choice.code === null) return { tri: HELD, choice };
  if (!row.startOn) return { tri: unknown("no_start_on"), choice: null };
  const s = startCheck(row.startOn, on);
  if (s.mid) return { tri: unknown("mid_month_start"), choice: null };
  if (s.before) return { tri: not("before_start", row.startOn), choice: null };
  return { tri: HELD, choice };
}

/** 注16 の行の三値（届出のコードがないので、算定開始年月日を見ない） */
function note16Tri(rows: DeclarationRow[], on: On, today: string): Tri {
  const e = effectiveRow(rows, NOTE16_KEY, on.yearMonth);
  const g = gate(rows, NOTE16_KEY, e, today);
  if (g) return g;
  if (e!.row.requirement === "unknown") return unknown("requirement_unknown");
  if (e!.row.requirement === "not_met") return not("requirement_not_met");
  return HELD;
}

/** 施設基準コード c を、その日（またはその月）に持つか。決める順は X-141 のとおり（在支病・病院の側 → 分からない → 持たない → 持つ） */
export function heldOf(rows: DeclarationRow[], code: string, on: On, today: string): Tri {
  if ((HOSPITAL_CODES as readonly string[]).includes(code) || (HOSPITAL_SIDE_CODES as readonly string[]).includes(code)) return not("hospital");
  if (GRADE_CODES.includes(code)) {
    const { tri, choice } = gradeTri(rows, on, today);
    if (tri.v !== "held") return tri;
    return choice!.code === code ? HELD : not("grade_lacks");
  }
  return codeTri(rows, code, on, today);
}

/** G10 に渡す形：コードごとの三値と名称（design.md §15-2） */
export function declarationView(rows: DeclarationRow[], today: string): { held(code: string, on: On): Tri; nameOf(code: string): string | null } {
  return { held: (code, on) => heldOf(rows, code, on, today), nameOf: kijunNameOf };
}

/** 種別の三値（画面と、事務長の知らせに使う）。月で比べる */
export const gradeOf = (rows: DeclarationRow[], on: On, today: string) => gradeTri(rows, on, today);
export const note16Of = (rows: DeclarationRow[], on: On, today: string) => note16Tri(rows, on, today);

/**
 * 判定に渡す施設の設定（月で決まる値）。grade・note16Met・dxTier・baseUp は必ず入れ、分からないときは null。
 * 種別が分からないときは zaishishin・kyokagata・hasBeds も null（config の値を残さない。X-134 の三値の前提）
 */
export function facilityFromDeclaration(rows: DeclarationRow[], today: string, yearMonth: string): Partial<FacilityJson> {
  const on: On = { yearMonth };
  const { tri, choice } = gradeTri(rows, on, today);
  const grade = tri.v === "held" ? choice!.grade : null;
  const n16 = note16Tri(rows, on, today);
  const dx = codeTri(rows, "4100", on, today);
  const dxChoice = effectiveRow(rows, codeKey("4100"), yearMonth)?.row.choice;
  const dxTier = dx.v === "held" ? (dxChoice === "1" || dxChoice === "2" ? dxChoice : null) : dx.v === "not" ? "なし" : null;
  const b5 = codeTri(rows, "4303", on, today);
  const b = codeTri(rows, "4307", on, today);
  const baseUp = b5.v === "unknown" || b.v === "unknown" ? null : b5.v === "held" ? "注5" : b.v === "held" ? "通常" : "なし";
  return {
    grade,
    note16Met: n16.v === "held" ? true : n16.v === "not" ? false : null,
    dxTier,
    baseUp,
    ...(grade === null ? { zaishishin: null, kyokagata: null, hasBeds: null } : { zaishishin: grade !== "3", kyokagata: grade === "1B" || grade === "1N", hasBeds: grade === "1B" }),
  };
}

/** 院内処方か院外処方かの行の三値（月で決まる値。その診療年月で効く行。決める順の 2 の前半と、選んだ値が「分からない」） */
export function dispensingTri(rows: DeclarationRow[], today: string, yearMonth: string): Tri {
  const e = effectiveRow(rows, DISPENSING_KEY, yearMonth);
  const g = gate(rows, DISPENSING_KEY, e, today);
  if (g) return g;
  const c = e!.row.choice;
  return c === "outside" || c === "inside" ? HELD : unknown("requirement_unknown");
}

/** 院内処方か院外処方か（G11 だけに渡す。段 18）。その請求の診療年月で効く行で決める */
export function dispensingOf(rows: DeclarationRow[], today: string, yearMonth: string): "outside" | "inside" | "unknown" {
  if (dispensingTri(rows, today, yearMonth).v !== "held") return "unknown";
  return effectiveRow(rows, DISPENSING_KEY, yearMonth)!.row.choice as "outside" | "inside";
}

// ───────────────────────────────────────────────────────────────────────────
// 画面に出す確かめの文・確かめ直す日の知らせ・まとめて「変わりなし」の選べる行（design.md §15-2。純関数）

const REQUIREMENT_LABEL: Record<Requirement, string> = { met: "満たす", not_met: "満たさない", unknown: "分からない" };
const NOTIFIED_LABEL: Record<Notified, string> = { yes: "届出あり", no: "届出なし", unknown: "届出が分からない", na: "" };
const DISPENSING_LABEL: Record<string, string> = { outside: "院外処方だけ", inside: "院内処方もある", unknown: "分からない" };

/** 申告の 1 行の値を短く（確かめの文と画面に使う） */
export function valueLabel(row: DeclarationRow): string {
  if (row.itemKey === GRADE_KEY) return GRADE_CHOICES.find((c) => c.id === row.choice)?.label ?? "分からない";
  if (row.itemKey === NOTE16_KEY) return REQUIREMENT_LABEL[row.requirement];
  if (row.itemKey === DISPENSING_KEY) return DISPENSING_LABEL[row.choice ?? "unknown"] ?? "分からない";
  return `${NOTIFIED_LABEL[row.notified]}${row.choice ? `・加算${row.choice}` : ""}`;
}

/** 今日の前の月（入力欄の初期値と、さかのぼる直しの境目。設計の値） */
export const prevMonthOf = (today: string): string => addMonths(today.slice(0, 7), -1);

/**
 * いつの診療月から（fromMonth）の行を残す前に見せる確かめの文（design.md §15-2 の 1。C-240）。
 * 前の行があれば、その前の月は前の申告で判定すること。今日の前の月より前を選んだら（さかのぼる直し）、判定が変わる月の範囲と、先の月からの変更が残ること
 */
export function changeNotices(rows: DeclarationRow[], itemKey: string, fromMonth: string, today: string): string[] {
  const out: string[] = [];
  const before = effectiveRow(rows, itemKey, addMonths(fromMonth, -1));
  if (before) out.push(`${fromMonth} より前の診療月の請求は、前の申告（${valueLabel(before.row)}）で判定します`);
  const prev = prevMonthOf(today);
  if (fromMonth < prev) {
    const later = monthGroups(rows, itemKey).find((g) => g.fromMonth > fromMonth);
    // 終わりの月：選んだ年月より後の行のうち最も早い from_month の前の月（そういう行がなければ今日の前の月）
    const end = later ? addMonths(later.fromMonth, -1) : prev;
    out.push(`${fromMonth} から ${end} までの請求の判定が変わります`);
    if (later) out.push(`${later.fromMonth} からの請求は、「${valueLabel(later.rows.at(-1)!)}」のままです`);
  }
  return out;
}

/** 確かめ直す日の知らせの 1 行（項目と from_month の組の最新の行）。untilMonth は、この行が効く最後の診療月（null は今もこの先も効く） */
export type RecheckNotice = { key: string; id: number; fromMonth: string; untilMonth: string | null; recheckOn: string | null; state: "overdue" | "soon" | "none" };

/**
 * 確かめ直す日の知らせ（FR-190。design.md §15-2。round-52 X-150・round-53 C-274）：組ごとに、その行が効く診療月で
 * 「分からない」になるもの（確かめ直す日が空・比べる日より前）と、まだ効いていて確かめ直す日が近いもの。
 * 比べる日は、直後の組があればその組で最初に残した行の確かめた日、なければ今日。noFromMonth は、from_month のある行が 1 つもない項目（from_month を入れてもらう）
 */
export function recheckNotices(rows: DeclarationRow[], today: string, soonUntil: string): { rows: RecheckNotice[]; noFromMonth: string[] } {
  const keys = [...new Set(rows.map((r) => r.itemKey))];
  const out: RecheckNotice[] = [];
  const noFromMonth: string[] = [];
  for (const key of keys) {
    const groups = monthGroups(rows, key);
    if (!groups.length) {
      noFromMonth.push(key);
      continue;
    }
    groups.forEach((g, i) => {
      const row = g.rows.at(-1)!;
      const nextFirst = groups[i + 1]?.rows[0] ?? null;
      const base = { key, id: row.id, fromMonth: g.fromMonth, untilMonth: groups[i + 1] ? addMonths(groups[i + 1].fromMonth, -1) : null, recheckOn: row.recheckOn };
      if (!row.checkedOn || !row.recheckOn) out.push({ ...base, state: "none" });
      else if (row.recheckOn < (nextFirst?.checkedOn ?? today)) out.push({ ...base, state: "overdue" });
      else if (!nextFirst && row.recheckOn <= soonUntil) out.push({ ...base, state: "soon" });
    });
  }
  return { rows: out, noFromMonth };
}

/** まとめて「変わりなし」で選べる行（round-53 C-274）：項目ごとに、from_month のある組の最新の行の全部 */
export const selectableRows = (rows: DeclarationRow[]): DeclarationRow[] =>
  [...new Set(rows.map((r) => r.itemKey))].flatMap((key) => monthGroups(rows, key).map((g) => g.rows.at(-1)!));

/**
 * まとめて「変わりなし」の選ぶ画面の初期の選択（round-52 X-150・round-53 C-274）：申告の画面からは今日の前の月で効く行、
 * 知らせからは知らせの行、判定の画面の理由からはその診療月で効く行（itemKey を渡せばその項目だけ）。from_month が空の行は選ばない
 */
export function initialSelection(rows: DeclarationRow[], from: { screen: string } | { notice: number } | { month: string; itemKey?: string }): number[] {
  const selectable = new Set(selectableRows(rows).map((r) => r.id));
  if ("notice" in from) return selectable.has(from.notice) ? [from.notice] : [];
  const ym = "screen" in from ? prevMonthOf(from.screen) : from.month;
  const keys = "month" in from && from.itemKey ? [from.itemKey] : [...new Set(rows.map((r) => r.itemKey))];
  return keys.flatMap((k) => {
    const e = effectiveRow(rows, k, ym);
    return e ? [e.row.id] : [];
  });
}
