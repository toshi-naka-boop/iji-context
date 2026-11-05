// 層×生成元×トリガーの対応表（FR-66、design.md §4-1）。定数のみ
import type { KnowledgeStatus, Layer, Polarity, SourceType, TriggerKind } from "./types";

export const LAYERS: readonly Layer[] = ["制度", "地域", "ベテラン", "院内"];

/** knowledge/ 配下のディレクトリ名（英字固定） */
export const LAYER_SLUG: Record<Layer, string> = {
  制度: "system",
  地域: "regional",
  ベテラン: "veteran",
  院内: "local",
};

/** 層ごとに効く再検証トリガー（FR-66） */
export const LAYER_TRIGGERS: Record<Layer, Record<TriggerKind, boolean>> = {
  制度: { revision: true, reappointment: false, idle: false },
  地域: { revision: false, reappointment: true, idle: true },
  ベテラン: { revision: false, reappointment: false, idle: true },
  院内: { revision: false, reappointment: false, idle: true },
};

/** ③ idle の日数（設計パラメータ N=180） */
export const IDLE_DAYS = 180;

/** 生成元ごとに作れる層（§4-1） */
export const SOURCE_LAYERS: Record<SourceType, readonly Layer[]> = {
  初期投入: ["制度"],
  返戻: ["地域", "院内"],
  査定: ["地域"],
  再審査: ["地域"],
  エスカレーション: ["ベテラン"],
  提案: ["院内"],
  手動: ["院内"],
};

/** 生成元と層の組み合わせが許されるか */
export function isAllowedSource(layer: Layer, source: SourceType): boolean {
  return SOURCE_LAYERS[source].includes(layer);
}

/** 初期状態（§4-1）。許されない組み合わせは例外 */
export function initialStatus(
  layer: Layer,
  source: SourceType,
  opts: { reexamFiled?: boolean } = {},
): KnowledgeStatus {
  if (!isAllowedSource(layer, source)) {
    throw new Error(`生成元「${source}」から ${layer}層の知識は作れない`);
  }
  switch (source) {
    case "初期投入":
    case "再審査":
      return "承認済み";
    case "査定":
      return opts.reexamFiled ? "contested" : "未検証";
    default:
      return "未検証";
  }
}

/** polarity の既定（§3 の表） */
export function defaultPolarity(layer: Layer, source: SourceType): Polarity {
  if (layer === "地域") return source === "再審査" ? "allow" : "avoid";
  if (layer === "院内") return source === "返戻" ? "avoid" : "allow";
  return "allow";
}
