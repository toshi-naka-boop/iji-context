// 知識：検証キュー（FR-41・FR-65）と F11 提案・共感（FR-51）、査定・返戻の通知、ローカルルール
import path from "node:path";
import { evaluate } from "../../engine";
import type { ClaimContext, ClaimLine } from "../../engine/types";
import { IDLE_DAYS, LAYER_SLUG } from "../../lifecycle/layers";
import { matchState } from "../../lifecycle/match";
import { verificationQueue } from "../../lifecycle/queue";
import { seedLocalRules as seedInHouse } from "../../lifecycle/seed-local";
import { applyEvent, createKnowledge, listKnowledge, readBody, readKnowledge } from "../../lifecycle/store";
import { candidateOf, resolveNotice, type Notice } from "../../notice/notice";
import { SAMPLE_NOTICE_BASE, SAMPLE_NOTICE_PDF } from "../../notice/sample";
import type { UkeSources } from "../../uke/cases";
import { badRequest, conflict, notFound } from "../errors";
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
  const { loadQ, checkLines } = questions;

  /** 検証キュー：未検証の知識を共感数の多い順（同数は古い順）。状態は変えない */
  const queue = () => verificationQueue(listKnowledge(store)).map((m) => ({ ...m, body: readBody(store, m.id) }));
  /** 検証・共感は未検証の知識にだけできる。知識がない・状態が違うときは、利用者向けの誤りとして先に断る（文言は lifecycle のものと同じ） */
  function unverified(id: string, event: "VERIFY_APPROVE" | "VERIFY_REJECT" | "EMPATHY") {
    const m = readKnowledge(store, id);
    if (!m) throw notFound(`知識が見つからない: ${id}`);
    if (m.status !== "未検証") throw conflict(`許されない遷移: 状態「${m.status}」にイベント ${event} は適用できない（${id}）`);
  }
  /** ベテランの検証（承認で承認済み、却下で保管） */
  function verify(id: string, approve: boolean, reason?: string) {
    unverified(id, approve ? "VERIFY_APPROVE" : "VERIFY_REJECT");
    return applyEvent(store, id, approve ? { type: "VERIFY_APPROVE" } : { type: "VERIFY_REJECT", reason: reason?.trim() || "ベテランの検証で却下" }, now()).meta;
  }
  /** 共感（候補の並び順だけに効く。状態は変えない） */
  function empathize(id: string) {
    unverified(id, "EMPATHY");
    return applyEvent(store, id, { type: "EMPATHY" }, now()).meta;
  }
  /** 誰でも投稿できる改善提案（院内層の候補。既存の知識を直す案なら relates_to に対象を入れる） */
  function propose(input: { summary: string; body: string; relatesTo?: string | null }) {
    if (!input.summary.trim() || !input.body.trim()) throw badRequest("要約と本文が必要");
    // 要約は 1 行（文言は lifecycle の createKnowledge のものと同じ）
    if (/[\r\n]/.test(input.summary.trim())) throw badRequest("summary は 1 行・1024 文字以内で必須");
    // 番号は、いまある提案の番号の最大の次。件数から振ると、番号が飛んだときに既存の id とぶつかる
    const n = Math.max(0, ...listKnowledge(store).map((m) => Number(/\/proposal-(\d+)$/.exec(m.id)?.[1] ?? 0)));
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
    if (!item) throw badRequest(`通知に ${index + 1} 件目の項目がない`);
    const cand = candidateOf(item, opts);
    // 同じ項目をもう一度登録したときは、利用者向けの誤りとして先に断る（文言は lifecycle の createKnowledge のものと同じ）
    const id = `${LAYER_SLUG[cand.layer]}/${cand.slug}`;
    if (readKnowledge(store, id)) throw conflict(`既に存在する知識: ${id}`);
    return createKnowledge(store, cand, now());
  }
  /** 新しいクリニックに、根拠のある地域ルールを最初から入れる（K6 の合成の査定通知から。FR-79）。すでにあれば何もしない */
  function seedLocalRules() {
    // 院内ルールの種（中身は伏せ、何の区分に関するものかだけ出す。何年も積み上がった様子を見せる。FR-80）
    const inHouse = seedInHouse(store);
    const n = json<Notice>(path.join(paths.root, `${SAMPLE_NOTICE_BASE}.json`));
    const items = resolveNoticeItems(n);
    return [...inHouse.map((id) => ({ id })), ...items.flatMap((item, i) => {
      const cand = candidateOf(item, { reexamFiled: false, fileName: SAMPLE_NOTICE_PDF });
      if (listKnowledge(store).some((m) => m.id.endsWith(`/${cand.slug}`))) return [];
      return [registerNotice(n, i, { reexamFiled: false, fileName: SAMPLE_NOTICE_PDF })];
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
    if (lines) checkLines(lines, c.yearMonth);
    return localRulesFor(lines ? { ...c, lines } : c);
  };
  /** 知識の一覧（状態ごとの数を見せる用） */
  const knowledgeList = () => listKnowledge(store).map((m) => ({ id: m.id, layer: m.layer, status: m.status, summary: m.summary, empathy: m.empathy, hits: m.hits, misses: m.misses }));

  return { queue, verify, empathize, propose, resolveNoticeItems, registerNotice, seedLocalRules, localRulesOf, knowledgeList };
}

export type KnowledgeOps = ReturnType<typeof createKnowledgeOps>;
