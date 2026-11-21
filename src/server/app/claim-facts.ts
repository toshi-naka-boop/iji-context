// 請求ごとに確かめた事実（履歴を残し、項目と日付ごとに最新の 1 件を使う）。値は、例外の文言とログに出さない。
// 宛先を守る：医師あての事実（エンジンの宛先の表）を残せるのは医師の役割だけ、医療事務あての事実を残せるのは算定の仕事をする人だけ
import { applyClaimFacts, isClaimFactKey, isDatedFact, validateClaimFact, type ClaimFact, type ClaimFactInput } from "../../claim/facts";
import { targetOfNeed } from "../../engine";
import type { Facts } from "../../engine/types";
import { badRequest, forbidden, notFound } from "../errors";
import type { Role } from "../roles";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Uke } from "./uke";

type Row = { claim_id: string; key: string; date: string; value: string; source: string; checked_by: string; checked_at: string };

export function createClaimFacts(ctx: AppContext, clock: Clock, clerks: Clerks, uke: Uke) {
  const { sqlite } = ctx;
  const { now } = clock;

  /**
   * 項目と日付ごとに、最新の 1 件。いま請求ごとに持たない項目の行は使わない：
   * 居住の場所・文書の提供・緊急往診の対象か・管理料を算定する患者かは、患者ごとに持つように変えた（src/patient/facts.ts）。それより前に請求ごとに残した行は、判定にも一覧にも出さず、患者ごとに確かめ直してもらう
   */
  function latestClaimFacts(claimId: string): ClaimFact[] {
    const rows = sqlite.prepare("SELECT * FROM claim_facts WHERE id IN (SELECT MAX(id) FROM claim_facts WHERE claim_id = ? GROUP BY key, date) ORDER BY id").all(claimId) as Row[];
    return rows.filter((r) => isClaimFactKey(r.key)).map((r) => ({
      claimId: r.claim_id,
      key: r.key as ClaimFact["key"],
      date: r.date === "" ? null : r.date,
      value: JSON.parse(r.value) as ClaimFact["value"],
      source: r.source as ClaimFact["source"],
      checkedAt: r.checked_at,
      checkedBy: r.checked_by,
    }));
  }
  /** 症例・カルテ由来の事実に、その請求について残した最新の値を重ねる */
  const withClaimFacts = (claimId: string, facts: Facts): Facts => applyClaimFacts(facts, latestClaimFacts(claimId));

  const yearMonthOf = (claimId: string): string => {
    const r = uke.ukeReceipts().find((x) => x.claimId === claimId);
    if (!r) throw notFound(`UKE にないレセプト: ${claimId}`);
    return r.yearMonth;
  };
  /** 画面に返す形。target は誰あての事実か、checkedByName は確かめた人の名前 */
  function claimFacts(claimId: string) {
    const yearMonth = yearMonthOf(claimId);
    const nameOf = (id: string) => (sqlite.prepare("SELECT name FROM clerks WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";
    return { claimId, yearMonth, facts: latestClaimFacts(claimId).map((f) => ({ ...f, target: targetOfNeed(f.key), checkedByName: nameOf(f.checkedBy) })) };
  }
  function saveClaimFact(claimId: string, clerkId: string, role: Role, f: ClaimFactInput) {
    clerks.clerk(clerkId);
    const yearMonth = yearMonthOf(claimId);
    // 入力の検査で落ちたものは、利用者に文言を返す（検査は src/claim/facts.ts）
    try {
      validateClaimFact(f, yearMonth);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    const target = targetOfNeed(f.key);
    if (target === "doctor" && role !== "doctor") throw forbidden("これは医師が確かめる項目です。医師の役割の利用者が残します");
    if (target === "clerk" && role === "doctor") throw forbidden("これは医療事務が確かめる項目です。事務・ベテランの役割で残します");
    const value = typeof f.value === "string" ? f.value.trim() : f.value;
    sqlite
      .prepare("INSERT INTO claim_facts (claim_id, key, date, value, source, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(claimId, f.key, isDatedFact(f.key) ? f.date : "", JSON.stringify(value), f.source, clerkId, now());
    return claimFacts(claimId);
  }

  return { withClaimFacts, claimFacts, saveClaimFact };
}

export type ClaimFacts = ReturnType<typeof createClaimFacts>;
