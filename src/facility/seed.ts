// 施設の申告の表の読み書きと、クリニックの種類が決まったときの申告の用意（design.md §15-2「保存」「種を入れる場所は 1 つ」。C-214・C-222）。
// demo：config/facility.json の demoDeclaration から種を入れる（becomeDemo。ここだけ）。real：v28 の施設の設定（app_settings の "facility"）の
// note16Met・dxTier・baseUp を申告の行に移し、移したキーを app_settings から外す。未定：何もしない（app_settings を残し、申告も作らない）
import type Database from "better-sqlite3";
import facilityConfig from "../../config/facility.json";
import { period } from "../demo/period";
import { SELECTABLE_REVISIONS } from "../engine/revisions";
import { codeKey, DISPENSING_KEY, GRADE_KEY, NOTE16_KEY, type DeclarationRow, type DeclarationSource, type Notified, type Requirement } from "./declaration";

/** 1 行を足すときの中身（id・作った日時はここで付ける） */
export type DeclarationInput = Omit<DeclarationRow, "id" | "createdAt">;

type DbRow = { id: number; item_key: string; from_month: string | null; notified: Notified; notified_on: string | null; start_on: string | null; requirement: Requirement; choice: string | null; checked_by: string; checked_role: string; checked_on: string | null; recheck_on: string | null; source: DeclarationSource; created_at: string };

/** 申告の全部の行（古い順） */
export function readDeclarations(sqlite: Database.Database): DeclarationRow[] {
  return (sqlite.prepare("SELECT * FROM facility_declarations ORDER BY id").all() as DbRow[]).map((r) => ({
    id: r.id,
    itemKey: r.item_key,
    fromMonth: r.from_month,
    notified: r.notified,
    notifiedOn: r.notified_on,
    startOn: r.start_on,
    requirement: r.requirement,
    choice: r.choice,
    checkedBy: r.checked_by,
    checkedRole: r.checked_role,
    checkedOn: r.checked_on,
    recheckOn: r.recheck_on,
    source: r.source,
    createdAt: r.created_at,
  }));
}

/** 1 行を足す（追記だけ。前の行は消さない＝変更の記録） */
export function insertDeclaration(sqlite: Database.Database, d: DeclarationInput, at: string): number {
  return Number(
    sqlite
      .prepare("INSERT INTO facility_declarations (item_key, from_month, notified, notified_on, start_on, requirement, choice, checked_by, checked_role, checked_on, recheck_on, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.itemKey, d.fromMonth, d.notified, d.notifiedOn, d.startOn, d.requirement, d.choice, d.checkedBy, d.checkedRole, d.checkedOn, d.recheckOn, d.source, at).lastInsertRowid,
  );
}

const SYSTEM = { checkedBy: "system", checkedRole: "system" };

/**
 * 種の日付（どれも設計の値。design.md §15-2）：確かめた日は時計の初期値、確かめ直す日はその 1 年後、
 * いつの診療月から（from_month）と算定開始年月日は、選べる版（比較用の版を含む）のうち最も早い版の開始月（とその初日）。
 * デモの架空クリニックは、デモで見せるどの診療月でも同じ施設にする（年月は版の一覧から出し、コードに直書きしない）
 */
export function seedDates() {
  const checkedOn = period.clockStart.slice(0, 10);
  const recheckOn = `${Number(checkedOn.slice(0, 4)) + 1}${checkedOn.slice(4)}`;
  const fromMonth = SELECTABLE_REVISIONS.map((r) => r.effectiveFrom).sort()[0];
  return { checkedOn, recheckOn, fromMonth, startOn: `${fromMonth}-01` };
}

/** 種の中身（config/facility.json の demoDeclaration）を、申告の行の形にする */
export function demoSeedRows(): DeclarationInput[] {
  const d = facilityConfig.demoDeclaration;
  const { checkedOn, recheckOn, fromMonth, startOn } = seedDates();
  const base = { ...SYSTEM, fromMonth, checkedOn, recheckOn, notifiedOn: null, source: "seed" as const };
  const codes = Object.entries(d.codes as Record<string, string>).map(([code, v]): DeclarationInput => {
    const yes = v !== "no";
    return { ...base, itemKey: codeKey(code), notified: yes ? "yes" : "no", startOn: yes ? startOn : null, requirement: "met", choice: v === "1" || v === "2" ? v : null };
  });
  return [
    { ...base, itemKey: GRADE_KEY, notified: "yes", startOn, requirement: "met", choice: d.grade },
    { ...base, itemKey: NOTE16_KEY, notified: "na", startOn: null, requirement: d.note16 as Requirement, choice: null },
    { ...base, itemKey: DISPENSING_KEY, notified: "na", startOn: null, requirement: "met", choice: d.dispensing },
    ...codes,
  ];
}

const sameContent = (a: DeclarationRow, b: DeclarationInput) =>
  a.source === b.source && a.fromMonth === b.fromMonth && a.notified === b.notified && a.notifiedOn === b.notifiedOn && a.startOn === b.startOn && a.requirement === b.requirement && a.choice === b.choice && a.checkedOn === b.checkedOn && a.recheckOn === b.recheckOn;

/**
 * デモ用のクリニックにする：種を項目ごとに追記で足す。種を入れる場所はここだけ（design.md §15-2）。
 * 利用者の入れた行（source: input）が 1 つでもある項目には足さない（効く行は有効月の順で選ぶので、同じ from_month の種が後の id で利用者の行を上書きしうる。C-240）。
 * 種と同じ from_month の行のうち最新が、すでに同じ中身の種なら足さない（何度呼んでも行が増えない）。
 * 呼ぶのは applyKind（クリニックを作るとき・reset-demo のあと・マイグレーション 12・未定からデモを選んだとき）とマイグレーション 13 だけ。トランザクションは呼び出し側が張る
 */
export function becomeDemo(sqlite: Database.Database, at: string): number {
  const rows = readDeclarations(sqlite);
  let added = 0;
  for (const s of demoSeedRows()) {
    const mine = rows.filter((r) => r.itemKey === s.itemKey);
    if (mine.some((r) => r.source === "input")) continue;
    const latest = mine.filter((r) => r.fromMonth === s.fromMonth).at(-1);
    if (latest && sameContent(latest, s)) continue;
    insertDeclaration(sqlite, s, at);
    added++;
  }
  return added;
}

const SETTING_KEY = "facility";
/** v28 の施設の設定から申告に移すキー（ほかの priceResponse などは設定のまま） */
export const MOVED_SETTING_KEYS = ["note16Met", "dxTier", "baseUp"] as const;

/**
 * 実在用のクリニック：app_settings の "facility" に残っている note16Met・dxTier・baseUp を申告の行に移し（source: migrated。
 * 確かめた日・確かめ直す日は空なので「分からない」になる。L-88）、移したキーを app_settings から外す（2 か所に持たない）
 */
export function moveSettings(sqlite: Database.Database, at: string): number {
  const raw = (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(SETTING_KEY) as { value: string } | undefined)?.value;
  if (raw === undefined) return 0;
  const saved = JSON.parse(raw) as Record<string, unknown>;
  // いつの診療月からは推し量って埋めない（空の行は効く行に選ばれず「分からない」。design.md §15-2 の「保存」）
  const base = { ...SYSTEM, fromMonth: null, checkedOn: null, recheckOn: null, notifiedOn: null, startOn: null, source: "migrated" as const };
  const out: DeclarationInput[] = [];
  if ("note16Met" in saved) {
    const v = saved.note16Met;
    out.push({ ...base, itemKey: NOTE16_KEY, notified: "na", requirement: v === true ? "met" : v === false ? "not_met" : "unknown", choice: null });
  }
  if ("dxTier" in saved) {
    const v = saved.dxTier;
    out.push({ ...base, itemKey: codeKey("4100"), notified: v === "1" || v === "2" ? "yes" : v === "なし" ? "no" : "unknown", requirement: v === null ? "unknown" : "met", choice: v === "1" || v === "2" ? v : null });
  }
  if ("baseUp" in saved) {
    const v = saved.baseUp;
    const of = (yes: boolean): Notified => (v === null ? "unknown" : yes ? "yes" : "no");
    out.push({ ...base, itemKey: codeKey("4307"), notified: of(v === "通常" || v === "注5"), requirement: v === null ? "unknown" : "met", choice: null });
    out.push({ ...base, itemKey: codeKey("4303"), notified: of(v === "注5"), requirement: v === null ? "unknown" : "met", choice: null });
  }
  for (const d of out) insertDeclaration(sqlite, d, at);
  const rest = Object.fromEntries(Object.entries(saved).filter(([k]) => !(MOVED_SETTING_KEYS as readonly string[]).includes(k)));
  sqlite.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(JSON.stringify(rest), SETTING_KEY);
  return out.length;
}

/** クリニックの種類を申告に当てた印（app_settings）。未定のクリニックは持たない */
export const APPLIED_KEY = "facility_kind_applied";

/**
 * クリニックの種類が決まっていれば、申告をその種類に合わせる（印を同じトランザクションで残す。design.md §15-2 の「kind と種の書き込み」）。
 * 開くたびに auth.db の kind と印を照らし、同じなら何もしない。kind を auth.db に書いたあと、ここの前で止まっても、次に開いたときに直る。
 * マイグレーション 12 の run と、開くとき（src/server/app/context.ts）に呼ぶ。トランザクションは呼び出し側が張る
 */
export function applyKind(sqlite: Database.Database, kind: "demo" | "real" | "undecided", at: string): void {
  if (kind === "undecided") return;
  const applied = (sqlite.prepare("SELECT value FROM app_settings WHERE key = ?").get(APPLIED_KEY) as { value: string } | undefined)?.value;
  if (applied === kind) return;
  if (kind === "demo") becomeDemo(sqlite, at);
  else moveSettings(sqlite, at);
  sqlite.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(APPLIED_KEY, kind);
}
