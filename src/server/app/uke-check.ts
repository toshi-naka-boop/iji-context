// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）判定した結果。
// 月末の点検（利用者が行を入力する問題。src/server/app/question-case.ts）とは別の道で、何も記録しない（開くたびに計算する）。
// 判定は、コメントを持つ請求（commentsKnown が真。摘要欄の記載の点検 R17 が動く）・カルテ側の記録がない請求（recordsKnown が偽）として行う。
// 点検の対象外の単位があれば partial で、出るのは申告のある種類の指摘だけ。合計は、UKE に書いてある請求の合計と、点検した行の小計を別々に返す
import { resolveRevision } from "../../engine/revisions";
import type { Cases } from "./cases";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

/** 1〜31 日の回数を、算定日（"YYYY-MM-DD"。回数ぶん重ねる）にする */
const datesOf = (yearMonth: string, days: number[]): string[] => days.flatMap((n, i) => Array.from({ length: n }, () => `${yearMonth}-${String(i + 1).padStart(2, "0")}`));

export function createUkeCheck(uke: Uke, cases: Cases, patientProfile: (claimId: string) => ReturnType<Patients["patientProfile"]>) {
  function ukeCheck(claimId: string) {
    const { receipt: r, uploaded } = uke.receiptOf(claimId);
    const head = { claimId, yearMonth: r.yearMonth, patient: r.patient.name, patientNo: uploaded ? (r.patientNo ?? "") : null };
    // 読み直しで読めなかったレセプト（表が変わって点数が合わない／診療年月の版がない）は、理由だけを返す
    if (r.unreadable) return { ...head, unreadable: r.unreadable };
    const rev = resolveRevision(r.yearMonth);
    // UKE に書いてあることだけで点検する：行とコメントは UKE のまま、出来事は持たない（同梱の症例でも、カルテ側の記録は使わない）
    const result = cases.judge({ ...cases.caseOf(claimId), events: [], recordsKnown: false });
    const others = r.others ?? [];
    const findings = result.findings.filter((f) => f.kind !== "情報不足");
    return {
      ...head,
      unreadable: null,
      revisionId: result.revisionId,
      /** UKE に書いてある請求の合計（HO と、KO の並び） */
      declared: r.declared ?? { ho: null, ko: [] },
      /** 点検した行（UKE の単位の並びのまま）。points は 1 回分 */
      lines: r.lines.map((l) => ({ kubun: l.kubun, no: rev.points[l.kubun].no, name: rev.points[l.kubun].name, count: l.count, dates: l.dates, points: rev.points[l.kubun].points })),
      /** 点検した行の小計（請求の合計ではない） */
      subtotal: result.subtotal !== undefined ? result.subtotal : result.total,
      /** 点検の対象外の単位（コード・1 回分の点数・回数・算定日）と、その行の数 */
      others: others.map((o) => ({ codes: o.codes, points: o.points, count: o.count, dates: datesOf(r.yearMonth, o.days) })),
      otherRows: others.reduce((s, o) => s + o.codes.length, 0),
      partial: others.length > 0,
      recordsKnown: false,
      commentsKnown: true,
      findings,
      /** 記載もれ（摘要欄の記載。R17）の件数 */
      commentMissingCount: findings.filter((f) => f.kind === "記載もれ").length,
      /** 情報不足（確かめる事実と、決められないこと） */
      missing: result.findings.filter((f) => f.kind === "情報不足"),
      applied: result.applied,
      /** コメント（UKE に書いてある並びのまま）。text は文字データの原文 */
      comments: r.comments.map((c) => ({ code: c.code, text: c.raw })),
      /** 患者情報チェック（P 系。ユスティの指摘とは別の欄） */
      patientFindings: patientProfile(claimId).findings,
    };
  }
  return { ukeCheck };
}
