// evaluate(ctx)：渡された算定行を検証し、合計する純関数（design.md §2）。算定行を生成しない
import type { ClaimContext, EngineResult, FactKey, Finding, Rule } from "./types";
import { pointsOf } from "./points-2024";
import { r01 } from "./rules/r01";
import { r02 } from "./rules/r02";
import { r03 } from "./rules/r03";
import { r04 } from "./rules/r04";
import { r05 } from "./rules/r05";
import { r06 } from "./rules/r06";
import { r07 } from "./rules/r07";
import { r08 } from "./rules/r08";
import { r09 } from "./rules/r09";
import { r10 } from "./rules/r10";
import { r11 } from "./rules/r11";
import { r12 } from "./rules/r12";
import { r13 } from "./rules/r13";
import { r14 } from "./rules/r14";

export const RULES: Rule[] = [r01, r02, r03, r04, r05, r06, r07, r08, r09, r10, r11, r12, r13, r14];

/** 制度層の知識が結果と「関係あり」かを決めるための、ルールの対象区分（§4-4） */
export function ruleKubun(ruleId: string): string[] {
  const rule = RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`未知のルール: ${ruleId}`);
  return rule.kubun;
}

/** 不明な事実を誰に聞くか。臨床の判断は医師、それ以外は医療事務 */
const DOCTOR_FACTS: FactKey[] = ["table7", "table8_2", "mainDisease", "homeOxygen", "acuteExacerbation", "deathPlace"];

export function evaluate(ctx: ClaimContext): EngineResult {
  if (ctx.yearMonth !== "2025-03") throw new Error(`診療年月は 2025-03 固定: ${ctx.yearMonth}`);

  const byLine = ctx.lines.map((l) => ({ kubun: l.kubun, points: pointsOf(l.kubun) }));
  const total = byLine.some((b) => b.points === null)
    ? null
    : ctx.lines.reduce((s, l, i) => s + (byLine[i].points as number) * l.count, 0);

  const findings: Finding[] = [];
  const applied: string[] = [];
  for (const rule of RULES) {
    if (!rule.appliesTo(ctx)) continue;
    applied.push(rule.id);
    const unknown = rule.needs(ctx).find((k) => !ctx.facts[k].known);
    if (unknown) {
      findings.push({
        ruleId: rule.id,
        kind: "情報不足",
        lineRefs: rule.kubun.filter((k) => ctx.lines.some((l) => l.kubun === k)),
        missing: { target: DOCTOR_FACTS.includes(unknown) ? "doctor" : "clerk", field: unknown },
        messageKey: `${rule.id}.missing_fact`,
        reference: rule.reference,
      });
      continue;
    }
    findings.push(...rule.check(ctx));
  }
  return { claimId: ctx.claimId, total, byLine, findings, applied };
}
