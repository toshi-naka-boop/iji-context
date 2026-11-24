// 包括の検査の三段（design.md §19-4 の 1・§19-10 完了条件 3）を、実データの masters.db の点数で確かめる。点数はマスターと EM・版の点数表から引いて組み、テストに書かない。
// データは同梱しないので、RESEMEN_MASTER_DIR があるときだけ動く。
// D008 の群はまだ版に入れていない（BNP が codes の D008_19 と重なる。v44 の実装で止めた点）ので、D008 の組は EM の一覧と段の点数で作った群を recalcUnit に渡して確かめる
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { CERTAIN, evaluateGeneric } from "../../src/generic";
import { g02, recalcClaim } from "../../src/generic/g02";
import { recalcUnit, type RecalcBundle, type RecalcItem } from "../../src/generic/points";
import type { GenericAboutMore, GenericClaim, GenericFinding, GenericUnitDetail } from "../../src/generic/types";
import { openMasters, pickSnapshot, shinryoOf } from "../../src/masters/db";
import { genericText } from "../../src/messages";
import { YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
const rev = resolveRevision(YM);
const about: GenericAboutMore = { yearMonth: YM, generation: rev.generation, outpatient: true, birth: "19500615", clinic: true };

const em = readFileSync(path.join(root, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
const emGroup = (name: string): string[] => {
  const line = em.split("\n").find((l) => l.startsWith(`- ${name} `) && l.includes("の包括の項目"))!;
  return line.slice(line.lastIndexOf("：") + 1).split("・");
};
const emTier = (kubun: string): number => Number(em.split("\n").find((l) => l.startsWith(`| ${kubun} |`))!.split("|")[3].trim().replaceAll(",", ""));

// コード（名前は EM §2-15 表 1-2 と §2-8）
const FT3 = "160033210";
const FT4 = "160033310";
const CORTISOL = "160034010";
const ALDO_URINE = "160136550";
const CATECHOL = "160033510";
const ACTH = "160035610";
const TESTO = "160033910";
const TBC = "160031410";
const PROGE = "160034710";
const GASTRIN = "160032010";
const ADH = "160035910";
const ANP = "160116310";
const IGFBP3 = "160163350";
const NORMETA = "160115910";
const PREGNANTRIOL = "160034910";
const D008_MORE = ["160032910", "160033010", "160149910", "160034110", "160033610", "160034210", "160032610", "160032510", "160034310", "160192910"]; // 号 12〜19 の名前に検体のない行
const D007_TEN = ["160017410", "160019010", "160019210", "160019310", "160019410", "160020410", "160021110", "160021410", "160022510", "160022610"]; // EM 5-1 の K1 の 10 項目
const D007_K = "160021410";
const D007_CR = "160019210";
const BUN_URINE = "160131950";
const D013_FIVE = ["160049210", "160049510", "160050010", "160050110", "160118510"];
const HOUMON = rev.codes.C001_1I.primary;

describe("包括の検査の三段（段 22b。完了条件 3）", () => {
  const ctx = () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, rev.generation)!.snapshot;
    const p = (code: string) => shinryoOf(db, snap, code)!.points;
    const raw = (codes: string[]) => codes.reduce((s, c) => s + p(c), 0);
    const version: RecalcBundle[] = rev.bundles.map((b) => ({ name: b.tiers[0].kubun.split("_")[0], members: b.members, tiers: b.tiers.map((t) => ({ min: t.min, points: rev.points[t.kubun].points! })), bloodOnly: b.bloodOnly === true }));
    const d008: RecalcBundle = { name: "D008", members: emGroup("D008"), tiers: [{ min: 3, points: emTier("D008_3") }, { min: 6, points: emTier("D008_6") }, { min: 8, points: emTier("D008_8") }] };
    const bundles = [...version, d008];
    const si = (c: string): RecalcItem => ({ kind: "SI", code: c, quantity: "" });
    const tier = (codes: string[], uke: number) => {
      const r = recalcUnit(db, { SI: snap, IY: null, TO: null }, codes.map(si), { shikibetsu: "60", shikibetsuSure: true, bundles, uke });
      if (!("tier" in r) || !r.tier) throw new Error(`三段にならない: ${JSON.stringify(r)}`);
      return { base: r.points, ...r.tier };
    };
    const claim = (...units: { codes: string[]; points: number; day?: number }[]): GenericClaim => {
      let line = 10;
      const out: GenericUnitDetail[] = units.map((u) => ({ points: u.points, count: 1, days: Array.from({ length: 31 }, (_, d) => (d === (u.day ?? 1) - 1 ? 1 : 0)), items: u.codes.map((c, i) => ({ kind: "SI" as const, code: c, line: line++, shikibetsu: i === 0 ? "60" : "", quantity: "" })) }));
      return { units: out };
    };
    return { db, p, raw, tier, claim, version };
  };
  const table = (prefix: string, n: number) => (prefix === "D008" ? [3, 6, 8].filter((m) => m <= n).map((m) => emTier(`D008_${m}`)).at(-1)! : rev.bundles.flatMap((b) => b.tiers).filter((t) => t.kubun.startsWith(prefix) && t.min <= n).map((t) => rev.points[t.kubun].points!).at(-1)!);
  /** G02 の指摘を、言い切らない文で */
  const texts = (found: ReturnType<typeof g02.run>) => (Array.isArray(found) ? found.map((f: GenericFinding) => genericText({ ...f, certainty: "条件つき" })) : []);

  it.skipIf(!has)("表の値で合っている請求（D008 の 3・6・8 項目、D013 の 3・4・5 項目）は (1) で何も出ない", () => {
    const { tier, claim, db } = ctx();
    const d008 = [FT3, FT4, CORTISOL, ...D008_MORE];
    for (const n of [3, 6, 8]) expect(tier(d008.slice(0, n), table("D008", n)).stage, `D008 ${n}`).toBe(1);
    for (const n of [3, 4, 5]) {
      const c = claim({ codes: D013_FIVE.slice(0, n), points: table("D013", n) });
      expect(recalcClaim(c, db, about), `D013 ${n}`).toMatchObject([{ status: "match" }]);
      expect(g02.run(c, db, about)).toEqual([]);
    }
  });

  it.skipIf(!has)("尿の項目が混ざる正しい請求：表の値なら (1)。素の合算なら全部外しで (2)、外と読んだ行に（尿）は出ない", () => {
    const { tier, raw } = ctx();
    const codes = [FT4, CORTISOL, ALDO_URINE];
    expect(tier(codes, table("D008", 3)).stage).toBe(1);
    const r = tier(codes, raw(codes));
    expect(r).toMatchObject({ stage: 2, read: [FT4, CORTISOL] });
  });

  it.skipIf(!has)("名前に検体のない行を表の外と読む請求：(2) が 1 件、文に両方の読みとカテコールアミンの行が出る", () => {
    const { tier, p } = ctx();
    const base = table("D008", 4);
    const r = tier([FT3, FT4, CORTISOL, CATECHOL], table("D008", 3) + p(CATECHOL));
    expect(r).toMatchObject({ stage: 2, read: [CATECHOL], more: false, base });
    const text = genericText({ certainty: "条件つき", messageKey: "G02.bundle_read", params: { base: String(base), uke: "", read: CATECHOL, more: "", lower: "", later: "" } });
    expect(text).toContain(`同じ日の検体（尿なども含む）を合わせれば ${base} 点です`);
    expect(text).toContain("2 回目以降の採血の項目があれば、今の点数");
    expect(text).toContain(CATECHOL);
  });

  it.skipIf(!has)("示す組の順：同じ点数の行が 2 つあれば、区分番号・号・コードの昇順の最初の組を示し、ほかの読みもあると添える", () => {
    const { tier, p } = ctx();
    expect(p(CATECHOL)).toBe(p(ACTH));
    // 並びを変えても同じ組
    for (const codes of [[FT3, FT4, CATECHOL, ACTH], [ACTH, CATECHOL, FT4, FT3]]) expect(tier(codes, table("D008", 3) + p(CATECHOL))).toMatchObject({ stage: 2, read: [CATECHOL], more: true });
  });

  it.skipIf(!has)("同じ日に 2 回採血した正しい請求：(2) が 1 件で、2 回目の 2 行が外と読んだ行に出る", () => {
    const { tier, raw } = ctx();
    const r = tier([TESTO, FT3, CORTISOL, TBC, PROGE], table("D008", 3) + raw([TBC, PROGE]));
    expect(r).toMatchObject({ stage: 2, read: [TBC, PROGE] });
  });

  it.skipIf(!has)("素の合算で多く請求した誤り：(2)（素に合う）。素の合算から 1 点ずらすと (3)", () => {
    const { tier, raw } = ctx();
    const codes = [GASTRIN, ADH, ANP];
    expect(raw(codes)).toBeGreaterThan(table("D008", 3));
    // 全部外し（外の候補は号の昇順）
    expect(tier(codes, raw(codes))).toMatchObject({ stage: 2, read: [ANP, ADH, GASTRIN] });
    expect(tier(codes, raw(codes) - 1).stage).toBe(3);
  });

  it.skipIf(!has)("D007：表の値の 10 項目は (1)。2 回目の K・Cr を素で足した正しい請求は (2) で、確定の不一致は出ない。（尿）の行は項目数に入る", () => {
    const { claim, db, p, raw } = ctx();
    const ten = table("D007", 10);
    expect(recalcClaim(claim({ codes: D007_TEN, points: ten }), db, about)).toMatchObject([{ status: "match" }]);
    const twice = claim({ codes: [...D007_TEN, D007_K, D007_CR], points: ten + raw([D007_K, D007_CR]) });
    expect(recalcClaim(twice, db, about)).toMatchObject([{ status: "bundleRead" }]);
    const found = g02.run(twice, db, about);
    expect(Array.isArray(found) && found.map((f) => [f.messageKey, f.certainty])).toEqual([["G02.bundle_read", "条件つき"]]);
    expect(texts(found)[0]).toContain(`同じ日の検体（尿なども含む）を合わせれば ${table("D007", 12)} 点です`);
    // （尿）の行を項目数に入れて表の値で書いた単位
    const withUrine = [...D007_TEN.slice(0, 9), BUN_URINE];
    expect(recalcClaim(claim({ codes: withUrine, points: ten }), db, about)).toMatchObject([{ status: "match" }]);
    // （尿）の行だけを素で足した単位：(2) か (3) で、（尿）の行は外と読んだ行に出ない
    const r = recalcClaim(claim({ codes: [...D007_TEN, BUN_URINE], points: ten + p(BUN_URINE) }), db, about) as { status: string; read?: string[] }[];
    expect(["bundleRead", "bundleNone"]).toContain(r[0].status);
    expect(r[0].read ?? []).not.toContain(BUN_URINE);
  });

  it.skipIf(!has)("D013：5 項目のうち 2 項目を素で足した単位は (2) で、文に血液でない検体の読みも並ぶ", () => {
    const { claim, db, raw } = ctx();
    const c = claim({ codes: D013_FIVE, points: table("D013", 3) + raw(D013_FIVE.slice(3)) });
    const list = recalcClaim(c, db, about);
    expect(list).toMatchObject([{ status: "bundleRead", bloodOnly: true }]);
    const t = texts(g02.run(c, db, about));
    expect(t).toHaveLength(1);
    expect(t[0]).toContain(`全部が 1 回の採血の血液なら ${table("D013", 5)} 点です`);
    expect(t[0]).toContain("血液でない検体の項目があれば");
  });

  it.skipIf(!has)("k ＝ 4 が要る組は (3)。n ＝ 13 の単位では一部外しを試さない（n ＝ 12 なら (2)）", () => {
    const { tier, raw } = ctx();
    const second = [GASTRIN, IGFBP3, NORMETA, PREGNANTRIOL];
    expect(tier([FT3, FT4, CORTISOL, ...second], table("D008", 3) + raw(second)).stage).toBe(3);
    const twelve = [FT3, FT4, CORTISOL, ...D008_MORE.slice(0, 9)];
    const extra = twelve.slice(-2);
    expect(tier(twelve, table("D008", 10) + raw(extra)).stage).toBe(2);
    const thirteen = [FT3, FT4, CORTISOL, ...D008_MORE];
    expect(tier(thirteen, table("D008", 10) + raw(thirteen.slice(-3))).stage).toBe(3);
    expect(tier(thirteen.slice(0, 12), table("D008", 9) + raw(thirteen.slice(9, 12))).stage).toBe(2);
  });

  it.skipIf(!has)("ほかの行と同じ単位なら bundleMixed、同じ日の 2 単位なら bundleSplit。三段の指摘は確定の一覧に入らない", () => {
    const { claim, db, raw } = ctx();
    expect(recalcClaim(claim({ codes: [...D007_TEN, HOUMON], points: 1 }), db, about)).toMatchObject([{ status: "excluded", reason: "bundleMixed" }]);
    expect(recalcClaim(claim({ codes: D007_TEN.slice(0, 5), points: 1 }, { codes: D007_TEN.slice(5), points: 1 }), db, about)).toMatchObject([
      { status: "excluded", reason: "bundleSplit" },
      { status: "excluded", reason: "bundleSplit" },
    ]);
    const c = claim({ codes: D013_FIVE, points: table("D013", 3) + raw(D013_FIVE.slice(3)) }, { codes: D007_TEN, points: table("D007", 10) + 1, day: 2 });
    const all = evaluateGeneric(c, db, about, undefined, new Set([...CERTAIN, "G02.points"])).findings.filter((f) => f.check === "G02");
    expect(all.map((f) => [f.messageKey, f.certainty])).toEqual([
      ["G02.bundle_read_blood", "条件つき"],
      ["G02.bundle_none", "条件つき"],
    ]);
  });
});
