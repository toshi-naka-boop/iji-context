// 症例（ClaimContext）と合成 UKE のあいだの変換（F4）
// UKE が持つのは請求の中身（コード・回数・日付・コメント）と患者・保険の情報だけ。
// 事実（facts）・出来事（events）・過去月（history）は合成カルテ・受給者証・設定ファイルから来る（spec FR-07、design.md §6）
import { requiredComments } from "../engine/comments";
import { resolveRevision } from "../engine/revisions";
import type { ClaimContext, Comment, Facility, Payer } from "../engine/types";
import type { UkeClinic, UkeFile, UkePatient } from "./types";
import { commentOf } from "./uke";

/**
 * bundleItems は、包括の検査の区分の行を UKE に書くときに並べる検査項目のコード（請求 id → 区分 → コード。合成の設定で、EM 5-1 の表による）。
 * commentValues は、症例の事実・出来事からは決まらない摘要欄の記載の値（請求 id → EM §2-10 表 1 の行の id → コードと文字データ（半角）。同じく EM 5-1 の合成の設定）
 */
export type UkeSources = {
  clinic: UkeClinic;
  patients: Record<string, UkePatient>;
  bundleItems?: Record<string, Record<string, string[]>>;
  commentValues?: Record<string, Record<string, { code: string; text: string }[]>>;
};

/**
 * 症例の UKE に書く、摘要欄の必須の記載（design.md §11-13）。導出の comments と同じ関数（requiredComments）で作る。
 * 値が事実・出来事から決まらない記載（needsInput）は、合成の設定（values：行の id → コードと文字データ）から順に取る。設定がなければ例外（記載もれの UKE を黙って作らない）
 */
export function commentsOfCase(c: ClaimContext, values: Record<string, { code: string; text: string }[]> = {}): Comment[] {
  const used = new Map<string, number>();
  return requiredComments(c, resolveRevision(c.yearMonth)).map((r) => {
    if (r.status === "ready") return commentOf(r.code!, r.text!, [r.kubun]);
    const n = used.get(r.rule) ?? 0;
    used.set(r.rule, n + 1);
    const v = values[r.rule]?.[n];
    if (!v || (r.code !== null && r.code !== v.code)) throw new Error(`${c.claimId}: 摘要欄の記載の値がない: ${r.rule}`);
    return commentOf(v.code, v.text, [r.kubun]);
  });
}

/**
 * 保険者番号から審査支払機関を決める（保険証の情報で区別する。2026-11-06 ユーザー判断）。
 * 6 桁は国保（市町村国保・国保組合）、39 で始まる 8 桁は後期高齢者医療 → 国保連。それ以外の 8 桁は被用者保険（社保）→ 支払基金
 */
export function payerOfInsurer(insurerNumber: string): Payer {
  if (/^\d{6}$/.test(insurerNumber)) return "国保連";
  if (/^39\d{6}$/.test(insurerNumber)) return "国保連";
  if (/^\d{8}$/.test(insurerNumber)) return "支払基金";
  throw new Error(`保険者番号の形式が不正: ${insurerNumber}`);
}

/** 審査支払機関ごとに 1 ファイル（spec FR-05：国保連 IR=2、支払基金 IR=1）。並びは入力の順 */
export function buildUkeFiles(cases: ClaimContext[], src: UkeSources, billingMonth: string): Record<Payer, UkeFile> {
  const files = {} as Record<Payer, UkeFile>;
  for (const c of cases) {
    const patient = src.patients[c.claimId];
    if (!patient) throw new Error(`患者情報がない: ${c.claimId}`);
    const derived = payerOfInsurer(patient.insurer.number);
    if (derived !== c.payer) throw new Error(`${c.claimId}: 保険証（${patient.insurer.number}）では ${derived} だが、請求は ${c.payer}`);
  }
  for (const payer of ["国保連", "支払基金"] as const) {
    const mine = cases.filter((c) => payerOfInsurer(src.patients[c.claimId].insurer.number) === payer);
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
        const items = src.bundleItems?.[c.claimId] ?? {};
        const lines = c.lines.map((l) => (Object.hasOwn(items, l.kubun) ? { ...l, items: items[l.kubun] } : l));
        // 施設に入居する患者かは、居住の場所の事実から（在宅ターミナルケア加算のコードを決める。design.md §11-14）
        const facilityResident = c.facts.residence.known && c.facts.residence.value === "施設入居等";
        return { claimId: c.claimId, yearMonth: c.yearMonth, patient, lines, comments: [...(c.comments ?? []), ...commentsOfCase(c, src.commentValues?.[c.claimId])], commentsKnown: true, facilityResident };
      }),
    };
  }
  return files;
}

/** UKE のレセプト 1 件を、カルテ側の事実と合わせて ClaimContext にする */
export function toClaimContext(
  file: UkeFile,
  claimId: string,
  extras: { facility: Facility; facts: ClaimContext["facts"]; events: ClaimContext["events"]; recordsKnown: boolean; history?: ClaimContext["history"] },
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
    recordsKnown: extras.recordsKnown,
    // 検査項目のコード（items）は UKE の側の持ち物で、エンジンには渡さない
    lines: r.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })),
    comments: r.comments,
    commentsKnown: r.commentsKnown,
    ...(extras.history ? { history: extras.history } : {}),
  };
}
