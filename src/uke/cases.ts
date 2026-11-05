// 症例（ClaimContext）と合成 UKE のあいだの変換（F4）
// UKE が持つのは請求の中身（区分・回数・日付・コメント）と患者・保険の情報だけ。
// 事実（facts）・出来事（events）・過去月（history）は合成カルテ・受給者証・設定ファイルから来る（spec FR-07、design.md §6）
import type { ClaimContext, Facility, Payer } from "../engine/types";
import type { UkeClinic, UkeFile, UkePatient } from "./types";

export type UkeSources = { clinic: UkeClinic; patients: Record<string, UkePatient> };

/** 審査支払機関ごとに 1 ファイル（spec FR-05：国保連 IR=2、支払基金 IR=1）。並びは入力の順 */
export function buildUkeFiles(cases: ClaimContext[], src: UkeSources, billingMonth: string): Record<Payer, UkeFile> {
  const files = {} as Record<Payer, UkeFile>;
  for (const payer of ["国保連", "支払基金"] as const) {
    const mine = cases.filter((c) => c.payer === payer);
    const prefs = new Set(mine.map((c) => c.prefecture));
    if (prefs.size > 1) throw new Error(`1 ファイルに複数の都道府県: ${[...prefs].join(",")}`);
    files[payer] = {
      payer,
      prefecture: mine[0]?.prefecture ?? "東京都",
      clinic: src.clinic,
      billingMonth,
      receipts: mine.map((c) => {
        const patient = src.patients[c.claimId];
        if (!patient) throw new Error(`患者情報がない: ${c.claimId}`);
        return { claimId: c.claimId, yearMonth: c.yearMonth, patient, lines: c.lines, comments: c.comments ?? [] };
      }),
    };
  }
  return files;
}

/** UKE のレセプト 1 件を、カルテ側の事実と合わせて ClaimContext にする */
export function toClaimContext(
  file: UkeFile,
  claimId: string,
  extras: { facility: Facility; facts: ClaimContext["facts"]; events: ClaimContext["events"]; history?: ClaimContext["history"] },
): ClaimContext {
  const r = file.receipts.find((x) => x.claimId === claimId);
  if (!r) throw new Error(`UKE にないレセプト: ${claimId}`);
  return {
    claimId: r.claimId,
    yearMonth: r.yearMonth,
    facility: extras.facility,
    payer: file.payer,
    prefecture: file.prefecture,
    facts: extras.facts,
    events: extras.events,
    lines: r.lines,
    comments: r.comments,
    ...(extras.history ? { history: extras.history } : {}),
  };
}
