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
import { evaluateG11, type ConfirmedAct, type G11Claim, type G11Devices, type G11Result, type G11Structured, type RxDay } from "../../generic/g11";
import { rxConfirmedOf } from "../../structured/rx-mark";
import { r18SameFamily, rulesStep3 } from "../../generic/g11-rules";
import { sidelessOf } from "../../generic/g10";
import { withMasters, type MastersDb } from "../../masters/db";
import type { StructuredChart } from "../../connect/types";
import { withStructured } from "../../structured/g11-input";
import type { SItem } from "../../structured/overlap";
import { chartFileOf } from "./case-files";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import { declarationViewOf, todayOf } from "./facility";

/** 画面と応答の B の欄：G11 の結果と、取り込んだ請求では「カルテを貼った患者だけを見ています」の 1 行（L-122） */
export type Torikawasure = G11Result & { coverage?: string };

type Entry = { date: string; acts?: ChartAct[]; rxNotes?: RxNote[]; rxChoice?: RxChoice | null };

/** 保存した行ったこと（日ごと）を、G11 の入力にする。noteId はカルテの id（合成カルテは日の並びの番号）。stored は保存したカルテ（行為の位置を添え、当てられない行為をあとから選べる。X-157） */
export function actsInput(days: { date: string; noteId: number; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null; stored?: boolean; confirmed?: boolean }[]): { acts: ConfirmedAct[]; rxDays: RxDay[] } {
  return {
    acts: days.flatMap((d) => d.acts.map((act, index) => ({ date: d.date, noteId: d.noteId, ...(d.stored ? { index } : {}), act }))),
    rxDays: days.map((d) => ({ date: d.date, rx: d.rx.length > 0, choice: d.rxChoice ?? (d.rx.length > 0 ? rxDefault(d.rx) : null), ...(d.confirmed ? { confirmed: true } : {}) })),
  };
}

/**
 * 請求の患者・診療年月の、残した構造化データと当てたコードつきの行為（src/server/app/structured.ts。ないときは null）。
 * 規則の候補（design.md §16-4）に使う、さかのぼる月の処方のオーダーと医療事務が入れた時刻も持つ
 */
export type StructuredOfClaim = (claimId: string, yearMonth: string, db: MastersDb | null) => ({ chart: StructuredChart; items: SItem[] } & Partial<Omit<G11Structured, "chart" | "items" | "texts">>) | null;
/** カルテの文章のある日（確かめたかは問わない）。stored は確かめて残した行ったこと（確かめていなければ null） */
export type TextDay = { date: string; text: string; soap: string; stored: StoredActs | null; rxChoice?: RxChoice | null };

/** 構造化データのない請求の、患者の機器（機器を確かめた患者だけ。ないときは null。C-440） */
export type DevicesOfClaim = (claimId: string, yearMonth: string) => G11Devices | null;

export function createTorikawasure(ctx: Pick<AppContext, "sqlite" | "paths">, clock: Pick<Clock, "now">, structuredOf?: StructuredOfClaim, devicesOf?: DevicesOfClaim) {
  /** 合成の症例の、合成カルテの確かめたあとの行ったこと（合成カルテのない症例・acts を持たない合成カルテは空） */
  function chartDays(claimId: string): { date: string; noteId: number; acts: ChartAct[]; rx: RxNote[]; rxChoice: RxChoice | null; stored?: boolean }[] {
    const f = chartFileOf(ctx.paths.root, claimId);
    if (!f) return [];
    const entries = (JSON.parse(readFileSync(f, "utf8")) as { entries: Entry[] }).entries;
    return entries.flatMap((e, i) => (e.acts ? [{ date: e.date, noteId: i + 1, acts: e.acts, rx: e.rxNotes ?? [], rxChoice: e.rxChoice ?? null }] : []));
  }
  /** 確かめたカルテ（id・日・保存した行ったこと）を、日ごとの形にする */
  const storedDays = (notes: { id: number; date: string; acts: StoredActs | null | undefined }[]) =>
    notes.flatMap((n) => (n.acts ? [{ date: n.date, noteId: n.id, acts: n.acts.acts, rx: n.acts.rx, rxChoice: n.acts.rxChoice, stored: true, confirmed: rxConfirmedOf(n.acts) }] : []));
  /** 合成の症例の、合成カルテの文（確かめたあとの acts を持つ日は確かめたものとして扱う） */
  function chartTextDays(claimId: string): TextDay[] {
    const f = chartFileOf(ctx.paths.root, claimId);
    if (!f) return [];
    const entries = (JSON.parse(readFileSync(f, "utf8")) as { entries: (Entry & { s?: string; o?: string; a?: string; p?: string; rx?: string })[] }).entries;
    return entries.map((e) => ({ date: e.date, text: [e.s, e.o, e.a, e.p, e.rx].filter(Boolean).join("\n"), soap: [e.s, e.o, e.a, e.p].filter(Boolean).join("\n"), stored: e.acts ? { acts: e.acts, rx: e.rxNotes ?? [], rxChoice: e.rxChoice ?? null, rxChoiceBy: null } : null }));
  }

  /**
   * G11 を掛ける。claim は突き合わせる請求（取り込んだ請求は UKE の単位、算定プレビュー・月末の点検は claimOfLines の単位）、base は元の請求の文脈（手順 3 と同じ族の例外が使う）、
   * hand は元の請求の手書きのルールの結果（R ルールと 2 回言わない）
   */
  function run(input: { claim: G11Claim; base: ClaimContext; rev: Revision; path: "uke" | "preview"; days: Parameters<typeof actsInput>[0]; hand: Finding[]; texts?: TextDay[]; pastTextsUnreadable?: boolean }): G11Result {
    const { acts, rxDays } = actsInput(input.days);
    const ym = input.base.yearMonth;
    const declaration = declarationViewOf(ctx, clock);
    const dispensing = dispensingOf(readDeclarations(ctx.sqlite), todayOf(clock), ym);
    return withMasters((db) => {
      // 構造化データがあれば、文章の行為と突き合わせてから G11 に渡す（design.md §16-3。段 19b）
      const s = structuredOf?.(input.base.claimId, ym, db) ?? null;
      const joined = s ? withStructured(acts, s, input.rev) : { acts, scope: [] };
      // 規則の候補（design.md §16-4）：残した構造化データがある請求だけ。カルテの文章は確かめたかを問わずに渡す
      const rxCodes = new Set([input.rev.consts.rx.many, input.rev.consts.rx.other].flatMap((k) => (Object.hasOwn(input.rev.codes, k) ? [input.rev.codes[k].primary, ...input.rev.codes[k].accept] : [])));
      const structured: G11Structured | undefined = s
        ? {
            chart: s.chart,
            items: s.items,
            history: s.history ?? [],
            lookbackMonths: s.lookbackMonths ?? 0,
            times: s.times ?? [],
            ...(input.pastTextsUnreadable ? { pastTextsUnreadable: true } : {}),
            ...(s.devices ? { devices: s.devices } : {}),
            texts: (input.texts ?? []).map((t) => ({
              date: t.date,
              text: t.text,
              soap: t.soap,
              confirmed: t.stored !== null,
              choice: t.stored ? (t.stored.rxChoice ?? (t.stored.rx.length > 0 ? rxDefault(t.stored.rx) : null)) : null,
              rxAct: !!t.stored?.acts.some((a) => a.match && rxCodes.has(a.match.code)),
            })),
          }
        : undefined;
      const devices = s ? null : (devicesOf?.(input.base.claimId, ym) ?? null);
      const r = evaluateG11(
        input.claim,
        db,
        { yearMonth: ym, generation: input.rev.generation, acts: joined.acts, rxDays, path: input.path, dispensing, declaration, sideless: sidelessOf(input.rev), outpatient: true, ...(structured ? { structured } : {}), ...(devices ? { devices } : {}) },
        input.rev,
        { step3: rulesStep3(input.base, input.rev, db, input.path === "uke"), sameFamily: r18SameFamily(input.base, input.rev, db), hand: input.hand },
      );
      return "skip" in r || joined.scope.length === 0 ? r : { ...r, scope: [...r.scope, ...joined.scope] };
    });
  }
  return { chartDays, storedDays, chartTextDays, run };
}

export type TorikawasureOps = ReturnType<typeof createTorikawasure>;
