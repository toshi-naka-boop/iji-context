// 検証キュー（design.md §4-5、FR-65）。並べるだけで状態は変えない
import { ms } from "./time";
import type { KnowledgeMeta } from "./types";

/** 未検証を empathy 降順、同数なら source_event.at 昇順（さらに id 昇順）で返す。入力は変更しない */
export function verificationQueue(metas: readonly KnowledgeMeta[]): KnowledgeMeta[] {
  return metas
    .filter((m) => m.status === "未検証")
    .sort((a, b) => {
      if (b.empathy !== a.empathy) return b.empathy - a.empathy;
      const ta = ms(a.source_event.at);
      const tb = ms(b.source_event.at);
      if (ta !== tb) return ta - tb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
