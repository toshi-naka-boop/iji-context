// 取り込んだレセプトの全件の一覧（採点 r1 医療事務課長 P1-1）：月末の点検で、取り込んだ全件を、点検の結果の件数つきで 1 画面に並べる。
// 件数は、取り込んだレセプトの点検（src/server/app/uke-check.ts の ukeCheck。UKE に書いてあるとおりのまま）と同じ数え方：
// 確定＝条件つきでない指摘（手書きのルールとデータで動く点検）／条件つき＝条件つきの指摘／情報不足＝点検の画面と同じまとめ方の件数／
// 見ていません＝どの点検も見ていない行（単位）の数。読めない・版のないレセプトは、点検していないとして状態だけを出す。
// 読むだけで、何も記録しない（院内の知識の USED も付けない）。接続先（構造化データ）は読まない
import type { Finding } from "../../engine/types";
import type { ClaimReviews } from "./claim-reviews";
import type { Uke } from "./uke";
import type { UkeCheck } from "./uke-check";

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
  missing: number;
  unchecked: number;
  /** 本人がこの請求の点検を確かめたか（実在のデータで使うクリニックだけ。ほかは持たない） */
  reviewed?: boolean;
};

export function createUkeSummary(uke: Uke, ukeCheck: UkeCheck["ukeCheck"], claimReviews: ClaimReviews) {
  /**
   * アップロードしたファイル（クリニックの全員の分）と、本人が取り込んだ見本のレセプトを、ファイルの順・レセプトの並びのまま。
   * アップロードは取り込んだ本人の一覧にしか載らないが、月末の締めは課長・事務長も全件を見るので、ここでは誰が取り込んだかで分けない
   */
  function ukeSummary(clerkId: string): UkeSummaryRow[] {
    return uke.ukeList(clerkId).filter((u) => u.uploaded || u.imported).flatMap((u) =>
      u.receipts.map((x): UkeSummaryRow => {
        const head = { claimId: x.claimId, label: u.uploaded ? x.claimId : x.claimId.split("-")[0], patient: x.patient, patientNo: x.patientNo };
        const zero = { confirmed: 0, conditional: 0, missing: 0, unchecked: 0 };
        if (x.unreadable !== null) return { ...head, state: "unreadable", ...zero };
        if (x.revisionId === null) return { ...head, state: "noRevision", ...zero };
        const r = ukeCheck(x.claimId, clerkId);
        if (!("rows" in r)) return { ...head, state: r.unreadable ? "unreadable" : "noRevision", ...zero };
        const hand = r.findings;
        const generic = r.generic?.findings ?? [];
        const reviewed = claimReviews.reviewedOf(x.claimId, clerkId);
        return {
          ...head,
          state: "checked",
          confirmed: hand.filter((f) => f.params?.conditional !== "1").length + generic.filter((f) => f.certainty === "確定").length,
          conditional: hand.filter((f) => f.params?.conditional === "1").length + generic.filter((f) => f.certainty === "条件つき").length,
          missing: missingCount(r.missing),
          unchecked: r.rows.filter((row) => row.checkedBy === "none").length,
          ...(reviewed !== undefined ? { reviewed: reviewed !== null } : {}),
        };
      }),
    );
  }
  return { ukeSummary };
}
