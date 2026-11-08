// 立ち絵の表情（3 種）。メンターの出力（expression）ではなく、場面で決める（2026-11-07 ユーザー判断）
import type { Situation, Topic } from "./output";

export const FACES = { 喜び: "joy", 通常: "normal", 落ち込み: "down" } as const;
export type Face = keyof typeof FACES;

/** 正解したときは喜び、愚痴を聞くときと間違えたときは落ち込み、ほかは通常 */
export function faceFor(situation: Situation, topic: Topic): Face {
  if (topic === "愚痴") return "落ち込み";
  if (situation === "正方向") return "喜び";
  if (situation === "新人の誤り") return "落ち込み";
  return "通常";
}

/** public/characters/<絵>-<joy|normal|down>.png */
export const faceImage = (image: string, face: Face) => `/characters/${image}-${FACES[face]}.png`;

/** 選ぶ画面だけで使うポーズの絵（マッキーは手を振る絵）。public/characters/<絵>-select.png */
export const selectImage = (image: string) => `/characters/${image}-select.png`;
