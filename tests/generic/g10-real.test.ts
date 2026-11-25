// 実データ（masters.db）で確かめる、段 17e の完了条件（design.md §15-5・§15-10）：G10 の読み違いの検査と、デモのクリニックの申告での数。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）。
// 段の報告に出す数（jitsurei.UKE の G10 の数、正しい側が「ちょうど 1 行」になった組の数と標本 30 組）は、console.log に出す
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import facilityConfig from "../../config/facility.json";
import { resolveRevision } from "../../src/engine/revisions";
import { declarationView, type DeclarationRow, type DeclarationView, type Tri } from "../../src/facility/declaration";
import { demoSeedRows, seedDates } from "../../src/facility/seed";
import { g10, groupsOf, sidelessOf } from "../../src/generic/g10";
import { claimOfLines } from "../../src/generic/overlap";
import type { GenericAbout, GenericClaim } from "../../src/generic/types";
import { openMasters, pickSnapshot, type ShinryoRow } from "../../src/masters/db";
import { openApp, type AppPaths } from "../../src/server/app";
import { loadCase } from "../engine/helpers";
import { claimId, YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const repo = path.join(__dirname, "..", "..");
let skipped = 0;
const withData = (name: string, fn: () => void | Promise<void>) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn);
};

const rev = resolveRevision(YM);
const CASES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
/** どのコードも同じ三値を返す申告（読み違いの検査。§12-6 の広く掛ける検査と同じ考え） */
const every = (t: Tri): DeclarationView => ({ held: () => t, nameOf: () => null });
const aboutWith = (declaration: DeclarationView): GenericAbout => ({ yearMonth: YM, generation: rev.generation, declaration, sideless: sidelessOf(rev) });
/** G10 の指摘を全部（evaluateGeneric の 1 回の上限 FINDING_LIMIT を掛けずに） */
const g10Of = (claim: GenericClaim, about: GenericAbout) => {
  const db = openMasters(file)!;
  try {
    const r = g10.run(claim, db, about);
    if (!Array.isArray(r)) throw new Error(r.skip);
    return r;
  } finally {
    db.close();
  }
};

let tmp: string | null = null;
const pathsOf = (): AppPaths => {
  tmp ??= mkdtempSync(path.join(tmpdir(), "iji-g10-real-"));
  const d = path.join(tmp, "app");
  mkdirSync(d, { recursive: true });
  return { root: repo, dbFile: path.join(d, "app.db"), knowledgeDir: path.join(d, "knowledge"), skillsDir: path.join(d, "skills"), queryLogDir: path.join(d, "query-log") };
};

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (!has) process.stderr.write(`段 17e の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
});

describe("段 17e：実データの masters.db で G10", () => {
  withData("施設基準のある全コードを 1 行ずつ置き、全部を「持つ」にした申告で G10 が 0 件、全部を「持たない」にすると注14 の行を除く全部の行に出る", () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, rev.generation)!.snapshot;
    const rows = db.prepare("SELECT * FROM shinryo WHERE snapshot = ? AND (shisetsu_g1 != '0' OR shisetsu_g2 != '0' OR shisetsu_g3 != '0')").all(snap) as ShinryoRow[];
    db.close();
    const judged = rows.filter((r) => groupsOf(r) !== "note14");
    const claim: GenericClaim = { units: rows.map((r) => ({ items: [{ kind: "SI", code: r.code }] })) };
    expect(g10Of(claim, aboutWith(every({ v: "held" })))).toEqual([]);
    const not = g10Of(claim, { ...aboutWith(every({ v: "not", reason: "notified_no" })), sideless: new Set(rows.map((r) => r.code)) });
    expect(new Set(not.map((f) => f.codes[0]))).toEqual(new Set(judged.map((r) => r.code)));
    expect(not.every((f) => f.messageKey === "G10.not_held")).toBe(true);
    console.log(`G10 の広く掛ける検査（診療行為 ${snap}）：施設基準のある ${rows.length} コード、うち注14 の行 ${rows.length - judged.length}、全部を持たないで指摘のあるコード ${new Set(not.map((f) => f.codes[0])).size}`);
  });

  withData("デモのクリニックの申告で、K1〜K7 の取り込んだ請求と導出の行に G10 は 0 件。要る施設基準コードの和集合が種に含まれる。jitsurei.UKE の数を報告する", () => {
    const app = openApp(pathsOf(), { kind: "demo" });
    try {
      const need = new Set<string>();
      const db = openMasters(file)!;
      const snap = pickSnapshot(db, "shinryo", YM, rev.generation)!.snapshot;
      const groupCodes = (code: string) => {
        const r = db.prepare("SELECT * FROM shinryo WHERE snapshot = ? AND code = ?").get(snap, code) as ShinryoRow | undefined;
        const g = r ? groupsOf(r) : [];
        return g === "note14" ? [] : g;
      };
      for (const k of CASES) {
        const c = app.ukeCheck(claimId(k)) as unknown as { generic: { findings: { check: string; text: string }[] }; rows: { items: { code: string }[] }[] };
        expect([k, c.generic.findings.filter((f) => f.check === "G10").map((f) => f.text)]).toEqual([k, []]);
        // 導出の行（症例の行を区分からコードに直したもの）
        const derived = claimOfLines(loadCase(k).lines, rev).claim;
        for (const u of [...c.rows, ...derived.units]) for (const it of u.items) for (const g of groupCodes(it.code)) {
          // 組の中は「どれか」：種で持つコードが 1 つでもあればよい。在支病・病院の側は持たないので除く
          need.add(g.filter((x) => !["3057", "3058", "3169"].includes(x)).sort().join("/"));
        }
      }
      db.close();
      const seed = new Set([...Object.keys(facilityConfig.demoDeclaration.codes).filter((x) => facilityConfig.demoDeclaration.codes[x as keyof typeof facilityConfig.demoDeclaration.codes] !== "no"), "3168"]);
      expect([...need].filter((g) => !g.split("/").some((x) => seed.has(x)))).toEqual([]);
      console.log(`K1〜K7 の請求と導出の行が要る施設基準の組：${[...need].sort().join("、")}（種：${[...seed].sort().join("・")}）`);

      // jitsurei.UKE をデモの申告で掛けた G10 の数（報告。データはリポジトリに入れない）
      const me = app.createClerk("てすと").id;
      const ids = app.uploadUke(me, readFileSync(path.join(repo, "fixtures", "uke", "jitsurei.UKE"))).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((x) => x.claimId));
      expect(ids.length).toBeGreaterThan(0);
      const counts = new Map<string, number>();
      let n = 0;
      for (const id of ids) {
        const c = app.ukeCheck(id) as unknown as { generic?: { findings: { check: string; messageKey?: string; text: string }[]; overlap: { judged: number }; scope?: { notDone: string[] } } };
        for (const f of c.generic?.findings.filter((x) => x.check === "G10") ?? []) {
          n++;
          const key = f.text.replace(/（コード \d+）.*/, "");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const scope = c.generic?.scope?.notDone.filter((t) => t.startsWith("施設基準の要る行") || t.startsWith("注14") || t.startsWith("正しい側")) ?? [];
        console.log(`jitsurei.UKE ${id}：G10 ${c.generic?.findings.filter((x) => x.check === "G10").length ?? 0} 件、手書きのルールが判定済み ${c.generic?.overlap.judged ?? 0}、${scope.join("／")}`);
      }
      console.log(`jitsurei.UKE をデモの申告で掛けた G10：${ids.length} 件の請求で ${n} 件（${[...counts].map(([k, v]) => `${k} ${v}`).join("・")}）`);
    } finally {
      app.close();
    }
  });
  withData("施設基準のある全コードを 1 行ずつ置いても、正しい側の行は添えない（L-91。2026-11-23 に添え書きを止めた）", () => {
    const db = openMasters(file)!;
    const snap = pickSnapshot(db, "shinryo", YM, rev.generation)!.snapshot;
    const rows = db.prepare("SELECT * FROM shinryo WHERE snapshot = ? AND (shisetsu_g1 != '0' OR shisetsu_g2 != '0' OR shisetsu_g3 != '0') ORDER BY code").all(snap) as ShinryoRow[];
    db.close();
    const seed: DeclarationRow[] = demoSeedRows().map((d, i) => ({ ...d, id: i + 1, createdAt: "" }));
    const about = aboutWith(declarationView(seed, seedDates().checkedOn));
    const found = g10Of({ units: rows.map((r) => ({ items: [{ kind: "SI", code: r.code }] })) }, about);
    expect(found.filter((f) => f.params.side !== "")).toEqual([]);
  });
});
