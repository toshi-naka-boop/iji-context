// R17 摘要欄の記載（design.md §11-13）。コメントを持つ作り方の請求（commentsKnown が真）だけを見る。偽なら当たらない（指摘も情報不足も返さない）。
// 置き場所では判定しない：コメントコードは項目ごとに決まっているので、「レセプトのどこかに、そのコードのコメントがあるか」で見る（Comment.on は使わない）。
// どの記載が要るかは版の表（EM §2-10 表 1）、条件と数え方は comments.ts（導出の「摘要欄に書くこと」と共有）。文章（理由）の中身は読まない
import { commentCodesFor, commentFormatOk, commentWhen, dateOfWareki, kanriStartMonth, visitOrOushinDays, type CommentSpec } from "../comments";
import { overLimitVisitDays } from "../predicates";
import type { CommentRule } from "../revisions/types";
import type { ClaimContext, Finding, Rule } from "../types";
import { eventsOf, present } from "./util";

export function makeR17(spec: CommentSpec): Rule {
  const kubun = [...new Set(spec.comments.flatMap((r) => r.kubun))];
  return {
    id: "R17",
    kubun,
    reference: "診療報酬請求書等の記載要領 別表Ⅰ（摘要欄への記載事項）",
    // 死亡年月日の突き合わせだけが、出来事（死亡の記録）を読む。算定開始月の突き合わせは、記録になければ比べない
    recordFindings: ["comment_mismatch_deathDate"],
    // 点検の対象外の行がある請求で出すのは、必ず要る記載（when が always）の記載もれと、形式だけ。条件つきの記載と日付の突き合わせは申告しない（design.md §11-11）
    soundWhenPartial: ["comment_missing", "comment_format"],
    appliesTo: (ctx) => ctx.commentsKnown && present(ctx, kubun).length > 0,
    // 条件を決める事実の不明は、記載ごとに check が情報不足で返す（needs に入れると、ほかの記載の点検まで止まる）
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const comments = ctx.comments ?? [];
      for (const rule of spec.comments) {
        const refs = present(ctx, rule.kubun);
        if (refs.length === 0) continue;
        const found = (key: string, params: Record<string, string> = {}): Finding => ({
          ruleId: this.id,
          kind: "記載もれ",
          lineRefs: refs,
          messageKey: `${this.id}.${key}`,
          params: { rule: rule.id, what: rule.summary, ...params },
          reference: this.reference,
        });
        const badFormat = comments.some((x) => rule.codes.includes(x.code) && !commentFormatOk(x.code, x.text));
        if (badFormat) out.push(found("comment_format"));
        const when = commentWhen(rule, ctx, spec);
        if (when.known === false) {
          // 条件を決める事実（別表第七・急性増悪・看取りの場所）は、どれも医師が確かめる
          out.push({ ruleId: this.id, kind: "情報不足", lineRefs: refs, missing: { target: "doctor", field: when.need }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
          continue;
        }
        if (when.times === 0) continue;
        const codes = commentCodesFor(rule, ctx, spec);
        const countOf = (code: string) => comments.filter((x) => x.code === code).length;
        const enough = rule.need === "each" ? codes.every((code) => countOf(code) >= when.times) : codes.reduce((s, code) => s + countOf(code), 0) >= when.times;
        if (!enough) {
          // 点検の対象外の行がある請求では、条件つきの記載の記載もれを、申告のない種類にする（evaluate が捨てて、決められないと返す）
          out.push(found(ctx.partial && rule.when !== "always" ? "comment_missing_conditional" : "comment_missing"));
          continue;
        }
        // 形式の合わない記載がある項目は、中身を比べない（読めない値を「食い違い」と言わない）
        if (badFormat || rule.compare === undefined) continue;
        const mismatch = compare(rule.compare, ctx, codes);
        if (mismatch) out.push(found(`comment_mismatch_${rule.compare}`, mismatch));
      }
      return out;
    },
  };

  /** 中身の突き合わせ。食い違えば、文言に埋める値（足りない日 lacking・多い日 extra。"YYYY-MM-DD" の「,」区切り）を返す。比べない場合と一致は null */
  function compare(kind: NonNullable<CommentRule["compare"]>, ctx: ClaimContext, codes: string[]): Record<string, string> | null {
    const mine = (ctx.comments ?? []).filter((x) => codes.includes(x.code));
    const datesOf = (pick: (code: string) => boolean) => [...new Set(mine.filter((x) => pick(x.code)).map((x) => dateOfWareki(x.text) as string))].sort();
    const diff = (written: string[], billed: string[], both: boolean): Record<string, string> | null => {
      const lacking = billed.filter((d) => !written.includes(d));
      const extra = both ? written.filter((d) => !billed.includes(d)) : [];
      return lacking.length || extra.length ? { ...(lacking.length ? { lacking: lacking.join(",") } : {}), ...(extra.length ? { extra: extra.join(",") } : {}) } : null;
    };
    switch (kind) {
      case "visitDates":
        // 記載の年月日の集合と、訪問診療料・往診料の行の算定日の集合が一致するか
        return diff(datesOf(() => true), visitOrOushinDays(ctx, spec), true);
      case "acuteVisitDates":
        // 「訪問診療を行った年月日」の記載が、週の上限を超えた週の訪問診療料の算定日をすべて含むか
        return diff(datesOf((code) => spec.commentCodes[code]?.visited === true), overLimitVisitDays(ctx, spec.consts), false);
      case "deathDate": {
        // 記録がない請求では比べない（evaluate も recordFindings の申告で捨てる）。記録があって死亡の出来事がなければ、「なかった」と読む
        if (!ctx.recordsKnown) return null;
        const death = eventsOf(ctx, "death")[0]?.date;
        return datesOf(() => true).some((d) => d !== death) ? {} : null;
      }
      case "hokatsuState": {
        // 事実と対応のあるコード（要介護3・4・5、障害支援区分2 以上）だけを、確かめてある事実と比べる。事実が不明なら比べない
        const care = ctx.facts.careLevel;
        const disability = ctx.facts.disabilitySupportLevel;
        const wrong = mine.some((x) => {
          const note = spec.commentCodes[x.code];
          if (note?.careLevel !== undefined && care.known && care.value !== note.careLevel) return true;
          return note?.disabilityLevelMin !== undefined && disability.known && disability.value < note.disabilityLevelMin;
        });
        return wrong ? {} : null;
      }
      case "ikouStart": {
        // 算定開始月の記録がなければ比べない（記録のない請求では不明）
        const start = kanriStartMonth(ctx);
        return start !== undefined && datesOf(() => true).some((d) => d.slice(0, 7) !== start) ? {} : null;
      }
    }
  }
}
