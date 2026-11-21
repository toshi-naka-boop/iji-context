// 背反の組の院内の知識（design.md §14）：G05 に渡す知識と本人のレベル。知識は院内層・ベテラン層の match.codePair を持つもの（保管は除く）
import { listKnowledge } from "../../lifecycle/store";
import type { CodePair } from "../../lifecycle/types";
import type { LocalPairKnowledge } from "../../generic/local-pair";
import type { GenericAbout } from "../../generic/types";
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
