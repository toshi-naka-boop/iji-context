// 点検の範囲の説明に足すもの（design.md §12-5・§12-6）：検算（G02）の数と対象外の理由、G02〜G09 が点検していないこと（G04〜G06 は src/messages.ts の GENERIC_SCOPE_NOTE）。
// 「指摘なし」は、ここに挙げた「していない」ことについては言えない
import type { MastersDb } from "../masters/db";
import { GENERIC_SCOPE_NOTE, LOCAL_PAIR_TEXT } from "../messages";
import { recalcClaim, recalcSummary } from "./g02";
import { g03NotDone } from "./g03";
import { g07NotDone } from "./g07";
import { g08NotDone } from "./g08";
import { g09NotDone } from "./g09";
import type { GenericAbout, GenericClaim, GenericResult, RecalcSummary } from "./types";

/** recalc は、G02 が動いて、点数の書いてある単位があるときだけ。notDone は、していない点検（文）。g09 は、適応・併用（G09）の但し書きと、見たもの・見ていないもの（G09 が動いたときだけ。画面は、G09 の見出しの下に出す） */
export type GenericScope = { recalc?: RecalcSummary; notDone: string[]; g09?: string[] };

export function genericScopeOf(claim: GenericClaim, masters: MastersDb | null, about: GenericAbout, result: GenericResult): GenericScope {
  const out: GenericScope = { notDone: [] };
  const ran = (id: string) => result.ran.some((r) => r.check === id);
  if (masters !== null && ran("G02")) {
    const list = recalcClaim(claim, masters, about);
    if (Array.isArray(list) && list.length > 0) out.recalc = recalcSummary(list);
    else out.notDone.push("点数の検算は、点数の書いてある単位（取り込んだレセプトの単位）にだけ掛けます。ここの行には点数が書いていないので、検算していません");
  }
  if (ran("G03")) out.notDone.push(...g03NotDone(about));
  // 背反の特例条件の例外に当たるので出していない組（design.md §13-2 の 2。消えたことが分かるように、数と例外の id を出す）
  if ((result.silenced ?? []).length > 0) out.notDone.push(`特例の例外に当たるので出していない：${result.silenced!.reduce((s, x) => s + x.count, 0)} 件（${result.silenced!.map((x) => x.hx).join("・")}）`);
  // 院内の知識で「この請求も条件に当たる」と押したので出していない組と日（design.md §14-3。数と知識の id）
  if ((result.localSilenced ?? []).length > 0) out.notDone.push(`${LOCAL_PAIR_TEXT.silenced}：${result.localSilenced!.reduce((s, x) => s + x.count, 0)} 件（${result.localSilenced!.map((x) => x.id).join("・")}）`);
  // G04〜G06 の断り（作っていない単位・数え方）。画面の部品が別に足していたのをここに寄せ、月末の点検・算定プレビューの 1 行の表示でも出す（round-32 O-19）
  for (const r of result.ran) if (GENERIC_SCOPE_NOTE[r.check]) out.notDone.push(`${r.check}（${r.kind}）が点検していないこと：${GENERIC_SCOPE_NOTE[r.check]}`);
  if (masters !== null && ran("G07")) out.notDone.push(...g07NotDone(claim, masters, about));
  if (masters !== null && ran("G08")) out.notDone.push(...g08NotDone(masters, about));
  if (masters !== null && ran("G09")) out.g09 = g09NotDone(claim, masters, about);
  return out;
}
