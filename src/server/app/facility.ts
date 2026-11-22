// 施設の設定と施設の申告（spec FR-148・FR-188〜191。design.md §2-7・§15-2・§15-9）。
// 申告（施設の種別・注16・院内／院外処方・施設基準コードごとの届出）は facility_declarations に追記で残し、判定には src/facility/declaration.ts の三値で渡す。
// 申告に移さない設定（物価対応料・同じ日の重ね）は、今までどおり app_settings の "facility" に JSON（項目 → 値か null）で持つ。
// 判定に渡す形は「config の既定値 ← 残した設定 ← 申告 ← 症例ごとの上書き」。申告の項目（種別・注16・DX・ベースアップ）は、どのクリニックでも config の既定値を使わない（申告がなければ分からない）
import kijun from "../../../config/shisetsu-kijun.json";
import { FACT_KEYS, type FacilityJson } from "../../engine/facility";
import { hasRevision, resolveRevision } from "../../engine/revisions";
import { codeOf } from "../../engine/revisions/codes";
import type { FacilityFactKey } from "../../engine/types";
import { GRADE_CHOICES, GRADE_CODES, HOSPITAL_CODES } from "../../facility/codes";
import {
  codeKey,
  DISPENSING_KEY,
  dispensingTri,
  effectiveRow,
  facilityFromDeclaration,
  GRADE_KEY,
  gradeOf,
  heldOf,
  kijunNameOf,
  LISTED_CODES,
  NOTE16_KEY,
  note16Of,
  TRI_REASON_LABEL,
  type DeclarationRow,
  type On,
  type Requirement,
  type Tri,
} from "../../facility/declaration";
import { insertDeclaration, MOVED_SETTING_KEYS, readDeclarations } from "../../facility/seed";
import { pickSnapshot, shinryoOf, withMasters } from "../../masters/db";
import type { User } from "../auth";
import { badRequest } from "../errors";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Uke } from "./uke";

/** 申告に移さない、設定のままの項目 */
export const SETTING_KEYS = FACT_KEYS.filter((k) => k !== "grade" && !(MOVED_SETTING_KEYS as readonly string[]).includes(k));
type Saved = Partial<Pick<FacilityJson, FacilityFactKey>>;

const SETTING_KEY = "facility";

/** クリニックで残した設定（申告に移した項目は入れない。未定のクリニックに残っている v28 の値も使わない） */
function savedOf(ctx: Pick<AppContext, "setting">): Saved {
  const raw = ctx.setting(SETTING_KEY);
  const all = raw === null ? {} : (JSON.parse(raw) as Saved);
  return Object.fromEntries(Object.entries(all).filter(([k]) => (SETTING_KEYS as string[]).includes(k))) as Saved;
}

/** 今日（時計の日付。"YYYY-MM-DD"） */
export const todayOf = (clock: Pick<Clock, "now">): string => clock.now().slice(0, 10);

/** 判定に渡す前の施設の設定（JSON の形）：config の既定値に、残した設定と、その診療年月の申告を重ねる */
export const facilityJsonOf = (ctx: Pick<AppContext, "facility" | "setting" | "sqlite">, today: string, yearMonth: string): FacilityJson => ({
  ...ctx.facility,
  ...savedOf(ctx),
  ...facilityFromDeclaration(readDeclarations(ctx.sqlite), today, yearMonth),
});

type KijunRow = { codes: string[]; name: string; abbrev: string };
const abbrevOf = (code: string): string | null => (kijun as { rows: KijunRow[] }).rows.find((r) => r.codes.includes(code))?.abbrev ?? null;

/** 申告の入力（スキーマ src/server/schemas/facility.ts が形を確かめたあと） */
export type DeclarationBody =
  | { item: "grade"; choice: string; requirement: Requirement; startOn: string | null; notifiedOn: string | null; checkedOn: string | null; recheckOn: string | null }
  | { item: "note16"; requirement: Requirement; checkedOn: string | null; recheckOn: string | null }
  | { item: "dispensing"; choice: "outside" | "inside" | "unknown"; checkedOn: string | null; recheckOn: string | null }
  | { item: string; notified: "yes" | "no" | "unknown"; requirement: Requirement; startOn: string | null; notifiedOn: string | null; choice: "1" | "2" | null; checkedOn: string | null; recheckOn: string | null };

const statusOf = (t: Tri) => ({ v: t.v, reason: t.v === "held" ? null : TRI_REASON_LABEL[t.reason], ...(t.v === "not" && t.startOn ? { startOn: t.startOn } : {}) });

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function createFacility(ctx: AppContext, clock: Clock, uke: Pick<Uke, "ukeFiles">) {
  /** 設定の画面に出す一覧（申告に移さない項目だけ）：項目ごとに、いま効いている値（null は分からない）と、クリニックで残した値か（偽なら既定値のまま） */
  function facilitySettings() {
    const saved = savedOf(ctx);
    const now = { ...ctx.facility, ...saved };
    return { items: SETTING_KEYS.map((key) => ({ key, value: now[key], saved: key in saved })) };
  }
  /** 1 項目を残す。null は「分からない」。値の形はスキーマ（src/server/schemas/facility.ts）が先に確かめる */
  function saveFacility(key: FacilityFactKey, value: string | boolean | null) {
    const raw = ctx.setting(SETTING_KEY);
    ctx.setSetting(SETTING_KEY, JSON.stringify({ ...(raw === null ? {} : JSON.parse(raw)), [key]: value }));
    return facilitySettings();
  }

  /** 申告の一覧に並べる項目の鍵（種別・注16・院内／院外処方・表 4 の行） */
  const itemKeys = () => [GRADE_KEY, NOTE16_KEY, DISPENSING_KEY, ...LISTED_CODES.map(codeKey)];

  /**
   * 請求に出てきたのに申告の一覧にない施設基準コード（件数の多い順。L-90）。取り込んだレセプトの行のコードを、基本マスターの施設基準の 3 列で引く。
   * 種別で決まるコード・在支病・名寄せ（8032）・注14（4101）は、申告の別の行で決まるか判定しないので出さない。マスターがなければ空
   */
  function unlistedCodes(): { code: string; count: number }[] {
    const skip = new Set([...LISTED_CODES, ...GRADE_CODES, ...HOSPITAL_CODES, "8032", "4101"]);
    const counts = new Map<string, number>();
    withMasters((db) => {
      if (!db) return;
      for (const file of uke.ukeFiles()) {
        for (const r of file.receipts) {
          if (!hasRevision(r.yearMonth)) continue;
          const rev = resolveRevision(r.yearMonth);
          const snap = pickSnapshot(db, "shinryo", r.yearMonth, rev.generation)?.snapshot;
          if (!snap) continue;
          const codes = [
            ...r.lines.flatMap((l) => {
              try {
                return [codeOf(rev, l.kubun)];
              } catch {
                return [];
              }
            }),
            ...(r.others ?? []).flatMap((o) => o.codes),
          ];
          for (const code of codes) {
            const row = shinryoOf(db, snap, code);
            if (!row) continue;
            for (const c of new Set([row.shisetsu_g1, row.shisetsu_g2, row.shisetsu_g3].flatMap((v) => (v && v !== "0" ? v.split("/") : [])))) {
              if (!skip.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
            }
          }
        }
      }
    });
    return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }

  /** 申告の一覧（画面と GET /api/facility/declaration）。いまの状態は今日の日付で決める */
  function declarations() {
    const rows = readDeclarations(ctx.sqlite);
    const today = todayOf(clock);
    const on: On = { yearMonth: today.slice(0, 7), day: today };
    const month: On = { yearMonth: today.slice(0, 7) };
    const unlisted = unlistedCodes();
    const keys = [...itemKeys(), ...unlisted.map((u) => codeKey(u.code)).filter((k) => rows.some((r) => r.itemKey === k))];
    const grade = gradeOf(rows, month, today);
    const items = keys.map((key) => {
      const e = effectiveRow(rows, key, on);
      const code = key.startsWith("code:") ? key.slice(5) : null;
      const tri: Tri =
        key === GRADE_KEY ? gradeOf(rows, on, today).tri : key === NOTE16_KEY ? note16Of(rows, on, today) : key === DISPENSING_KEY ? dispensingTri(rows, today) : heldOf(rows, code!, on, today);
      return {
        key,
        code,
        name: code ? kijunNameOf(code) : null,
        abbrev: code ? abbrevOf(code) : null,
        row: e?.row ?? null,
        status: statusOf(tri),
        history: rows.filter((r) => r.itemKey === key).length,
      };
    });
    // 確かめ直す日の知らせ（FR-190。事務長の画面）：効く行の確かめ直す日が、近い（設定の日数以内）・過ぎた・ない
    const soonUntil = addDays(today, ctx.recheckNoticeDays);
    const recheck = { soon: [] as string[], overdue: [] as string[], none: [] as string[] };
    for (const it of items) {
      if (!it.row) continue;
      const r = it.row.recheckOn;
      if (r === null) recheck.none.push(it.key);
      else if (r < today) recheck.overdue.push(it.key);
      else if (r <= soonUntil) recheck.soon.push(it.key);
    }
    // 合わない組み合わせ（J-5）：知らせるだけで、判定には申告をそのまま使う（FR-191）
    const mismatches: string[] = [];
    const gradeId = grade.tri.v === "held" ? grade.choice!.id : null;
    const heldNow = (c: string) => heldOf(rows, c, month, today).v === "held";
    if (gradeId && gradeId !== "zaishishin3" && (heldNow("3340") || heldNow("3469"))) mismatches.push("在宅療養実績加算1・2 を持つと申告されていますが、種別が在支診（(3)）ではありません");
    if (gradeId && (gradeId === "zaishishin3" || gradeId === "outside") && heldNow("4248")) mismatches.push("在宅医療充実体制加算を持つと申告されていますが、種別が在支診（(3)）か在支診以外です");
    return {
      today,
      gradeChoices: GRADE_CHOICES.map((g) => ({ id: g.id, label: g.label })),
      items,
      unlisted: unlisted.filter((u) => !rows.some((r) => r.itemKey === codeKey(u.code))),
      recheck,
      recheckNoticeDays: ctx.recheckNoticeDays,
      mismatches,
    };
  }

  /** 1 項目を残す（追記。前の行は変更の記録として残る）。確かめた人は、ログインした利用者 */
  function saveDeclaration(user: Pick<User, "name" | "role">, body: DeclarationBody) {
    const by = { checkedBy: user.name, checkedRole: user.role, checkedOn: body.checkedOn, recheckOn: body.recheckOn, source: "input" as const };
    const at = new Date().toISOString();
    if (body.item === GRADE_KEY) {
      const b = body as Extract<DeclarationBody, { item: "grade" }>;
      const notified = b.choice === "unknown" ? "unknown" : b.choice === "outside" ? "no" : "yes";
      insertDeclaration(ctx.sqlite, { ...by, itemKey: GRADE_KEY, notified, notifiedOn: b.notifiedOn, startOn: b.startOn, requirement: b.requirement, choice: b.choice }, at);
    } else if (body.item === NOTE16_KEY) {
      const b = body as Extract<DeclarationBody, { item: "note16" }>;
      insertDeclaration(ctx.sqlite, { ...by, itemKey: NOTE16_KEY, notified: "na", notifiedOn: null, startOn: null, requirement: b.requirement, choice: null }, at);
    } else if (body.item === DISPENSING_KEY) {
      const b = body as Extract<DeclarationBody, { item: "dispensing" }>;
      insertDeclaration(ctx.sqlite, { ...by, itemKey: DISPENSING_KEY, notified: "na", notifiedOn: null, startOn: null, requirement: "met", choice: b.choice }, at);
    } else {
      const b = body as Extract<DeclarationBody, { notified: string }>;
      const code = b.item.slice(5);
      if ((HOSPITAL_CODES as readonly string[]).includes(code)) throw badRequest("在宅療養支援病院のコードは申告しません（診療所は持ちません）", ["item"]);
      if (GRADE_CODES.includes(code)) throw badRequest("このコードは施設の種別で決まります。種別の欄で申告してください", ["item"]);
      if (code === "4100" && b.notified === "yes" && b.choice === null) throw badRequest("在宅医療DX情報活用加算は、加算1 か加算2 かも選んでください", ["choice"]);
      if (code !== "4100" && b.choice !== null) throw badRequest("加算1・加算2 を選ぶのは、在宅医療DX情報活用加算だけです", ["choice"]);
      insertDeclaration(ctx.sqlite, { ...by, itemKey: b.item, notified: b.notified, notifiedOn: b.notifiedOn, startOn: b.startOn, requirement: b.requirement, choice: b.choice }, at);
    }
    return declarations();
  }

  /** 1 項目の変更の記録（新しい順） */
  const declarationHistory = (item: string): DeclarationRow[] =>
    readDeclarations(ctx.sqlite)
      .filter((r) => r.itemKey === item)
      .reverse();

  return { facilitySettings, saveFacility, declarations, saveDeclaration, declarationHistory };
}
