// 取り込んだレセプトの全件の一覧（採点 r1 医療事務課長 P1-1）：月末の点検で、取り込んだ全件を、点検の結果の件数つきで 1 画面に並べる。
// 件数は、取り込んだレセプトの点検（src/server/app/uke-check.ts の ukeCheck。UKE に書いてあるとおりのまま）と同じ数え方：
// 確定＝条件つきでない指摘（手書きのルールとデータで動く点検）／条件つき＝条件つきの指摘／情報不足＝点検の画面と同じまとめ方の件数（missing は今までどおりカルテ側の記録がない分も含む。画面は、入力で消えるものだけの missingOpen を出す）／
// 見ていません＝どの点検も見ていない行（単位）の数と、見ていないこと（カルテ側の記録で決まる点・介護保険とほかの医療機関との調整）の数／患者情報＝患者情報の指摘（P 系。ユスティの指摘とは別に数える。宛先は医療事務）の件数。読めない・版のないレセプトは、点検していないとして状態だけを出す。
// 読むだけで、何も記録しない（院内の知識の USED も付けない）。接続先（構造化データ）は読まない
import type { Finding } from "../../engine/types";
import { conditionalKeysOf } from "../../uke/premise";
import type { ClaimReviews } from "./claim-reviews";
import type { PremiseChecks } from "./premise-checks";
import type { Uke } from "./uke";
import type { UkeCheck } from "./uke-check";

/**
 * カルテ側の記録がない（chartRecord）は、入力で消えない（取り込んだレセプトには記録を足す手段がない）ので、情報不足には数えず「見ていない」に 1 つ数える（採点 r2 医療事務課長 P1-2）。
 * 点検の画面も同じ扱い（app/uke/[claimId]/page.tsx）
 */
const UNSEEN_MISSING = "chartRecord";
/** 点検の画面で 1 件にまとめる情報不足（app/uke/[claimId]/page.tsx の groupMissing と同じ） */
const SHARED_MISSING = ["chartRecord", "unsupportedLines"];
const missingCount = (missing: Finding[]) => {
  const shared = new Set(missing.flatMap((f) => (SHARED_MISSING.includes(f.missing?.field ?? "") ? [f.missing!.field] : [])));
  return missing.filter((f) => !SHARED_MISSING.includes(f.missing?.field ?? "")).length + shared.size;
};

export type UkeSummaryRow = {
  claimId: string;
  /** 画面に出す請求の番号（見本は症例の番号、アップロードはアプリが振った番号） */
  label: string;
  patient: string;
  patientNo: string | null;
  /** checked＝点検した／unreadable＝読めない（取り込み直しが要る）／noRevision＝診療年月の版がない（試算だけ） */
  state: "checked" | "unreadable" | "noRevision";
  confirmed: number;
  conditional: number;
  /** 条件つきの指摘のうち、医療事務が前提を確かめたもの（採点 r4 医療事務課長 P1-1）。残りには数えない */
  conditionalChecked: number;
  /** 情報不足の件数（今までの数え方。カルテ側の記録がない分の 1 件を含む） */
  missing: number;
  /** 情報不足のうち、確かめて入れれば消えるものの件数（カルテ側の記録がない分を除く。一覧の「情報不足」の列） */
  missingOpen: number;
  unchecked: number;
  /**
   * 見ていないこと（行ではなく、点検の範囲で見ていないもの）の数。カルテ側の記録で決まる点を見ていなければ 1、
   * 介護保険・ほかの医療機関との調整の「見ていません」（聞き取りの答えがないなど）は文の数だけ足す
   */
  unseen: number;
  /** 患者情報の指摘（P 系）の件数。確定・条件つきには入れない（ユスティの指摘とは別の系統） */
  patientFindings: number;
  /**
   * 締めの「まだ手を付ける残り」があるか（採点 r3 医療事務課長 #3）：確定・条件つき（前提を確かめていないもの。採点 r4 医療事務課長 P1-1）・情報不足（入力で消えるもの）・患者情報の指摘・
   * 聞き取りの答えがない介護保険とほかの医療機関との調整のどれかが残る。読めないレセプト（取り込み直しが要る）も残りに入れる
   */
  open: boolean;
  /**
   * 仕組み上いつも残る「見ていないこと」の数（入力で消えない）：カルテ側の記録で決まる点を見ていなければ 1。
   * unseen からこれを引いた残りは、聞き取りに答えれば消える分。どの点検も見ていない行（unchecked）も入力では消えない
   */
  fixedUnseen: number;
  /** 本人がこの請求の点検を確かめたか（実在のデータで使うクリニックだけ。ほかは持たない） */
  reviewed?: boolean;
};

export function createUkeSummary(uke: Uke, ukeCheck: UkeCheck["ukeCheck"], claimReviews: ClaimReviews, premiseChecks: PremiseChecks) {
  /**
   * アップロードしたファイル（クリニックの全員の分）と、本人が取り込んだ見本のレセプトを、ファイルの順・レセプトの並びのまま。
   * アップロードは取り込んだ本人の一覧にしか載らないが、月末の締めは課長・事務長も全件を見るので、ここでは誰が取り込んだかで分けない
   */
  function ukeSummary(clerkId: string): UkeSummaryRow[] {
    return uke.ukeList(clerkId).filter((u) => u.uploaded || u.imported).flatMap((u) =>
      u.receipts.map((x): UkeSummaryRow => {
        const head = { claimId: x.claimId, label: u.uploaded ? x.claimId : x.claimId.split("-")[0], patient: x.patient, patientNo: x.patientNo };
        const zero = { confirmed: 0, conditional: 0, conditionalChecked: 0, missing: 0, missingOpen: 0, unchecked: 0, unseen: 0, patientFindings: 0, fixedUnseen: 0 };
        // 読めない＝取り込み直せば点検できる（残り）。版がない＝点検できない（仕組み上の残りで、手を付けても消えない）
        if (x.unreadable !== null) return { ...head, state: "unreadable", ...zero, open: true };
        if (x.revisionId === null) return { ...head, state: "noRevision", ...zero, open: false };
        const r = ukeCheck(x.claimId, clerkId);
        if (!("rows" in r)) return { ...head, state: r.unreadable ? "unreadable" : "noRevision", ...zero, open: Boolean(r.unreadable) };
        const hand = r.findings;
        const generic = r.generic?.findings ?? [];
        const reviewed = claimReviews.reviewedOf(x.claimId, clerkId);
        const confirmed = hand.filter((f) => f.params?.conditional !== "1").length + generic.filter((f) => f.certainty === "確定").length;
        const conditional = hand.filter((f) => f.params?.conditional === "1").length + generic.filter((f) => f.certainty === "条件つき").length;
        // 前提を確かめた条件つきの指摘（いま出ている指摘の鍵に当たるものだけ。中身が変わった指摘の前の確かめは数えない）
        const checkedKeys = new Set(premiseChecks.premiseChecksOf(x.claimId).map((p) => p.key));
        const conditionalChecked = conditionalKeysOf(r).filter((k) => checkedKeys.has(k)).length;
        const missingOpen = missingCount(r.missing.filter((f) => f.missing?.field !== UNSEEN_MISSING));
        const fixedUnseen = r.missing.some((f) => f.missing?.field === UNSEEN_MISSING) ? 1 : 0;
        return {
          ...head,
          state: "checked",
          confirmed,
          conditional,
          conditionalChecked,
          missing: missingCount(r.missing),
          missingOpen,
          unchecked: r.rows.filter((row) => row.checkedBy === "none").length,
          unseen: fixedUnseen + r.careUnseen.length,
          patientFindings: r.patientFindings.length,
          open: confirmed + conditional - conditionalChecked + missingOpen + r.patientFindings.length + r.careUnseen.length > 0,
          fixedUnseen,
          ...(reviewed !== undefined ? { reviewed: reviewed !== null } : {}),
        };
      }),
    );
  }
  return { ukeSummary };
}
