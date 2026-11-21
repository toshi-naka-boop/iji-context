// 施設の設定の読み込み（design.md §2-7）。config/facility.json の既定値に、症例ごとの上書き（fixtures/cases/Kn.json の facility）を重ねる。
// JSON では null を「不明」とし、ここで三値（Fact）に変える。重ねるのはこの 1 か所
import type { Facility, FacilityFactKey, Fact } from "./types";

export const FACT_KEYS: FacilityFactKey[] = ["dxTier", "baseUp", "priceResponse", "note16Met", "revisitBaseUpSameDay", "revisitPriceSameDay"];

type ValueOf<F> = F extends Fact<infer T> ? T : never;
/** 設定ファイルと症例の JSON での形。三値の項目は値そのものか null（不明） */
export type FacilityJson = Omit<Facility, FacilityFactKey> & { [K in FacilityFactKey]: ValueOf<Facility[K]> | null };

export const DX_TIERS = ["1", "2", "なし"] as const;
export const BASE_UPS = ["通常", "注5", "なし"] as const;

/** 既定値に上書きを重ねて、判定に渡す施設の設定にする。三値の項目がない・null なら「不明」 */
export function facilityOf(config: FacilityJson, override: Partial<FacilityJson> = {}): Facility {
  const raw = { ...config, ...override };
  const out = { ...raw } as unknown as Facility;
  for (const k of FACT_KEYS) {
    const v = raw[k];
    (out as Record<FacilityFactKey, Fact<unknown>>)[k] = v === null || v === undefined ? { known: false } : { known: true, value: v };
  }
  if (out.dxTier.known && !DX_TIERS.includes(out.dxTier.value)) throw new Error(`施設の設定 dxTier の値が違う: ${String(out.dxTier.value)}`);
  if (out.baseUp.known && !BASE_UPS.includes(out.baseUp.value)) throw new Error(`施設の設定 baseUp の値が違う: ${String(out.baseUp.value)}`);
  for (const k of ["priceResponse", "note16Met", "revisitBaseUpSameDay", "revisitPriceSameDay"] as const) {
    const f = out[k];
    if (f.known && typeof f.value !== "boolean") throw new Error(`施設の設定 ${k} は true・false・null のいずれか`);
  }
  return out;
}
