// 背反の組の院内の知識（design.md §14-3）：G05 が、§13 で決まらない背反の行に、院内層・ベテラン層の codePair の知識を添える。
// G05 が読むのは知識の meta の polarity・conditionNote・status・rev と、今の状態に入った時刻（押した事実が効くか）だけ（本文は読まない）
import type { CodePair, KnowledgeStatus, Polarity } from "../lifecycle/types";

/** 条件を見せて算定できる扱い（ボタン）にするレベル（L-83。config/levels.json の Lv.5 ＝ 180 件。利用者の判断 2026-11-22） */
export const LOCAL_PAIR_MIN_LEVEL = 5;

/** G05 に渡す知識 1 件。since は今の状態に入った時刻（status_since） */
export type LocalPairKnowledge = { id: string; status: KnowledgeStatus; polarity: Polarity; conditionNote: string; rev: string; since: string };

/** 押した事実の key：local:<知識の id>@<rev>:<コード①>:<コード②>（コードは小さい順。design.md §14-3） */
export const localKey = (id: string, rev: string, a: string, b: string): string => `local:${id}@${rev}:${[a, b].sort().join(":")}`;
const KEY = /^local:((?:local|veteran)\/[a-z0-9-]{1,60})@([0-9a-f]{12}):(\d{9}):(\d{9})$/;
/** 押した事実の key を分ける。形が違えば null */
export function parseLocalKey(key: string): { id: string; rev: string; codes: [string, string] } | null {
  const m = KEY.exec(key);
  return m && m[3] < m[4] ? { id: m[1], rev: m[2], codes: [m[3], m[4]] } : null;
}
export const isLocalKey = (key: string): boolean => parseLocalKey(key) !== null;
/** 監査ログの対象に書く形：押した事実の key は、コードを除いた local:<知識の id>@<rev>（知識の id に組が入っている。対象の長さの上限で切れないように） */
export const auditKeyOf = (key: string): string => {
  const k = parseLocalKey(key);
  return k ? `local:${k.id}@${k.rev}` : key;
};

/** 組の向きをそろえる（小さい順） */
export const pairOf = (c1: string, c2: string, tani: 1 | 2 | 3): CodePair => (c1 < c2 ? { a: c1, b: c2, tani } : { a: c2, b: c1, tani });

/**
 * 指摘に添える院内の知識（params.local に JSON で入れる。画面は src/generic/view.ts が文にする）。
 * mode：allow＝Lv.5 以上で承認済みの allow（ボタン）／avoid＝Lv.5 以上で承認済みの avoid（G05.local_avoid）／hint＝Lv.1〜4 のヒント／conflict＝承認済みの allow と avoid が両方ある（使わない）／unverified＝未検証だけがある（前回の確かめ）。
 * dates は、ボタンを出す日（押していない日。同一月の表は空）
 */
export type LocalAttach = { mode: "allow" | "avoid" | "hint" | "conflict" | "unverified"; pair: CodePair; knowledge: { id: string; rev: string; polarity: Polarity; conditionNote: string }[]; dates: string[] };
