// R17 摘要欄の記載（design.md §11-13）。コメントを持つ作り方の請求（commentsKnown が真）だけを見る。偽なら当たらない（指摘も情報不足も返さない）。
// 置き場所では判定しない：コメントコードは項目ごとに決まっているので、「レセプトのどこかに、そのコードのコメントがあるか」で見る（Comment.on は使わない）。
// どの記載が要るかは版の表（EM §2-10 表 1）、条件と数え方は comments.ts（導出の「摘要欄に書くこと」と共有）。文章（理由）の中身は読まない
import { commentCodesFor, commentFormatOk, commentWhen, dateOfWareki, kanriStartMonth, visitOrOushinDays, type CommentSpec } from "../comments";
import { kanriKubun, overLimitVisitDays } from "../predicates";
import type { CommentRule } from "../revisions/types";
import type { ClaimContext, Comment, Finding, Rule } from "../types";
import { eventsOf, present } from "./util";
import { hasVisit2, VISIT2_HELD_COMMENTS } from "../visit2";

export function makeR17(spec: CommentSpec): Rule {
  const kubun = [...new Set(spec.comments.flatMap((r) => r.kubun))];
  return {
    id: "R17",
    kubun,
    reference: "診療報酬請求書等の記載要領 別表Ⅰ（摘要欄への記載事項）",
    // 死亡年月日の突き合わせだけが、出来事（死亡の記録）を読む。算定開始月の突き合わせは、記録になければ比べない
    recordFindings: ["comment_mismatch_deathDate"],
    // 点検の対象外の行がある請求で出すのは、必ず要る記載（when が always）の記載もれと、形式、包括的支援加算の状態と確かめた事実の食い違い
    // （コメントと事実だけで決まる。対象外の行が増えても解消しない：反証 round-28）。条件つきの記載と日付の突き合わせは申告しない（design.md §11-11）
    soundWhenPartial: ["comment_missing", "comment_format", "comment_mismatch_hokatsuState"],
    // 条件と突き合わせが読む行：訪問診療料・往診料の日（同じ日の往診の理由・週の上限・訪問日の記載）と、管理料の族（族ごとにコードが違う記載）
    reads() {
      return [...new Set([...this.kubun, ...spec.consts.visitKubun, spec.consts.oushin.kubun, ...kanriKubun(spec.consts)])];
    },
    // 必ず要る記載（when が always）の記載もれを判定する。データで動く点検（G07）と重ねるための申告で、判定は変えない。同じ記載（コメントコード）かどうかは、重なりの規則が版の表で見る
    covers: () => ({ kind: "記載もれ", finding: "comment_missing", kubun: [...new Set(spec.comments.filter((r) => r.when === "always").flatMap((r) => r.kubun))].map((k) => [k]) }),
    appliesTo: (ctx) => ctx.commentsKnown && present(ctx, kubun).length > 0,
    // 条件を決める事実の不明は、記載ごとに check が情報不足で返す（needs に入れると、ほかの記載の点検まで止まる）
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const comments = ctx.comments ?? [];
      for (const rule of spec.comments) {
        const refs = present(ctx, rule.kubun);
        if (refs.length === 0) continue;
        // 訪問診療料(Ⅰ)2 の行がある請求：在医総管の月の訪問日の記載（T176）は決められない（design.md §18-12 の 8。当面の形。src/engine/visit2.ts）
        if (VISIT2_HELD_COMMENTS.includes(rule.id) && hasVisit2(ctx.lines, spec.consts)) {
          out.push({ ruleId: this.id, kind: "情報不足", lineRefs: refs, missing: { target: "clerk", field: "unsupportedLines" }, messageKey: `${this.id}.missing_fact`, params: { rule: rule.id }, reference: this.reference });
          continue;
        }
        const found = (key: string, params: Record<string, string> = {}): Finding => ({
          ruleId: this.id,
          kind: "記載もれ",
          lineRefs: refs,
          messageKey: `${this.id}.${key}`,
          params: { rule: rule.id, what: rule.summary, ...params },
          reference: this.reference,
        });
        // seqs は、その指摘が言っているコメントの通し番号（通し番号を持つコメントだけ。「,」区切り）：形の指摘は形が誤ったコメント、比べる指摘は中身を言っているコメント（多い日の記載）だけ。
        // データで動く点検の記載の形の指摘と、コメント 1 つの単位で重ねる（design.md §17-3。X-321・X-330・X-331）
        const seqsOf = (list: typeof comments): Record<string, string> => {
          const seqs = list.flatMap((x) => (x.seq === undefined ? [] : [String(x.seq)]));
          return seqs.length > 0 ? { seqs: seqs.join(",") } : {};
        };
        const bad = comments.filter((x) => rule.codes.includes(x.code) && !commentFormatOk(x.code, x.text));
        const badFormat = bad.length > 0;
        if (badFormat) out.push(found("comment_format", seqsOf(bad)));
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
        if (mismatch) out.push(found(`comment_mismatch_${rule.compare}`, { ...mismatch.values, ...seqsOf(mismatch.used) }));
      }
      return out;
    },
  };

  /**
   * 中身の突き合わせ。食い違えば、文言に埋める値（values：足りない日 lacking・多い日 extra。"YYYY-MM-DD" の「,」区切り）と、実際に比べたコメント（used）を返す。比べない場合と一致は null。
   * used は、比べる対象のコードのコメントのうち、指摘が中身を言っているもの（多い日の記載）だけ。足りない日だけの指摘では空（X-331・X-340）
   */
  function compare(kind: NonNullable<CommentRule["compare"]>, ctx: ClaimContext, codes: string[]): { values: Record<string, string>; used: Comment[] } | null {
    const mine = (ctx.comments ?? []).filter((x) => codes.includes(x.code));
    const datesOf = (list: Comment[]) => [...new Set(list.map((x) => dateOfWareki(x.text) as string))].sort();
    const diff = (used: Comment[], billed: string[], both: boolean) => {
      const written = datesOf(used);
      const lacking = billed.filter((d) => !written.includes(d));
      const extra = both ? written.filter((d) => !billed.includes(d)) : [];
      // 重なりに使うコメントは、指摘が中身を言っているもの（多い日＝extra の記載）だけ。足りない日はコメントがないことなので、どのコメントも指していない（X-340）
      const pointed = used.filter((x) => extra.includes(dateOfWareki(x.text) as string));
      return lacking.length || extra.length ? { values: { ...(lacking.length ? { lacking: lacking.join(",") } : {}), ...(extra.length ? { extra: extra.join(",") } : {}) }, used: pointed } : null;
    };
    switch (kind) {
      case "visitDates":
        // 記載の年月日の集合と、訪問診療料・往診料の行の算定日の集合が一致するか
        return diff(mine, visitOrOushinDays(ctx, spec), true);
      case "acuteVisitDates":
        // 「訪問診療を行った年月日」の記載が、週の上限を超えた週の訪問診療料の算定日をすべて含むか
        return diff(
          mine.filter((x) => spec.commentCodes[x.code]?.visited === true),
          overLimitVisitDays(ctx, spec.consts),
          false,
        );
      case "deathDate": {
        // 記録がない請求では比べない（evaluate も recordFindings の申告で捨てる）。記録があって死亡の出来事がなければ、「なかった」と読む
        if (!ctx.recordsKnown) return null;
        const death = eventsOf(ctx, "death")[0]?.date;
        return datesOf(mine).some((d) => d !== death) ? { values: {}, used: mine } : null;
      }
      case "hokatsuState": {
        // 事実と対応のあるコード（要介護3・4・5、障害支援区分2 以上）だけを、確かめてある事実と比べる。事実が不明なら比べない
        // 月の途中で要介護度が変わり、区間で値が違う月は、要介護度の記載を比べない（design.md §18-12 の 4）
        const mixed = ctx.facts.careLevelMixed?.known === true && ctx.facts.careLevelMixed.value;
        const care = mixed ? ({ known: false } as const) : ctx.facts.careLevel;
        const disability = ctx.facts.disabilitySupportLevel;
        const used = mine.filter((x) => {
          const note = spec.commentCodes[x.code];
          return (note?.careLevel !== undefined && care.known) || (note?.disabilityLevelMin !== undefined && disability.known);
        });
        const wrong = used.some((x) => {
          const note = spec.commentCodes[x.code];
          if (note?.careLevel !== undefined && care.known && care.value !== note.careLevel) return true;
          return note?.disabilityLevelMin !== undefined && disability.known && disability.value < note.disabilityLevelMin;
        });
        return wrong ? { values: {}, used } : null;
      }
      case "ikouStart": {
        // 算定開始月の記録がなければ比べない（記録のない請求では不明）
        const start = kanriStartMonth(ctx);
        return start !== undefined && datesOf(mine).some((d) => d.slice(0, 7) !== start) ? { values: {}, used: mine } : null;
      }
    }
  }
}
