// 背反の組の院内の知識（design.md §14）：G05 に渡す知識と本人のレベル（知識は院内層・ベテラン層の match.codePair を持つもの。保管は除く）と、作る入口
import { LAYER_SLUG } from "../../lifecycle/layers";
import { applyEvent, createKnowledge, listKnowledge, PAIR_NOTE_MAX, readKnowledge } from "../../lifecycle/store";
import { approvalRound } from "../../lifecycle/machine";
import { ms } from "../../lifecycle/time";
import type { CodePair, Polarity } from "../../lifecycle/types";
import { LOCAL_PAIR_MIN_LEVEL, parseLocalKey, type LocalPairKnowledge } from "../../generic/local-pair";
import { TABLE } from "../../generic/tensuhyo";
import type { GenericAbout } from "../../generic/types";
import type { GenericView } from "../../generic/view";
import { fillLocal, LOCAL_PAIR_TEXT, type LocalPairBasis } from "../../messages";
import { badRequest, conflict } from "../errors";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Questions } from "./questions";

/** G05 に渡すもの（GenericAbout の localKnowledge・level） */
export type LocalAbout = Pick<GenericAbout, "localKnowledge" | "level">;

export function createLocalPairs(ctx: AppContext, questions: Pick<Questions, "status">) {
  const { store } = ctx;
  /** その組（同じ tani）の院内層・ベテラン層の知識（保管は除く。G05 が読むのは meta の polarity・conditionNote・status・rev と、承認済みに入った回数だけ） */
  function knowledgeFor(pair: CodePair): LocalPairKnowledge[] {
    return listKnowledge(store)
      .filter((m) => (m.layer === "院内" || m.layer === "ベテラン") && m.status !== "保管")
      .filter((m) => m.match.codePair?.a === pair.a && m.match.codePair.b === pair.b && m.match.codePair.tani === pair.tani)
      .map((m) => ({ id: m.id, status: m.status, polarity: m.polarity, conditionNote: m.conditionNote ?? "", rev: m.rev, round: approvalRound(m) }));
  }
  /** 本人のレベル（F10。処理件数の累計。練習問題も数える）。ボタンを出すかは、これだけで決める（C-184。役割では分けない） */
  const levelOf = (clerkId: string): number => questions.status(clerkId).level;
  /** 本人（clerkId）について G05 に渡すもの。本人が分からないときはレベルを渡さない（ボタンを出さない） */
  const aboutFor = (clerkId?: string): LocalAbout => ({ localKnowledge: knowledgeFor, ...(clerkId ? { level: levelOf(clerkId) } : {}) });
  return { knowledgeFor, levelOf, aboutFor };
}

export type LocalPairs = ReturnType<typeof createLocalPairs>;

/** 作る入口の入力（design.md §14-2）。condition は根拠を除いた条件の文 */
export type PairInput = { claimId: string; a: string; b: string; tani: 1 | 2 | 3; polarity: Polarity; basis: LocalPairBasis; condition: string };

/**
 * 作る入口・押した事実の照らし・返戻の入口（design.md §14-2〜§14-4）。check は、取り込んだレセプトの点検（G05 を計算し直す。USED は出さない）
 */
export function createLocalPairOps(ctx: AppContext, clock: Clock, check: (claimId: string, clerkId?: string) => unknown, levelOf: (clerkId: string) => number = () => 0) {
  const { store } = ctx;
  const { now } = clock;
  /** その請求の行の、算定日ごとのコード（"YYYY-MM-DD" → コード）と、請求のコード全部（点検の結果の rows から） */
  function codesOf(claimId: string): { all: Set<string>; on: (date: string) => Set<string> } {
    const rows = ((check(claimId) as { rows?: { items: { code: string }[]; dates: string[] }[] }).rows ?? []);
    return {
      all: new Set(rows.flatMap((r) => r.items.map((it) => it.code))),
      on: (date) => new Set(rows.filter((r) => r.dates.includes(date)).flatMap((r) => r.items.map((it) => it.code))),
    };
  }
  /** その請求の G05 を計算し直して、院内の知識を添える対象の組か（codePair と tani が一致する指摘があるか） */
  function isTarget(claimId: string, pair: CodePair): boolean {
    const r = check(claimId) as { generic?: GenericView };
    return (r.generic?.findings ?? []).some((f) => f.check === "G05" && f.localPair?.a === pair.a && f.localPair.b === pair.b && f.localPair.tani === pair.tani);
  }
  /** 作る（院内層・未検証）。G05 の対象でない組・allow と「返戻・査定された」の組は 400、同じ組・同じ向きの知識（relates_to なし・未検証／承認済み／contested）が既にあれば 409 */
  function createPair(input: PairInput) {
    if (!(input.a < input.b)) throw badRequest("コードは小さい順に 2 つ");
    if (input.polarity === "allow" && input.basis === "返戻・査定された") throw badRequest("返戻・査定された組を「条件に当たれば併せて算定できる」としては残せません");
    const pair: CodePair = { a: input.a, b: input.b, tani: input.tani };
    if (!isTarget(input.claimId, pair)) throw badRequest("この請求の点検に、院内の知識を残せる背反の指摘がない組です");
    const same = listKnowledge(store).find((m) => m.relates_to === null && m.polarity === input.polarity && (m.status === "未検証" || m.status === "承認済み" || m.status === "contested") && m.match.codePair?.a === pair.a && m.match.codePair.b === pair.b && m.match.codePair.tani === pair.tani);
    if (same) throw conflict(`同じ組・同じ扱いの院内の知識が、すでにあります: ${same.id}`);
    const conditionNote = `${fillLocal(LOCAL_PAIR_TEXT.basisPrefix, { basis: input.basis })}${input.condition.trim()}`;
    if (input.condition.trim() === "" || conditionNote.length > PAIR_NOTE_MAX) throw badRequest(`条件は、根拠と合わせて 1〜${PAIR_NOTE_MAX} 字で書いてください`);
    const base = `pair-${pair.a}-${pair.b}-t${pair.tani}-${input.polarity}`;
    const taken = new Set(listKnowledge(store).map((m) => m.id));
    let slug = base;
    for (let n = 2; taken.has(`${LAYER_SLUG["院内"]}/${slug}`); n++) slug = `${base}-${n}`;
    const summary = fillLocal(input.polarity === "allow" ? LOCAL_PAIR_TEXT.summaryAllow : LOCAL_PAIR_TEXT.summaryAvoid, { a: pair.a, b: pair.b, table: TABLE.haihan[pair.tani] });
    return createKnowledge(
      store,
      {
        layer: "院内",
        slug,
        summary,
        body: `${summary}\n\n${conditionNote}`,
        source: { type: input.polarity === "avoid" && input.basis === "返戻・査定された" ? "返戻" : "手動", ref: `uke:${input.claimId}` },
        polarity: input.polarity,
        matchApprox: true,
        conditionNote,
        match: { codePair: pair },
      },
      now(),
    );
  }
  /**
   * 押した事実を書く前に照らす（design.md §14-3。C-173）：本人が Lv.5 以上・知識が承認済みの allow・key の 2 つのコードと rev がその知識のもの・
   * 請求にその組の行があり、1 日・同時の表ならその日に両方ある（同一月の表は請求に両方。日付を付けない。X-124）・その組が G05 の対象。どれかが合わなければ 400
   */
  function admitPress(claimId: string, clerkId: string, f: { key: string; date: string | null }): number {
    const k = parseLocalKey(f.key);
    if (!k) throw badRequest("残せない項目です");
    if (levelOf(clerkId) < LOCAL_PAIR_MIN_LEVEL) throw badRequest(`「条件に当たる」は、Lv.${LOCAL_PAIR_MIN_LEVEL} から残せます`);
    const m = readKnowledge(store, k.id);
    const pair = m?.match.codePair;
    if (!m || !pair || m.status !== "承認済み" || m.polarity !== "allow") throw badRequest("承認済みの「条件に当たれば併せて算定できる」院内の知識ではありません");
    if (m.rev !== k.rev || pair.a !== k.codes[0] || pair.b !== k.codes[1]) throw badRequest("知識が直されました。点検を開き直してください");
    const codes = codesOf(claimId);
    if (pair.tani === 2) {
      if (f.date !== null) throw badRequest("同一月の組に日付は付けません");
      if (!codes.all.has(pair.a) || !codes.all.has(pair.b)) throw badRequest("この請求に、この組の行がありません");
    } else {
      if (f.date === null) throw badRequest("この請求の診療年月の日付を選ぶ");
      const on = codes.on(f.date);
      if (!on.has(pair.a) || !on.has(pair.b)) throw badRequest("この日に、この組の両方の行がありません");
    }
    if (!isTarget(claimId, pair)) throw badRequest("この請求の点検に、院内の知識を使う背反の指摘がない組です");
    return approvalRound(m);
  }
  /**
   * 指摘に添えた承認済みの知識に USED を出す（design.md §14-3。C-172・X-121）。取り込んだレセプトの点検・月末の点検だけが呼ぶ（算定プレビューでは出さない）。
   * 同じ請求・同じ知識は 1 日（日本時間）1 回まで。出したときの状態が承認済み・要再検証でなければ出さない
   */
  function markUsed(claimId: string, ids: string[]) {
    const at = now();
    const dayOf = new Date(ms(at) + 9 * 3_600_000).toISOString().slice(0, 10);
    for (const id of ids) {
      const m = readKnowledge(store, id);
      if (!m || (m.status !== "承認済み" && m.status !== "要再検証")) continue;
      if (ctx.sqlite.prepare("INSERT OR IGNORE INTO local_used (claim_id, knowledge_id, day) VALUES (?, ?, ?)").run(claimId, id, dayOf).changes === 0) continue;
      applyEvent(store, id, { type: "USED" }, at);
    }
  }
  /** その請求にその組の行があるか（1 日・同時の表は、同じ日に両方。同一月の表は請求に両方） */
  function hasPair(codes: ReturnType<typeof codesOf>, pair: CodePair, dates: string[]): boolean {
    if (pair.tani === 2) return codes.all.has(pair.a) && codes.all.has(pair.b);
    return dates.some((d) => codes.on(d).has(pair.a) && codes.on(d).has(pair.b));
  }
  /** 承認済みの allow の、背反の組の知識（院内層・ベテラン層） */
  const approvedAllow = () => listKnowledge(store).filter((m) => (m.layer === "院内" || m.layer === "ベテラン") && m.status === "承認済み" && m.polarity === "allow" && m.match.codePair !== undefined);
  /**
   * 「この請求のこの組が返戻・査定された」を出す組（design.md §14-4。C-182）：その請求にその組があり、その codePair の承認済みの allow の知識があるもの。押した事実がなくても出す。
   * result は、その請求の点検の結果（行の rows を読む）
   */
  function returnsOf(claimId: string, result: unknown): { a: string; b: string; tani: 1 | 2 | 3; ids: string[] }[] {
    const rows = (result as { rows?: { items: { code: string }[]; dates: string[] }[] }).rows ?? [];
    if (rows.length === 0) return [];
    const codes = { all: new Set(rows.flatMap((r) => r.items.map((it) => it.code))), on: (date: string) => new Set(rows.filter((r) => r.dates.includes(date)).flatMap((r) => r.items.map((it) => it.code))) };
    const dates = [...new Set(rows.flatMap((r) => r.dates))];
    const out: { a: string; b: string; tani: 1 | 2 | 3; ids: string[] }[] = [];
    for (const m of approvedAllow()) {
      const p = m.match.codePair!;
      if (!hasPair(codes, p, dates)) continue;
      const same = out.find((x) => x.a === p.a && x.b === p.b && x.tani === p.tani);
      if (same) same.ids.push(m.id);
      else out.push({ ...p, ids: [m.id] });
    }
    return out;
  }
  /**
   * 「この請求のこの組が返戻・査定された」（design.md §14-4。C-170・X-119）：その組の承認済みの allow の知識を要再検証にし（TRIGGER{localReturn}。根拠に請求 id と組）、
   * その請求で押した事実を取り消す。ほかの組の知識は変えない。clearPressed は、その請求の押した事実を取り消す関数（取り消した key を返す）
   */
  function localReturn(claimId: string, clerkId: string, pair: CodePair, clearPressed: (claimId: string, clerkId: string, knowledgeId: string, codes: [string, string]) => string[]): { ids: string[]; cleared: string[] } {
    const r = check(claimId);
    const target = returnsOf(claimId, r).find((x) => x.a === pair.a && x.b === pair.b && x.tani === pair.tani);
    if (!target) throw badRequest("この請求に、この組の行と、承認済みの「条件に当たれば併せて算定できる」院内の知識がありません");
    const at = now();
    const cleared: string[] = [];
    for (const id of target.ids) {
      applyEvent(store, id, { type: "TRIGGER", trigger: "localReturn" }, at, { trigger: "localReturn", claimId, codePair: pair });
      cleared.push(...clearPressed(claimId, clerkId, id, [pair.a, pair.b]));
    }
    return { ids: target.ids, cleared };
  }
  return { isTarget, createPair, admitPress, markUsed, returnsOf, localReturn };
}
