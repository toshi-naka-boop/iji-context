// F9 防いだ額（spec FR-52〜58、決定44〜50、EM #7-5）
// 「防いだ」＝提出前にエンジンが指摘し、提出までに本人が直した項目だけ。自己申告は数えない
// 金額は点数×10円で、常に「推定」。公費・自己負担の内訳は分けない。「多く取る」方向の表示はしない
// 数え方（実装上の解釈。起きたらユーザーに確認）：
//   取りこぼしを防いだ ＝ 下書きで「取り忘れ」と指摘され、確定版にはない指摘。確定版で足した、そのルールの対象区分の点数
//   差し戻しを防いだ   ＝ 下書きで「背反・区分誤り・要件不足」と指摘され、確定版にはない指摘。指摘された行のうち確定版で外した区分の点数
//   医師記載起因       ＝ 下書きで医師あての「情報不足」と指摘され、医師確認（F1）で解決したもの。件数だけ
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
  const finalKubun = new Set(final.lines.map((l) => l.kubun));
  const seen = new Set<string>();
  const out: PreventedItem[] = [];
  for (const d of q.drafts) {
    const draftKubun = new Set(d.lines.map((l) => l.kubun));
    for (const f of d.findings) {
      if (finalKeys.has(key(f)) || seen.has(key(f))) continue;
      seen.add(key(f));
      const base = { questionId: q.id, claimId: q.claimId, ruleId: f.ruleId };
      if (f.kind === "情報不足") {
        // 同じ不足項目を複数のルールが指摘しても、医師確認は 1 件なので 1 回だけ数える
        const field = f.missing?.field;
        if (f.missing?.target === "doctor" && field && resolvedByDoctor.includes(field) && !seen.has(`field|${field}`)) {
          seen.add(`field|${field}`);
          out.push({ ...base, kind: "医師記載起因", points: 0 });
        }
        continue;
      }
      if (f.kind === "取り忘れ") {
        const ruleKubun = RULES.find((r) => r.id === f.ruleId)?.kubun ?? [];
        const added = ruleKubun.filter((k) => finalKubun.has(k) && !draftKubun.has(k));
        if (added.length) out.push({ ...base, kind: "取りこぼし", points: added.reduce((s, k) => s + linePoints(final.lines, k), 0) });
        continue;
      }
      const removed = f.lineRefs.filter((k) => draftKubun.has(k) && !finalKubun.has(k));
      if (removed.length) out.push({ ...base, kind: "差し戻し", points: removed.reduce((s, k) => s + linePoints(d.lines, k), 0) });
    }
  }
  return out;
}

export type PreventedSummary = {
  label: typeof ESTIMATE_LABEL;
  取りこぼし: { count: number; yen: number };
  差し戻し: { count: number; yen: number };
  医師記載起因: { count: number };
};

export function summarize(items: PreventedItem[]): PreventedSummary {
  const sum = (k: PreventedItem["kind"]) => items.filter((i) => i.kind === k);
  const yen = (xs: PreventedItem[]) => xs.reduce((s, i) => s + i.points, 0) * YEN_PER_POINT;
  return {
    label: ESTIMATE_LABEL,
    取りこぼし: { count: sum("取りこぼし").length, yen: yen(sum("取りこぼし")) },
    差し戻し: { count: sum("差し戻し").length, yen: yen(sum("差し戻し")) },
    医師記載起因: { count: sum("医師記載起因").length },
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
