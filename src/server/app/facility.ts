// 施設の設定の入力（spec FR-148。design.md §2-7・§6-1）：三値の項目を、事務長がクリニック（tenant）ごとに残す。
// 残した値は app_settings の "facility" に JSON（項目 → 値か null）で持つ。null は「分からない」、項目がなければ config/facility.json の既定値のまま。
// 効く順は、症例ごとの上書き＞クリニックで残した値＞config の既定値。症例ごとの上書きを重ねるのは今までどおり src/server/app/cases.ts の caseBaseOf
import { FACT_KEYS, type FacilityJson } from "../../engine/facility";
import type { FacilityFactKey } from "../../engine/types";
import type { AppContext } from "./context";

type Saved = Partial<Pick<FacilityJson, FacilityFactKey>>;

const SETTING_KEY = "facility";

/** クリニックで残した値（残していない項目は入らない） */
function savedOf(ctx: Pick<AppContext, "setting">): Saved {
  const raw = ctx.setting(SETTING_KEY);
  return raw === null ? {} : (JSON.parse(raw) as Saved);
}

/** 判定に渡す前の施設の設定（JSON の形）：config の既定値に、クリニックで残した値を重ねる */
export const facilityJsonOf = (ctx: Pick<AppContext, "facility" | "setting">): FacilityJson => ({ ...ctx.facility, ...savedOf(ctx) });

export function createFacility(ctx: AppContext) {
  /** 設定の画面に出す一覧：項目ごとに、いま効いている値（null は分からない）と、クリニックで残した値か（偽なら既定値のまま） */
  function facilitySettings() {
    const saved = savedOf(ctx);
    const now = facilityJsonOf(ctx);
    return { items: FACT_KEYS.map((key) => ({ key, value: now[key], saved: key in saved })) };
  }
  /** 1 項目を残す。null は「分からない」。値の形はスキーマ（src/server/schemas/facility.ts）が先に確かめる */
  function saveFacility(key: FacilityFactKey, value: string | boolean | null) {
    ctx.setSetting(SETTING_KEY, JSON.stringify({ ...savedOf(ctx), [key]: value }));
    return facilitySettings();
  }
  return { facilitySettings, saveFacility };
}
