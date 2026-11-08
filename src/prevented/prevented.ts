// F9 防いだ額（spec FR-52〜58、決定44〜50、EM #7-5）
// 「防いだ」＝提出前にエンジンが指摘し、提出までに本人が直した項目だけ。自己申告は数えない
// 金額は点数×10円で、常に「推定」。公費・自己負担の内訳は分けない。「多く取る」方向の表示はしない
// 数え方（2026-11-06 ユーザー判断）：下書きで指摘され、確定版では消えた指摘ごとに、そのルールの対象区分の点数が下書き→確定版でどう変わったかを見る
//   取りこぼしを防いだ ＝ 点数が増えた（取り忘れた加算を足した、過少の区分を正しい区分に直した）。増えた分
//   差し戻しを防いだ   ＝ 点数が減った（背反・要件不足の行を外した、過大の区分を直した）。減った分
//   医師記載起因       ＝ 医師あての情報不足が医師確認（F1）で解決したもの。医師の回答で算定できるようになった分（増えた分）も金額で出す。
//                        事務長から医師へ「記載不足でこのくらい取りこぼしている」を伝える材料にする（決定47）
// FR-56「多く取る方向の表示・誘導をしない」の趣旨は、経営の目線を持たせすぎて、取れない算定まで取りにいかせないこと。
// ここで数えるのはルールエンジンが正しいと判定した確定版との差だけなので、この趣旨に反しない
// 同じ区分の変化は 1 つの指摘にだけ数える（重なるルールで二重に数えない）
import { RULES } from "../engine";
import { pointsOf } from "../engine/points-2024";
import type { ClaimLine, Finding } from "../engine/types";
import type { Question } from "../practice/practice";

export const YEN_PER_POINT = 10;
export const ESTIMATE_LABEL = "推定";

export type PreventedItem = {
  questionId: string;
  claimId: string;
  ruleId: string;
  kind: "取りこぼし" | "差し戻し" | "医師記載起因";
  points: number;
};

const key = (f: Finding) => `${f.ruleId}|${f.messageKey}`;
const linePoints = (lines: ClaimLine[], kubun: string) => {
  const l = lines.find((x) => x.kubun === kubun);
  const p = l ? pointsOf(kubun) : null;
  return l && p !== null ? p * l.count : 0;
};

/** 1 問ぶんの「防いだ」項目。resolvedByDoctor は F1 で解決した不足項目（field） */
export function preventedOf(q: Question, resolvedByDoctor: string[] = []): PreventedItem[] {
  if (!q.confirmed || q.drafts.length === 0) return [];
  const final = q.confirmed;
  const finalKeys = new Set(final.result.findings.map(key));
  const seen = new Set<string>();
  const counted = new Set<string>();
  const out: PreventedItem[] = [];
  /** そのルールの対象区分のうち、まだ数えていないものの点数の変化（確定版 − 下書き） */
  const delta = (draft: ClaimLine[], ruleId: string): number => {
    const kubun = (RULES.find((r) => r.id === ruleId)?.kubun ?? []).filter((k) => !counted.has(k));
    const d = kubun.reduce((sum, k) => sum + linePoints(final.lines, k) - linePoints(draft, k), 0);
    if (d !== 0) for (const k of kubun) if (linePoints(final.lines, k) !== linePoints(draft, k)) counted.add(k);
    return d;
  };
  for (const d of q.drafts) {
    for (const f of d.findings) {
      if (finalKeys.has(key(f)) || seen.has(key(f))) continue;
      seen.add(key(f));
      const base = { questionId: q.id, claimId: q.claimId, ruleId: f.ruleId };
      if (f.kind === "情報不足") {
        // 同じ不足項目を複数のルールが指摘しても、医師確認は 1 件なので 1 回だけ数える
        const field = f.missing?.field;
        if (f.missing?.target === "doctor" && field && resolvedByDoctor.includes(field) && !seen.has(`field|${field}`)) {
          seen.add(`field|${field}`);
          out.push({ ...base, kind: "医師記載起因", points: Math.max(0, delta(d.lines, f.ruleId)) });
        }
        continue;
      }
      const change = delta(d.lines, f.ruleId);
      if (change > 0) out.push({ ...base, kind: "取りこぼし", points: change });
      else if (change < 0) out.push({ ...base, kind: "差し戻し", points: -change });
    }
  }
  return out;
}

export type PreventedSummary = {
  label: typeof ESTIMATE_LABEL;
  取りこぼし: { count: number; yen: number };
  差し戻し: { count: number; yen: number };
  医師記載起因: { count: number; yen: number };
};

export function summarize(items: PreventedItem[]): PreventedSummary {
  const sum = (k: PreventedItem["kind"]) => items.filter((i) => i.kind === k);
  const yen = (xs: PreventedItem[]) => xs.reduce((s, i) => s + i.points, 0) * YEN_PER_POINT;
  return {
    label: ESTIMATE_LABEL,
    取りこぼし: { count: sum("取りこぼし").length, yen: yen(sum("取りこぼし")) },
    差し戻し: { count: sum("差し戻し").length, yen: yen(sum("差し戻し")) },
    医師記載起因: { count: sum("医師記載起因").length, yen: yen(sum("医師記載起因")) },
  };
}

/** 本人向け：既定は非表示。トグル（optIn）で詳細を開く。見逃した額は出さない（FR-57・FR-58） */
export function personalView(items: PreventedItem[], optIn: boolean): { visible: false } | { visible: true; summary: PreventedSummary } {
  return optIn ? { visible: true, summary: summarize(items) } : { visible: false };
}

/** 事務長向け：月次の集計だけ。見逃した額（返戻・査定になった行の点数）もここにだけ出す（FR-58）。個人別には分けない */
export function managerReport(items: PreventedItem[], missed: { claimId: string; kubun: string[]; lines: ClaimLine[] }[]): PreventedSummary & { 見逃し: { count: number; yen: number } } {
  const missedPoints = missed.reduce((s, m) => s + m.kubun.reduce((t, k) => t + linePoints(m.lines, k), 0), 0);
  return { ...summarize(items), 見逃し: { count: missed.length, yen: missedPoints * YEN_PER_POINT } };
}
