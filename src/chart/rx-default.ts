// その日の院内・院外の初期値（design.md §15-6。C-243）：本人が確かめた処方の文だけから、決まった文字の規則で出す。LLM も請求も使わない。本人は直せる
import type { RxChoice, RxNote } from "./acts";

/** 院外の語（設計の値。テストで縛る） */
export const RX_OUTSIDE_WORDS = ["院外処方", "処方箋", "処方せん"] as const;
/** 院内の語（設計の値。テストで縛る） */
export const RX_INSIDE_WORDS = ["院内"] as const;

/**
 * その日の処方の文（rx の quote。2 つ以上あれば全部を合わせる）を NFKC にして空白を除き、語を探す。
 * 院外の語だけ → 院外処方箋（outside）、院内の語だけ → 院内（inside）、どちらもある・どちらもない → 分からない（unknown）
 */
export function rxDefault(rx: RxNote[]): RxChoice {
  const text = rx.map((r) => r.quote).join("").normalize("NFKC").replace(/\s/g, "");
  const out = RX_OUTSIDE_WORDS.some((w) => text.includes(w));
  const inn = RX_INSIDE_WORDS.some((w) => text.includes(w));
  return out && !inn ? "outside" : inn && !out ? "inside" : "unknown";
}
