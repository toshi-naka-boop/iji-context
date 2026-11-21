// カルテの画面の算定プレビュー（spec FR-101。design.md §2-8）：導出の結果（行・根拠・保留・未対応）と検証の結果を、画面に出す形にまとめる。
// ここは並べ替えと文言だけで、判定はしない（導出は deriveLines、検証は evaluate）。宛先は医療事務なので点数を出してよい
import type { DeriveResult, LineBasis, Pending, Unsupported } from "../engine/derive";
import type { Revision } from "../engine/revisions/types";
import type { ClaimEvent, EngineResult } from "../engine/types";
import { DERIVE_TEXT, findingText, needLabel } from "../messages";

const EVENT_LABEL: Record<ClaimEvent["type"], string> = { visit: "訪問診療", oushin: "往診", test: "検査", prescription: "処方", death: "死亡", discharge: "退院", kanriStart: "管理料の算定開始" };
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const eventText = (e: { type: ClaimEvent["type"]; date: string }) => `${EVENT_LABEL[e.type]} ${md(e.date)}`;

/** 導出の未対応を画面に出す文 */
export const unsupportedText = (u: Unsupported): string => (u.code === "unmapped_test_item" ? `検査の項目「${u.detail}」は、区分の表にないので行にしていません` : u.detail);

export type ClaimPreviewLine = {
  kubun: string;
  name: string;
  count: number;
  dates: string[];
  /** 1 回あたりの点数と小計（点数未収載の区分は null） */
  points: number | null;
  subtotal: number | null;
  /** 導出した行の根拠。入力どおりに通した行（導出しない区分）は null */
  basis: { rule: string; events: string[]; needs: string[]; byChoice: boolean; tentative: boolean } | null;
  /**
   * この行について摘要欄に書くこと（design.md §11-13）。what は何の記載か。entries は 1 件ずつ：
   * ready はコードと値まで決まったもの、needsInput は医療事務が入れるもの（code が null なら、当たるコードも選ぶ）
   */
  comments: { what: string; entries: { code: string | null; text: string | null; status: "ready" | "needsInput" }[] }[];
};

export type ClaimPreview = {
  revisionId: string;
  lines: ClaimPreviewLine[];
  totalStatus: DeriveResult["totalStatus"];
  /** 合計。保留・未対応があるとき（withheld）は出さない */
  total: number | null;
  pending: (
    | { kind: "事実不足"; id: string; text: string; target: "doctor" | "clerk"; blocks: string[] }
    | { kind: "要選択"; id: string; text: string; options: { id: string; label: string }[]; blocks: string[] }
  )[];
  unsupported: { code: string; text: string }[];
  /** 送られた答えのうち、今の要選択にない id（使わなかった答え。導出の staleChoices のまま） */
  staleChoices: string[];
  notBilled: string[];
  findings: { ruleId: string; kind: string; text: string; lines: string[] }[];
};

/** engine は、請求の判定（EngineResult）か試算（TrialResult）の、行ごとの点数・合計・指摘 */
export function claimPreviewOf(derived: DeriveResult, engine: Pick<EngineResult, "byLine" | "total" | "findings">, rev: Revision): ClaimPreview {
  const nameOf = (kubun: string) => rev.points[kubun]?.name ?? kubun;
  const basisOf = (b: LineBasis | undefined): ClaimPreviewLine["basis"] =>
    b ? { rule: DERIVE_TEXT[b.derive] ?? b.derive, events: b.events.map(eventText), needs: b.needs.map(needLabel), byChoice: b.choice !== undefined, tentative: b.tentative } : null;
  const pendingOf = (p: Pending): ClaimPreview["pending"][number] =>
    p.kind === "要選択"
      ? { kind: p.kind, id: p.id, text: p.question, options: p.options.map((o) => ({ id: o.id, label: o.label })), blocks: p.blocks.map(nameOf) }
      : { kind: p.kind, id: p.id, text: `${needLabel(p.need)}${p.date ? `（${md(p.date)}）` : ""}`, target: p.target, blocks: p.blocks.map(nameOf) };
  /** その区分の最初の行に、摘要欄に書くことを記載（版の表の行）ごとにまとめて付ける */
  const commentsOf = (kubun: string, i: number): ClaimPreviewLine["comments"] => {
    if (derived.lines.findIndex((l) => l.kubun === kubun) !== i) return [];
    const mine = derived.comments.filter((c) => c.kubun === kubun);
    return [...new Set(mine.map((c) => c.rule))].map((rule) => ({
      what: rev.comments.find((r) => r.id === rule)?.summary ?? rule,
      entries: mine.filter((c) => c.rule === rule).map(({ code, text, status }) => ({ code, text, status })),
    }));
  };
  return {
    revisionId: derived.revisionId,
    lines: derived.lines.map((l, i) => {
      const points = engine.byLine[i]?.points ?? null;
      return { kubun: l.kubun, name: nameOf(l.kubun), count: l.count, dates: l.dates, points, subtotal: points === null ? null : points * l.count, basis: basisOf(derived.basis[i]), comments: commentsOf(l.kubun, i) };
    }),
    totalStatus: derived.totalStatus,
    total: derived.totalStatus === "withheld" ? null : engine.total,
    pending: derived.pending.map(pendingOf),
    unsupported: derived.unsupported.map((u) => ({ code: u.code, text: unsupportedText(u) })),
    staleChoices: derived.staleChoices,
    // 行にしなかった理由は、混ぜずに 1 つずつ出す（1 回の診療として片方を選んだ／訪問診療のあとの往診ではない／文書の提供がない。design.md §11-5）
    notBilled: derived.notBilled.map((n) =>
      n.reason === "same_encounter"
        ? `${eventText(n.event)}：1 回の診療として${n.event.type === "oushin" ? "訪問診療料" : "往診料"}を選んだので、行にしていません`
        : n.reason === "oushin_not_after_visit"
          ? `${eventText(n.event)}：訪問診療のあとに、病状の急変などで行った往診ではないので、同じ日の往診料は行にしていません`
          : `${eventText(n.event)}：往診の日・その翌日の訪問診療で、連絡先などの文書を提供している患者ではないので、行にしていません`,
    ),
    findings: engine.findings.map((f) => ({ ruleId: f.ruleId, kind: f.kind, text: findingText(f), lines: f.lineRefs.map(nameOf) })),
  };
}
