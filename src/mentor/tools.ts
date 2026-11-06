// メンターのツール 6 つの中身（spec FR-13、決定68）。Agent SDK への登録（zod のスキーマ）は別に行う
// query_history / ask_peer_mentor / ask_human / ask_doctor / ask_missing（知識は Skill で読む。workspace.ts の Hooks で状態を確かめる）
import type { ClaimContext } from "../engine/types";
import { applyEvent, readKnowledge, type StoreOptions } from "../lifecycle/store";
import { askMissing, type AskMissing, type QueryDraft, type QueryLog } from "../query/doctor-query";

export type MentorDeps = {
  store: StoreOptions;
  queryLog: QueryLog;
  /** ベテランのメンター（別セッション）に問いを渡す。答えられなければ null（FR-14） */
  askPeerMentor: (question: string) => Promise<string | null>;
  /** ベテラン本人に届ける（ベテランのメンター経由のみ。CLAUDE.md） */
  askHuman: (question: string) => Promise<{ queued: string }>;
  /** カルテとの照合で見つかった不一致（F4）。医師確認は決まった質問で送る */
  crosscheck?: () => CrossItem[];
};

/** 照合の不一致 1 件。sent は同じ項目の医師確認がもう送られているか */
export type CrossItem = { ruleId: string; disease: string; why: string; draft: QueryDraft; sent: boolean };


/** query_history：その請求の過去月の算定（設定ファイルの固定値。決定62） */
export function queryHistory(ctx: ClaimContext): { yearMonth: string; kubun: string[] }[] {
  return ctx.history ?? [];
}

/** ask_doctor／ask_missing：宛先が医師なら医師確認（F1）、医療事務なら F3 */
export function askMissingTool(deps: Pick<MentorDeps, "queryLog">, req: AskMissing, now: string) {
  return askMissing(deps.queryLog, req, now);
}

/** ask_peer_mentor → 解けなければ ask_human（FR-14） */
export async function askPeerThenHuman(deps: Pick<MentorDeps, "askPeerMentor" | "askHuman">, question: string): Promise<{ from: "peer"; answer: string } | { from: "human"; queued: string }> {
  const peer = await deps.askPeerMentor(question);
  if (peer !== null) return { from: "peer", answer: peer };
  return { from: "human", ...(await deps.askHuman(question)) };
}

/** 回答で引用した知識に USED を出す（C-8）。承認済み・要再検証の知識だけ（ほかは黙って飛ばす） */
export function markCited(store: StoreOptions, ids: string[], now: string): string[] {
  const used: string[] = [];
  for (const id of ids) {
    const m = readKnowledge(store, id);
    if (!m || (m.status !== "承認済み" && m.status !== "要再検証")) continue;
    applyEvent(store, id, { type: "USED" }, now);
    used.push(id);
  }
  return used;
}
