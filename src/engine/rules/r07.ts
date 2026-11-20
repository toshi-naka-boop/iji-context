// R07 処方箋料の区分（design.md §11-5）。区分 2 になる理由は 2 つ：内服の種類数が閾値以上／向精神薬の長期処方。それ以外は区分 3。
// 判定の単位は処方 1 回ごと（EM #7-13）。期待される区分は、導出の D10 と同じ述語（rxKubunOn）で決める
import { rxKubunOn } from "../predicates";
import type { RevisionConsts } from "../revisions/types";
import type { Finding, Rule } from "../types";
import { finding, has, lineOf } from "./util";

export function makeR07(c: RevisionConsts): Rule {
  const { many: MANY, other: OTHER } = c.rx;
  return {
    id: "R07",
    kubun: [OTHER, MANY],
    reference: "F400 処方箋料 2・3",
    appliesTo: (ctx) => has(ctx, OTHER) || has(ctx, MANY),
    needs: () => [],
    check(ctx) {
      /** 区分誤りの理由（行ごとに 1 件にまとめる） */
      const wrong = new Set<"use_seven_or_more" | "use_long_psychotropic" | "not_seven_or_more">();
      const missing: Finding[] = [];
      // 行の日ごとに、その日の処方から期待される区分と比べる（日付のない行は "" で引くので、対応がとれない）
      for (const k of [OTHER, MANY]) {
        if (!has(ctx, k)) continue;
        const dates = [...new Set(lineOf(ctx, k)?.dates ?? [])];
        for (const d of dates.length ? dates : [""]) {
          const e = rxKubunOn(ctx, c, d);
          if (e.known === false) {
            // 決まらない日は、区分 2 の行でも区分 3 の行でも情報不足（不明を区分 3 とみなさない。X-85）。
            // 処方の記録と対応がとれない行は、区分誤りとも正しいとも言わない
            const key = e.need === "rxRecord" ? "no_rx_record" : "missing_fact";
            const target = e.need === "rxRecord" ? "clerk" : "doctor";
            missing.push({ ruleId: this.id, kind: "情報不足", lineRefs: [k], missing: { target, field: e.need, ...(d ? { date: d } : {}) }, messageKey: `${this.id}.${key}`, reference: this.reference });
          } else if (e.kubun !== k) wrong.add(k === MANY ? "not_seven_or_more" : e.why === "long" ? "use_long_psychotropic" : "use_seven_or_more");
        }
      }
      const out: Finding[] = [];
      if (wrong.has("use_seven_or_more")) out.push(finding(this, "区分誤り", [OTHER], "use_seven_or_more"));
      if (wrong.has("use_long_psychotropic")) out.push(finding(this, "区分誤り", [OTHER], "use_long_psychotropic"));
      if (wrong.has("not_seven_or_more")) out.push(finding(this, "区分誤り", [MANY], "not_seven_or_more"));
      return [...out, ...missing];
    },
  };
}
