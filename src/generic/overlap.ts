// 手書きのルール（R01〜）と、データで動く点検（G04〜）の重なり（design.md §12-2「手書きのルールとの重なり」。C-99・X-95）。
// evaluateGeneric は手書きの結果を知らない。呼び出し側が、手書きの結果と、行とコードの対応（mapClaim の origins）と、データで動く点検の指摘をここに渡して、出すものを決める。
// 重なりは、区分キーではなく、もとの UKE のコードと単位で決める。対象は、ルールが covers で「判定する」と申告した組だけ（R04・R05・R06・R09・R11・R12・R17）：
// 記載もれ（G07 と R17）は、区分に加えて、同じ記載（コメントコード）のときだけ重ねる：G07 の指摘の候補のコードと、版の表（rev.comments）の、その区分の必ず要る行のコードが 1 つでも重なること
//   (1) 重複：そのルールが、その組の指摘（情報不足でないもの）を出している → データの指摘は出さない（2 回言わない）
//   (2) そのルールが「確かめてください」（情報不足）で止まった → データの指摘は出す（1 つの不明と関係なく、データから言えることは言える）
//   (3) そのルールが判定して黙った → 当たる単位が全部エンジンに渡っていて、ルールが動き、情報不足を返さず、記録があるか、その判定が出来事を読まない、の全部を満たす組だけ止める（数を返す）
//   (4) それ以外（申告のない組、対象外の単位のコードを含む組）→ そのまま出す
// 施設基準（G10）は covers ではなく、施設基準コードの担当の表（src/facility/codes.ts の KIJUN_OWNERS。design.md §15-5。C-216）で決める：
//   その行について担当のルールが申告の値で言った（区分誤り・要件不足の指摘か、担当の申告の値の情報不足）→ G10 は出さない（手書きのルールが判定済みに数える）。ほかは出す
import type { Revision } from "../engine/revisions/types";
import { HOSPITAL_CODES, HOSPITAL_SIDE_CODES, KIJUN_OWNERS } from "../facility/codes";
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
 * 区分を codes[kubun].primary でコードに直し、1 行を 1 単位にする。コードに直せない区分（uncoded）と、包括の検査の区分は掛けない。
 * きざみで数える区分（行の回数が 項目数 × 回数 になっている）は、算定のある日ごとに 1 回として渡す（少なく数える側）
 */
export function claimOfLines(lines: ClaimLine[], rev: Revision): { claim: TimedClaim; mapped: MappedLine[] } {
  const claim: TimedClaim = { units: [] };
  const mapped: MappedLine[] = [];
  for (const l of lines) {
    // 回数 0 の行（算定日なし。入力の途中で 0 に直した行）は、算定していない行なので渡さない（round-32 codex-1）
    if (l.count <= 0 || !Object.hasOwn(rev.codes, l.kubun)) continue;
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

/**
 * G10 の指摘の組（params.kijunCodes）を担当する手書きのルール。在支病・病院の側のコードは除いて、残りが全部同じ担当の行にあるときだけ（表にないコードを含む組は G10 だけが言う）
 */
function ownerOf(kijunCodes: string): (typeof KIJUN_OWNERS)[number] | null {
  const hospital = [...HOSPITAL_CODES, ...HOSPITAL_SIDE_CODES] as string[];
  const codes = kijunCodes.split("/").filter((c) => c !== "" && !hospital.includes(c));
  if (codes.length === 0) return null;
  const owner = KIJUN_OWNERS.find((o) => o.codes.includes(codes[0]));
  return owner && codes.every((c) => owner.codes.includes(c)) ? owner : null;
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
  /** 記載もれ：版の表の、その区分の必ず要る行（id を渡せば、その行）が、指摘の候補のコメントコードを持つか。ほかの種類は、いつも真 */
  const sameComment = (g: GenericFinding, kubun: (string | undefined)[], id?: string): boolean => {
    if (g.kind !== "記載もれ") return true;
    const wanted = (g.params.comments ?? "").split(",");
    return rev.comments.some((r) => (id === undefined || r.id === id) && r.when === "always" && r.kubun.some((k) => kubun.includes(k)) && r.codes.some((c) => wanted.includes(c)));
  };
  const out: Overlap = { findings: [], duplicate: 0, judged: 0 };
  for (const g of generic) {
    // 施設基準（G10）：担当のルールが、その行について申告の値で言ったときだけ出さない（手書きのルールの側を残す。§0-12）
    if (g.check === "G10") {
      const owner = ownerOf(g.params.kijunCodes ?? "");
      const k = kubunOf.get(g.codes[0]);
      const said =
        owner !== null &&
        k !== undefined &&
        hand.findings.some((f) => f.ruleId === owner.rule && f.lineRefs.includes(k) && (f.kind === "情報不足" ? f.missing !== undefined && owner.fields.includes(f.missing.field) : owner.keys.includes(f.messageKey)));
      if (said) out.judged++;
      else out.findings.push(g);
      continue;
    }
    // 背反の特例の例外に当たる場合の記載（G05.exception_needs_comment。design.md §13-2 の 2。C-119・X-108）：covers には頼らず、
    // 同じ請求で手書きの R17 が同じコメントコードの記載もれ（情報不足でないもの）を出していれば出さない。R17 が止まった・情報不足を返した・出していないときは出す
    if (g.messageKey === "G05.exception_needs_comment") {
      const wanted = (g.params.comments ?? "").split("・");
      if (hand.findings.some((f) => f.ruleId === "R17" && f.kind === "記載もれ" && f.messageKey === "R17.comment_missing" && rev.comments.some((r) => r.id === f.params?.rule && r.codes.some((c) => wanted.includes(c))))) {
        out.duplicate++;
        continue;
      }
    }
    // 記載の形（G07.form・form_day00・form_future。design.md §17-3）：同じコメントの行（UKE の行番号）について R17 が指摘（形 comment_format、中身の食い違い comment_mismatch_* など）を
    // 出しているときだけ出さない（X-321・C-480）。別の行の G07 の指摘は残す。R17 は対応する算定行がなければ形を見ないので、R17 のコードでも R17 が見なかったコメントは G07 が言う
    if (g.messageKey.startsWith("G07.form")) {
      const line = g.params.line;
      if (line !== undefined && hand.findings.some((f) => f.ruleId === "R17" && f.kind !== "情報不足" && (f.params?.lines ?? "").split(",").includes(line))) out.duplicate++;
      else out.findings.push(g);
      continue;
    }
    const kubun = g.codes.map((code) => kubunOf.get(code));
    // 当たるコードのどれかが、エンジンに渡っていない（手書きの表にないコード）→ 手書きは、その組を見ていない
    const owners = kubun.includes(undefined) ? [] : covers.filter((c) => c.kind === g.kind && c.sets.has(setKey(kubun as string[])) && sameComment(g, kubun));
    const said = owners.some((c) => hand.findings.some((f) => f.ruleId === c.rule.id && f.kind !== "情報不足" && f.messageKey === `${c.rule.id}.${c.finding}` && f.lineRefs.some((k) => kubun.includes(k)) && sameComment(g, kubun, f.params?.rule)));
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
  // 同じ診療行為に、傷病名の要件（G08）と診療行為の適応（G09）の両方が残ったときは、G08 だけを出す（同じ「対象の傷病名が見当たらない」を 2 回言わない）。
  // 重なりの規則の後で消す：G08 が手書きのルール（R06）の判定済み・重複で消えたときは、G09 を残す（round-32 O-16）
  const g08Codes = new Set(out.findings.filter((f) => f.check === "G08").flatMap((f) => f.codes));
  out.findings = out.findings.filter((f) => !(f.check === "G09" && f.messageKey.startsWith("G09.si_") && f.codes.some((c) => g08Codes.has(c))));
  return out;
}
