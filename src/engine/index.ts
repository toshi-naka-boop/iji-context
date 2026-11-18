// evaluate(ctx)：渡された算定行を検証し、合計する純関数（design.md §2）。算定行を生成しない
// 点数とルールは、診療年月から決まる改定の版のものを使う（§2-5）。該当する版がなければ例外
import { pointsOf, resolveRevision, REVISIONS } from "./revisions";
import type { Revision } from "./revisions/types";
import type { ClaimContext, ClaimLine, EngineResult, FacilityFactKey, FactKey, Finding, NeedKey, Rule } from "./types";

/** その診療年月の版のルール一式。版のない年月は例外 */
export function rulesOf(yearMonth: string, revs: Revision[] = REVISIONS): Rule[] {
  return resolveRevision(yearMonth, revs).rules;
}

/**
 * 制度層の知識が結果と「関係あり」かを決めるための、ルールの対象区分（§4-4）。提出の診療年月の版から取る。
 * その版にないルールは空配列。版のない年月は例外のまま（黙って空配列にしない）
 */
export function ruleKubun(ruleId: string, yearMonth: string, revs: Revision[] = REVISIONS): string[] {
  return rulesOf(yearMonth, revs).find((r) => r.id === ruleId)?.kubun ?? [];
}

/** 不明な事実を誰に聞くか。臨床の判断は医師、それ以外は医療事務 */
const DOCTOR_FACTS: FactKey[] = ["table7", "table8_2", "table8_3Other", "mainDisease", "homeOxygen", "acuteExacerbation", "deathPlace"];

/** 不明な入力の宛先（導出の保留と共有する） */
export const targetOfNeed = (key: NeedKey): "doctor" | "clerk" => ((DOCTOR_FACTS as string[]).includes(key) ? "doctor" : "clerk");

/** 要る入力（患者の事実か、施設の設定）が分かっているか */
function knownNeed(ctx: ClaimContext, key: NeedKey): boolean {
  return key.startsWith("facility.") ? ctx.facility[key.slice("facility.".length) as FacilityFactKey].known : ctx.facts[key as FactKey].known;
}

/**
 * 同じ区分の行（回数 1 以上）を 1 つに束ねる（回数は合計、日付は連結。並びは最初の行の位置）。
 * ルールは区分ごとに 1 行を前提に書いてあるので、同じ区分を複数の行に分けた請求でも、先頭の行だけを見て済ませない（X-75）
 */
function mergeLines(lines: ClaimLine[]): ClaimLine[] {
  const merged = new Map<string, ClaimLine>();
  const out: ClaimLine[] = [];
  for (const l of lines) {
    const first = l.count > 0 ? merged.get(l.kubun) : undefined;
    if (first) {
      first.count += l.count;
      first.dates.push(...l.dates);
      continue;
    }
    const copy = { ...l, dates: [...l.dates] };
    if (l.count > 0) merged.set(l.kubun, copy);
    out.push(copy);
  }
  return out;
}

export function evaluate(input: ClaimContext, revs: Revision[] = REVISIONS): EngineResult {
  const rev = resolveRevision(input.yearMonth, revs);
  const excludedCount = input.excluded?.length ?? 0;

  // 行ごとの点数と合計は、渡された行のまま出す
  const byLine = input.lines.map((l) => ({ kubun: l.kubun, points: pointsOf(rev, l.kubun) }));
  // 点数未収載の行か、判定の対象外の行（FR-111）があれば、合計は出さない
  const total =
    excludedCount > 0 || byLine.some((b) => b.points === null)
      ? null
      : input.lines.reduce((s, l, i) => s + (byLine[i].points as number) * l.count, 0);

  // ルールには、同じ区分の行を束ねた請求を渡す
  const ctx: ClaimContext = { ...input, lines: mergeLines(input.lines) };

  const findings: Finding[] = [];
  const applied: string[] = [];
  for (const rule of rev.rules) {
    if (!rule.appliesTo(ctx)) continue;
    applied.push(rule.id);
    const unknown = rule.needs(ctx).find((k) => !knownNeed(ctx, k));
    if (unknown) {
      findings.push({
        ruleId: rule.id,
        kind: "情報不足",
        lineRefs: rule.kubun.filter((k) => ctx.lines.some((l) => l.kubun === k)),
        // 施設の設定の不明も宛先は医療事務（field が "facility." で始まることで見分ける。§6-1）
        missing: { target: targetOfNeed(unknown), field: unknown },
        messageKey: `${rule.id}.missing_fact`,
        reference: rule.reference,
      });
      continue;
    }
    findings.push(...rule.check(ctx));
  }
  return { claimId: ctx.claimId, revisionId: rev.id, total, byLine, findings, applied, excludedCount };
}
