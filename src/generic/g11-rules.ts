// G11 の手順 3（design.md §15-8）：元の請求＋手順 1 を通った候補の全部に、手書きのルールを 1 回掛け、候補が関わる指摘を候補の添え書きにする（隠さない）。
// 段 18b は R18 だけを掛ける（段 18c に頼らない。round-53 C-273）。担当のルール（g11Owned の区分）・指摘の days・同じ族の区分誤りの文は段 18c で足す。
// 候補のコードが版の区分に当たれば行にし、当たらなければ点検の対象外の単位として足す（partial のルールの決め方は src/engine/index.ts の partialBy）
import { evaluateWith, partialBy } from "../engine";
import { kubunOfCode } from "../engine/revisions/codes";
import type { Revision } from "../engine/revisions/types";
import type { ClaimContext } from "../engine/types";
import { findingText, needLabel } from "../messages";
import type { MastersDb } from "../masters/db";
import type { NeedKey } from "../engine/types";
import type { Note, Step3 } from "./g11";
import { outsideOf } from "./lookup";

/** base は元の請求の文脈（取り込んだ請求は mapClaim の行と対象外の単位、算定プレビューは導出の行） */
export function r18Step3(base: ClaimContext, rev: Revision, db: MastersDb | null): Step3 {
  return (cands) => {
    const notes = new Map<number, Note[]>();
    const rule = rev.rules.find((r) => r.id === "R18");
    if (!rule) return { notes, scope: [] };
    const lines = [...base.lines];
    const kubunOf = new Map<number, Set<string>>();
    const codesOf = new Map<number, Set<string>>();
    const outside: string[] = [];
    for (const c of cands)
      for (const u of c.units)
        for (const it of u.items) {
          codesOf.set(c.id, (codesOf.get(c.id) ?? new Set()).add(it.code));
          const k = it.kind === "SI" ? kubunOfCode(rev, it.code) : null;
          if (k) {
            lines.push({ kubun: k, count: Math.max(1, u.count), dates: [c.date] });
            kubunOf.set(c.id, (kubunOf.get(c.id) ?? new Set()).add(k));
          } else outside.push(it.code);
        }
    let ctx: ClaimContext = { ...base, lines };
    if (outside.length > 0) {
      const codes = [...(base.outside?.codes.map((x) => x.code) ?? []), ...outside];
      const o = db ? outsideOf(db, rev, base.yearMonth, codes) : undefined;
      ctx = { ...ctx, partial: true, ...(o ? { outside: o } : {}) };
    }
    const result = evaluateWith(ctx, { ...rev, rules: [rule] });
    const by = partialBy(rule, rev, ctx);
    const hits = by === "all" ? null : new Set((by ?? []).map((x) => x.code));
    const push = (id: number, n: Note) => {
      const list = notes.get(id) ?? [];
      if (!list.some((m) => m.text === n.text)) list.push(n);
      notes.set(id, list);
    };
    for (const f of result.findings) {
      for (const c of cands) {
        const mine = kubunOf.get(c.id) ?? new Set();
        if (f.kind === "情報不足" && f.missing?.field === "unsupportedLines") {
          // 判定できない行：partial にした対象外の単位のコードに、候補のコードが入るとき
          if (hits === null || [...(codesOf.get(c.id) ?? [])].some((x) => hits.has(x))) push(c.id, { reason: "手書きのルールで判定できない行", text: "手書きのルールで判定できない行があります。算定できるか確かめてください" });
          continue;
        }
        if (!f.lineRefs.some((k) => mine.has(k))) continue;
        if (f.kind === "情報不足" && f.missing) push(c.id, { reason: "情報不足", text: `${needLabel(f.missing.field as NeedKey)}を確かめないと算定できるかは言えません` });
        else push(c.id, { reason: "手書きのルールの指摘", text: `${findingText(f)}。施設の種別（R18）に当たる恐れがあります。算定できるか確かめてください` });
      }
    }
    return { notes, scope: [] };
  };
}
