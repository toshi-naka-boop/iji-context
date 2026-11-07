// 医師確認の練習問題（spec FR-76。2026-11-07 ユーザー判断）：推測で算定せず、医師に聞いてから確定する練習。
// 題材は根拠のある 3 つだけ（K1 の別表第八の二＝エンジンのテスト、週 4 回の訪問＝report-A 項目 21 の 13、K4 の DOAC と病型＝EM 5-1）。
// 回答は問題の中だけで事実に戻す（本物の患者情報は変えない）。判定はユスティだけが行う
import type { ClaimContext } from "../engine/types";
import type { QueryDraft } from "../query/doctor-query";

/** 医師に聞く事実（問題の中で、回答から値に戻す） */
export type AskFact = "table8_2" | "acuteExacerbation";

type FactQuestion = { label: string; question: string; options: string[]; value: Record<string, boolean>; indicators: (c: ClaimContext) => { source: string; text: string }[] };

const yesNo = (b: { known: boolean; value?: unknown }, yes: string, no: string) => (b.known ? (b.value ? yes : no) : "記載なし");

/** 7 要件の検査（validateQuery）を通る質問の雛形。点数・金額に触れず、選択肢に「その他」「判定不能」を入れる */
export const FACT_QUESTIONS: Record<AskFact, FactQuestion> = {
  table8_2: {
    label: "別表第八の二に当たるか",
    question: "在宅酸素療法を行っている患者さんについて、別表第八の二（特掲診療料の施設基準等 別表第八の二）に該当するかの記載が診療録にありません。該当するものを選んでください。",
    options: ["該当する", "該当しない", "その他", "判定不能"],
    value: { 該当する: true, 該当しない: false },
    indicators: (c) => [
      { source: "診療録", text: `在宅酸素療法：${yesNo(c.facts.homeOxygen, "実施中", "なし")}` },
      { source: "傷病名", text: c.facts.mainDisease.known ? String(c.facts.mainDisease.value) : "記載なし" },
    ],
  },
  acuteExacerbation: {
    label: "急性増悪があったか",
    question: "3/10〜3/13 の週に訪問診療を 4 回行っています。この期間の病状について、急性増悪の有無の記載が診療録にありません。該当するものを選んでください。",
    options: ["急性増悪あり", "急性増悪なし", "その他", "判定不能"],
    value: { 急性増悪あり: true, 急性増悪なし: false },
    indicators: () => [
      { source: "訪問の記録", text: "3/10・3/11・3/12・3/13 に訪問診療" },
      { source: "診療録", text: "急性増悪の有無：記載なし" },
    ],
  },
};

/** 問題ごとに 1 つの質問にする（同じ患者・同じ時計でも、問題が違えば別の質問になる） */
export const askField = (fact: AskFact, questionId: string) => `fact:${fact}@${questionId}`;

export function factQueryDraft(fact: AskFact, ctx: ClaimContext, questionId: string): QueryDraft {
  const t = FACT_QUESTIONS[fact];
  return {
    claimId: ctx.claimId,
    field: askField(fact, questionId),
    why: `練習問題：${t.label}が診療録になく、算定の条件を判定できない`,
    question: t.question,
    indicators: t.indicators(ctx),
    options: t.options,
    createdBy: "clerk",
  };
}

/** 承認された回答を事実の値に戻す（「その他」「判定不能」は分からないまま） */
export function answerValue(fact: AskFact, option: string): boolean | null {
  const v = FACT_QUESTIONS[fact].value[option];
  return v === undefined ? null : v;
}

export type DoctorDrill = { id: string; claimId: string; situation: string[]; ask?: AskFact; crosscheck?: string; make: (base: ClaimContext) => ClaimContext };

export const DOCTOR_DRILLS: DoctorDrill[] = [
  {
    id: "m01",
    claimId: "K1-2025-03",
    situation: ["在宅酸素療法をしている", "別表第八の二に当たるかは、カルテに書かれていない"],
    ask: "table8_2",
    make: (k) => ({ ...k, facts: { ...k.facts, table8_2: { known: false } } }),
  },
  {
    id: "m02",
    claimId: "K1-2025-03",
    situation: ["3/10〜3/13 の週に 4 回訪問した（3/10・3/11・3/12・3/13）", "急性増悪だったかは、カルテに書かれていない"],
    ask: "acuteExacerbation",
    make: (k) => {
      const extra = ["2025-03-10", "2025-03-11", "2025-03-13"];
      return {
        ...k,
        facts: { ...k.facts, acuteExacerbation: { known: false } },
        events: [...k.events, ...extra.map((date) => ({ type: "visit" as const, date, sameBuildingCount: 1 }))],
        lines: k.lines.map((l) => (l.kubun === "C001_1I" ? { ...l, count: l.count + extra.length, dates: [...l.dates, ...extra].sort() } : l)),
      };
    },
  },
  {
    id: "m03",
    claimId: "K4-2025-03",
    situation: ["DOAC を処方している", "傷病名は「心房細動」だけで、病型は書かれていない", "要介護度は要介護2（介護保険証で確認済み）"],
    crosscheck: "M01",
    make: (k) => ({ ...k, facts: { ...k.facts, careLevel: { known: true, value: 2 } } }),
  },
];

export const isDoctorDrill = (id: string) => DOCTOR_DRILLS.some((d) => d.id === id);
export function doctorDrillOf(id: string): DoctorDrill {
  const d = DOCTOR_DRILLS.find((x) => x.id === id);
  if (!d) throw new Error(`医師確認の練習問題がない: ${id}`);
  return d;
}
/** 一覧に出す形（何を聞くかは開いてから分かる） */
export const doctorDrillList = () => DOCTOR_DRILLS.map((d, i) => ({ id: d.id, no: i + 1, claimId: d.claimId, situation: d.situation }));

/** 承認された回答を、問題の事実に重ねる */
export function withAnswer(ctx: ClaimContext, fact: AskFact, value: boolean | null): ClaimContext {
  if (value === null) return ctx;
  return { ...ctx, facts: { ...ctx.facts, [fact]: { known: true, value } } };
}
