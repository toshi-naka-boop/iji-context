// 知識：検証キュー（FR-41・FR-65）と F11 提案・共感（FR-51）、査定・返戻の通知、ローカルルール
import path from "node:path";
import { evaluate, ruleKubun } from "../../engine";
import { hasRevision, resolveRevision } from "../../engine/revisions";
import type { ClaimContext, ClaimLine } from "../../engine/types";
import { IDLE_DAYS, LAYER_SLUG } from "../../lifecycle/layers";
import { matchState } from "../../lifecycle/match";
import { verificationQueue } from "../../lifecycle/queue";
import { seedLocalRules as seedInHouse } from "../../lifecycle/seed-local";
import { applyEvent, createKnowledge, listKnowledge, readBody, readKnowledge } from "../../lifecycle/store";
import { jstYearMonth } from "../../lifecycle/time";
import type { Actor, KnowledgeMeta } from "../../lifecycle/types";
import { candidateOf, resolveNotice, type Notice } from "../../notice/notice";
import { SAMPLE_NOTICE_BASE, SAMPLE_NOTICE_PDF } from "../../notice/sample";
import { checkable, docKey, judge, judgeAll, related } from "../../official/match";
import { selectorOf } from "../../generic/g05";
import { pairHasPattern } from "../../generic/haihan";
import { TABLE } from "../../generic/tensuhyo";
import { withMasters } from "../../masters/db";
import type { OfficialDoc } from "../../official/types";
import type { UkeSources } from "../../uke/cases";
import { badRequest, conflict, notFound } from "../errors";
import type { Cases } from "./cases";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { QuestionCase } from "./question-case";
import type { Questions } from "./questions";

export function createKnowledgeOps(ctx: AppContext, clock: Clock, casesOf: Cases, questionCase: QuestionCase, questions: Questions) {
  const { paths, store, official, sqlite } = ctx;
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
    // 承認済みで入れた種には、いまのレジストリとの矛盾を「確認済み」として記録する（最初の会議で種がまとめて要再検証にならないように）
    const inHouse = seedInHouse(store, { official, now: now() });
    const n = json<Notice>(path.join(paths.root, `${SAMPLE_NOTICE_BASE}.json`));
    const items = resolveNoticeItems(n);
    return [...inHouse.map((id) => ({ id })), ...items.flatMap((item, i) => {
      const cand = candidateOf(item, { reexamFiled: false, fileName: SAMPLE_NOTICE_PDF });
      if (listKnowledge(store).some((m) => m.id.endsWith(`/${cand.slug}`))) return [];
      return [registerNotice(n, i, { reexamFiled: false, fileName: SAMPLE_NOTICE_PDF })];
    })];
  }
  /** 知識の match（機械が見る条件）を言葉にする。区分の名前はその年月の版の点数表から取る */
  function matchText(m: KnowledgeMeta, yearMonth: string): string {
    const points = resolveRevision(yearMonth).points;
    const name = (k: string) => points[k]?.name ?? k;
    const { ruleId, kubunAll, payer, prefecture, facts, commentOn, consecutiveMonths, codePair } = m.match;
    const parts = [
      // 背反の組の知識（design.md §14-1）：条件は conditionNote の文だけで、機械では当てない
      ...(codePair ? [`背反の組 ${codePair.a}・${codePair.b}（${TABLE.haihan[codePair.tani]}）`] : []),
      ...(kubunAll && kubunAll.length > 0 ? [`${kubunAll.map(name).join("・")}を算定している`] : ruleId !== undefined ? [`ユスティの ${ruleId} が当てはまる`] : []),
      ...(payer !== undefined ? [`審査支払機関が${payer}`] : []),
      ...(prefecture !== undefined ? [prefecture] : []),
      ...(facts?.careLevelMin !== undefined ? [`要介護${facts.careLevelMin}以上`] : []),
      ...(facts?.insurance !== undefined ? [`保険が${facts.insurance}`] : []),
      ...(facts?.table8_2 !== undefined ? [`別表第八の二に${facts.table8_2 ? "当たる" : "当たらない"}`] : []),
      ...(facts?.table7 !== undefined ? [`別表第七に${facts.table7 ? "当たる" : "当たらない"}`] : []),
      ...(commentOn ?? []).map((c) => `${name(c.kubun)}に摘要コメントが${c.present ? "ある" : "ない"}`),
      ...(consecutiveMonths ? [`${name(consecutiveMonths.kubun)}を ${consecutiveMonths.min} か月以上続けて算定している`] : []),
    ];
    return parts.length > 0 ? parts.join("・") : "条件なし";
  }
  /** 確かめた人の名前（表示用。知識には医療事務 id だけを残す） */
  const clerkName = (id: string) => (sqlite.prepare("SELECT name FROM clerks WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id;
  const docView = (d: OfficialDoc, verdict: string) => ({ id: d.id, kind: d.kind, issuer: d.issuer, number: d.number, issuedOn: d.issuedOn, url: d.url, stance: d.stance, summary: d.summary, verdict });
  /**
   * 知識 1 件の、公的情報との突き合わせの結果と出典リンク（FR-128。決まった規則で、その年月の版に当たる文書だけを使う）。
   * 条件に当たるかを人が確かめられる文書（§11-3）には、文書の鍵・文書の条件・確かめた結果を添える
   */
  function officialOf(m: KnowledgeMeta, yearMonth: string) {
    const generation = resolveRevision(yearMonth).generation;
    const kubunOfRule = (ruleId: string) => ruleKubun(ruleId, yearMonth);
    const all = judgeAll(m, official.docs, generation, kubunOfRule);
    const hit = new Set(Object.values(all.ids).flat());
    const checked = new Map((all.checked ?? []).map((c) => [c.id, c]));
    const targets = official.docs.filter((d) => checkable(d) && related(m, d, generation, kubunOfRule));
    return {
      verdict: all.verdict,
      /** まとめの結果が、人の確認（当たる）で決まったものか */
      humanChecked: all.ids[all.verdict as keyof typeof all.ids]?.some((id) => checked.get(id)?.applies === true) ?? false,
      /** 近似の知識（条件の注記あり）。注記に照らして読むのは人 */
      approx: all.approx,
      conditionNote: all.approx ? m.conditionNote : null,
      /** 当たった文書（id 昇順）。要旨とリンクだけで、原文は持たない */
      docs: official.docs.filter((d) => hit.has(d.id)).map((d) => docView(d, judge(m, d, generation, kubunOfRule))),
      /** 人が「この文書の条件には当たらない」と確かめた文書（結果には数えない。隠さずに出す） */
      notApplying: targets.filter((d) => checked.get(d.id)?.applies === false).map((d) => docView(d, "対象外")),
      /** 知識の match を言葉にしたものと、知識の注記（機械は見ない） */
      matchText: matchText(m, yearMonth),
      ruleNote: m.conditionNote,
      /** 条件に当たるかを確かめられる文書（id 昇順）。check は確かめた結果（まだなら null）。停止・保管の知識では確かめられない */
      canCheck: m.status !== "停止" && m.status !== "保管",
      checks: targets.map((d) => {
        const c = checked.get(d.id);
        return { docId: d.id, key: docKey(d), condition: d.scope.conditionNote as string, check: c ? { applies: c.applies, by: clerkName(c.by), at: c.at.slice(0, 10) } : null };
      }),
    };
  }
  /**
   * 公的文書の条件に当たるかを、人が確かめる（§11-3）。状態は変えない。確かめで「矛盾の恐れ」になった文書は、次の会議の整理でトリガー④の対象になる。
   * 判定の世代は今の年月の版（トリガー④と同じ）。input.key は画面に出したときの文書の鍵で、いまの鍵と違えば断る（読んだ版と違う版に確認を付けない）
   */
  function checkOfficial(id: string, input: { docId: string; key: string }, applies: boolean, who: { by: string; actor: Exclude<Actor, "system"> }) {
    const m = readKnowledge(store, id);
    if (!m) throw notFound(`知識が見つからない: ${id}`);
    if (m.layer === "制度") throw badRequest("制度層の知識は、公的文書との突き合わせの対象ではありません");
    const yearMonth = jstYearMonth(now());
    const generation = official.generationOf(yearMonth);
    const doc = official.docs.find((d) => d.id === input.docId);
    if (!doc || generation === null || !related(m, doc, generation, (ruleId) => ruleKubun(ruleId, yearMonth))) throw badRequest("この文書は、この知識の突き合わせの対象ではありません");
    if (!checkable(doc)) throw badRequest("この文書は、条件に当たるかを確かめる対象ではありません");
    if (docKey(doc) !== input.key) throw conflict("文書が更新されました。読み直してください");
    if (m.status === "停止" || m.status === "保管") throw conflict(`状態「${m.status}」の知識では確かめられません`);
    const after = applyEvent(store, id, { type: "OFFICIAL_CHECK", key: input.key, applies, ...who }, now(), { officialIds: [input.key] }).meta;
    return { id, status: after.status, docId: doc.id, key: input.key, applies };
  }
  /**
   * ローカルルール（地域・ベテランの判断・院内）のうち、この請求に当てはまるもの（FR-78）。
   * ユスティ（全国共通の決まり）とは別に見せる。保管したものは出さない。停止・要再検証のものは状態を付けて出す（隠さない。メンターは使わない）。
   * 院内のものはメンターの助言には使わない（FR-12）。各ルールに、公的情報との突き合わせの結果と出典リンクを添える（請求の診療年月の版）
   */
  function localRulesFor(ctx: ClaimContext) {
    const applied = evaluate(ctx).applied;
    return listKnowledge(store)
      .filter((m) => m.layer !== "制度" && m.status !== "保管")
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
        official: officialOf(m, ctx.yearMonth),
      }));
  }
  const localRulesOf = (questionId: string, lines?: ClaimLine[]) => {
    const q = loadQ(questionId);
    const c = caseFor(q);
    if (lines) checkLines(lines, c.yearMonth);
    return localRulesFor(lines ? { ...c, lines } : c);
  };
  /**
   * 知識の一覧（どの状態のものも出す）。ローカルルール（制度層以外）には、今の年月の版での公的情報との突き合わせを添える。
   * 今の年月に当たる版がなければ突き合わせない（null）
   */
  const knowledgeList = () => {
    const yearMonth = jstYearMonth(now());
    const judged = hasRevision(yearMonth);
    const metas = listKnowledge(store);
    // 背反の組の知識には、組・条件と、EM の例外の組（HP）が入っているか（入っていれば §13 で決まるので使われない。design.md §14-3）を添える
    const emDecided = withMasters((db) => {
      const sel = db && judged ? selectorOf(db, { yearMonth, generation: resolveRevision(yearMonth).generation }) : null;
      return new Set(metas.filter((m) => m.match.codePair && pairHasPattern(m.match.codePair, sel)).map((m) => m.id));
    });
    return metas.map((m) => ({
      id: m.id,
      layer: m.layer,
      status: m.status,
      summary: m.summary,
      empathy: m.empathy,
      hits: m.hits,
      misses: m.misses,
      official: m.layer !== "制度" && judged ? officialOf(m, yearMonth) : null,
      ...(m.match.codePair ? { pair: { ...m.match.codePair, table: TABLE.haihan[m.match.codePair.tani], conditionNote: m.conditionNote ?? "", polarity: m.polarity, emDecided: emDecided.has(m.id) } } : {}),
    }));
  };

  return { queue, verify, empathize, propose, resolveNoticeItems, registerNotice, seedLocalRules, localRulesOf, knowledgeList, checkOfficial };
}

export type KnowledgeOps = ReturnType<typeof createKnowledgeOps>;
