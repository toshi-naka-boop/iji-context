// 取り込んだファイルを消す（design.md §11-11「消す」・X-87）。単位は取り込んだファイル（アップロード 1 回）。請求ごとには消さない。
// 消すもの：原本のファイル、そのファイルの請求にぶら下がる提出・適用記録・提出結果・会議の項目・処理体験（問題）・医師確認・ベテランへの問い・訪問カルテ（とその記載への略語の医師の答え）・算定プレビューで入れた摘要欄の記載・請求ごとに確かめた事実・医師が「その他」「判定不能」と答えた記録・査定・返戻の明細の当て方と判定、
// ほかのどの請求からも参照されなくなった患者マスタ・加入情報・確かめた患者情報。読み直しのキャッシュと、取り込みの記録も捨てる。
// 残るもの：監査ログ（id だけ）、その請求から作った知識の候補（文は人が書いたもの。消すかは責任者が知識の画面で決める）、AI のサービス側に送った内容。
// メンターのやり取り（セッション）と作業場所は DB の外にあるので、消す相手（医療事務と、その人がこれまでに使ったセッションの全部）を返し、呼び出し側（src/server/instance.ts）が消す
import { rmSync } from "node:fs";
import path from "node:path";
import { listQueries } from "../../query/doctor-query";
import { VETERAN_CLERK } from "./clerks";
import { forgetAbbrevAnswers } from "./doctor-abbrevs";
import type { AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

export function createErase(ctx: AppContext, uke: Uke, patients: Patients) {
  const { sqlite, queryLog } = ctx;

  /** id の一覧を IN (...) に並べる（値は ? で渡す） */
  const marks = (ids: string[]) => ids.map(() => "?").join(", ");

  /** その請求の医師確認の記録（1 質問 2 ファイル）を消す */
  function forgetQueries(claimIds: string[]): void {
    for (const q of listQueries(queryLog).filter((x) => claimIds.includes(x.claimId))) {
      for (const ext of ["json", "md"]) rmSync(path.join(queryLog.dir, `${q.id}.${ext}`), { force: true });
    }
  }

  /**
   * 1 つのトランザクションで消す。途中で失敗したら DB は元のまま（ファイルは、DB の書き換えが全部済んでから最後に消す）。
   * 返すのは、消した請求の id と、メンターのやり取りを消す相手。氏名・番号は返さない
   */
  function deleteUpload(sha256: string): { claimIds: string[]; clerks: { id: string; sessionIds: string[] }[] } {
    return sqlite
      .transaction(() => {
        const target = uke.uploadedFile(sha256);
        const claimIds = target.receipts.map((r) => r.claimId);
        // 消える請求の患者（患者マスタの id）。ほかの請求から参照が残る患者は、あとで外す
        const gone = new Set(target.receipts.map((r) => patients.ingest(r.patient)));
        const clerkIds = new Set<string>();
        if (claimIds.length > 0) {
          const questions = sqlite.prepare(`SELECT id, clerk_id FROM questions WHERE claim_id IN (${marks(claimIds)})`).all(...claimIds) as { id: string; clerk_id: string }[];
          const submitted = (sqlite.prepare(`SELECT submission_id FROM submissions WHERE claim_id IN (${marks(claimIds)})`).all(...claimIds) as { submission_id: string }[]).map((r) => r.submission_id);
          // 提出の id は問題の id（src/server/app/questions.ts の confirmQ）。提出にならなかった問題にも、提出結果だけが取り込まれていることがある
          const subs = [...new Set([...submitted, ...questions.map((q) => q.id)])];
          if (subs.length > 0) {
            for (const table of ["applications", "claim_results", "digest_items"]) sqlite.prepare(`DELETE FROM ${table} WHERE submission_id IN (${marks(subs)})`).run(...subs);
            // 知識ごとの会議の項目（取り忘れ・確かめ直し）は、理由に、根拠にした提出の一覧（提出の id・請求の id）を持つ。消した提出の分だけを一覧から外す。
            // 取り忘れの項目で、根拠の提出が 1 つも残らないものは、項目ごと消す（答える相手のない議題を残さない）
            const goneSubs = new Set(subs);
            const scrub = (v: unknown): unknown =>
              Array.isArray(v)
                ? v.filter((x) => !(typeof x === "string" && goneSubs.has(x)) && !(x !== null && typeof x === "object" && goneSubs.has((x as { submissionId?: string }).submissionId ?? ""))).map(scrub)
                : v !== null && typeof v === "object"
                  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
                  : v;
            for (const r of sqlite.prepare("SELECT item_id, kind, reason FROM digest_items").all() as { item_id: string; kind: string; reason: string }[]) {
              const next = scrub(JSON.parse(r.reason)) as { misses?: unknown[] };
              if (JSON.stringify(next) === r.reason) continue;
              if (r.kind === "miss" && next.misses?.length === 0) sqlite.prepare("DELETE FROM digest_items WHERE item_id = ?").run(r.item_id);
              else sqlite.prepare("UPDATE digest_items SET reason = ? WHERE item_id = ?").run(JSON.stringify(next), r.item_id);
            }
            // 会議の整理が「対象から外した提出」として覚えている id からも外す
            for (const r of sqlite.prepare("SELECT review_id, skipped FROM reviews WHERE skipped != '[]'").all() as { review_id: string; skipped: string }[]) {
              const kept = (JSON.parse(r.skipped) as string[]).filter((id) => !subs.includes(id));
              sqlite.prepare("UPDATE reviews SET skipped = ? WHERE review_id = ?").run(JSON.stringify(kept), r.review_id);
            }
          }
          sqlite.prepare(`DELETE FROM submissions WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          for (const q of questions) {
            clerkIds.add(q.clerk_id);
            // 問題ごとに数えていた、雑談・愚痴が続いた回数
            sqlite.prepare("DELETE FROM app_settings WHERE key IN (?, ?)").run(`smalltalk:${q.id}`, `vent:${q.id}`);
          }
          sqlite.prepare(`DELETE FROM questions WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          // 略語の医師への答え（FR-211）：そのカルテの記載の分と、記載のなくなった答え
          forgetAbbrevAnswers(sqlite, (sqlite.prepare(`SELECT id FROM chart_notes WHERE claim_id IN (${marks(claimIds)})`).all(...claimIds) as { id: number }[]).map((r) => r.id));
          sqlite.prepare(`DELETE FROM chart_notes WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          sqlite.prepare(`DELETE FROM chart_comments WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          sqlite.prepare(`DELETE FROM claim_facts WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          sqlite.prepare(`DELETE FROM claim_reviews WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          sqlite.prepare(`DELETE FROM doctor_fact_notes WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          // 査定・返戻の突き合わせ（spec FR-202 の I-1）：その請求に当てた明細の判定を消し、当て方を外す（明細そのものは、取り込んだ CSV を消すまで残る。当てられないものに戻る）
          sqlite.prepare(`DELETE FROM review_judgments WHERE item_id IN (SELECT id FROM review_items WHERE claim_id IN (${marks(claimIds)}))`).run(...claimIds);
          sqlite.prepare(`UPDATE review_items SET claim_id = NULL, claim_by = NULL, claim_note = NULL, line_code = NULL, line_by = NULL, confirmed_by = NULL, confirmed_at = NULL WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds);
          // ベテランへの問い。ベテランのメンターにも同じ問いが渡っているので、そのやり取りも消す
          const peers = sqlite.prepare(`DELETE FROM peer_questions WHERE claim_id IN (${marks(claimIds)})`).run(...claimIds).changes;
          if (peers > 0) clerkIds.add(VETERAN_CLERK);
        }
        // 取り込みの一覧・取り込みの記録・読み直しのキャッシュから外す（このあとの ukeReceipts() には、このファイルは出ない）
        const original = uke.forgetUpload(sha256);
        // ほかのどの請求（見本と、残っているファイル。読み直しで読めなかったレセプトも含む）からも参照されなくなった患者だけを消す
        for (const r of uke.ukeReceipts()) gone.delete(patients.ingest(r.patient));
        for (const id of gone) {
          for (const table of ["patient_facts", "patient_coverages", "chart_structured", "structured_inputs", "patient_devices", "device_proposals", "patient_care", "other_institutions", "other_institutions_none"]) sqlite.prepare(`DELETE FROM ${table} WHERE patient_id = ?`).run(id);
          sqlite.prepare("DELETE FROM patients WHERE id = ?").run(id);
        }
        // メンターのやり取りは 1 人 1 セッションで、請求ごとに切り分けられない。その請求を相談した人のセッションをまるごと切る。
        // 前に使って捨てたセッション（同期の世代が変わった・作り直した）の記録にも、その請求の相談が残っているので、これまでに使った id を全部返す
        const clerks = [...clerkIds].map((id) => {
          const sessionIds = (sqlite.prepare("SELECT session_id FROM clerk_sessions WHERE clerk_id = ?").all(id) as { session_id: string }[]).map((r) => r.session_id);
          sqlite.prepare("DELETE FROM clerk_sessions WHERE clerk_id = ?").run(id);
          sqlite.prepare("UPDATE clerks SET session_id = NULL WHERE id = ?").run(id);
          return { id, sessionIds };
        });
        // ファイル：医師確認の記録と、原本
        forgetQueries(claimIds);
        rmSync(original, { force: true });
        return { claimIds, clerks };
      })
      .immediate();
  }

  /**
   * クリニックをまるごと消すとき（src/server/instance.ts の eraseTenant）に、DB の外にあるメンターのやり取りを消す相手を返す：
   * 医療事務ごとの、これまでに使ったセッションの id の全部（deleteUpload の clerks と同じ形）。DB は書き換えない（DB はファイルごと消す）
   */
  function allSessions(): { id: string; sessionIds: string[] }[] {
    const rows = sqlite.prepare("SELECT clerk_id AS id, session_id AS sid FROM clerk_sessions UNION SELECT id, session_id AS sid FROM clerks WHERE session_id IS NOT NULL").all() as { id: string; sid: string }[];
    const by = new Map<string, string[]>();
    for (const r of rows) by.set(r.id, [...(by.get(r.id) ?? []), r.sid]);
    return [...by].map(([id, sessionIds]) => ({ id, sessionIds }));
  }

  return { deleteUpload, forgetQueries, allSessions };
}
