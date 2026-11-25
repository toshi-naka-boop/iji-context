// 処方の日の「確かめた」の印（design.md §16-4-1。round-65 C-410・round-66 C-421）。印は、そのときの処方の文（rx の quote を連ねたもの）の sha256 を持ち、
// 取り込み直し・貼り直しで文が変わったら、印はないものとして読む（消さない）
import { createHash } from "node:crypto";
import type { RxNote, StoredActs } from "../chart/acts";

/** その日の処方の文の指紋（rx の quote を順に連ねた sha256） */
export const rxHashOf = (rx: RxNote[]): string => createHash("sha256").update(rx.map((r) => r.quote).join("\n")).digest("hex");

/** 保存したカルテの印が、いまの処方の文で効くか */
export const rxConfirmedOf = (stored: Pick<StoredActs, "rx" | "rxConfirmed">): boolean => !!stored.rxConfirmed && stored.rxConfirmed.rxHash === rxHashOf(stored.rx);
