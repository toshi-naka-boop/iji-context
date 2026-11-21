// 請求ごとに確かめた事実（履歴を残し、項目と日付ごとに最新の 1 件を使う）。値は、例外の文言とログに出さない。
// 宛先を守る：医師あての事実（エンジンの宛先の表）を残せるのは医師の役割だけ、医療事務あての事実を残せるのは算定の仕事をする人だけ。
// 背反の特例条件の例外の問いの答え（haihan:*。design.md §13-3）も同じ表に入れ、宛先は医療事務。答えを書くのは saveClaimFact の 1 か所だけ（X-105）
import { applyClaimFacts, CLEARED, isClaimFactKey, isDatedFact, isHaihanFactKey, validateClaimFact, type ClaimFact, type ClaimFactInput } from "../../claim/facts";
import { targetOfNeed } from "../../engine";
import { exceptionOf, parseHaihanKey, sharedFactOf } from "../../generic/haihan";
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
  function latestRows(claimId: string): ClaimFact[] {
    const rows = sqlite.prepare("SELECT * FROM claim_facts WHERE id IN (SELECT MAX(id) FROM claim_facts WHERE claim_id = ? GROUP BY key, date) ORDER BY id").all(claimId) as Row[];
    return rows.filter((r) => isClaimFactKey(r.key) || isHaihanFactKey(r.key)).map((r) => ({
      claimId: r.claim_id,
      key: r.key as ClaimFact["key"],
      date: r.date === "" ? null : r.date,
      value: JSON.parse(r.value) as ClaimFact["value"],
      source: r.source as ClaimFact["source"],
      checkedAt: r.checked_at,
      checkedBy: r.checked_by,
    }));
  }
  /** 項目と日付ごとの最新のうち、取り消していないもの（design.md §13-3。最新が取り消しなら「答えなし」） */
  const latestClaimFacts = (claimId: string): ClaimFact[] => latestRows(claimId).filter((f) => f.value !== CLEARED);
  /** 症例・カルテ由来の事実に、その請求について残した最新の値を重ねる（取り消した日は不明に戻す） */
  const withClaimFacts = (claimId: string, facts: Facts): Facts => applyClaimFacts(facts, latestRows(claimId));
  /** 例外の問いの答えを読む関数（G05 の answers。design.md §13-2）。key は haihan:*、date は日ごとの問いなら算定日、請求ごとなら null。答えがない・取り消してあれば null */
  function answersOf(claimId: string): (key: string, date: string | null) => string | null {
    const latest = latestClaimFacts(claimId).filter((f) => isHaihanFactKey(f.key));
    return (key, date) => {
      const f = latest.find((x) => x.key === key && x.date === date);
      return f && typeof f.value === "string" ? f.value : null;
    };
  }

  const yearMonthOf = (claimId: string): string => {
    const r = uke.ukeReceipts().find((x) => x.claimId === claimId);
    if (!r) throw notFound(`UKE にないレセプト: ${claimId}`);
    return r.yearMonth;
  };
  /** 画面に返す形。target は誰あての事実か、checkedByName は確かめた人の名前 */
  function claimFacts(claimId: string) {
    const yearMonth = yearMonthOf(claimId);
    const nameOf = (id: string) => (sqlite.prepare("SELECT name FROM clerks WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "";
    return { claimId, yearMonth, facts: latestClaimFacts(claimId).map((f) => ({ ...f, target: targetOf(f.key), checkedByName: nameOf(f.checkedBy) })) };
  }
  /** 誰あての項目か。例外の問いの答えは医療事務あて */
  const targetOf = (key: ClaimFactInput["key"]): "doctor" | "clerk" => (isClaimFactKey(key) ? targetOfNeed(key) : "clerk");
  /** 例外の問いの答えが、既存の事実（sameDayOushinAfterVisit）を使う問いなら、その事実の名前 */
  const sharedOf = (key: string): string | null => {
    const k = parseHaihanKey(key);
    const x = k ? exceptionOf(k.hx) : undefined;
    return x ? sharedFactOf(x) : null;
  };
  /** 入力の検査（文言を利用者に返す）と、宛先の確認。共有の事実を書く道も、同じ 2 つを通す（round-36 C-140） */
  function admit(f: ClaimFactInput, yearMonth: string, role: Role) {
    // 入力の検査で落ちたものは、利用者に文言を返す（検査は src/claim/facts.ts）
    try {
      validateClaimFact(f, yearMonth);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    const target = targetOf(f.key);
    if (target === "doctor" && role !== "doctor") throw forbidden("これは医師が確かめる項目です。医師の役割の利用者が残します");
    if (target === "clerk" && role === "doctor") throw forbidden("これは医療事務が確かめる項目です。事務・ベテランの役割で残します");
  }
  function saveClaimFact(claimId: string, clerkId: string, role: Role, f: ClaimFactInput) {
    clerks.clerk(clerkId);
    const yearMonth = yearMonthOf(claimId);
    admit(f, yearMonth, role);
    const value = typeof f.value === "string" ? f.value.trim() : f.value;
    const at = now();
    const insert = (key: string, date: string | null, v: unknown) =>
      sqlite.prepare("INSERT INTO claim_facts (claim_id, key, date, value, source, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(claimId, key, date ?? "", JSON.stringify(v), f.source, clerkId, at);
    /** 最新が答えのとき（取り消していないとき）だけ、取り消しの行を足す（行は消さない。C-118） */
    const clear = (key: string, date: string | null) => {
      if (latestClaimFacts(claimId).some((x) => x.key === key && x.date === date)) insert(key, date, CLEARED);
    };
    const shared = sharedOf(f.key);
    sqlite.transaction(() => {
      if (isHaihanFactKey(f.key) && shared !== null) {
        // 共有の事実を使う問い（X-105）：「その他」「判定不能」→ その日の共有の事実を取り消し（R10 も不明に戻る）、haihan:* に答えを残す（もう問わない記録）。
        // 当たる・当たらない → haihan:* を取り消して、共有の事実を書く（当たる＝真）
        const means = exceptionOf(parseHaihanKey(f.key)!.hx)!.ask!.choices.find((c) => c.label === value)!.means;
        // 共有の事実の側も、値の検査と宛先の確認を通す（取り消すときも、宛先は同じ。round-36 C-140）
        admit({ key: shared as ClaimFactInput["key"], date: f.date, value: means === "当たる", source: f.source }, yearMonth, role);
        if (means === "決まらない") {
          clear(shared, f.date);
          insert(f.key, f.date, value);
        } else {
          clear(f.key, f.date);
          insert(shared, f.date, means === "当たる");
        }
      } else if (isHaihanFactKey(f.key)) insert(f.key, f.date, value);
      else {
        insert(f.key, isDatedFact(f.key) ? f.date : null, value);
        // 共有の事実を直接書いたとき（R10 の入力）も、その日の、その事実を使う問いの「もう問わない記録」を取り消す（読む側は共有の事実を先に読むので、残っていても効かないが、経過を合わせる）
        if (isDatedFact(f.key))
          for (const x of latestClaimFacts(claimId)) if (isHaihanFactKey(x.key) && x.date === f.date && sharedOf(x.key) === f.key) insert(x.key, x.date, CLEARED);
      }
    })();
    return claimFacts(claimId);
  }

  return { withClaimFacts, claimFacts, saveClaimFact, answersOf };
}

export type ClaimFacts = ReturnType<typeof createClaimFacts>;
