// 取り忘れ（G11。design.md §15-8・§15-9 の B の欄）を、取り込んだ請求の点検・月末の点検・算定プレビューから呼ぶ入口。読むだけで、何も記録しない
// （区分誤りの出る前に選んだ対応は、消さずに読むときに外す。src/server/app/notes.ts の aliasOf。反証 round-55 C-293）。判定は src/generic/g11.ts の決まった規則だけで、LLM は使わない。
// 行ったことは、取り込んだ請求では貼って確かめたカルテ（kind「記録」）、合成の症例では合成カルテの確かめたあとの acts と、本人が確かめたカルテの acts
import { readFileSync } from "node:fs";
import type { ChartAct, RxChoice, RxNote, StoredActs } from "../../chart/acts";
import { rxDefault } from "../../chart/rx-default";
import type { Revision } from "../../engine/revisions/types";
import type { ClaimContext, Finding } from "../../engine/types";
import { dispensingOf } from "../../facility/declaration";
import { readDeclarations } from "../../facility/seed";
import { evaluateG11, type ConfirmedAct, type G11Claim, type G11Result, type RxDay } from "../../generic/g11";
import { r18SameFamily, rulesStep3 } from "../../generic/g11-rules";
import { sidelessOf } from "../../generic/g10";
import { withMasters } from "../../masters/db";
import { chartFileOf } from "./case-files";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import { declarationViewOf, todayOf } from "./facility";

/** 画面と応答の B の欄：G11 の結果と、取り込んだ請求では「カルテを貼った患者だけを見ています」の 1 行（L-122） */
export type Torikawasure = G11Result & { coverage?: string };

type Entry = { date: string; acts?: ChartAct[]; rxNotes?: RxNote[]; rxChoice?: RxChoice | null };

/** 保存した行ったこと（日ごと）を、G11 の入力にする。noteId はカルテの id（合成カルテは日の並びの番号）。stored は保存したカルテ（行為の位置を添え、当てられない行為をあとから選べる。X-157） */
export function actsInput(days: { date: string; noteId: number; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null; stored?: boolean }[]): { acts: ConfirmedAct[]; rxDays: RxDay[] } {
  return {
    acts: days.flatMap((d) => d.acts.map((act, index) => ({ date: d.date, noteId: d.noteId, ...(d.stored ? { index } : {}), act }))),
    rxDays: days.map((d) => ({ date: d.date, rx: d.rx.length > 0, choice: d.rxChoice ?? (d.rx.length > 0 ? rxDefault(d.rx) : null) })),
  };
}

export function createTorikawasure(ctx: Pick<AppContext, "sqlite" | "paths">, clock: Pick<Clock, "now">) {
  /** 合成の症例の、合成カルテの確かめたあとの行ったこと（合成カルテのない症例・acts を持たない合成カルテは空） */
  function chartDays(claimId: string): { date: string; noteId: number; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null; stored?: boolean }[] {
    const f = chartFileOf(ctx.paths.root, claimId);
    if (!f) return [];
    const entries = (JSON.parse(readFileSync(f, "utf8")) as { entries: Entry[] }).entries;
    return entries.flatMap((e, i) => (e.acts ? [{ date: e.date, noteId: i + 1, acts: e.acts, rx: e.rxNotes ?? [], rxChoice: e.rxChoice ?? null }] : []));
  }
  /** 確かめたカルテ（id・日・保存した行ったこと）を、日ごとの形にする */
  const storedDays = (notes: { id: number; date: string; acts: StoredActs | null | undefined }[]) =>
    notes.flatMap((n) => (n.acts ? [{ date: n.date, noteId: n.id, acts: n.acts.acts, rx: n.acts.rx, rxChoice: n.acts.rxChoice, stored: true }] : []));

  /**
   * G11 を掛ける。claim は突き合わせる請求（取り込んだ請求は UKE の単位、算定プレビュー・月末の点検は claimOfLines の単位）、base は元の請求の文脈（手順 3 と同じ族の例外が使う）、
   * hand は元の請求の手書きのルールの結果（R ルールと 2 回言わない）
   */
  function run(input: { claim: G11Claim; base: ClaimContext; rev: Revision; path: "uke" | "preview"; days: Parameters<typeof actsInput>[0]; hand: Finding[] }): G11Result {
    const { acts, rxDays } = actsInput(input.days);
    const ym = input.base.yearMonth;
    const declaration = declarationViewOf(ctx, clock);
    const dispensing = dispensingOf(readDeclarations(ctx.sqlite), todayOf(clock), ym);
    return withMasters((db) =>
      evaluateG11(
        input.claim,
        db,
        { yearMonth: ym, generation: input.rev.generation, acts, rxDays, path: input.path, dispensing, declaration, sideless: sidelessOf(input.rev), outpatient: true },
        input.rev,
        { step3: rulesStep3(input.base, input.rev, db, input.path === "uke"), sameFamily: r18SameFamily(input.base, input.rev, db), hand: input.hand },
      ),
    );
  }
  return { chartDays, storedDays, run };
}

export type TorikawasureOps = ReturnType<typeof createTorikawasure>;
