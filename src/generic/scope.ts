// 点検の範囲の説明に足すもの（design.md §12-5・§12-6）：検算（G02）の数と対象外の理由、G02・G03 が点検していないこと。
// 「指摘なし」は、ここに挙げた「していない」ことについては言えない
import type { MastersDb } from "../masters/db";
import { recalcClaim, recalcSummary } from "./g02";
import { g03NotDone } from "./g03";
import type { GenericAbout, GenericClaim, GenericResult, RecalcSummary } from "./types";

/** recalc は、G02 が動いて、点数の書いてある単位があるときだけ。notDone は、していない点検（文） */
export type GenericScope = { recalc?: RecalcSummary; notDone: string[] };

export function genericScopeOf(claim: GenericClaim, masters: MastersDb | null, about: GenericAbout, result: GenericResult): GenericScope {
  const out: GenericScope = { notDone: [] };
  const ran = (id: string) => result.ran.some((r) => r.check === id);
  if (masters !== null && ran("G02")) {
    const list = recalcClaim(claim, masters, about);
    if (Array.isArray(list) && list.length > 0) out.recalc = recalcSummary(list);
    else out.notDone.push("点数の検算は、点数の書いてある単位（取り込んだレセプトの単位）にだけ掛けます。ここの行には点数が書いていないので、検算していません");
  }
  if (ran("G03")) out.notDone.push(...g03NotDone(about));
  return out;
}
