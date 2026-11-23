// evaluate(ctx)：渡された算定行を検証し、合計する純関数（design.md §2）。算定行を生成しない
// 点数とルールは、診療年月から決まる改定の版のものを使う（§2-5）。該当する版がなければ例外
import { pointsOf, resolveRevision, REVISIONS } from "./revisions";
import type { Revision } from "./revisions/types";
import type { ClaimContext, ClaimLine, EngineResult, FacilityFactKey, FactKey, Finding, NeedKey, OutsideCode, Rule } from "./types";

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
const DOCTOR_FACTS: FactKey[] = ["table7", "table8_2", "table8_3Other", "mainDisease", "homeOxygen", "acuteExacerbation", "deathPlace", "rxLongPsychotropic"];

/** 不明な入力の宛先（導出の保留と共有する） */
export const targetOfNeed = (key: NeedKey): "doctor" | "clerk" => ((DOCTOR_FACTS as string[]).includes(key) ? "doctor" : "clerk");

/** 要る入力（患者の事実か、施設の設定）が分かっているか */
function knownNeed(ctx: ClaimContext, key: NeedKey): boolean {
  return key.startsWith("facility.") ? ctx.facility[key.slice("facility.".length) as FacilityFactKey].known : (ctx.facts[key as FactKey]?.known ?? false);
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

/**
 * そのルールを partial として扱うか（design.md §12-4）。null＝扱わない（対象外の単位がないか、あっても、このルールの読む区分と関係がない）。
 * "all"＝対象外の単位があり、ルールごとには決められない（基本マスターがない／ルールに reads の申告がない／読む区分の区分番号が引けない）。
 * 配列＝このルールを止める対象外の単位のコード：マスターにないコードと、reads の区分と同じ区分番号のコード
 */
export function partialBy(rule: Rule, rev: Revision, input: Pick<ClaimContext, "partial" | "outside">): "all" | OutsideCode[] | null {
  if (!input.partial) return null;
  const reads = rule.reads?.(rev);
  if (!input.outside || !reads) return "all";
  const nos = new Set<string>();
  for (const k of reads) {
    const no = Object.hasOwn(input.outside.noOf, k) ? input.outside.noOf[k] : [];
    if (no.length === 0) return "all";
    for (const n of no) nos.add(n);
  }
  const hit = input.outside.codes.filter((c) => !c.known || (c.no !== null && nos.has(c.no)));
  return hit.length > 0 ? hit : null;
}

/**
 * 重なりの段（design.md §15-4。round-57 C-324・round-58 C-332）：同じ行に R19 の use_band が出たら、R18 の use_note14_reduced を外す
 * （R19 の名称が注14 の側まで名指しするので、直し先を 2 つ出さない）。note14_conflict と facility.note14 の情報不足は外さない
 */
function overlapNote14(findings: Finding[]): Finding[] {
  const band = new Set(findings.filter((f) => f.messageKey === "R19.use_band").flatMap((f) => f.lineRefs));
  return findings.filter((f) => f.messageKey !== "R18.use_note14_reduced" || !f.lineRefs.every((k) => band.has(k)));
}

export function evaluate(input: ClaimContext, revs: Revision[] = REVISIONS): EngineResult {
  return evaluateWith(input, resolveRevision(input.yearMonth, revs));
}

/** evaluate の中身。版の解決だけを飛ばし、渡された版の点数表とルールで判定する（試算が使う。design.md §11-12） */
export function evaluateWith(input: ClaimContext, rev: Revision): EngineResult {
  // 行ごとの点数と合計は、渡された行のまま出す
  const byLine = input.lines.map((l) => ({ kubun: l.kubun, points: pointsOf(rev, l.kubun) }));
  // 点数未収載の行があれば、行の合計は出さない
  const sum = byLine.some((b) => b.points === null) ? null : input.lines.reduce((s, l, i) => s + (byLine[i].points as number) * l.count, 0);
  // 点検の対象外の単位（partial。§11-11）があれば、合計は出さない（partial では、点検した行の小計を別に返す）
  const total = input.partial ? null : sum;

  // ルールには、同じ区分の行を束ねた請求を渡す
  const merged: ClaimContext = { ...input, lines: mergeLines(input.lines) };

  const findings: Finding[] = [];
  const applied: string[] = [];
  for (const rule of rev.rules) {
    // 対象外の単位がある請求でも、このルールの読む区分と関係がなければ、このルールは全部の行がある請求として判定する（design.md §12-4）
    const ctx: ClaimContext = merged.partial && partialBy(rule, rev, merged) === null ? { ...merged, partial: false } : merged;
    if (!rule.appliesTo(ctx)) continue;
    applied.push(rule.id);
    // 記録がないので決められない指摘があることを、情報不足として 1 件返す。入力では消えない（この請求に記録を足す手段がない）
    if (!ctx.recordsKnown && rule.recordFindings.length > 0)
      findings.push({
        ruleId: rule.id,
        kind: "情報不足",
        lineRefs: rule.kubun.filter((k) => ctx.lines.some((l) => l.kubun === k)),
        missing: { target: "clerk", field: "chartRecord" },
        messageKey: `${rule.id}.missing_fact`,
        reference: rule.reference,
      });
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
        ...(rule.needDays ? { days: rule.needDays(ctx) } : {}),
      });
      continue;
    }
    const found = rule.check(ctx);
    // カルテ側の記録がない請求：出来事を読んで決める指摘は捨てる（空の出来事を「なかった」と読まない）。行と事実だけで決まる指摘はそのまま出す
    const kept = ctx.recordsKnown ? found : found.filter((f) => !rule.recordFindings.includes(f.messageKey.slice(rule.id.length + 1)));
    // 点検の対象外の単位がある請求：いまある行と確かめた事実だけから言えると申告のある種類（soundWhenPartial）だけを出す。
    // 捨てた指摘があれば、決められないことを情報不足として 1 件返す。入力では消えない。情報不足（確かめる事実）はそのまま出す
    const sound = ctx.partial ? kept.filter((f) => f.kind === "情報不足" || rule.soundWhenPartial.includes(f.messageKey.slice(rule.id.length + 1))) : kept;
    if (sound.length < kept.length)
      findings.push({
        ruleId: rule.id,
        kind: "情報不足",
        lineRefs: rule.kubun.filter((k) => ctx.lines.some((l) => l.kubun === k)),
        missing: { target: "clerk", field: "unsupportedLines" },
        messageKey: `${rule.id}.missing_fact`,
        reference: rule.reference,
      });
    findings.push(...sound);
  }
  return { claimId: input.claimId, revisionId: rev.id, total, ...(input.partial ? { subtotal: sum } : {}), byLine, findings: overlapNote14(findings), applied };
}
