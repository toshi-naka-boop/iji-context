// 導出と検証が共有する述語（design.md §2-8）。段 1 は、ルールの中にあった判定をそのまま切り出したもの（判定は変えない）
import { addDays, countOf, eventsOf, fact } from "./rules/util";
import type { RevisionConsts } from "./revisions/types";
import type { ClaimContext } from "./types";

/** 算定した訪問診療の回数（訪問診療料の行の回数） */
export function visitCount(ctx: ClaimContext, c: RevisionConsts): number {
  return countOf(ctx, c.visitKubun);
}

/** 包括的支援加算の対象か（要介護度が下限以上で、重症区分以外）。careLevel・table8_2 が分かっている前提 */
export function hokatsuEligible(ctx: ClaimContext, c: RevisionConsts): boolean {
  return fact(ctx, "careLevel") >= c.hokatsu.careLevelMin && !fact(ctx, "table8_2");
}

/** 内服の種類数が閾値以上の処方があるか（処方箋料の区分を決める） */
export function rxManyOral(ctx: ClaimContext, c: RevisionConsts): boolean {
  return eventsOf(ctx, "prescription").some((e) => e.oralKinds >= c.rx.oralKindsThreshold);
}

/** ターミナルケア加算の訪問の回数の要件（死亡日前の所定の日数以内に、訪問診療・往診が所定の回数以上）。死亡の出来事がなければ偽 */
export function terminalVisitsOk(ctx: ClaimContext, c: RevisionConsts): boolean {
  const death = eventsOf(ctx, "death")[0];
  if (!death) return false;
  const from = addDays(death.date, -c.terminal.days);
  const n = ctx.events.filter((e) => (e.type === "visit" || e.type === "oushin") && e.date >= from && e.date <= death.date).length;
  return n >= c.terminal.minVisits;
}

/** 週（日曜始まり）ごとの訪問回数の最大値。週の区切りは暦週とした（推測。留意事項で要確認） */
export function maxVisitsPerWeek(ctx: ClaimContext): number {
  const perWeek = new Map<string, number>();
  for (const v of eventsOf(ctx, "visit")) {
    const d = new Date(`${v.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const key = d.toISOString().slice(0, 10);
    perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...perWeek.values());
}

/** "YYYY-MM" の差（月数） */
function monthDiff(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 在宅移行早期加算の対象か：退院後に在宅療養を始めた患者で、在医総管の算定開始月から所定の月数以内・退院から所定の日数以内。
 * 再入院→再退院で数え直す例外は、退院イベントのうち最も新しいものを起点にすることで扱う
 */
export function ikouEligible(ctx: ClaimContext, c: RevisionConsts): boolean {
  const start = eventsOf(ctx, "kanriStart").map((e) => e.month).sort().at(-1);
  const discharge = eventsOf(ctx, "discharge").map((e) => e.date).sort().at(-1);
  if (!start || !discharge) return false;
  const months = monthDiff(start, ctx.yearMonth);
  // 算定開始月を 1 か月目として数える
  if (months < 0 || months > c.ikou.months - 1) return false;
  // 退院からの日数（請求月の初日で判定）
  return `${ctx.yearMonth}-01` <= addDays(discharge, c.ikou.daysFromDischarge);
}
