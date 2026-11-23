// G11 の手順 3（design.md §15-8）：元の請求＋手順 1 を通った候補の全部に、手書きのルールを 1 回掛け、候補が関わる指摘を候補の添え書きにする（隠さない）。
// 掛けるのは R18 と、g11Owned の候補があるときはその区分の担当のルール（derive.ts の g11Owners。段 18c）。
// 候補 c が関わる指摘：lineRefs に c の区分が入り、指摘が days を持つときは c の算定日がその中に入るもの（情報不足の missing.date も同じ）。
// 日で決まるルール（R10・R13）の、日を持たない情報不足は候補に付けず、点検の範囲に 1 行で出す（round-54 C-282）。
// 添え書きの文は定型文と値だけで作り、LLM は使わない。中身は候補の側から書き、相手を名指しする（round-54 C-284）。
// 候補のコードが版の区分に当たれば行にし、当たらなければ点検の対象外の単位として足す（partial のルールの決め方は src/engine/index.ts の partialBy）
import { evaluateWith, partialBy } from "../engine";
import { g11Owners } from "../engine/derive";
import { baseUpDayKubun, kanriOf, kanriKubunOf, kubunFamily } from "../engine/predicates";
import { kubunOfCode } from "../engine/revisions/codes";
import type { Revision } from "../engine/revisions/types";
import type { ClaimContext, Finding } from "../engine/types";
import { findingText, needLabel } from "../messages";
import type { MastersDb } from "../masters/db";
import type { NeedKey } from "../engine/types";
import type { G11Item, Note, SameFamily, Step3 } from "./g11";
import { outsideOf } from "./lookup";

/** 添え書きに出す手書きのルールの名前（ルールの番号ではなく中身を先に書く。番号は括弧で添える） */
const RULE_NAME: Record<string, string> = {
  R01: "管理料の回数の区分",
  R02: "重症の区分",
  R03: "包括的支援加算",
  R08: "ベースアップ評価料の日の区分",
  R09: "看取り加算・死亡診断加算・在宅ターミナルケア加算",
  R10: "往診と訪問診療の同じ日・翌日",
  R12: "在宅医療DX情報活用加算",
  R13: "週の訪問診療の回数",
  R14: "在宅移行早期加算",
  R15: "物価対応料の日の区分",
  R16: "管理料の族",
  R18: "施設の種別",
};
const ruleName = (id: string) => `${RULE_NAME[id] ?? "手書きのルール"}（${id}）`;
/** 日で決まるルール（日を持たない情報不足は、点検の範囲に 1 行で出す。C-282） */
const DAY_RULES = new Set(["R10", "R13"]);

type Cand = Parameters<Step3>[0][number];

/** 候補と元の請求を合わせた請求の文脈。kubunOf は候補ごとの区分、codesOf は候補ごとのコード、outside は区分に当たらないコード */
function contextOf(base: ClaimContext, rev: Revision, db: MastersDb | null, cands: { date: string; units: { items: G11Item[]; count: number }[] }[]) {
  const lines = [...base.lines];
  const kubunOf = new Map<number, Set<string>>();
  const codesOf = new Map<number, Set<string>>();
  const outside: string[] = [];
  cands.forEach((c, i) => {
    for (const u of c.units)
      for (const it of u.items) {
        codesOf.set(i, (codesOf.get(i) ?? new Set()).add(it.code));
        const k = it.kind === "SI" ? kubunOfCode(rev, it.code) : null;
        if (k) {
          lines.push({ kubun: k, count: Math.max(1, u.count), dates: [c.date] });
          kubunOf.set(i, (kubunOf.get(i) ?? new Set()).add(k));
        } else outside.push(it.code);
      }
  });
  let ctx: ClaimContext = { ...base, lines };
  if (outside.length > 0) {
    const codes = [...(base.outside?.codes.map((x) => x.code) ?? []), ...outside];
    const o = db ? outsideOf(db, rev, base.yearMonth, codes) : undefined;
    ctx = { ...ctx, partial: true, ...(o ? { outside: o } : {}) };
  }
  return { ctx, kubunOf, codesOf };
}

/**
 * 区分誤りの直し先（正しい側の kubun）。R18 は指摘の params.fix、R01 は管理料の回数の区分、R08 は訪問診療時・再診時等の同じ並びの区分。
 * ほかの区分誤り（R02・R16 など）は直し先を持たない（「ほか」の文で出す）
 */
function fixOf(f: Finding, kubun: string, rev: Revision): string | null {
  const c = rev.consts;
  if (f.params?.fix) return f.params.fix;
  if (f.ruleId === "R01") {
    const k = kanriOf(c, kubun);
    const tier = f.messageKey === "R01.use_once" || f.messageKey === "R01.note16_once_rate" ? c.kanri.note16.to : f.messageKey === "R01.use_twice_or_more" ? c.kanri.note16.from : null;
    return k && tier ? (kanriKubunOf(c, k.family, k.grade, tier) ?? null) : null;
  }
  if (f.ruleId === "R08") {
    const { visit, revisit } = baseUpDayKubun(c);
    if (f.messageKey === "R08.oushin_only_day" && visit.includes(kubun)) return revisit[visit.indexOf(kubun)] ?? null;
    if (f.messageKey === "R08.use_visit" && revisit.includes(kubun)) return visit[revisit.indexOf(kubun)] ?? null;
  }
  return null;
}

/**
 * 手順 3 の本体。base は元の請求の文脈（取り込んだ請求は mapClaim の行と対象外の単位、算定プレビューは導出の行）。
 * owned を偽にすると R18 だけを掛ける（段 18b の形。担当のルールを足さない）
 */
export function rulesStep3(base: ClaimContext, rev: Revision, db: MastersDb | null, owned = true): Step3 {
  return (cands) => {
    const notes = new Map<number, Note[]>();
    const scope: string[] = [];
    const { ctx, kubunOf, codesOf } = contextOf(base, rev, db, cands);
    // 掛けるルール：R18 と、候補の区分の担当のルール
    const candKubun = new Set(cands.flatMap((_, i) => [...(kubunOf.get(i) ?? [])]));
    const ids = new Set(["R18", ...(owned ? g11Owners(rev.consts).filter((o) => o.kubun.some((k) => candKubun.has(k))).flatMap((o) => o.rules) : [])]);
    const rules = rev.rules.filter((r) => ids.has(r.id));
    if (rules.length === 0) return { notes, scope };
    const result = evaluateWith(ctx, { ...rev, rules });
    const family = kubunFamily(rev.consts);
    const nameOf = (k: string) => (Object.hasOwn(rev.points, k) ? rev.points[k].name : k);
    const push = (i: number, n: Note) => {
      const id = cands[i].id;
      const list = notes.get(id) ?? [];
      if (!list.some((m) => m.text === n.text)) list.push(n);
      notes.set(id, list);
    };
    /** 相手の区分 p が、その日（day が null なら月）に元の請求にあるか、候補にあるか */
    const isCand = (p: string, day: string | null) => cands.some((c, j) => kubunOf.get(j)?.has(p) && (day === null || c.date === day));
    const label = (p: string, day: string | null) => `${nameOf(p)}${!base.lines.some((l) => l.kubun === p && l.count > 0 && (day === null || l.dates.includes(day))) && isCand(p, day) ? "の候補" : ""}`;
    const { visitKubun, oushin } = rev.consts;
    /** 候補の側から書く指摘の中身（C-284）。mine は候補の区分 */
    const contentOf = (f: Finding, mine: Set<string>, date: string): string => {
      const others = (ks: string[]) => [...new Set(ks.filter((k) => !mine.has(k)))];
      switch (f.messageKey) {
        case "R10.same_encounter": {
          const p = mine.has(oushin.kubun) ? others(f.lineRefs.filter((k) => visitKubun.includes(k))) : [oushin.kubun];
          return `同じ日に${p.map((k) => label(k, date)).join("・")}があります`;
        }
        case "R10.same_day_as_visit":
          return `同じ日に${label(oushin.kubun, date)}があります`;
        case "R10.visit_day_after_oushin":
          return "前の日に往診料があります";
        case "R10.oushin_not_after_visit":
          return `同じ日に${visitKubun.filter((k) => ctx.lines.some((l) => l.kubun === k && l.dates.includes(date))).map((k) => label(k, date)).join("・") || "訪問診療料"}があります`;
        case "R13.over_three_a_week":
          return `この週の訪問診療料が ${rev.consts.weeklyVisitLimit} 回を超えます`;
        default: {
          const p = others(f.lineRefs);
          return p.length > 0 ? `${p.map((k) => label(k, null)).join("・")}があります` : findingText(f);
        }
      }
    };
    const dayless = new Map<string, Set<string>>();
    for (const f of result.findings) {
      const rule = rules.find((r) => r.id === f.ruleId);
      if (f.kind === "情報不足" && f.missing?.field === "unsupportedLines") {
        // 判定できない行：partial にした対象外の単位のコードに、候補のコードが入るとき
        const by = rule ? partialBy(rule, rev, ctx) : "all";
        const hits = by === "all" ? null : new Set((by ?? []).map((x) => x.code));
        cands.forEach((_, i) => {
          if (hits === null || [...(codesOf.get(i) ?? [])].some((x) => hits.has(x))) push(i, { reason: "手書きのルールで判定できない行", text: "手書きのルールで判定できない行があります。算定できるか確かめてください", rule: f.ruleId });
        });
        continue;
      }
      const days = f.days ?? (f.missing?.date ? [f.missing.date] : null);
      // 日で決まるルールの、日を持たない情報不足は候補に付けず、点検の範囲に 1 行（C-282）
      if (f.kind === "情報不足" && f.missing && days === null && DAY_RULES.has(f.ruleId)) {
        cands.forEach((_, i) => {
          for (const k of f.lineRefs) if (kubunOf.get(i)?.has(k)) dayless.set(f.missing!.field, (dayless.get(f.missing!.field) ?? new Set()).add(k));
        });
        continue;
      }
      cands.forEach((c, i) => {
        const mine = kubunOf.get(i) ?? new Set<string>();
        const hit = f.lineRefs.filter((k) => mine.has(k));
        if (hit.length === 0) return;
        if (days !== null && !days.includes(c.date)) return;
        if (f.kind === "情報不足" && f.missing) return push(i, { reason: "情報不足", text: `${needLabel(f.missing.field as NeedKey)}を確かめないと算定できるかは言えません`, rule: f.ruleId });
        const fix = f.kind === "区分誤り" ? fixOf(f, hit[0], rev) : null;
        if (fix && family[fix] !== undefined && family[fix] === family[hit[0]])
          return push(i, { reason: "同じ族の区分誤り", text: `正しい区分は${f.params?.fixName ?? nameOf(fix)}の恐れがあります（${f.ruleId} による）。どの区分で算定するか確かめてください`, rule: f.ruleId, doubt: true });
        push(i, { reason: "手書きのルールの指摘", text: `${contentOf(f, mine, c.date)}。${ruleName(f.ruleId)}に当たる恐れがあります。算定できるか確かめてください`, rule: f.ruleId });
      });
    }
    for (const [field, ks] of dayless) scope.push(`${needLabel(field as NeedKey)}が分からないので、${[...ks].map(nameOf).join("・")}の候補は算定できるか確かめてください`);
    return { notes, scope };
  };
}

/** 段 18b の形（R18 だけ）。テストと、担当のルールを掛けない呼び出しのため */
export const r18Step3 = (base: ClaimContext, rev: Revision, db: MastersDb | null): Step3 => rulesStep3(base, rev, db, false);

/** 手順 1 の同じ族の例外（L-128）：元の請求＋候補 1 つに R18 を 1 回掛け、候補の区分を同じ族に直す区分誤りがあれば、その添え書き */
export function r18SameFamily(base: ClaimContext, rev: Revision, db: MastersDb | null): SameFamily {
  return (cand) => {
    const rule = rev.rules.find((r) => r.id === "R18");
    if (!rule) return null;
    const { ctx, kubunOf } = contextOf(base, rev, db, [cand]);
    const mine = kubunOf.get(0) ?? new Set<string>();
    const family = kubunFamily(rev.consts);
    for (const f of evaluateWith(ctx, { ...rev, rules: [rule] }).findings) {
      if (f.kind !== "区分誤り" || !f.params?.fix) continue;
      const k = f.lineRefs.find((x) => mine.has(x));
      if (k && family[f.params.fix] !== undefined && family[f.params.fix] === family[k])
        return { reason: "同じ族の区分誤り", text: `正しい区分は${f.params.fixName ?? f.params.fix}の恐れがあります（R18 による）。どの区分で算定するか確かめてください`, rule: "R18", doubt: true };
    }
    return null;
  };
}
