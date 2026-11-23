// 時間の語の規則（design.md §16-6。L-177）：訪問の時刻が取れない日に、医療事務へ時刻の入力を案内するかを、確かめた文章の文字で決める。LLM は使わない
/** 時間の語（設計の値。テストで縛る） */
export const TIME_HINT_WORDS = ["時間", "分", "時", ":"] as const;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = TIME_HINT_WORDS.map((w) => new RegExp(`[0-9]${esc(w)}|${esc(w)}[0-9]`));

/** 文章を NFKC にして空白を除き、時間の語と数字が並んでいれば true（「1時間10分」「10:00」など） */
export function hasTimeHint(text: string): boolean {
  const t = text.normalize("NFKC").replace(/\s/g, "");
  return PATTERNS.some((p) => p.test(t));
}
