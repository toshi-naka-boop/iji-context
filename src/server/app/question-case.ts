// 問題ごとの請求の組み立て：訪問の時点・練習問題・医師確認の練習問題で、判定に渡す請求を変える
import type { ClaimContext, ClaimLine } from "../../engine/types";
import { answerValue, askField, doctorDrillOf, isDoctorDrill, withAnswer } from "../../practice/doctor-drills";
import { drillOf } from "../../practice/drills";
import type { Question } from "../../practice/practice";
import { contextAsOf, deferAtMidMonth, outlook } from "../../visit/as-of";
import type { Cases } from "./cases";
import type { Doctor } from "./doctor";
import type { Notes } from "./notes";

export function createQuestionCase(cases: Cases, notes: Notes, doctor: Doctor) {
  const { caseOf, judge } = cases;
  const { monthOf } = notes;
  const { doctorQueries } = doctor;

  /** 問題の請求：訪問の時点の問題なら、その日までの実施と記録だけにする（FR-68） */
  const caseAt = (claimId: string, asOf?: string, clerkId?: string): ClaimContext => (asOf ? contextAsOf(monthOf(claimId, clerkId), asOf) : caseOf(claimId));
  /** 練習問題は、よくある間違いを入れた明細と、そのときの状況で始める（FR-75） */
  const caseFor = (q: Question): ClaimContext => {
    if (q.drill && isDoctorDrill(q.drill)) {
      // 医師確認の練習問題：承認された回答だけを、この問題の事実に戻す（本物の患者情報は変えない。FR-76）
      const d = doctorDrillOf(q.drill);
      const base = d.make(caseOf(q.claimId));
      const a = d.ask ? drillQuery(q) : null;
      return d.ask && a?.status === "承認済み" && a.answer ? withAnswer(base, d.ask, answerValue(d.ask, a.answer.option)) : base;
    }
    return q.drill ? drillOf(q.drill).make(caseOf(q.claimId)) : caseAt(q.claimId, q.asOf, q.clerkId);
  };
  /** 医師確認の練習問題で、この問題から送った医師確認 */
  const drillQuery = (q: Question) => {
    const d = q.drill && isDoctorDrill(q.drill) ? doctorDrillOf(q.drill) : null;
    return d?.ask ? (doctorQueries().find((x) => x.field === askField(d.ask!, q.id)) ?? null) : null;
  };
  /** 訪問の時点では、月末まで決まらないルールを指摘にしない */
  const judgeFor = (q: Question) => (q.asOf ? (c: ClaimContext) => deferAtMidMonth(judge(c)) : judge);
  const withLines = (claimId: string, lines: ClaimLine[], facts?: Partial<ClaimContext["facts"]>, asOf?: string, clerkId?: string): ClaimContext => {
    const c = caseAt(claimId, asOf, clerkId);
    return { ...c, lines, facts: { ...c.facts, ...(facts ?? {}) } };
  };
  /** 訪問の時点の問題に添える見込み（指摘ではない） */
  const outlookOf = (q: Question) =>
    q.drill && isDoctorDrill(q.drill)
      ? `これは医師確認の練習問題。カルテに書かれていない事実を推測で埋めず、医師確認を送ってから確定する。メンターは医師への質問を自分で書かず、本人が画面の「医師確認を送る」で送るよう促す。状況：${doctorDrillOf(q.drill).situation.join("。")}`
      : q.drill
      ? `これは練習問題（よくある間違いを入れた明細）。本人が直して確定する。状況：${drillOf(q.drill).situation.join("。") || "特になし"}`
      : q.asOf
        ? `これは訪問の記録をレセコンに入れる前の確認（月の途中）。判定はその日までの実施と記録だけで、月末に決まるルール（在医総管の区分など）は入っていない。見込み：${outlook(monthOf(q.claimId, q.clerkId), q.asOf)}`
        : null;

  return { caseAt, caseFor, drillQuery, judgeFor, withLines, outlookOf };
}

export type QuestionCase = ReturnType<typeof createQuestionCase>;
