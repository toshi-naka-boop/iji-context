// 点検の範囲の説明に足すもの（design.md §12-5・§12-6）：検算（G02）の数と対象外の理由、G02〜G09 が点検していないこと（G04〜G06 は src/messages.ts の GENERIC_SCOPE_NOTE）。
// 「指摘なし」は、ここに挙げた「していない」ことについては言えない
import type { Revision } from "../engine/revisions/types";
import { minashiOneLines } from "../engine/rules/r19";
import type { ClaimContext, ClaimLine } from "../engine/types";
import { hasShisetsuGroups, OLD_SHISETSU_G03_REASON, pickSnapshot, shinryoOf, type MastersDb } from "../masters/db";
import { GENERIC_SCOPE_NOTE, LOCAL_PAIR_TEXT } from "../messages";
import { recalcClaim, recalcNotesOf, recalcSummary } from "./g02";
import { g03NotDone } from "./g03";
import { conditionalOf, formOnlyNote, g07NotDone, type Conditional } from "./g07";
import { g08NotDone } from "./g08";
import { g09NotDone } from "./g09";
import { g10NotDone } from "./g10";
import { g12NotDone } from "./g12";
import type { GenericAbout, GenericClaim, GenericResult, RecalcSummary } from "./types";

/**
 * recalc は、G02 が動いて、点数の書いてある単位があるときだけ。notDone は、していない点検（文）。g09 は、適応・併用（G09）の但し書きと、見たもの・見ていないもの（G09 が動いたときだけ。画面は、G09 の見出しの下に出す）。
 * conditional は、記載が要ることがある項目（条件区分 00。判定しない。design.md §17-1）：G07 が動いて、並べる項番か外した組があるときだけ。指摘の数・提出の判定には入れない
 */
export type GenericScope = { recalc?: RecalcSummary; recalcNotes?: string[]; notDone: string[]; g09?: string[]; conditional?: Conditional };

export function genericScopeOf(claim: GenericClaim, masters: MastersDb | null, about: GenericAbout, result: GenericResult): GenericScope {
  const out: GenericScope = { notDone: [] };
  const ran = (id: string) => result.ran.some((r) => r.check === id);
  if (masters !== null && ran("G02")) {
    const list = recalcClaim(claim, masters, about);
    if (Array.isArray(list) && list.length > 0) {
      out.recalc = recalcSummary(list);
      out.recalcNotes = recalcNotesOf(about);
    }
    else out.notDone.push("点数の検算は、点数の書いてある単位（取り込んだレセプトの単位）にだけ掛けます。ここの行には点数が書いていないので、検算していません");
  }
  if (ran("G03")) out.notDone.push(...g03NotDone(about), ...(masters !== null && !hasShisetsuGroups(masters) ? [OLD_SHISETSU_G03_REASON] : []));
  // 背反の特例条件の例外に当たるので出していない組（design.md §13-2 の 2。消えたことが分かるように、数と例外の id を出す）
  if ((result.silenced ?? []).length > 0) out.notDone.push(`特例の例外に当たるので出していない：${result.silenced!.reduce((s, x) => s + x.count, 0)} 件（${result.silenced!.map((x) => x.hx).join("・")}）`);
  // 院内の知識で「この請求も条件に当たる」と押したので出していない組と日（design.md §14-3。数と知識の id）
  if ((result.localSilenced ?? []).length > 0) out.notDone.push(`${LOCAL_PAIR_TEXT.silenced}：${result.localSilenced!.reduce((s, x) => s + x.count, 0)} 件（${result.localSilenced!.map((x) => x.id).join("・")}）`);
  // G04〜G06 の断り（作っていない単位・数え方）。画面の部品が別に足していたのをここに寄せ、月末の点検・算定プレビューの 1 行の表示でも出す（round-32 O-19）
  for (const r of result.ran) if (GENERIC_SCOPE_NOTE[r.check]) out.notDone.push(`${r.check}（${r.kind}）が点検していないこと：${GENERIC_SCOPE_NOTE[r.check]}`);
  if (masters !== null && ran("G07") && result.g07FormOnly !== undefined) out.notDone.push(formOnlyNote(result.g07FormOnly));
  else if (masters !== null && ran("G07")) {
    out.notDone.push(...g07NotDone(claim, masters, about));
    const c = conditionalOf(claim, masters, about);
    if (c !== null && c.items.length + c.hidden.r17 + c.hidden.present > 0) out.conditional = c;
  }
  if (masters !== null && ran("G08")) out.notDone.push(...g08NotDone(masters, about));
  if (masters !== null && ran("G09")) out.g09 = g09NotDone(claim, masters, about);
  if (masters !== null && ran("G10")) out.notDone.push(...g10NotDone(claim, masters, about));
  if (masters !== null && ran("G12")) out.notDone.push(...g12NotDone(claim, masters, about));
  return out;
}

/**
 * C〜I の手順に回した区分（在宅医療充実体制加算・在宅療養実績加算・在宅療養移行加算・注8 の減算。版の定数 deferred）と、注8 の減算の対象になる管理料（在支診以外〔種別 3〕の管理料）の行の数を、
 * 点検の範囲に出す文（design.md §15-4。L-92）。算定の要件と取り忘れは見ていない（黙って通さない）。行がなければ null。
 * 届出の有無は G10 が見ている（design.md §15-4）
 */
export function deferredNote(lines: ClaimLine[], rev: Revision): string | null {
  const deferred = new Set([...(rev.consts.deferred ?? []), ...rev.consts.kanri.rows.filter((r) => r.grade === "3").map((r) => r.kubun)]);
  const n = lines.filter((l) => l.count > 0 && deferred.has(l.kubun)).length;
  return n > 0 ? `在宅医療充実体制加算・在宅療養実績加算・在宅療養移行加算・注8 の減算の算定の要件と取り忘れは見ていません（届出の有無だけ G10 が見ています）：${n} 行` : null;
}

/** 情報通信機器を用いた診療に係る基準（EM §2-11 表 4。3825） */
const ICT_KIJUN = "3825";

/**
 * 単一建物の人数の次元で、点検の範囲に出す文（design.md §15-4。段 17f）：
 * 戸数によるみなしのコメントで 1 人と読んだ在医総管の行（R19 が何も言わない行。V-3）と、情報通信機器の区分（ハ・ホ）の管理料の行（対象外の単位のまま見ていない。L-110）。
 * 情報通信機器の区分は版の区分になく EM にコードを持たないので、基本マスターの行（在医総管・施医総管の区分番号で、施設基準の組に 3825 を持つもの）で数える。マスターがなければ数えない
 */
export function buildingScopeNotes(ctx: ClaimContext, rev: Revision, claim: GenericClaim | null, db: MastersDb | null, about: GenericAbout | null): string[] {
  const out: string[] = [];
  const minashi = minashiOneLines(ctx, rev.consts).length;
  if (minashi > 0) out.push(`みなしのコメントで 1 人と読んだ行：${minashi} 行`);
  if (claim && db && about) {
    const snap = pickSnapshot(db, "shinryo", about.yearMonth, about.generation)?.snapshot;
    if (snap) {
      const ict = (code: string) => {
        const r = shinryoOf(db, snap, code);
        return !!r && r.sho === 2 && r.bu === 2 && r.kubun_no === 2 && (r.eda === 0 || r.eda === 2) && [r.shisetsu_g1, r.shisetsu_g2, r.shisetsu_g3].some((g) => (g ?? "").split("/").includes(ICT_KIJUN));
      };
      const n = claim.units.filter((u) => u.items.some((it) => it.kind === "SI" && ict(it.code))).length;
      if (n > 0) out.push(`情報通信機器の区分は見ていません：${n} 行`);
    }
  }
  return out;
}
