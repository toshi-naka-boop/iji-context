// 実データ（masters.db）で確かめる、段 11 の完了条件（design.md §12-6・§12-7）：G02（点数の検算）・G03（行の属性）の、当たる側・当たらない側・広く掛ける検査と、原文の計算例。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasRevision, resolveRevision } from "../../src/engine/revisions";
import { evaluateGeneric } from "../../src/generic";
import { recalcClaim, recalcSummary } from "../../src/generic/g02";
import { recalcUnit } from "../../src/generic/points";
import type { GenericAboutMore, GenericClaim, GenericUnitDetail } from "../../src/generic/types";
import { openMasters, pickSnapshot, type IyakuhinRow, type ShinryoRow, type TokuteiRow } from "../../src/masters/db";
import { readEm, verifyMasters } from "../../src/masters/verify";
import type { UkeClaim } from "../../src/uke/types";
import { parseUke } from "../../src/uke/uke";
import { YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
let skipped = 0;
const withData = (name: string, fn: () => void, timeout?: number) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn, timeout);
};

const rev = resolveRevision(YM);
const GEN = rev.generation;
const aboutOf = (c: UkeClaim): GenericAboutMore => ({ yearMonth: c.yearMonth, generation: resolveRevision(c.yearMonth).generation, outpatient: true, birth: c.patient.birth, clinic: true });
const claimsOf = (name: string) => parseUke(readFileSync(path.join(root, "fixtures", "uke", name))).claims.filter((c) => c.unsupported === undefined && hasRevision(c.yearMonth));
const jitsurei = () => structuredClone(claimsOf("jitsurei.UKE"));
/** G02・G03 の指摘だけ */
const found = (db: NonNullable<ReturnType<typeof openMasters>>, c: GenericClaim, about: GenericAboutMore) => evaluateGeneric(c, db, about).findings.filter((f) => f.check === "G02" || f.check === "G03");

describe("段 11：実データの masters.db で", () => {
  withData("錨と式の錨（EM §2-11。原文の計算例）が全部通り、G02・G03 の準備ができている", () => {
    const db = openMasters(file)!;
    const em = readEm(root);
    const r = verifyMasters(db, em, { write: false });
    expect(r.lines.filter((l) => /が外れた|件数が違う|食い違う/.test(l))).toEqual([]);
    expect(r.failures).toBe(0);
    expect(em.formulas.length).toBeGreaterThanOrEqual(20);
    expect(r.lines).toContain(`式の錨：${em.formulas.length} 個のうち ${em.formulas.length} 個が通った`);
    expect(r.ready.filter((x) => x.check === "G02" || x.check === "G03").map((x) => x.ready)).toEqual([true, true]);
    // 原文の計算例を、検算の式に 1 つずつ通す（薬剤料・器材料・きざみ・注加算・マイナス）
    const snap = { SI: pickSnapshot(db, "shinryo", YM, GEN)!.snapshot, IY: pickSnapshot(db, "iyakuhin", YM, GEN)!.snapshot, TO: pickSnapshot(db, "tokutei", YM, GEN)!.snapshot };
    for (const f of em.formulas) expect([f.id, recalcUnit(db, snap, f.items, { shikibetsu: f.shikibetsu, shikibetsuSure: true, bundles: [] })]).toMatchObject([f.id, { points: f.points }]);
    expect(new Set(em.formulas.map((f) => f.items[0].kind))).toEqual(new Set(["SI", "IY", "TO"]));
    db.close();
  });

  withData("当たらない側：同梱の UKE 全部で、G02・G03 の指摘が 0 件（条件つきも）。jitsurei.UKE の検算できた単位は全部合う", () => {
    const db = openMasters(file)!;
    const files = readdirSync(path.join(root, "fixtures", "uke")).filter((n) => n.endsWith(".UKE"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    let claims = 0;
    for (const name of files)
      for (const c of claimsOf(name)) {
        claims++;
        const r = evaluateGeneric(c, db, aboutOf(c));
        expect(r.ran.map((x) => x.check)).toEqual(expect.arrayContaining(["G02", "G03"]));
        expect([name, r.findings.filter((f) => f.check === "G02" || f.check === "G03")]).toEqual([name, []]);
        const list = recalcClaim(c, db, aboutOf(c));
        expect(Array.isArray(list) && list.filter((x) => x.status === "mismatch")).toEqual([]);
      }
    expect(claims).toBeGreaterThanOrEqual(10);
    const sum = jitsurei().map((c) => recalcSummary(recalcClaim(c, db, aboutOf(c)) as Exclude<ReturnType<typeof recalcClaim>, { skip: string }>));
    const total = sum.reduce((s, x) => ({ units: s.units + x.units, checked: s.checked + x.checked, matched: s.matched + x.matched }), { units: 0, checked: 0, matched: 0 });
    expect(total.matched).toBe(total.checked);
    // 診療行為・薬剤料（投薬・注射）・器材料（酸素）・きざみの単位が、検算できた側に入っている
    expect(total.checked).toBeGreaterThanOrEqual(30);
    db.close();
  });

  withData("薬剤料を途中で丸めない（round-32 codex-4）：610408044 の使用量 8.77193（15.0000003 円）は 2 点で合い、1 点なら合わない", () => {
    const db = openMasters(file)!;
    const about: GenericAboutMore = { yearMonth: "2026-11", generation: GEN };
    const status = (points: number) => {
      const units: GenericUnitDetail[] = [{ points, count: 1, days: [1], items: [{ kind: "IY", code: "610408044", quantity: "8.77193", shikibetsu: "21", line: 1 }] }];
      const r = recalcClaim({ units } as GenericClaim, db, about);
      return Array.isArray(r) ? r.map((x) => [x.status, "calc" in x ? x.calc : null]) : r;
    };
    expect(status(2)).toEqual([["match", 2]]);
    expect(status(1)).toEqual([["mismatch", 2]]);
    db.close();
  });

  withData("当たる側：点数を 1 つ変えた版・数量を変えた版・年齢を範囲の外にした版・入院専用のコードを足した版で、変えた行だけが出る", () => {
    const db = openMasters(file)!;
    // 点数を 1 つ変える（1 件めの再診料）
    let cs = jitsurei();
    cs[0].units[0].points += 1;
    let f = found(db, cs[0], aboutOf(cs[0]));
    expect(f.map((x) => [x.check, x.units, x.params.uke, x.params.calc, x.certainty])).toEqual([["G02", [0], String(cs[0].units[0].points), String(cs[0].units[0].points - 1), "条件つき"]]);
    // 数量を変える（薬の使用量。1 件めの外用薬）
    cs = jitsurei();
    const drug = cs[0].units.findIndex((u) => u.items.every((it) => it.kind === "IY") && u.points > 5);
    cs[0].units[drug].items[0].quantity = String(Number(cs[0].units[drug].items[0].quantity) * 3);
    f = found(db, cs[0], aboutOf(cs[0]));
    expect(f.map((x) => [x.check, x.units])).toEqual([["G02", [drug]]]);
    // 数量を変える（きざみ。4 件めの患家診療時間加算を 70 分から 130 分に）
    cs = jitsurei();
    const step = cs[3].units.findIndex((u) => u.items.some((it) => it.quantity === "70"));
    cs[3].units[step].items[0].quantity = "130";
    f = found(db, cs[3], aboutOf(cs[3]));
    expect(f.map((x) => [x.check, x.units, x.params.uke, x.params.calc])).toEqual([["G02", [step], "100", "300"]]);
    // 年齢を範囲の外にする（2 件めの点滴注射は 6 歳以上。4 歳の患者にする）
    cs = jitsurei();
    cs[1].patient.birth = `${Number(YM.slice(0, 4)) - 4}0101`;
    f = found(db, cs[1], aboutOf(cs[1]));
    expect(f.map((x) => [x.messageKey, x.codes])).toEqual([["G03.age", ["130003810"]]]);
    // 入院専用のコードを足す（手術後医学管理料 2〔診療所の場合〕。EM §2-11 A10）。点数はマスターどおり
    cs = jitsurei();
    cs[0].units.push({ line: 9000, items: [{ line: 9000, kind: "SI", code: "113004610", quantity: "", shikibetsu: "13" }], points: 1056, count: 1, days: [1], futan: "1", shikibetsu: "13" });
    f = found(db, cs[0], aboutOf(cs[0]));
    expect(f.map((x) => [x.messageKey, x.codes, x.units])).toEqual([["G03.inpatient_only", ["113004610"], [cs[0].units.length - 1]]]);
    // 病院に限るコード（手術後医学管理料 1〔病院の場合〕。A09）は、入院専用と、病院に限るの 2 件
    cs = jitsurei();
    cs[0].units.push({ line: 9000, items: [{ line: 9000, kind: "SI", code: "113004510", quantity: "", shikibetsu: "13" }], points: 1188, count: 1, days: [1], futan: "1", shikibetsu: "13" });
    expect(found(db, cs[0], aboutOf(cs[0])).map((x) => x.messageKey)).toEqual(["G03.inpatient_only", "G03.hospital_only"]);
    db.close();
  });

  withData(
    "広く掛ける検査：医科診療行為マスターの全コードを 1 行ずつ、正しい形（そのコードの点数・入外・施設の種別・年齢の範囲の中の患者）で置いて、G01〜G03 の指摘が 0 件",
    () => {
      const db = openMasters(file)!;
      const snap = pickSnapshot(db, "shinryo", YM, GEN)!.snapshot;
      const rows = db.prepare("SELECT * FROM shinryo WHERE snapshot = ?").all(snap) as ShinryoRow[];
      const y = Number(YM.slice(0, 4));
      const num = (v: string) => (/^\d{2}$/.test(v) && v !== "00" ? Number(v) : null);
      const hits: string[] = [];
      const excluded = new Map<string, number>();
      let checked = 0;
      let alone = 0;
      for (const r of rows) {
        // 点数（マイナス）の行は、単独では置けない（引かれる側の行が要る）。数だけ数える
        if (r.point_kind === "8") {
          alone++;
          continue;
        }
        const age = num(r.age_lower) ?? (num(r.age_upper) !== null ? num(r.age_upper)! - 1 : 40);
        const about: GenericAboutMore = { yearMonth: YM, generation: GEN, outpatient: r.nyugai !== "1", clinic: r.hospital_clinic !== "1", birth: `${y - age}0615` };
        // きざみの行は、数量を下限値にして基本点数。端数は四捨五入
        const unit: GenericUnitDetail = { items: [{ kind: "SI", code: r.code, quantity: r.kizami_kind === "1" ? String(r.kizami_lower) : "", line: 1, shikibetsu: "" }], points: Math.floor(r.points + 0.5), count: 1, days: [1] };
        const claim: GenericClaim = { units: [unit] };
        const res = evaluateGeneric(claim, db, about);
        for (const f of res.findings) hits.push(`${f.check} ${f.messageKey} ${r.code}`);
        const one = (recalcClaim(claim, db, about) as { status: string; reason?: string }[])[0];
        if (one.status === "excluded") excluded.set(one.reason!, (excluded.get(one.reason!) ?? 0) + 1);
        else checked++;
      }
      console.log(`広く掛ける検査（診療行為 ${snap}）：${rows.length} コード、指摘 ${hits.length} 件、検算できた ${checked}、単独で置けない（点数（マイナス））${alone}、検算の対象外 ${[...excluded].map(([k, n]) => `${k} ${n}`).join("・")}`);
      expect(hits).toEqual([]);
      expect(rows.length).toBeGreaterThan(10000);
      expect(checked).toBeGreaterThan(10000);
      db.close();
    },
    300_000,
  );

  withData(
    "広く掛ける検査：医薬品・特定器材マスターの全コードを、使用量 1 で式に通して、例外が出ない（点数になるか、理由つきの対象外）",
    () => {
      const db = openMasters(file)!;
      const iy = pickSnapshot(db, "iyakuhin", YM, GEN)!.snapshot;
      const to = pickSnapshot(db, "tokutei", YM, GEN)!.snapshot;
      const tally = (rows: { code: string }[], kind: "IY" | "TO", snapshot: string) => {
        const out = new Map<string, number>();
        for (const r of rows) {
          const x = recalcUnit(db, { SI: null, IY: snapshot, TO: snapshot }, [{ kind, code: r.code, quantity: "1" }], { shikibetsu: "21", shikibetsuSure: true, bundles: [] });
          const key = "points" in x ? "点数になる" : x.reason;
          if ("points" in x) expect(Number.isInteger(x.points) && x.points >= 0).toBe(true);
          out.set(key, (out.get(key) ?? 0) + 1);
        }
        return [...out].map(([k, n]) => `${k} ${n}`).join("・");
      };
      const drugs = db.prepare("SELECT code FROM iyakuhin WHERE snapshot = ?").all(iy) as IyakuhinRow[];
      const devices = db.prepare("SELECT code FROM tokutei WHERE snapshot = ?").all(to) as TokuteiRow[];
      console.log(`広く掛ける検査（医薬品 ${iy}）：${drugs.length} コード：${tally(drugs, "IY", iy)}`);
      console.log(`広く掛ける検査（特定器材 ${to}）：${devices.length} コード：${tally(devices, "TO", to)}`);
      expect(drugs.length).toBeGreaterThan(10000);
      expect(devices.length).toBeGreaterThan(1000);
      db.close();
    },
    300_000,
  );

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    if (!has) process.stderr.write(`段 11 の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 5);
  });
});
