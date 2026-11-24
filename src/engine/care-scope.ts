// 介護保険との調整で、R16 と導出 D03 が管理料の族を言わない月（design.md §18-2・§18-3。C-490・C-501・C-511）。R16・D03・R20 が同じ答えを使う
import { residenceOfType } from "./care";
import type { ClaimContext } from "./types";

/**
 * R16・D03 が黙る理由。null は黙らない（今までどおり 2 値で見る）。
 * none：住まいの種別が 2 値に当たらない（老健・介護医療院・養護〔それ以外〕）／midMonth：月の途中で住まいが変わった／
 * shortStay：短期入所生活介護の月か、2 値が施設入居等の患者の小多機・看多機の宿泊の月（R16 と R20 の向きが逆になり得る月。管理料の族は R20 だけが見る）
 */
export function familySilence(ctx: Pick<ClaimContext, "facts" | "care">): "none" | "midMonth" | "shortStay" | null {
  const t = ctx.facts.residenceType;
  if (t?.known && residenceOfType(t.value) === "none") return "none";
  if (ctx.care?.residence?.changedMidMonth) return "midMonth";
  const s = ctx.care?.shortStay;
  if (s?.status === "使った") {
    if (s.uses.some((u) => u.kind === "短期入所生活介護")) return "shortStay";
    const res = ctx.facts.residence;
    if (res.known && res.value === "施設入居等" && s.uses.some((u) => u.kind === "小多機・看多機の宿泊")) return "shortStay";
  }
  return null;
}
