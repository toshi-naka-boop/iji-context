// テスト用：取り忘れ（G11）の入力を、同梱の合成データ（fixtures/charts/K8〜K11.json と -abbrev、fixtures/uke/torikawasure.UKE）から作る。
// カルテは本人が確かめたあとの形の acts を持つので、LLM は通さない
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChartAct, RxChoice, RxNote } from "../../src/chart/acts";
import { rxDefault } from "../../src/chart/rx-default";
import { resolveRevision } from "../../src/engine/revisions";
import { declarationView, type DeclarationRow, type DeclarationView } from "../../src/facility/declaration";
import { demoSeedRows, seedDates } from "../../src/facility/seed";
import type { ConfirmedAct, Dispensing, G11About, G11Claim, RxDay } from "../../src/generic/g11";
import { parseUke } from "../../src/uke/uke";
import type { UkeClaim } from "../../src/uke/types";

export const repo = path.join(__dirname, "..", "..");
export const YM = "2026-10";
export const rev = resolveRevision(YM);
export const G11_CASES = ["K8", "K9", "K10", "K11"] as const;

type Entry = { date: string; acts: ChartAct[]; rxNotes: RxNote[]; rxChoice: RxChoice | null };
/** 合成カルテ（abbrev＝略した書き方の合成カルテ） */
export const chartOf = (k: string, abbrev = false): { entries: Entry[] } => JSON.parse(readFileSync(path.join(repo, "fixtures", "charts", `${k}${abbrev ? "-abbrev" : ""}.json`), "utf8"));

/** カルテの確かめたあとの acts と、日ごとの処方の記載・院内外（本人が選んでいなければ初期値の規則） */
export function actsOf(k: string, abbrev = false): { acts: ConfirmedAct[]; rxDays: RxDay[] } {
  const entries = chartOf(k, abbrev).entries;
  return {
    acts: entries.flatMap((e, i) => e.acts.map((act) => ({ date: e.date, noteId: i + 1, act }))),
    rxDays: entries.map((e) => ({ date: e.date, rx: e.rxNotes.length > 0, choice: e.rxChoice ?? (e.rxNotes.length > 0 ? rxDefault(e.rxNotes) : null) })),
  };
}

/** torikawasure.UKE の K8〜K11 の請求（カルテ番号等の欄が症例の番号） */
export function ukeClaimOf(k: string): UkeClaim {
  const parsed = parseUke(readFileSync(path.join(repo, "fixtures", "uke", "torikawasure.UKE")));
  const c = parsed.claims.find((x) => x.patientNo === k);
  if (!c) throw new Error(`torikawasure.UKE に ${k} がない`);
  return c;
}

/** デモのクリニックの申告（種） */
export const demoDeclaration = (): DeclarationView => declarationView(demoSeedRows().map((d, i): DeclarationRow => ({ ...d, id: i + 1, createdAt: "" })), seedDates().checkedOn);
/** どのコードも分からない申告（申告が空の実在用のクリニック） */
export const emptyDeclaration = (): DeclarationView => declarationView([], seedDates().checkedOn);

export function aboutOf(k: string, opt: { abbrev?: boolean; dispensing?: Dispensing; path?: "uke" | "preview"; declaration?: DeclarationView } = {}): G11About {
  const { acts, rxDays } = actsOf(k, opt.abbrev);
  return { yearMonth: YM, generation: rev.generation, acts, rxDays, path: opt.path ?? "uke", dispensing: opt.dispensing ?? "inside", declaration: opt.declaration ?? demoDeclaration(), outpatient: true };
}

/** 請求から、そのコードの行（単位の中の行）を外す。単位の行がなくなれば単位ごと外す。day を渡すとその日の分だけ（回数を 1 減らす） */
export function without(claim: G11Claim, code: string, day?: number): G11Claim {
  return {
    units: claim.units.flatMap((u) => {
      if (!u.items.some((it) => it.code === code)) return [u];
      if (day !== undefined && u.days && (u.days[day - 1] ?? 0) > 0 && u.days.filter((n) => n > 0).length > 1) {
        // その日の分だけを別の単位に分けて外す
        const rest = u.days.map((n, i) => (i === day - 1 ? 0 : n));
        const items = u.items.filter((it) => it.code !== code);
        const on = u.days.map((n, i) => (i === day - 1 ? n : 0));
        return [{ ...u, days: rest, count: rest.reduce((s, n) => s + n, 0) }, ...(items.length > 0 ? [{ ...u, items, days: on, count: on.reduce((s, n) => s + n, 0) }] : [])];
      }
      const items = u.items.filter((it) => it.code !== code);
      return items.length > 0 ? [{ ...u, items }] : [];
    }),
  };
}
