// 実データ（masters.db）で確かめる、段 14 の完了条件（design.md §12-6・§12-7）：G09（適応・併用）の、当たる側・当たらない側・広く掛ける検査・速さ。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRevision } from "../../src/engine/revisions";
import { evaluateGeneric } from "../../src/generic";
import { g09, g09Look, type G09Look } from "../../src/generic/g09";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import type { GenericAboutMore, GenericFinding } from "../../src/generic/types";
import { openMasters, pickSnapshot } from "../../src/masters/db";
import { readEm, verifyMasters } from "../../src/masters/verify";
import { diseaseCodeOf, SUSPECTED_MODIFIER } from "../../src/uke/diseases";
import type { UkeClaim } from "../../src/uke/types";
import { YM } from "../helpers/period";
import { M, S } from "./small-checkmaster";
import { claimsOf } from "./small-comments";

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
const base: GenericAboutMore = { yearMonth: YM, generation: rev.generation, outpatient: true };
const withDiseases = (...codes: string[]): GenericAboutMore => ({ ...base, diseases: codes.map((code) => ({ code })) });
type Item = [kind: "SI" | "IY", code: string];
const DAYS = (...days: number[]) => Array.from({ length: 31 }, (_, i) => (days.includes(i + 1) ? 1 : 0));
const claimOf = (...units: [items: Item[], days: number[]][]): TimedClaim => ({ units: units.map(([items, days]) => ({ items: items.map(([kind, code]) => ({ kind, code })), count: days.length, days: DAYS(...days) })) });
/** 同梱の UKE のレセプトについて分かっていること（取り込んだレセプトの点検と同じ：傷病名コードと、疑い病名かどうか） */
const aboutOf = (c: UkeClaim): GenericAboutMore => ({ ...base, yearMonth: c.yearMonth, birth: c.patient.birth, clinic: true, diseases: c.patient.diseases.map((d) => ({ code: d.code ?? diseaseCodeOf(d.name), suspected: d.modifiers?.includes(SUSPECTED_MODIFIER) === true })) });
const mine = (fs: GenericFinding[]) => fs.filter((f) => f.check === "G09");
const note = (text: string) => console.log(text);
const FILES = ["jitsurei.UKE", "kisaimore.UKE", "kokuhoren.UKE", "shiharaikikin.UKE", "taishogai.UKE"];

describe("段 14：実データの masters.db で", () => {
  withData("錨（EM §2-11。原文で確かめた事実）が全部通り、G09 の準備ができている", () => {
    const db = openMasters(file)!;
    const em = readEm(root);
    const r = verifyMasters(db, em, { write: false });
    expect(r.lines.filter((l) => /が外れた|件数が違う|食い違う/.test(l))).toEqual([]);
    expect(r.failures).toBe(0);
    expect(em.anchors.filter((a) => a.table.startsWith("cm_")).length).toBeGreaterThanOrEqual(9);
    expect(r.ready.filter((x) => x.check === "G09").map((x) => [x.ready, x.reason])).toEqual([[true, ""]]);
    db.close();
  });

  withData("適応（医薬品）当たる側：jitsurei.UKE の内服のレセプトで、傷病名を全部消すと、表にある薬の全部に出る。元のままでは、当たる傷病名のある薬には出ない。表にない薬には何も言わない", () => {
    const db = openMasters(file)!;
    const claim = claimsOf("jitsurei.UKE")[2];
    const look = g09Look(claim, db, aboutOf(claim)) as G09Look;
    expect(look.iy).toEqual({ all: 12, inTable: 9, conditioned: 0 });
    // 元のまま：SY は 高血圧症・心房細動・慢性心不全。出るのは、表の傷病名（240 件。湿疹・皮膚炎・鼻炎など）が 1 つもない抗アレルギー薬だけ
    expect(look.findings.map((f) => [f.messageKey, f.codes[0], f.certainty])).toEqual([["G09.iy_no_disease", "610421327", "条件つき"]]);
    // 傷病名を全部消す：表にある 9 つの薬の全部に、薬ごとに 1 件。表にない 3 つ（うち 1 つは薬剤料の逓減のコード）には出ない
    const sy = (...codes: string[]): GenericAboutMore => ({ ...aboutOf(claim), diseases: codes.map((code) => ({ code })) });
    const none = mine(evaluateGeneric(claim, db, sy()).findings);
    expect(none.map((f) => f.messageKey)).toEqual(Array.from({ length: 9 }, () => "G09.iy_no_disease"));
    expect(new Set(none.map((f) => f.codes[0])).size).toBe(9);
    expect(none.every((f) => f.certainty === "条件つき" && f.source.data === "チェックマスタ 医薬品適応関連マスタファイル" && f.source.ref === `医薬品コード=${f.codes[0]}`)).toBe(true);
    for (const code of ["620000168", "612120358", "630010002"]) expect(none.some((f) => f.codes.includes(code)), code).toBe(false);
    // 当たる傷病名を 1 つ戻す（高血圧症）：その傷病名が表にある薬（7 つ）から消える
    const one = mine(evaluateGeneric(claim, db, sy("8833421")).findings);
    expect(one.map((f) => f.codes[0]).sort()).toEqual(["610421327", "613330001"]);
    // 指摘の文は、表の傷病名を全部は並べない（先頭の 3 件と、残りの数）
    expect(none.find((f) => f.codes[0] === "613330001")!.params).toMatchObject({ count: "325" });
    expect(none.find((f) => f.codes[0] === "613330001")!.params.diseases).toMatch(/^「[^」]+」（\d{7}）、「[^」]+」（\d{7}）、「[^」]+」（\d{7}） ほか 322 件$/);
    db.close();
  });

  withData("錨の組：リバーロキサバンと非弁膜症性心房細動、ＢＮＰ と心不全（疑い病名でも）、悪性腫瘍特異物質治療管理料と胃癌（確定病名のときだけ）、併用の組（同じ日に両方あるときだけ）", () => {
    const db = openMasters(file)!;
    const keys = (c: TimedClaim, a: GenericAboutMore) => mine(evaluateGeneric(c, db, a).findings).map((f) => [f.messageKey, ...f.codes]);
    const suspected = (code: string): GenericAboutMore => ({ ...base, diseases: [{ code, suspected: true }] });
    expect(keys(claimOf([[["IY", M.riva]], [5]]), withDiseases(S.nvaf))).toEqual([]);
    expect(keys(claimOf([[["IY", M.riva]], [5]]), withDiseases(S.igan))).toEqual([["G09.iy_no_disease", M.riva]]);
    expect(keys(claimOf([[["IY", M.pentasa]], [5]]), withDiseases(S.uc))).toEqual([]);
    expect(keys(claimOf([[["SI", M.bnp]], [5]]), withDiseases(S.shinfuzen))).toEqual([]);
    expect(keys(claimOf([[["SI", M.bnp]], [5]]), suspected(S.shinfuzen))).toEqual([]);
    expect(keys(claimOf([[["SI", M.bnp]], [5]]), withDiseases(S.dcm))).toEqual([]);
    expect(keys(claimOf([[["SI", M.bnp]], [5]]), withDiseases(S.igan))).toEqual([["G09.si_no_disease", M.bnp]]);
    expect(keys(claimOf([[["SI", M.marker]], [5]]), withDiseases(S.igan))).toEqual([]);
    expect(keys(claimOf([[["SI", M.marker]], [5]]), suspected(S.igan))).toEqual([["G09.si_suspected", M.marker]]);
    // 併用の組（仕様書の例。どちらも注射薬で、適応の表に傷病名の行があるので、傷病名は未コード化にして、適応を黙らせる）
    const quiet = withDiseases("0000999");
    expect(keys(claimOf([[["IY", M.buscopan]], [5]], [[["IY", M.primperan]], [5]]), quiet)).toEqual([["G09.heiyo_kinki", M.buscopan, M.primperan]]);
    expect(keys(claimOf([[["IY", M.buscopan]], [5]]), quiet)).toEqual([]);
    expect(keys(claimOf([[["IY", M.primperan]], [5]]), quiet)).toEqual([]);
    expect(keys(claimOf([[["IY", M.buscopan]], [5]], [[["IY", M.primperan]], [6]]), quiet)).toEqual([]);
    db.close();
  });

  withData("当たらない側：同梱の UKE 全部で、G09 の指摘は 1 件だけ（jitsurei.UKE の 3 件目の抗アレルギー薬。検証用のレセプトの傷病名が、その薬と対応していない）。院外処方の症例（薬の行がない）には、薬の指摘が出ない", () => {
    const db = openMasters(file)!;
    const all: string[] = [];
    for (const name of FILES) {
      claimsOf(name).forEach((claim, i) => {
        const about = aboutOf(claim);
        const r = evaluateGeneric(claim, db, about);
        expect(r.ran.some((x) => x.check === "G09"), `${name} #${i + 1}`).toBe(true);
        for (const f of mine(r.findings)) all.push(`${name} #${i + 1} ${f.messageKey} ${f.codes.join("×")}`);
        const look = g09Look(claim, db, about) as G09Look;
        if (name !== "jitsurei.UKE") expect(look.iy.all, `${name} #${i + 1}`).toBe(0);
      });
    }
    expect(all).toEqual(["jitsurei.UKE #3 G09.iy_no_disease 610421327"]);
    // K6（傷病名が「心不全の疑い」のまま ＢＮＰ を連月で算定して査定された症例）：傷病名が未コード化（0000999）なので、適応は見ない（名前では当てない）。表では、ＢＮＰ は心不全の疑い病名も対象
    const k6 = claimsOf("shiharaikikin.UKE")[0];
    expect(g09Look(k6, db, aboutOf(k6))).toMatchObject({ why: "uncoded", si: { inTable: 1 }, findings: [] });
    // K1（慢性心不全で ＢＮＰ）：表に当たる傷病名があるので出ない
    const k1 = claimsOf("kokuhoren.UKE")[0];
    expect(g09Look(k1, db, aboutOf(k1))).toMatchObject({ why: null, si: { inTable: 1 }, findings: [] });
    // jitsurei.UKE の 4 件目（在宅・処方箋料あり）：院外処方の薬は見られないことを、点検の範囲に出す
    const zaitaku = claimsOf("jitsurei.UKE")[3];
    expect(g09Look(zaitaku, db, aboutOf(zaitaku))).toMatchObject({ shohosen: true, iy: { all: 0 } });
    db.close();
  });

  withData("広く掛ける検査：適応の表に行のある全部の医薬品・診療行為について、表の傷病名を 1 つ置くと出ず、傷病名を空にすると出る（性別・年齢の条件つきの行があるコードは、空でも出ない）", () => {
    const db = openMasters(file)!;
    const s = pickSnapshot(db, "checkmaster", YM, rev.generation)!.snapshot;
    const shobyo = pickSnapshot(db, "shobyo", YM, rev.generation)!.snapshot;
    for (const [kind, table, key] of [["IY", "cm_tekio", "G09.iy_no_disease"], ["SI", "cm_si_shobyo", "G09.si_no_disease"]] as const) {
      // 表にあるコード（廃止でない傷病名の行がある）と、その傷病名のうち、持っている傷病名マスターにあるもの 1 つ（なければ null）
      // cond＝性別・年齢の条件つきの行（廃止でない）がある。そのコードの適応は見ないので、空でも出ない
      const rows = db.prepare(`SELECT c.code, min(CASE WHEN m.code IS NOT NULL THEN c.shobyo END) AS disease, max(c.sex <> '0' OR c.age_lower <> 0 OR c.age_upper <> 999.99) AS cond FROM ${table} c LEFT JOIN shobyo m ON m.snapshot = ? AND m.code = c.shobyo WHERE c.snapshot = ? AND c.shobyo > '0000003' AND c.change <> '9' GROUP BY c.code`).all(shobyo, s) as { code: string; disease: string | null; cond: number }[];
      let noMaster = 0;
      let cond = 0;
      const wrong: string[] = [];
      for (const r of rows) {
        const claim = claimOf([[[kind, r.code]], [5]]);
        const empty = (g09.run(claim, db, withDiseases()) as GenericFinding[]).filter((f) => f.messageKey === key);
        if (r.cond === 1) {
          cond++;
          if (empty.length !== 0) wrong.push(`${r.code} 条件つきなのに空で出る`);
          continue;
        }
        if (empty.length !== 1 || empty[0].codes[0] !== r.code || empty[0].certainty !== "条件つき") wrong.push(`${r.code} 空で出ない`);
        if (r.disease === null) {
          noMaster++;
          continue;
        }
        if ((g09.run(claim, db, withDiseases(r.disease)) as GenericFinding[]).some((f) => f.messageKey.startsWith(key.slice(0, 6)))) wrong.push(`${r.code} × ${r.disease} で出る`);
      }
      note(`広く掛ける検査（${table}）：${rows.length} コード（うち性別・年齢の条件つきの行があるので見ない ${cond}）。ほかは、傷病名を空にすると全部に出て、表の傷病名を 1 つ置くと出ない。外れ ${wrong.length} 件。表の傷病名がどれも傷病名マスターにないコード ${noMaster} 件（置く検査はしていない）`);
      expect(cond).toBeLessThan(rows.length / 10);
      expect(wrong).toEqual([]);
      expect(rows.length).toBeGreaterThan(kind === "IY" ? 10000 : 1500);
    }
    // 併用：廃止でない組の全部。同じ日に置くと 1 件、別の日に置くと 0 件
    const pairs = db.prepare("SELECT code_l, code_r FROM cm_heiyo_kinki WHERE snapshot = ? AND change <> '9' AND code_l < code_r").all(s) as { code_l: string; code_r: string }[];
    const bad: string[] = [];
    for (const p of pairs) {
      const same = (g09.run(claimOf([[["IY", p.code_l]], [5]], [[["IY", p.code_r]], [5]]), db, base) as GenericFinding[]).filter((f) => f.messageKey === "G09.heiyo_kinki");
      const apart = (g09.run(claimOf([[["IY", p.code_l]], [5]], [[["IY", p.code_r]], [6]]), db, base) as GenericFinding[]).filter((f) => f.messageKey === "G09.heiyo_kinki");
      if (same.length !== 1 || apart.length !== 0) bad.push(`${p.code_l}×${p.code_r}`);
    }
    note(`広く掛ける検査（cm_heiyo_kinki）：${pairs.length} 組。同じ日に置くと 1 件、別の日に置くと 0 件。外れ ${bad.length} 件`);
    expect(bad).toEqual([]);
    db.close();
  }, 300_000);

  withData("速さ：薬 20 品目・傷病名 10 のレセプトの点検が 50 ミリ秒以内。薬を上限いっぱい並べた細工したレセプトでも、時間が表の大きさを超えて膨らまない", () => {
    const db = openMasters(file)!;
    const s = pickSnapshot(db, "checkmaster", YM, rev.generation)!.snapshot;
    // 表の行の多い薬から順に（いちばん重い側）。性別・年齢の条件つきの行がある薬は、適応を見ずに通るので除く（傷病名を引く道を測る）
    const heavy = (db.prepare("SELECT code FROM cm_tekio WHERE snapshot = ? AND shobyo > '0000003' AND change <> '9' GROUP BY code HAVING max(sex <> '0' OR age_lower <> 0 OR age_upper <> 999.99) = 0 ORDER BY count(*) DESC LIMIT 4900").all(s) as { code: string }[]).map((r) => r.code);
    const diseases = ["8833421", "4273006", "4289018", "2500015", "4389014", "3320002", "5908007", "8835114", "7262006", "4939008"];
    const timed = (fn: () => unknown): number => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };
    const median = (fn: () => unknown) => [1, 2, 3, 4, 5].map(() => timed(fn)).sort((a, b) => a - b)[2];
    const twenty = claimOf(...heavy.slice(0, 20).map((code, i): [Item[], number[]] => [[["IY", code]], [1 + (i % 28)]]));
    const about = withDiseases(...diseases);
    const only = median(() => g09.run(twenty, db, about));
    const whole = median(() => evaluateGeneric(twenty, db, about));
    note(`速さ：薬 20 品目（表の行の多い順）・傷病名 10 のレセプトで、G09 だけ ${only.toFixed(1)} ミリ秒、G01〜G09 の全部 ${whole.toFixed(1)} ミリ秒（5 回の中央値）`);
    expect(only).toBeLessThan(50);
    expect(whole).toBeLessThan(50);
    // 細工したレセプト：UKE の行数の上限（5,000 行）に近い 4,900 品目を 1 行ずつ。傷病名 10（索引で引く道）と 60（表の側を読む道）
    const max = claimOf(...heavy.map((code): [Item[], number[]] => [[["IY", code]], [5]]));
    const before = process.memoryUsage().heapUsed;
    const count = (a: GenericAboutMore) => (g09.run(max, db, a) as GenericFinding[]).length;
    const found = [0, 0];
    const few = timed(() => (found[0] = count(about)));
    const sixty = withDiseases(...diseases, ...(db.prepare("SELECT code FROM shobyo WHERE snapshot = ? AND code > '0000999' ORDER BY code LIMIT 50").all(pickSnapshot(db, "shobyo", YM, rev.generation)!.snapshot) as { code: string }[]).map((r) => r.code));
    const many = timed(() => (found[1] = count(sixty)));
    const heap = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    note(`細工したレセプト（薬 4,900 品目）：傷病名 10 で ${few.toFixed(0)} ミリ秒（指摘 ${found[0]} 件）、傷病名 60 で ${many.toFixed(0)} ミリ秒（指摘 ${found[1]} 件）。ヒープの増え ${heap.toFixed(1)} MB`);
    // どちらの道でも、当たる・当たらないは同じ（足した 50 の傷病名で当たる薬の分だけ減る）
    expect(found[0]).toBeGreaterThan(1000);
    expect(found[1]).toBeGreaterThan(1000);
    expect(found[1]).toBeLessThanOrEqual(found[0]);
    expect(few).toBeLessThan(10_000);
    expect(many).toBeLessThan(10_000);
    db.close();
  }, 120_000);

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    if (!has) process.stderr.write(`段 14 の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 6);
  });
});
