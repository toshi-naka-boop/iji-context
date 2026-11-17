// 知識：検証キュー（FR-41・FR-65）と F11 提案・共感（FR-51）、査定・返戻の通知、ローカルルール
import path from "node:path";
import { evaluate } from "../../engine";
import type { ClaimContext, ClaimLine } from "../../engine/types";
import { IDLE_DAYS } from "../../lifecycle/layers";
import { matchState } from "../../lifecycle/match";
import { verificationQueue } from "../../lifecycle/queue";
import { seedLocalRules as seedInHouse } from "../../lifecycle/seed-local";
import { applyEvent, createKnowledge, listKnowledge, readBody } from "../../lifecycle/store";
import { candidateOf, resolveNotice, type Notice } from "../../notice/notice";
import type { UkeSources } from "../../uke/cases";
import type { Cases } from "./cases";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { QuestionCase } from "./question-case";
import type { Questions } from "./questions";

export function createKnowledgeOps(ctx: AppContext, clock: Clock, casesOf: Cases, questionCase: QuestionCase, questions: Questions) {
  const { paths, store } = ctx;
  const { now } = clock;
  const { cases } = casesOf;
  const { caseFor } = questionCase;
  const { loadQ } = questions;

  /** 検証キュー：未検証の知識を共感数の多い順（同数は古い順）。状態は変えない */
  const queue = () => verificationQueue(listKnowledge(store)).map((m) => ({ ...m, body: readBody(store, m.id) }));
  /** ベテランの検証（承認で承認済み、却下で保管） */
  function verify(id: string, approve: boolean, reason?: string) {
    return applyEvent(store, id, approve ? { type: "VERIFY_APPROVE" } : { type: "VERIFY_REJECT", reason: reason?.trim() || "ベテランの検証で却下" }, now()).meta;
  }
  /** 共感（候補の並び順だけに効く。状態は変えない） */
  const empathize = (id: string) => applyEvent(store, id, { type: "EMPATHY" }, now()).meta;
  /** 誰でも投稿できる改善提案（院内層の候補。既存の知識を直す案なら relates_to に対象を入れる） */
  function propose(input: { summary: string; body: string; relatesTo?: string | null }) {
    if (!input.summary.trim() || !input.body.trim()) throw new Error("要約と本文が必要");
    const n = listKnowledge(store).filter((m) => m.layer === "院内").length;
    return createKnowledge(
      store,
      { layer: "院内", slug: `proposal-${String(n + 1).padStart(4, "0")}`, summary: input.summary.trim().slice(0, 200), body: input.body.trim(), source: { type: "提案", ref: `proposal-${n + 1}` }, relates_to: input.relatesTo ?? null, match: {} },
      now(),
    );
  }
  // 査定・返戻の通知（FR-42・FR-43）：対応づけは決まった規則。知識の候補にするのは本人が確かめた項目だけ
  const resolveNoticeItems = (notice: Notice) => resolveNotice(notice, json<UkeSources>(path.join(paths.root, "fixtures", "uke", "patients.json")), cases());
  function registerNotice(notice: Notice, index: number, opts: { reexamFiled: boolean; fileName: string }) {
    const item = resolveNoticeItems(notice)[index];
    if (!item) throw new Error(`通知に ${index + 1} 件目の項目がない`);
    return createKnowledge(store, candidateOf(item, opts), now());
  }
  /** 新しいクリニックに、根拠のある地域ルールを最初から入れる（K6 の合成の査定通知から。FR-79）。すでにあれば何もしない */
  function seedLocalRules() {
    // 院内ルールの種（中身は伏せ、何の区分に関するものかだけ出す。何年も積み上がった様子を見せる。FR-80）
    const inHouse = seedInHouse(store);
    const n = json<Notice>(path.join(paths.root, "fixtures", "notices", "K6-2025-02-satei.json"));
    const items = resolveNoticeItems(n);
    return [...inHouse.map((id) => ({ id })), ...items.flatMap((item, i) => {
      const cand = candidateOf(item, { reexamFiled: false, fileName: "K6-2025-02-satei.pdf" });
      if (listKnowledge(store).some((m) => m.id.endsWith(`/${cand.slug}`))) return [];
      return [registerNotice(n, i, { reexamFiled: false, fileName: "K6-2025-02-satei.pdf" })];
    })];
  }
  /**
   * ローカルルール（地域・ベテランの判断・院内）のうち、この請求に当てはまるもの（FR-78）。
   * ユスティ（全国共通の決まり）とは別に見せる。保管・停止したものは出さない。院内のものはメンターの助言には使わない（FR-12）
   */
  function localRulesFor(ctx: ClaimContext) {
    const applied = evaluate(ctx).applied;
    return listKnowledge(store)
      .filter((m) => m.layer !== "制度" && m.status !== "保管" && m.status !== "停止")
      .map((m) => ({ m, state: matchState(m, ctx, applied) }))
      .filter((x) => x.state !== "nomatch")
      .map(({ m, state }) => ({
        id: m.id,
        layer: m.layer,
        status: m.status,
        summary: m.summary.replace("（中身は伏せています）", ""), // 2026-11-07 より前に入れた種の名前から外す（ユーザー判断）
        source: m.source_event.type,
        since: m.valid_from.slice(0, 10),
        hits: m.hits,
        /** 最後に当たった・使われた日（なければ null） */
        lastUsed: m.last_hit_at?.slice(0, 10) ?? null,
        /** 承認済みのまま、使われない期間（180 日）を超えている。レセメン会議で要再検証に回る */
        stale: m.status === "承認済み" && Date.parse(now()) - Date.parse(m.last_hit_at ?? m.status_since) >= IDLE_DAYS * 86_400_000,
        unknown: state === "unknown",
        usedByMentor: m.status === "承認済み" && m.layer !== "院内",
      }));
  }
  const localRulesOf = (questionId: string, lines?: ClaimLine[]) => {
    const q = loadQ(questionId);
    const c = caseFor(q);
    return localRulesFor(lines ? { ...c, lines } : c);
  };
  /** 知識の一覧（状態ごとの数を見せる用） */
  const knowledgeList = () => listKnowledge(store).map((m) => ({ id: m.id, layer: m.layer, status: m.status, summary: m.summary, empathy: m.empathy, hits: m.hits, misses: m.misses }));

  return { queue, verify, empathize, propose, resolveNoticeItems, registerNotice, seedLocalRules, localRulesOf, knowledgeList };
}

export type KnowledgeOps = ReturnType<typeof createKnowledgeOps>;
