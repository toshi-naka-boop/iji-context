// 手書きのルール（R01〜）と、データで動く点検（G04〜）の重なり（design.md §12-2「手書きのルールとの重なり」。C-99・X-95）。
// evaluateGeneric は手書きの結果を知らない。呼び出し側が、手書きの結果と、行とコードの対応（mapClaim の origins）と、データで動く点検の指摘をここに渡して、出すものを決める。
// 重なりは、区分キーではなく、もとの UKE のコードと単位で決める。対象は、ルールが covers で「判定する」と申告した組だけ（R04・R05・R09・R11・R12）：
//   (1) 重複：そのルールが、その組の指摘（情報不足でないもの）を出している → データの指摘は出さない（2 回言わない）
//   (2) そのルールが「確かめてください」（情報不足）で止まった → データの指摘は出す（1 つの不明と関係なく、データから言えることは言える）
//   (3) そのルールが判定して黙った → 当たる単位が全部エンジンに渡っていて、ルールが動き、情報不足を返さず、記録があるか、その判定が出来事を読まない、の全部を満たす組だけ止める（数を返す）
//   (4) それ以外（申告のない組、対象外の単位のコードを含む組）→ そのまま出す
import type { Revision } from "../engine/revisions/types";
import type { ClaimLine, EngineResult } from "../engine/types";
import type { TimedClaim } from "./tensuhyo";
import type { GenericFinding } from "./types";

/** エンジンに渡った行 1 つ：区分と、もとの単位の番号（請求の units の添字）・コード */
export type MappedLine = { kubun: string; unit: number; codes: string[] };

/** mapClaim の lines と origins（同じ並び）を、行ごとに並べる */
export const mappedLinesOf = (lines: Pick<ClaimLine, "kubun">[], origins: { unit: number; codes: string[] }[]): MappedLine[] =>
  lines.map((l, i) => ({ kubun: l.kubun, unit: origins[i].unit, codes: origins[i].codes }));

/**
 * 区分キーの算定行（月末の点検で入力した行・カルテから導いた行）を、算定日つきの請求と、行とコードの対応にする（design.md §12-2）：
 * 区分を codes[kubun].primary でコードに直し、1 行を 1 単位にする。コードに直せない区分（uncoded）と、包括の検査の区分は掛けない（src/generic/index.ts の unitsOfLines と同じ）。
 * きざみで数える区分（行の回数が 項目数 × 回数 になっている）は、算定のある日ごとに 1 回として渡す（少なく数える側）
 */
export function claimOfLines(lines: ClaimLine[], rev: Revision): { claim: TimedClaim; mapped: MappedLine[] } {
  const claim: TimedClaim = { units: [] };
  const mapped: MappedLine[] = [];
  for (const l of lines) {
    if (!Object.hasOwn(rev.codes, l.kubun)) continue;
    const { primary, quantity } = rev.codes[l.kubun];
    const dates = quantity ? [...new Set(l.dates)] : l.dates;
    const days = Array.from({ length: 31 }, () => 0);
    for (const d of dates) {
      const n = Number(d.slice(8, 10));
      if (n >= 1 && n <= 31) days[n - 1]++;
    }
    mapped.push({ kubun: l.kubun, unit: claim.units.length, codes: [primary] });
    claim.units.push({ items: [{ kind: "SI", code: primary }], count: quantity ? Math.max(1, dates.length) : l.count, days });
  }
  return { claim, mapped };
}

/**
 * 画面に並べる単位にまとめる：包括（G04）の指摘は、同じ子（含まれる側。codes の 2 つ目）について親が複数あれば、1 つの組にする（言い切りと条件つきは分ける）。
 * ほかの指摘は 1 件ずつ。並びは、最初に出てきた順
 */
export function groupSameChild<T extends { check: string; certainty: string; codes: { code: string }[] }>(findings: T[]): T[][] {
  const groups = new Map<string, T[]>();
  findings.forEach((f, i) => {
    const key = f.check === "G04" && f.codes.length === 2 ? `G04:${f.codes[1].code}:${f.certainty}` : `#${i}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  });
  return [...groups.values()];
}

/** findings＝出す指摘／duplicate＝手書きの指摘と重なるので出さなかった数（1）／judged＝手書きのルールが判定済みなので止めた数（3） */
export type Overlap = { findings: GenericFinding[]; duplicate: number; judged: number };

/**
 * hand は手書きの結果（applied がない＝試算の結果では、(3) では止めない）。recordsKnown は、その請求にカルテ側の記録があるか（ClaimContext.recordsKnown）。
 * mapped は、エンジンに渡った行とコードの対応。generic は、データで動く点検の指摘
 */
export function overlap(hand: Pick<EngineResult, "findings"> & { applied?: string[] }, rev: Revision, recordsKnown: boolean, mapped: MappedLine[], generic: GenericFinding[]): Overlap {
  const kubunOf = new Map<string, string>();
  for (const m of mapped) for (const code of m.codes) if (!kubunOf.has(code)) kubunOf.set(code, m.kubun);
  const mappedUnits = new Set(mapped.map((m) => m.unit));
  const setKey = (kubun: string[]) => [...new Set(kubun)].sort().join("|");
  const covers = rev.rules.flatMap((rule) => {
    const c = rule.covers?.(rev);
    return c ? [{ rule, kind: c.kind, finding: c.finding, sets: new Set(c.kubun.map(setKey)) }] : [];
  });
  const out: Overlap = { findings: [], duplicate: 0, judged: 0 };
  for (const g of generic) {
    const kubun = g.codes.map((code) => kubunOf.get(code));
    // 当たるコードのどれかが、エンジンに渡っていない（手書きの表にないコード）→ 手書きは、その組を見ていない
    const owners = kubun.includes(undefined) ? [] : covers.filter((c) => c.kind === g.kind && c.sets.has(setKey(kubun as string[])));
    const said = owners.some((c) => hand.findings.some((f) => f.ruleId === c.rule.id && f.kind !== "情報不足" && f.messageKey === `${c.rule.id}.${c.finding}` && f.lineRefs.some((k) => kubun.includes(k))));
    if (said) {
      out.duplicate++;
      continue;
    }
    const judged =
      g.units.every((u) => mappedUnits.has(u)) &&
      owners.some((c) => hand.applied?.includes(c.rule.id) && !hand.findings.some((f) => f.ruleId === c.rule.id && f.kind === "情報不足") && (recordsKnown || !c.rule.recordFindings.includes(c.finding)));
    if (judged) out.judged++;
    else out.findings.push(g);
  }
  return out;
}
