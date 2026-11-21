// 背反の組の院内の知識（design.md §14）：G05 に渡す知識と本人のレベル（知識は院内層・ベテラン層の match.codePair を持つもの。保管は除く）と、作る入口
import { LAYER_SLUG } from "../../lifecycle/layers";
import { createKnowledge, listKnowledge, PAIR_NOTE_MAX } from "../../lifecycle/store";
import type { CodePair, Polarity } from "../../lifecycle/types";
import type { LocalPairKnowledge } from "../../generic/local-pair";
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
  /** その組（同じ tani）の院内層・ベテラン層の知識（保管は除く。G05 が読むのは meta の polarity・conditionNote・status・rev と status_since だけ） */
  function knowledgeFor(pair: CodePair): LocalPairKnowledge[] {
    return listKnowledge(store)
      .filter((m) => (m.layer === "院内" || m.layer === "ベテラン") && m.status !== "保管")
      .filter((m) => m.match.codePair?.a === pair.a && m.match.codePair.b === pair.b && m.match.codePair.tani === pair.tani)
      .map((m) => ({ id: m.id, status: m.status, polarity: m.polarity, conditionNote: m.conditionNote ?? "", rev: m.rev, since: m.status_since }));
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
export function createLocalPairOps(ctx: AppContext, clock: Clock, check: (claimId: string, clerkId?: string) => unknown) {
  const { store } = ctx;
  const { now } = clock;
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
  return { isTarget, createPair };
}
