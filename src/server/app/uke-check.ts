// 取り込んだレセプトの点検（design.md §11-11・§11-13）：UKE に書いてあるとおりのまま（行もコメントも入れ替えずに）判定した結果。
// 月末の点検（利用者が行を入力する問題。src/server/app/question-case.ts）とは別の道で、何も記録しない（開くたびに計算する）。
// 判定は、コメントを持つ請求（commentsKnown が真。摘要欄の記載の点検 R17 が動く）・カルテ側の記録がない請求（recordsKnown が偽）として行う。
// 点検の対象外の単位があれば partial で、出るのは申告のある種類の指摘だけ。合計は、UKE に書いてある請求の合計と、点検した行の小計を別々に返す。
// 試算（ukeTrial。design.md §11-12）は、版を名指しして同じことをする：診療年月に版がないレセプトも、診療年月の版と違う版でも読める。保存しない
import { resolveRevision, revisionById, revisionChoices, UKE_TRIAL_REVISIONS } from "../../engine/revisions";
import type { Revision } from "../../engine/revisions/types";
import { trial } from "../../engine/trial";
import type { ClaimContext, ClaimLine, Finding } from "../../engine/types";
import type { UkeOther } from "../../uke/types";
import { mapClaim } from "../../uke/uke";
import { badRequest } from "../errors";
import type { Cases } from "./cases";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

/** 1〜31 日の回数を、算定日（"YYYY-MM-DD"。回数ぶん重ねる）にする */
const datesOf = (yearMonth: string, days: number[]): string[] => days.flatMap((n, i) => Array.from({ length: n }, () => `${yearMonth}-${String(i + 1).padStart(2, "0")}`));

/** 試算で選べる版（画面の選択肢）。own は、その診療年月の版か */
const trialRevisions = (yearMonth: string) => revisionChoices(UKE_TRIAL_REVISIONS, yearMonth);

/** 点検と試算で同じ形にして返す部分：点検した行・対象外の単位・指摘・情報不足 */
function bodyOf(yearMonth: string, rev: Revision, lines: ClaimLine[], others: UkeOther[], all: Finding[]) {
  const findings = all.filter((f) => f.kind !== "情報不足");
  return {
    /** 点検した行（UKE の単位の並びのまま）。points は、その版の 1 回分 */
    lines: lines.map((l) => ({ kubun: l.kubun, no: rev.points[l.kubun].no, name: rev.points[l.kubun].name, count: l.count, dates: l.dates, points: rev.points[l.kubun].points })),
    /** 点検の対象外の単位（コード・1 回分の点数・回数・算定日）と、その行の数 */
    others: others.map((o) => ({ codes: o.codes, points: o.points, count: o.count, dates: datesOf(yearMonth, o.days) })),
    otherRows: others.reduce((s, o) => s + o.codes.length, 0),
    partial: others.length > 0,
    recordsKnown: false,
    commentsKnown: true,
    findings,
    /** 記載もれ（摘要欄の記載。R17）の件数 */
    commentMissingCount: findings.filter((f) => f.kind === "記載もれ").length,
    /** 情報不足（確かめる事実と、決められないこと） */
    missing: all.filter((f) => f.kind === "情報不足"),
  };
}

export function createUkeCheck(uke: Uke, cases: Cases, patientProfile: (claimId: string) => ReturnType<Patients["patientProfile"]>) {
  function ukeCheck(claimId: string) {
    const { receipt: r, uploaded } = uke.receiptOf(claimId);
    const head = { claimId, yearMonth: r.yearMonth, patient: r.patient.name, patientNo: uploaded ? (r.patientNo ?? "") : null };
    // 読み直しで読めなかったレセプト（表が変わって点数が合わない）は、理由だけを返す
    if (r.unreadable) return { ...head, unreadable: r.unreadable };
    // 診療年月に版がないレセプトは、点検しない（近い版で代用しない）。画面は、選べる版から選んで試算する（ukeTrial）
    if (r.noRevision) return { ...head, unreadable: null, revisionId: null, revisions: trialRevisions(r.yearMonth) };
    const rev = resolveRevision(r.yearMonth);
    // UKE に書いてあることだけで点検する：行とコメントは UKE のまま、出来事は持たない（同梱の症例でも、カルテ側の記録は使わない）
    const result = cases.judge({ ...cases.caseOf(claimId), events: [], recordsKnown: false });
    return {
      ...head,
      unreadable: null,
      revisionId: result.revisionId,
      revisions: trialRevisions(r.yearMonth),
      /** UKE に書いてある請求の合計（HO と、KO の並び） */
      declared: r.declared ?? { ho: null, ko: [] },
      ...bodyOf(r.yearMonth, rev, r.lines, r.others ?? [], result.findings),
      /** 点検した行の小計（請求の合計ではない） */
      subtotal: result.subtotal !== undefined ? result.subtotal : result.total,
      applied: result.applied,
      /** コメント（UKE に書いてある並びのまま）。text は文字データの原文 */
      comments: r.comments.map((c) => ({ code: c.code, text: c.raw })),
      /** 患者情報チェック（P 系。ユスティの指摘とは別の欄） */
      patientFindings: patientProfile(claimId).findings,
    };
  }

  /**
   * 試算（design.md §11-12）：一覧にあるレセプトを、名指しした版のコードの表・点数表・ルールで読んで判定する。その場で計算して返し、何も保存しない。
   * 診療年月に版がないレセプトでも、診療年月の版と違う版でも読める。選べるのは、コードの表を持つ版だけ。日付は UKE のまま動かさない。
   * UKE に書いてある 1 回分の点数が、選んだ版の点数と違う単位は、断らずに行を引き、違いを pointDiffs に並べる（行の点数・小計は、選んだ版の点数）。
   * 戻りは試算の型（TrialResult の trial・rulesAvailable を持ち、revisionId・applied を持たない）で、提出の確定・適用記録の入口には渡せない
   */
  function ukeTrial(claimId: string, revId: string) {
    const rev = revisionById(revId);
    if (!rev || !UKE_TRIAL_REVISIONS.includes(rev)) throw badRequest("選べる版ではありません", ["rev"]);
    const { receipt: r, uploaded, claim } = uke.receiptOf(claimId);
    const parsed = claim();
    const mapped = mapClaim(parsed, rev, true);
    // 事実・施設の設定は、レセプトの側にあるものだけ（選んだ版が読む事実がなければ、情報不足になる。埋め合わせの値を作らない）。出来事は持たない
    const { partial: _partial, ...base } = cases.trialBaseOf(claimId);
    const ctx: ClaimContext = {
      ...base,
      events: [],
      recordsKnown: false,
      // 検査項目のコード（items）は UKE の側の持ち物で、エンジンには渡さない
      lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })),
      comments: mapped.comments,
      commentsKnown: true,
      ...(mapped.others.length > 0 ? { partial: true } : {}),
    };
    const { findings, subtotal, ...result } = trial(ctx, rev);
    /** 単位ごとの、点数の違い。複数の区分がある単位は、区分ごとに分けず、単位の合算どうしを比べる（kubun・name は単位の区分を並べたもの） */
    const pointDiffs = mapped.units.flatMap((u, i) =>
      u.ok && u.revPoints !== undefined
        ? [{ kubun: u.lines.map((l) => l.kubun), name: u.lines.map((l) => rev.points[l.kubun].name).join("＋"), ukePoints: parsed.units[i].points, revPoints: u.revPoints, count: parsed.units[i].count }]
        : [],
    );
    return {
      ...result,
      yearMonth: r.yearMonth,
      patient: r.patient.name,
      patientNo: uploaded ? (r.patientNo ?? "") : null,
      /** 診療年月から決まる版（なければ null）と、選べる版 */
      ownRevisionId: r.noRevision ? null : resolveRevision(r.yearMonth).id,
      revisions: trialRevisions(r.yearMonth),
      revisionLabel: rev.label,
      /** UKE に書いてある請求の合計（HO と、KO の並び。UKE の点数のまま） */
      declared: { ho: parsed.total?.points ?? null, ko: parsed.kohiTotals },
      ...bodyOf(r.yearMonth, rev, mapped.lines, mapped.others, findings),
      /** 点検した行の小計（選んだ版の点数で数えたもの。請求の合計ではない） */
      subtotal: subtotal !== undefined ? subtotal : result.total,
      pointDiffs,
      /** コメント（UKE に書いてある並びのまま）。text は文字データの原文 */
      comments: parsed.comments.map((c) => ({ code: c.code, text: c.raw })),
    };
  }

  return { ukeCheck, ukeTrial };
}
