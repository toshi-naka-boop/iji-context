// 導出と検証が共有する述語（design.md §2-8・§2-3-3・§2-3-4）
import { addDays, eventsOf, fact } from "./rules/util";
import type { KanriFamily, KanriTierKey, RevisionConsts } from "./revisions/types";
import type { ClaimContext, Fact } from "./types";

/** 版の管理料の区分をすべて（在医総管・施設総管の 2イ・2ロ・2ニ） */
export function kanriKubun(c: RevisionConsts): string[] {
  return Object.values(c.kanri.table).flatMap((t) => Object.values(t));
}

/** 管理料の区分のキーから、族と区分を引く */
export function kanriOf(c: RevisionConsts, kubun: string): { family: KanriFamily; tier: KanriTierKey } | undefined {
  for (const [family, tiers] of Object.entries(c.kanri.table) as [KanriFamily, Record<KanriTierKey, string>][])
    for (const [tier, k] of Object.entries(tiers) as [KanriTierKey, string][]) if (k === kubun) return { family, tier };
  return undefined;
}

/** 算定している管理料の行（回数 1 以上）を、族と区分つきで */
export function kanriLines(ctx: ClaimContext, c: RevisionConsts): { kubun: string; family: KanriFamily; tier: KanriTierKey }[] {
  return ctx.lines.flatMap((l) => {
    const k = l.count > 0 ? kanriOf(c, l.kubun) : undefined;
    return k ? [{ kubun: l.kubun, ...k }] : [];
  });
}

/** 行の日付（回数 1 以上の行だけ）。重複は除いて昇順 */
export function billedDays(ctx: ClaimContext, kubuns: string[]): string[] {
  const days = ctx.lines.filter((l) => l.count > 0 && kubuns.includes(l.kubun)).flatMap((l) => l.dates);
  return [...new Set(days)].sort();
}

/** 訪問診療料を算定した日 */
export function billedVisitDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  return billedDays(ctx, c.visitKubun);
}

/** 往診料を算定した日 */
export function billedOushinDays(ctx: ClaimContext, c: RevisionConsts): string[] {
  return billedDays(ctx, [c.oushin.kubun]);
}

/** 訪問診療料と往診料の両方を算定した日 */
export function sameDayPairs(ctx: ClaimContext, c: RevisionConsts): string[] {
  const o = new Set(billedOushinDays(ctx, c));
  return billedVisitDays(ctx, c).filter((d) => o.has(d));
}

/** その日に算定している訪問診療料の区分 */
export function visitKubunOn(ctx: ClaimContext, c: RevisionConsts, day: string): string[] {
  return c.visitKubun.filter((k) => ctx.lines.some((l) => l.kubun === k && l.count > 0 && l.dates.includes(day)));
}

/** 算定した訪問診療の回数（訪問診療料の行の回数） */
export function visitCount(ctx: ClaimContext, c: RevisionConsts): number {
  return ctx.lines.filter((l) => c.visitKubun.includes(l.kubun)).reduce((s, l) => s + l.count, 0);
}

/** none＝その月は管理料を算定できない */
export type KanriTier = "none" | KanriTierKey;
export type KanriExpect = {
  /** 訪問診療料の行の回数 */
  visits: number;
  /** 居住の場所から決まる族。不明なら known:false */
  family: Fact<KanriFamily>;
  tier: { known: true; value: KanriTier } | { known: false; need: "table8_2" | "facility.note16Met"; candidates: KanriTier[] };
};

/**
 * 管理料の期待される族と区分（§2-3-3）。R01・R02・R03・R16 が同じ答えを使う。
 * 区分を決める順は 回数 → 重症 → 注16。不明な事実を聞くのは、その答えで区分が変わるときだけ
 */
export function expectedKanri(ctx: ClaimContext, c: RevisionConsts): KanriExpect {
  const visits = visitCount(ctx, c);
  const res = ctx.facts.residence;
  const family: Fact<KanriFamily> = res.known ? { known: true, value: c.kanri.familyOf[res.value] } : { known: false };
  const { from, to } = c.kanri.note16;
  const tier = ((): KanriExpect["tier"] => {
    if (visits === 0) return { known: true, value: "none" };
    if (visits === 1) return { known: true, value: "ニ" };
    const severe = ctx.facts.table8_2;
    if (!severe.known) return { known: false, need: "table8_2", candidates: ["イ", "ロ", "ニ"] };
    if (severe.value) return { known: true, value: "イ" };
    const met = ctx.facility.note16Met;
    if (!met.known) return { known: false, need: "facility.note16Met", candidates: [from, to] };
    return { known: true, value: met.value ? from : to };
  })();
  return { visits, family, tier };
}

/** 包括的支援加算を見る月か（期待される区分が加算の対象の区分。注16 だけが未定のときは、どちらの候補も対象なので見る） */
export function hokatsuInScope(ctx: ClaimContext, c: RevisionConsts): boolean {
  const t = expectedKanri(ctx, c).tier;
  const tiers: KanriTier[] = c.hokatsu.tiers;
  return t.known === true ? tiers.includes(t.value) : t.need === "facility.note16Met" && t.candidates.every((x) => tiers.includes(x));
}

/** 包括的支援加算の対象か（要介護度が下限以上）。期待される区分が加算の対象の区分で、careLevel が分かっている前提 */
export function hokatsuEligible(ctx: ClaimContext, c: RevisionConsts): boolean {
  return fact(ctx, "careLevel") >= c.hokatsu.careLevelMin;
}

/**
 * 往診料を算定した日・その翌日の訪問診療料を算定できるか（§2-3-4 の「制限の判定」）。
 * 在支診で文書提供済みなら真、文書提供が不明なら "unknown"、それ以外は偽
 */
export function visitBillable(ctx: ClaimContext): boolean | "unknown" {
  if (!ctx.facility.zaishishin) return false;
  const doc = ctx.facts.contactDocProvided;
  return doc.known ? doc.value : "unknown";
}

/** 内服の種類数が閾値以上の処方があるか（処方箋料の区分を決める） */
export function rxManyOral(ctx: ClaimContext, c: RevisionConsts): boolean {
  return eventsOf(ctx, "prescription").some((e) => e.oralKinds >= c.rx.oralKindsThreshold);
}

/** ターミナルケア加算の訪問の回数の要件（死亡日前の所定の日数以内に、訪問診療・往診を所定の回数以上「実施」。出来事で数える）。死亡の出来事がなければ偽 */
export function terminalVisitsOk(ctx: ClaimContext, c: RevisionConsts): boolean {
  const death = eventsOf(ctx, "death")[0];
  if (!death) return false;
  const from = addDays(death.date, -c.terminal.days);
  const n = ctx.events.filter((e) => (e.type === "visit" || e.type === "oushin") && e.date >= from && e.date <= death.date).length;
  return n >= c.terminal.minVisits;
}

/** 週ごとの、訪問診療料を算定した回数の最大値。算定しなかった訪問は数えない */
export function maxVisitsPerWeek(ctx: ClaimContext, c: RevisionConsts): number {
  const perWeek = new Map<string, number>();
  for (const l of ctx.lines) {
    if (l.count <= 0 || !c.visitKubun.includes(l.kubun)) continue;
    for (const date of l.dates) {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - c.weekStartsOn + 7) % 7));
      const key = d.toISOString().slice(0, 10);
      perWeek.set(key, (perWeek.get(key) ?? 0) + 1);
    }
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
 * 在宅移行早期加算の対象か：退院後に在宅療養を始めた患者で、管理料の算定開始月から所定の月数以内・退院から所定の日数以内。
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
