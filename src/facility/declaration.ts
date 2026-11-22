// 施設の申告を、判定に使う三値にする純関数（design.md §15-2「三値の決め方」「判定に渡す形」。FR-188・190）。
// 申告は追記だけの履歴（facility_declarations）。項目ごとに「効く行」を選び、決まった順（X-141）で「持つ・持たない・分からない」を決める。
// 今日の日付は呼び出し側が時計（§11-7）から渡す。ここでは時計を読まない
import kijun from "../../config/shisetsu-kijun.json";
import type { FacilityJson } from "../engine/facility";
import { GRADE_CHOICES, GRADE_CODES, HOSPITAL_CODES } from "./codes";

export type Notified = "yes" | "no" | "unknown" | "na";
export type Requirement = "met" | "not_met" | "unknown";
export type DeclarationSource = "input" | "seed" | "migrated";

/** 申告の 1 行（facility_declarations の 1 行）。日付は "YYYY-MM-DD" */
export type DeclarationRow = {
  id: number;
  itemKey: string;
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
  no_check_date: "確かめた日か確かめ直す日が入っていません",
  expired: "確かめ直す日を過ぎています",
  notified_unknown: "届出が分からない",
  requirement_unknown: "要件を満たしているかが分からない",
  no_start_on: "届出ありですが、算定開始年月日が入っていません",
  mid_month_start: "月の途中から算定開始です",
  grade_unknown: "施設の種別が分からない",
  grade_requirement_not_met: "種別の要件を満たさないと申告されています。種別を直してください",
  hospital: "在宅療養支援病院のコードです（診療所は持ちません）",
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

/** 比べる日：算定日、なければ診療年月の末日 */
const compareDayOf = (on: On): string => on.day ?? lastDayOf(on.yearMonth);

/**
 * 効く行（C-215）：比べる日より後の算定開始年月日を持つ行を除いたうち、最新の行。残らなければ最新の行。
 * later は、効く行より後にあり、算定開始年月日が比べる日より後の行（先の日付の変更）。効く行の「確かめ直す日」を、その行を残した日で比べるのに使う
 */
export function effectiveRow(rows: DeclarationRow[], itemKey: string, on: On): { row: DeclarationRow; later: DeclarationRow | null } | null {
  const mine = rows.filter((r) => r.itemKey === itemKey).sort((a, b) => a.id - b.id);
  if (!mine.length) return null;
  const cmp = compareDayOf(on);
  const eligible = mine.filter((r) => !(r.startOn !== null && r.startOn > cmp));
  const row = eligible.at(-1) ?? mine.at(-1)!;
  const later = mine.find((r) => r.id > row.id && r.startOn !== null && r.startOn > cmp) ?? null;
  return { row, later };
}

const unknown = (reason: UnknownReason): Tri => ({ v: "unknown", reason });
const not = (reason: NotReason, startOn?: string): Tri => (startOn ? { v: "not", reason, startOn } : { v: "not", reason });
const HELD: Tri = { v: "held" };

/** 決める順の 2 の前半（行がない・日付がない・確かめ直す日を過ぎた） */
function gate(e: ReturnType<typeof effectiveRow>, today: string): Tri | null {
  if (!e) return unknown("no_row");
  const { row, later } = e;
  if (!row.checkedOn || !row.recheckOn) return unknown("no_check_date");
  // 先の日付の変更を入れたときは、前の行の確かめ直す日を、後の行を残した日で比べる（前の月が期限切れで「分からない」に落ちないように）
  const ref = later?.checkedOn ?? today;
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
  const e = effectiveRow(rows, codeKey(code), on);
  const g = gate(e, today);
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
  const e = effectiveRow(rows, GRADE_KEY, on);
  const g = gate(e, today);
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
  const e = effectiveRow(rows, NOTE16_KEY, on);
  const g = gate(e, today);
  if (g) return g;
  if (e!.row.requirement === "unknown") return unknown("requirement_unknown");
  if (e!.row.requirement === "not_met") return not("requirement_not_met");
  return HELD;
}

/** 施設基準コード c を、その日（またはその月）に持つか。決める順は X-141 のとおり（在支病 → 分からない → 持たない → 持つ） */
export function heldOf(rows: DeclarationRow[], code: string, on: On, today: string): Tri {
  if ((HOSPITAL_CODES as readonly string[]).includes(code)) return not("hospital");
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
 * zaishishin・kyokagata・hasBeds は種別が分かるときだけ入れる（分からないときは呼び出し側の値のまま。種別が分からないときの判定は段 17c）
 */
export function facilityFromDeclaration(rows: DeclarationRow[], today: string, yearMonth: string): Partial<FacilityJson> {
  const on: On = { yearMonth };
  const { tri, choice } = gradeTri(rows, on, today);
  const grade = tri.v === "held" ? choice!.grade : null;
  const n16 = note16Tri(rows, on, today);
  const dx = codeTri(rows, "4100", on, today);
  const dxChoice = effectiveRow(rows, codeKey("4100"), on)?.row.choice;
  const dxTier = dx.v === "held" ? (dxChoice === "1" || dxChoice === "2" ? dxChoice : null) : dx.v === "not" ? "なし" : null;
  const b5 = codeTri(rows, "4303", on, today);
  const b = codeTri(rows, "4307", on, today);
  const baseUp = b5.v === "unknown" || b.v === "unknown" ? null : b5.v === "held" ? "注5" : b.v === "held" ? "通常" : "なし";
  return {
    grade,
    note16Met: n16.v === "held" ? true : n16.v === "not" ? false : null,
    dxTier,
    baseUp,
    ...(grade === null ? {} : { zaishishin: grade !== "3", kyokagata: grade === "1B" || grade === "1N", hasBeds: grade === "1B" }),
  };
}

/** 院内処方か院外処方かの行の三値（決める順の 2 の前半と、選んだ値が「分からない」） */
export function dispensingTri(rows: DeclarationRow[], today: string): Tri {
  const e = effectiveRow(rows, DISPENSING_KEY, { yearMonth: today.slice(0, 7), day: today });
  const g = gate(e, today);
  if (g) return g;
  const c = e!.row.choice;
  return c === "outside" || c === "inside" ? HELD : unknown("requirement_unknown");
}

/** 院内処方か院外処方か（G11 だけに渡す。段 18） */
export function dispensingOf(rows: DeclarationRow[], today: string): "outside" | "inside" | "unknown" {
  if (dispensingTri(rows, today).v !== "held") return "unknown";
  return effectiveRow(rows, DISPENSING_KEY, { yearMonth: today.slice(0, 7), day: today })!.row.choice as "outside" | "inside";
}
