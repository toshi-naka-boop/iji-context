// 院外の語の規則（design.md §16-4-5 (e)。L-211・X-250）：カルテの文章に院外処方箋の記載があるかを、決まった文字の規則で見る。LLM は使わない。
// 処方の三択の初期値（src/chart/rx-default.ts の rxDefault）とは別の関数：院内の語と混ざっていても院外とする（在医総管 注2 を抑える向きにだけ使い、候補を出す理由には使わない）
import { RX_OUTSIDE_WORDS } from "../chart/rx-default";

/** 院外の語（§15-6 の初期値の規則の院外の語と同じ一覧から始める。テストで縛る） */
export const OUTSIDE_WORDS: readonly string[] = RX_OUTSIDE_WORDS;

/** 文章（S・O・A・P・処方の欄を合わせたもの）を NFKC にして空白を除き、院外の語が 1 つでもあれば true */
export function isOutsideText(text: string): boolean {
  const t = text.normalize("NFKC").replace(/\s/g, "");
  return OUTSIDE_WORDS.some((w) => t.includes(w));
}
