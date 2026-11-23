// 実データ（masters.db）で確かめる、段 12 の完了条件（design.md §12-2・§12-6・§12-7）：G04〜G06 と、手書きのルールとの重なり・突き合わせ。
// データは同梱しないので、環境変数 RESEMEN_MASTER_DIR（masters.db のあるフォルダ）があるときだけ動く。ないときは飛ばし、飛ばした数を表示する（黙って通さない）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSources } from "../../scripts/gen-uke";
import { evaluate } from "../../src/engine";
import { hasRevision, resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext, Rule } from "../../src/engine/types";
import { evaluateGeneric } from "../../src/generic";
import { g04 } from "../../src/generic/g04";
import { g05 } from "../../src/generic/g05";
import { g06 } from "../../src/generic/g06";
import { outsideOf } from "../../src/generic/lookup";
import { claimOfLines, mappedLinesOf, overlap } from "../../src/generic/overlap";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import { FINDING_LIMIT, type GenericFinding } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { openMasters, type MastersDb } from "../../src/masters/db";
import { GENERIC_TEXT_CERTAIN } from "../../src/messages";
import { DOCTOR_DRILLS } from "../../src/practice/doctor-drills";
import { DRILLS } from "../../src/practice/drills";
import { commentsOfCase } from "../../src/uke/cases";
import type { UkeClaim } from "../../src/uke/types";
import { mapClaim, parseUke } from "../../src/uke/uke";
import { line, loadCase, withLines } from "../engine/helpers";
import { day, YM } from "../helpers/period";

const dir = process.env.RESEMEN_MASTER_DIR;
const file = dir ? path.join(dir, "masters.db") : "";
const has = file !== "" && existsSync(file);
const root = path.join(__dirname, "..", "..");
let skipped = 0;
/** データがあるときだけ動くテスト */
const withData = (name: string, fn: () => void | Promise<void>, timeout?: number) => {
  if (!has) skipped++;
  it.skipIf(!has)(name, fn, timeout);
};
const note = (text: string) => process.stderr.write(`[段 12] ${text}\n`);

const rev = resolveRevision(YM);
const about = { yearMonth: YM, generation: rev.generation };
const [START, END] = [`${YM.replace("-", "")}01`, `${YM.replace("-", "")}31`];
/** 言い切りの候補の種類を、全部一覧に載せたつもりで掛ける（候補かどうかを見るため。出荷の一覧は空） */
const ALL: ReadonlySet<string> = new Set(Object.keys(GENERIC_TEXT_CERTAIN));
const NAMES = ["K1", "K2", "K3", "K4", "K5", "K6", "K7"];
const K1 = loadCase("K1");

type Unit = TimedClaim["units"][number];
const daysOf = (days: number[]) => {
  const d = Array.from({ length: 31 }, () => 0);
  for (const n of days) d[n - 1]++;
  return d;
};
const unit = (codes: string[], days: number[]): Unit => ({ items: codes.map((code) => ({ kind: "SI" as const, code })), count: days.length, days: daysOf(days) });
const tables = (fs: GenericFinding[]) => fs.filter((f) => ["G04", "G05", "G06"].includes(f.check));
/** 電子点数表と突き合わせる申告（包括・背反・回数）。記載もれ（R17）・傷病名（R06）の申告は、段 13 のテスト（comments-real.test.ts）が見る */
const tableCovers = (rule: Rule) => {
  const c = rule.covers?.(rev);
  return c && ["包括", "背反", "回数"].includes(c.kind) ? c : undefined;
};
const run = (db: MastersDb, units: Unit[], certain: ReadonlySet<string> = ALL) => tables(evaluateGeneric({ units }, db, about, undefined, certain).findings);
const brief = (fs: GenericFinding[]) => fs.map((f) => [f.messageKey, f.certainty, ...f.codes]);
const kubunOfCode = (code: string) => Object.keys(rev.codes).find((k) => rev.codes[k].primary === code || rev.codes[k].accept.includes(code));

/** 合成のレセプト（UKE を読んだ形）。点数は、版の表にあるコードの単位は版の点数の合計（mapClaim が引けるように）、ほかは 0 */
function ukeOf(units: { codes: string[]; days: number[] }[]): UkeClaim {
  return {
    line: 1,
    patientNo: "",
    yearMonth: YM,
    patient: { name: "", sex: 1, birth: "19400101", receiptType: "1112", insurer: { number: "", symbol: "", no: "" }, kohi: [], diseases: [] },
    total: null,
    realDays: null,
    kohiTotals: [],
    units: units.map((u, i) => ({
      line: i + 2,
      items: u.codes.map((code) => ({ line: i + 2, kind: "SI" as const, code, quantity: "", shikibetsu: "" })),
      points: u.codes.reduce((s, code) => s + (kubunOfCode(code) ? (rev.points[kubunOfCode(code)!].points ?? 0) : 0), 0),
      count: u.days.length,
      days: daysOf(u.days),
      futan: "1",
      shikibetsu: "",
    })),
    comments: [],
    eligibility: [],
    visits: [],
    copay: [],
    dpcExclusions: [],
    notes: [],
  };
}

/** 合成のレセプトを、取り込んだレセプトの点検と同じ道（手書きのルール・データで動く点検・重なり）に通す。カルテ側の記録はない */
function check(db: MastersDb, claim: UkeClaim, facility = K1.facility) {
  const mapped = mapClaim(claim, rev);
  const others = mapped.others.flatMap((o) => o.codes);
  const ctx: ClaimContext = {
    ...K1,
    facility,
    events: [],
    recordsKnown: false,
    lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })),
    comments: [],
    commentsKnown: false,
    ...(others.length > 0 ? { partial: true, outside: outsideOf(db, rev, YM, others) } : {}),
  };
  const hand = evaluate(ctx);
  const generic = tables(evaluateGeneric(claim, db, about).findings);
  return { hand, mapped, generic, ...overlap(hand, rev, false, mappedLinesOf(mapped.lines, mapped.origins), generic) };
}
const handOf = (r: { hand: { findings: { ruleId: string; kind: string; messageKey: string; missing?: { field: string } }[] } }, ruleId: string) =>
  r.hand.findings.filter((f) => f.ruleId === ruleId).map((f) => (f.kind === "情報不足" ? `情報不足:${f.missing!.field}` : f.messageKey));

/** 決まった種から作る乱数（無作為に選ぶ組を、毎回同じにする） */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sample = <T>(list: T[], n: number, rand: () => number): T[] => (list.length <= n ? list : Array.from({ length: n }, () => list[Math.floor(rand() * list.length)]));

describe("段 12：実データの masters.db で", () => {
  withData("(a) 手書きとデータの突き合わせ：R04・R05・R09・R11・R12 が申告した組は、版の表のどのコード（primary・accept）でも、電子点数表に行がある", () => {
    const db = openMasters(file)!;
    const codesOf = (k: string) => [rev.codes[k].primary, ...rev.codes[k].accept];
    const month = db.prepare("SELECT kubun, tokurei FROM haihan WHERE tani = 2 AND code1 = ? AND code2 = ? AND created_on <= ? AND abolished_on >= ?");
    const incl = db.prepare("SELECT h.unit1, k.tokurei FROM hojo h JOIN houkatsu k ON k.snapshot = h.snapshot AND k.group_no = h.group1 WHERE h.code = ? AND k.code = ? AND k.created_on <= ? AND k.abolished_on >= ?");
    const limit = db.prepare("SELECT limit_count, tokurei FROM kaisu WHERE unit_code = 131 AND code = ? AND created_on <= ? AND abolished_on >= ?");
    const missing: string[] = [];
    const counts: Record<string, number> = {};
    for (const rule of rev.rules) {
      const c = tableCovers(rule);
      if (!c) continue;
      counts[rule.id] = 0;
      for (const set of c.kubun) {
        const combos = set.length === 1 ? codesOf(set[0]).map((a) => [a]) : codesOf(set[0]).flatMap((a) => codesOf(set[1]).map((b) => [a, b]));
        for (const codes of combos) {
          // 手書きのルールは、条件なしで「算定できない」と言う。表でも、特例条件のない行であること（背反・包括は同一月内、回数は月 1 回）
          const ok =
            c.kind === "回数"
              ? (limit.all(codes[0], END, START) as { limit_count: number; tokurei: string }[]).some((r) => r.limit_count === 1 && r.tokurei === "0")
              : c.kind === "背反"
                ? (month.all(codes[0], codes[1], END, START) as { tokurei: string }[]).some((r) => r.tokurei === "0")
                : (incl.all(codes[0], codes[1], END, START) as { unit1: string; tokurei: string }[]).some((r) => r.unit1 === "2" && r.tokurei === "0");
          if (ok) counts[rule.id]++;
          else missing.push(`${rule.id} ${c.kind} ${set.join("×")} ${codes.join("×")}`);
        }
      }
    }
    // 載っていない組が出たら、手書きの根拠（EM の行）かデータの読み方のどちらかが誤り。ここで落として、人が見る（どちらかを黙って直さない）
    expect(missing).toEqual([]);
    // R05：管理料 210 区分（種別 4 の 24 区分〔段 17d〕、人数の区分の 96 区分〔段 17f〕、注14 の減の行の 90 区分〔段 17h〕）× 含まれる項目のコード 9
    expect(counts).toEqual({ R04: 1, R05: 1890, R09: 1, R11: 3, R12: 2 });
    note(`突き合わせ：申告した組（コードの組）${JSON.stringify(counts)}。電子点数表に載っていない組 0`);
    db.close();
  });

  withData("(a2) 同梱の症例と練習問題で、手書きのルールが実際に出した指摘（申告した種類）の組を全部挙げる：どれも、データで動く点検が同じ組を出す（表に載っている）", () => {
    const db = openMasters(file)!;
    const { src } = loadSources();
    const ukeCase = (name: string): ClaimContext => {
      const c = loadCase(name);
      return { ...c, comments: commentsOfCase(c, src.commentValues?.[c.claimId]), commentsKnown: true };
    };
    const nameOf = (claimId: string) => claimId.split("-")[0];
    const K5 = loadCase("K5");
    const inputs: { name: string; ctx: ClaimContext }[] = [
      ...NAMES.flatMap((n) => [{ name: n, ctx: loadCase(n) }, { name: `${n}（UKE・記録なし）`, ctx: { ...ukeCase(n), events: [], recordsKnown: false } }]),
      ...DRILLS.map((d) => ({ name: `練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
      ...DOCTOR_DRILLS.map((d) => ({ name: `医師確認の練習 ${d.id}`, ctx: d.make(loadCase(nameOf(d.claimId))) })),
      // 同梱の入力にない組は、症例に誤りを 1 つ入れて作る（R04・R09・R12・R05 の施設総管）
      { name: "K1＋在宅自己注射指導管理料", ctx: withLines(K1, line("C101_2I", 1, [day(6)])) },
      { name: "K5＋死亡診断加算", ctx: withLines(K5, line("C001_N8_SHIBOU", 1, K5.lines.find((l) => l.kubun === "C001_N7_MITORI")!.dates)) },
      { name: "K1＋電子的診療情報連携体制整備加算", ctx: withLines(K1, line("A_DENSHI_RENKEI", 1, [day(6)])) },
      { name: "K1＋判断料 2 回", ctx: withLines(K1, line("D026_3", 1, [day(20)])) },
      { name: "K4＋処方箋料", ctx: withLines(loadCase("K4"), line("F400_3", 1, [day(6)])) },
    ];
    const seen = new Map<string, string[]>();
    const lost: string[] = [];
    for (const { name, ctx } of inputs) {
      const hand = evaluate(ctx);
      const { claim, mapped } = claimOfLines(ctx.lines, rev);
      const generic = tables(evaluateGeneric(claim, db, about).findings);
      const codeOf = (k: string) => rev.codes[k].primary;
      for (const rule of rev.rules) {
        const c = tableCovers(rule);
        if (!c) continue;
        for (const f of hand.findings.filter((x) => x.messageKey === `${rule.id}.${c.finding}`)) {
          // 手書きの指摘の組：申告した組のうち、区分が全部請求にあり、指摘の行を含むもの
          const sets = c.kubun.filter((set) => set.every((k) => ctx.lines.some((l) => l.kubun === k && l.count > 0)) && set.some((k) => f.lineRefs.includes(k)));
          expect(sets.length, `${name} ${f.messageKey}`).toBeGreaterThan(0);
          for (const set of sets) {
            const codes = set.map(codeOf).sort();
            const hit = generic.some((g) => g.kind === c.kind && [...g.codes].sort().join() === codes.join());
            seen.set(`${rule.id} ${c.kind} ${set.join("×")}`, [...(seen.get(`${rule.id} ${c.kind} ${set.join("×")}`) ?? []), name]);
            if (!hit) lost.push(`${name}：${rule.id} ${set.join("×")}（${codes.join("×")}）`);
          }
        }
      }
      // 重ねると、手書きが指摘した組は、データの側からは出ない（2 回言わない）
      const o = overlap(hand, rev, ctx.recordsKnown, mapped, generic);
      for (const rule of rev.rules) {
        const c = tableCovers(rule);
        if (!c) continue;
        const said = hand.findings.filter((x) => x.messageKey === `${rule.id}.${c.finding}`).flatMap((x) => x.lineRefs.map((k) => rev.codes[k]?.primary));
        expect(o.findings.filter((g) => g.kind === c.kind && g.codes.every((code) => mapped.some((m) => m.codes.includes(code))) && g.codes.some((code) => said.includes(code)) && c.kubun.some((set) => set.map((k) => rev.codes[k].primary).sort().join() === [...g.codes].sort().join())), `${name} ${rule.id}`).toEqual([]);
      }
    }
    expect(lost).toEqual([]);
    // どのルールの指摘も、1 つ以上は入力に出ている（空のまま通らない）
    expect([...new Set([...seen.keys()].map((k) => k.split(" ")[0]))].sort()).toEqual(["R04", "R05", "R09", "R11", "R12"]);
    note(`手書きの指摘の組（${seen.size} 種類）：${[...seen].map(([k, names]) => `${k}［${names.length} 件の入力］`).join("、")}`);
    db.close();
  });

  withData("(b) 当たる側：錨の組で、わざと誤りを入れた合成のレセプト。入れた誤りだけが出る（包括・背反は単位ごと、回数は日・月）", () => {
    const db = openMasters(file)!;
    // もとの請求：K1（正しい請求）。データで動く点検の指摘は、もともと 0 件
    const base = claimOfLines(K1.lines, rev).claim.units;
    expect(run(db, base)).toEqual([]);
    const added = (...units: Unit[]) => brief(run(db, [...base, ...units]));
    const visit = Number(K1.lines.find((l) => l.kubun === "C001_1I")!.dates[0].slice(8));
    // 包括：同一月内（在医総管〔K1 にある〕と処方箋料。A34・A35）
    expect(added(unit(["120002910"], [3]))).toEqual([["G04.month", "確定", "114032510", "120002910"]]);
    // 包括：1 日につき（手術後医学管理料と尿中一般物質定性半定量検査。A40・A41）／同時（血管内視鏡検査と血液ガス分析。A36・A37）／1 手術につき（A42・A43）
    expect(added(unit(["113004610"], [3]), unit(["160000310"], [3]))).toContainEqual(["G04.day", "確定", "113004610", "160000310"]);
    expect(added(unit(["160171310"], [3]), unit(["160027710"], [3])).filter((x) => x.includes("160171310") && x.includes("160027710"))).toEqual([["G04.same", "条件つき", "160171310", "160027710"]]);
    expect(added(unit(["150187210"], [3]), unit(["150184510"], [3])).filter((x) => x[0].startsWith("G04"))).toEqual([["G04.surgery", "条件つき", "150187210", "150184510"]]);
    // 背反：1 日につき（初診料と訪問診療料。A44。残す側は初診料）
    const day1 = run(db, [...base, unit(["111000110"], [visit])]).filter((f) => f.codes.includes("111000110") && f.codes.includes("114001110"));
    expect(day1.map((f) => [f.messageKey, f.certainty, f.params.keep, f.source.data])).toEqual([["G05.day", "確定", "111000110", "背反関連テーブル（1 日につき）"]]);
    // 背反：同一月内（在宅酸素〔K1 にある〕と在宅自己注射。A47）／看取り加算と死亡診断加算（A48・A49。両向きの行で 1 回、残す側は看取り加算）
    expect(added(unit(["114040610"], [3]))).toEqual([["G05.month", "確定", "114003710", "114040610"]]);
    const mitori = run(db, [unit(["114018670"], [22]), unit(["114018570"], [22])]).filter((f) => f.source.data === "背反関連テーブル（同一月内）");
    expect(mitori.map((f) => [f.messageKey, f.certainty, f.params.keep])).toEqual([["G05.month", "確定", "114018570"]]);
    // 背反：同時（往診料と外来在宅共同指導料 2。A52・A53）：同じ単位なら言い切りの候補
    expect(brief(run(db, [unit(["114000110", "114061210"], [3])]))).toEqual([["G05.same_unit", "確定", "114000110", "114061210"]]);
    // 背反：1 週間につき（BNP と ANP。A58）：7 日以内なら条件つき
    expect(brief(run(db, [unit(["160162350"], [3]), unit(["160116310"], [5])]).filter((f) => f.messageKey.startsWith("G05.week")))).toEqual([["G05.week", "条件つき", "160116310", "160162350"]]);
    // 回数：日（訪問診療料は 1 日 1 回。A60）／月（血液学的検査判断料は月 1 回〔K1 に 1 回ある〕。A62）
    expect(added(unit(["114001110"], [visit]))).toEqual([["G06.day", "確定", "114001110"]]);
    expect(added(unit(["160061810"], [3]))).toEqual([["G06.month", "確定", "160061810"]]);
    // 回数：週（訪問診療料は週 3 回。特例条件あり。A61）。同じ週に 4 回（2 倍以下）は出ず、7 回（2 倍を超える）なら出る（round-32 codex-2）
    expect(run(db, [unit(["114001110"], [5, 6, 7, 8])]).filter((f) => f.check === "G06")).toEqual([]);
    expect(brief(run(db, [unit(["114001110"], [4, 5, 6, 7, 8, 9, 10])]).filter((f) => f.check === "G06"))).toEqual([["G06.week_cond", "条件つき", "114001110"]]);
    db.close();
  });

  withData("(c) 当たらない側：同じ組を単位の外（別の日）に置くと出ない。特例条件ありの組は、条件つきでしか出ない", () => {
    const db = openMasters(file)!;
    const pairOf = (fs: GenericFinding[], a: string, b: string) => brief(fs.filter((f) => f.codes.includes(a) && f.codes.includes(b)));
    // 別の日：1 日の包括・同時の包括・1 日の背反・同時の背反・日の回数
    expect(pairOf(run(db, [unit(["113004610"], [3]), unit(["160000310"], [4])]), "113004610", "160000310")).toEqual([]);
    expect(pairOf(run(db, [unit(["160171310"], [3]), unit(["160027710"], [4])]), "160171310", "160027710")).toEqual([]);
    expect(pairOf(run(db, [unit(["111000110"], [3]), unit(["114001110"], [4])]), "111000110", "114001110")).toEqual([]);
    expect(pairOf(run(db, [unit(["114000110"], [3]), unit(["114061210"], [4])]), "114000110", "114061210")).toEqual([]);
    expect(run(db, [unit(["114001110"], [3]), unit(["114001110"], [4])])).toEqual([]);
    // 特例条件あり：往診料と訪問診療料の同じ日（A46。急変の往診は算定できる）／在宅酸素と酸素吸入の同じ月（A51）／救急搬送診療料と往診料の同じ単位（A54）
    // 3 つとも例外の決まり（EM §2-12 の HP-01・HP-35・HP-14）の組なので、確かめることを挙げた条件つきの文になる（段 15a。利用者の判断 2026-11-22）
    expect(pairOf(run(db, [unit(["114000110"], [3]), unit(["114001110"], [3])]), "114000110", "114001110")).toEqual([["G05.exception_check", "条件つき", "114000110", "114001110"]]);
    expect(pairOf(run(db, [unit(["114003710"], [3]), unit(["140005610"], [9])]), "114003710", "140005610")).toEqual([["G05.exception_check", "条件つき", "114003710", "140005610"]]);
    expect(pairOf(run(db, [unit(["114000110", "114003010"], [3])]), "114000110", "114003010")).toEqual([["G05.exception_check", "条件つき", "114000110", "114003010"]]);
    // 包括の特例条件あり：1 日につき・同一月内の単位のグループから、特例条件ありの行を 1 つずつ探して置く
    for (const [u, key] of [["1", "G04.day_cond"], ["2", "G04.month_cond"]]) {
      const row = db.prepare("SELECT h.code parent, k.code child FROM hojo h JOIN houkatsu k ON k.snapshot = h.snapshot AND k.group_no = h.group1 WHERE h.unit1 = ? AND k.tokurei = '1' AND h.created_on <= ? AND k.created_on <= ? ORDER BY h.code, k.code LIMIT 1").get(u, START, START) as { parent: string; child: string };
      expect(pairOf(run(db, [unit([row.parent], [3]), unit([row.child], [3])]).filter((f) => f.check === "G04" && f.codes[0] === row.parent), row.parent, row.child), `${row.parent}×${row.child}`).toEqual([[key, "条件つき", row.parent, row.child]]);
    }
    // 手術前 1 週間の包括（A38・A39）は、点検しない
    expect(run(db, [unit(["113004110"], [3]), unit(["160000310"], [3])]).filter((f) => f.codes[0] === "113004110")).toEqual([]);
    db.close();
  });

  withData("(d) 完了条件：届出の区分が不明（R12 は情報不足で止まる）でも、在宅医療DX情報活用加算と電子的診療情報連携体制整備加算（再診）の背反が出る", () => {
    const db = openMasters(file)!;
    // 訪問診療料＋DX 加算（6 日・20 日）と、再診料＋電子的診療情報連携体制整備加算（13 日）。どれも版の表にあるコード
    const claim = ukeOf([{ codes: ["114001110", "114746310"], days: [6] }, { codes: ["114001110"], days: [20] }, { codes: ["112007410", "112709570"], days: [13] }]);
    const unknown = check(db, claim, { ...K1.facility, dxTier: { known: false } });
    expect(unknown.mapped.others).toEqual([]);
    expect(handOf(unknown, "R12")).toEqual(["情報不足:facility.dxTier"]);
    expect(unknown.findings.map((f) => [f.messageKey, f.certainty, [...f.codes].sort(), f.source.data])).toEqual([["G05.month", "条件つき", ["112709570", "114746310"], "背反関連テーブル（同一月内）"]]);
    expect([unknown.duplicate, unknown.judged]).toEqual([0, 0]);
    // 届出の区分が分かっていれば、R12 が同じ組を指摘するので、データの側からは出さない（2 回言わない）
    const known = check(db, claim, { ...K1.facility, dxTier: { known: true, value: "1" } });
    expect(handOf(known, "R12")).toEqual(["R12.same_month"]);
    expect([known.findings, known.duplicate]).toEqual([[], 1]);
    db.close();
  });

  withData("(d) 完了条件：在医総管と、処方箋料に付いた一般名処方加算（手書きの表にないコード）の包括が出る。処方箋料も、対象外の単位にあるので出る（C-99）", () => {
    const db = openMasters(file)!;
    // 手書きの表にない一般名処方加算を、マスターで探す
    const names = db.prepare("SELECT code, name FROM shinryo WHERE name LIKE '一般名処方加算%' ORDER BY code").all() as { code: string; name: string }[];
    const outside = names.filter((n) => kubunOfCode(n.code) === undefined);
    expect(outside.map((n) => n.name)).toEqual(["一般名処方加算２（処方箋料）"]);
    const ippan = outside[0].code;
    const claim = ukeOf([{ codes: ["114032510"], days: [20] }, { codes: ["114001110"], days: [20] }, { codes: ["120002910", ippan], days: [20] }]);
    const r = check(db, claim);
    // 処方箋料の単位は、表にない加算があるので、まるごと対象外。R05 は、処方箋料の行を見ていない（指摘も出さない）
    expect(r.mapped.others.map((o) => o.codes)).toEqual([["120002910", ippan]]);
    expect(handOf(r, "R05")).not.toContain("R05.bundled");
    expect(r.findings.filter((f) => f.check === "G04").map((f) => [f.messageKey, f.certainty, f.codes, f.source.data])).toEqual([
      ["G04.month", "条件つき", ["114032510", "120002910"], "包括・被包括テーブル"],
      ["G04.month", "条件つき", ["114032510", ippan], "包括・被包括テーブル"],
    ]);
    expect([r.duplicate, r.judged]).toEqual([0, 0]);
    // 処方箋料だけの単位（版の表のコード）なら、R05 が指摘するので、処方箋料の包括はデータの側からは出さない
    const plain = check(db, ukeOf([{ codes: ["114032510"], days: [20] }, { codes: ["114001110"], days: [20] }, { codes: ["120002910"], days: [20] }]));
    expect(handOf(plain, "R05")).toContain("R05.bundled");
    expect([plain.findings.filter((f) => f.check === "G04"), plain.duplicate]).toEqual([[], 1]);
    db.close();
  });

  withData("(d) 完了条件：初診料と、別の単位に書いた同時の背反（精神科継続外来支援・指導料。X-96）が、条件つきで出る。一覧に載せても言い切らない", () => {
    const db = openMasters(file)!;
    const apart = run(db, [unit(["111000110"], [6]), unit(["180031410"], [6])]).filter((f) => f.codes.includes("180031410"));
    expect(apart.map((f) => [f.messageKey, f.certainty, f.codes, f.params.keep, f.source.data])).toEqual([["G05.same_day", "条件つき", ["111000110", "180031410"], "111000110", "背反関連テーブル（同時）"]]);
    // 取り込んだレセプトの点検の道でも同じ（どちらも手書きの表にないコード）
    const r = check(db, ukeOf([{ codes: ["111000110"], days: [6] }, { codes: ["180031410"], days: [6] }]));
    expect(r.findings.filter((f) => f.codes.includes("180031410")).map((f) => [f.messageKey, f.certainty])).toEqual([["G05.same_day", "条件つき"]]);
    // 別の日なら出ない。同じ単位に書けば、言い切りの候補
    expect(run(db, [unit(["111000110"], [6]), unit(["180031410"], [7])]).filter((f) => f.codes.includes("180031410"))).toEqual([]);
    expect(brief(run(db, [unit(["111000110", "180031410"], [6])]).filter((f) => f.codes.includes("180031410")))).toEqual([["G05.same_unit", "確定", "111000110", "180031410"]]);
    db.close();
  });

  withData("(e) 同梱の UKE 全部と、同梱の症例：G04〜G06 の言い切りの候補は 0 件。条件つきの指摘は、確かめた 2 件だけ", () => {
    const db = openMasters(file)!;
    const cond: string[][] = [];
    let claims = 0;
    for (const name of readdirSync(path.join(root, "fixtures", "uke")).filter((f) => f.endsWith(".UKE")).sort()) {
      parseUke(readFileSync(path.join(root, "fixtures", "uke", name))).claims.forEach((claim, i) => {
        if (claim.unsupported !== undefined || !hasRevision(claim.yearMonth)) return;
        claims++;
        const fs = tables(evaluateGeneric(claim, db, { yearMonth: claim.yearMonth, generation: resolveRevision(claim.yearMonth).generation }, undefined, ALL).findings);
        expect(fs.filter((f) => f.certainty === "確定"), `${name} #${i + 1}`).toEqual([]);
        for (const f of fs) cond.push([`${name} #${i + 1}`, f.messageKey, ...f.codes]);
      });
    }
    expect(claims).toBeGreaterThanOrEqual(13);
    // 1 件ずつ原文で確かめたもの（段 12 の報告）：
    //  ・往診料と、訪問診療料の在宅ターミナルケア加算（注6）が同じ日（K5。往診料と訪問診療料の同じ日の背反の、加算の側の行。表は特例条件あり）
    // 週 4 回の訪問診療（K3。上限 3）は、round-32 codex-2 で出なくなった（連続する 7 日に上限の 2 倍を超えないので、起算日の数え方では正しい請求であり得る）。
    // 週 3 回を超える訪問診療は、手書きの R13 が見ている
    // 段 15a（design.md §13-5）：K5 の組は、例外 HX-02（死亡日の往診だけの日の在宅ターミナルケア加算）に当たるので、条件つきの背反（G05.day_cond）から、要件を挙げた G05.exception_needs_check に変わる
    expect(cond).toEqual([
      ["kokuhoren.UKE #5", "G05.exception_needs_check", "114000110", "114018370"],
    ]);
    // 同梱の症例（区分キーの行をコードに直して掛ける道）でも、言い切りの候補は 0 件
    for (const name of NAMES) expect(run(db, claimOfLines(loadCase(name).lines, rev).claim.units).filter((f) => f.certainty === "確定"), name).toEqual([]);
    db.close();
  });

  withData(
    "(f) 広く掛ける検査：背反・包括の表の組を、単位の外（別の日）に置くと、日・同時の指摘が出ない。単位の中に置くと必ず出て、特例条件ありは条件つき（表ごとに無作為に 2,000 組）",
    () => {
      const db = openMasters(file)!;
      const snapshot = (db.prepare("SELECT snapshot FROM sources WHERE dataset = 'tensuhyo' AND generation = ? ORDER BY snapshot").get(rev.generation) as { snapshot: string }).snapshot;
      const rand = rng(12);
      /** 日で決まる種類（別の日に置いたら、出てはいけない） */
      const DAY_KEYS = /^(G04\.(day|same|surgery)|G05\.(day|same_unit|same_day))(_cond)?$/;
      const N = 2000;
      const report: string[] = [];
      // 背反の 4 表（有効な行。コード①＜コード②の向きで、組ごとに 1 行）
      for (const tani of [1, 2, 3, 4]) {
        const all = db.prepare("SELECT code1 a, code2 b, tokurei FROM haihan WHERE snapshot = ? AND tani = ? AND code1 < code2 AND change <> '1' AND created_on <= ? AND abolished_on >= ?").all(snapshot, tani, START, END) as { a: string; b: string; tokurei: string }[];
        const picked = sample(all, N, rand);
        let apartHits = 0;
        for (const { a, b, tokurei } of picked) {
          const of = (units: Unit[]) => (g05.run({ units }, db, about) as GenericFinding[]).filter((f) => f.source.data.startsWith("背反") && f.codes.includes(a) && f.codes.includes(b));
          // 単位の外：別の日（3 日と 20 日。7 日より離す）
          const apart = of([unit([a], [3]), unit([b], [20])]);
          apartHits += apart.filter((f) => DAY_KEYS.test(f.messageKey) || f.messageKey.startsWith("G05.week")).length;
          expect(apart.filter((f) => DAY_KEYS.test(f.messageKey) || f.messageKey.startsWith("G05.week")), `${tani} ${a}×${b}`).toEqual([]);
          // 単位の中：同じ日（同時の表は、同じ単位と、別の単位の同じ日）。1 週間の表は、2 日あけて
          const mine = (fs: GenericFinding[]) => fs.filter((f) => f.source.data === ["", "背反関連テーブル（1 日につき）", "背反関連テーブル（同一月内）", "背反関連テーブル（同時）", "背反関連テーブル（1 週間につき）"][tani]);
          const sure = tokurei === "0" ? "確定" : "条件つき";
          const c = tokurei === "0" ? "" : "_cond";
          // 特例条件ありで、例外の決まり（EM §2-12）の組に当たる行は、例外の指摘（G05.exception_*）か、条件つきで出る（design.md §13-2。点検が言う exception_none の確定は言い切りの候補で、出荷の一覧に載るまで条件つき）
          const want = (key: string, certainty: string, fs: GenericFinding[]) => {
            const got = brief(mine(fs));
            if (tokurei === "1" && got.length === 1 && got[0][0].startsWith("G05.exception_")) return expect([got[0][0] === "G05.exception_none" || got[0][1] === "条件つき", got[0].slice(2)], `${a}×${b}`).toEqual([true, [a, b]]);
            expect(got, `${a}×${b}`).toEqual([[key, certainty, a, b]]);
          };
          if (tani === 1) want(`G05.day${c}`, sure, of([unit([a], [3]), unit([b], [3])]));
          if (tani === 2) want(`G05.month${c}`, sure, apart);
          if (tani === 3) {
            want(`G05.same_unit${c}`, sure, of([unit([a, b], [3])]));
            want(`G05.same_day${c}`, "条件つき", of([unit([a], [3]), unit([b], [3])]));
          }
          if (tani === 4) expect(brief(mine(of([unit([a], [3]), unit([b], [5])]))), `${a}×${b}`).toEqual([[`G05.week${c}`, "条件つき", a, b]]);
        }
        report.push(`背反 tani=${tani}：有効な組 ${all.length}、掛けた組 ${picked.length}、別の日に置いて出た日・同時・週の指摘 ${apartHits}`);
      }
      // 包括（包括単位①ごと）：親を無作為に選び、そのグループの子を無作為に 1 つ
      for (const u of ["1", "2", "3", "6"]) {
        const parents = db.prepare("SELECT code, group1 FROM hojo WHERE snapshot = ? AND unit1 = ? AND change <> '1' AND created_on <= ? AND abolished_on >= ?").all(snapshot, u, START, END) as { code: string; group1: string }[];
        const kids = db.prepare("SELECT code, tokurei FROM houkatsu WHERE snapshot = ? AND group_no = ? AND change <> '1' AND created_on <= ? AND abolished_on >= ?");
        let pairs = 0;
        let apartHits = 0;
        for (const p of Array.from({ length: N }, () => parents[Math.floor(rand() * parents.length)])) {
          const group = kids.all(snapshot, p.group1, START, END) as { code: string; tokurei: string }[];
          const k = group[Math.floor(rand() * group.length)];
          if (!k || k.code === p.code) continue;
          pairs++;
          const of = (units: Unit[]) => (g04.run({ units }, db, about) as GenericFinding[]).filter((f) => f.codes[0] === p.code && f.codes[1] === k.code);
          const apart = of([unit([p.code], [3]), unit([k.code], [20])]);
          const sure = k.tokurei === "0" && (u === "1" || u === "2") ? "確定" : "条件つき";
          const key = `G04.${{ "1": "day", "2": "month", "3": "same", "6": "surgery" }[u]}${k.tokurei === "0" ? "" : "_cond"}`;
          if (u === "2") expect(brief(apart), `${p.code}>${k.code}`).toEqual([[key, sure, p.code, k.code]]);
          else {
            apartHits += apart.length;
            expect(apart, `${p.code}>${k.code}`).toEqual([]);
            expect(brief(of([unit([p.code], [3]), unit([k.code], [3])])), `${p.code}>${k.code}`).toEqual([[key, sure, p.code, k.code]]);
          }
        }
        report.push(`包括 包括単位①=${u}：親 ${parents.length}、掛けた組 ${pairs}、別の日に置いて出た指摘 ${apartHits}`);
      }
      // 算定回数：表の全部のコードを、1 回ずつ置いたレセプト（上限は 1 回以上）で、回数の指摘が出ない
      const codes = (db.prepare("SELECT DISTINCT code FROM kaisu WHERE snapshot = ?").all(snapshot) as { code: string }[]).map((r) => r.code);
      expect(g06.run({ units: codes.map((code, i) => unit([code], [(i % 28) + 1])) }, db, about)).toEqual([]);
      report.push(`算定回数：${codes.length} コードを 1 回ずつ置いて、出た指摘 0`);
      for (const r of report) note(`広く掛ける検査　${r}`);
      db.close();
    },
    120_000,
  );

  withData("(g) 重くならない：行が 200 あるレセプト（種類の違うコード 200）でも、同じコードを上限いっぱい並べたレセプトでも、1 秒以内", () => {
    const db = openMasters(file)!;
    // 関連の多いコード（背反の行が多い順）から 200
    const codes = (db.prepare("SELECT code1 code FROM haihan GROUP BY code1 ORDER BY count(*) DESC, code1 LIMIT 200").all() as { code: string }[]).map((r) => r.code);
    const wide: Unit[] = codes.map((code, i) => unit([code], [(i % 28) + 1]));
    const many: Unit[] = Array.from({ length: 5000 }, (_, i) => unit([i % 2 ? "114003710" : "114040610"], [(i % 28) + 1]));
    for (const [name, units] of [["コード 200 種類", wide], ["2 つのコードを 5,000 単位", many]] as const) {
      const t0 = performance.now();
      const r = evaluateGeneric({ units }, db, about);
      const ms = performance.now() - t0;
      note(`時間　${name}：${ms.toFixed(0)} ミリ秒、指摘 ${r.findings.length} 件`);
      expect(ms).toBeLessThan(1000);
    }
    db.close();
  });

  withData("(h) 指摘の数の上限（round-32 S-9）：グループ A308031（1 日につき）の親と子を同じ日に 4,990 単位並べた細工でも、2 秒以内・点検ごと 200 件まで・JSON は小さい", () => {
    const db = openMasters(file)!;
    const live = `change <> '1' AND created_on <= '${END}' AND abolished_on >= '${START}'`;
    const snapshot = (db.prepare("SELECT snapshot FROM sources WHERE dataset = 'tensuhyo' AND generation = ? ORDER BY snapshot").get(rev.generation) as { snapshot: string }).snapshot;
    const parents = (db.prepare(`SELECT code FROM hojo WHERE snapshot = ? AND group1 = 'A308031' AND unit1 IN ('1','2','3','6') AND ${live}`).all(snapshot) as { code: string }[]).map((r) => r.code);
    const kids = (db.prepare(`SELECT DISTINCT code FROM houkatsu WHERE snapshot = ? AND group_no = 'A308031' AND ${live}`).all(snapshot) as { code: string }[]).map((r) => r.code).filter((c) => !parents.includes(c));
    const units = [...parents, ...kids].slice(0, 4990).map((code) => unit([code], [1]));
    expect(parents.length).toBeGreaterThan(100);
    const heap = process.memoryUsage().heapUsed;
    const once = () => {
      const [t0, c0] = [performance.now(), process.cpuUsage()];
      const r = evaluateGeneric({ units }, db, { yearMonth: YM, generation: rev.generation });
      return { r, ms: performance.now() - t0, cpu: (({ user, system }) => (user + system) / 1000)(process.cpuUsage(c0)) };
    };
    // 2 回掛けて、速いほうで縛る（並列のテストの中の揺れを除く。2 回目もマスターの引き当てから計算し直す）
    const [a, b] = [once(), once()];
    const { r, ms, cpu } = a.cpu <= b.cpu ? a : b;
    const json = JSON.stringify(genericView(r, null));
    note(`上限　細工した ${units.length} 単位：${ms.toFixed(0)} ミリ秒（CPU ${cpu.toFixed(0)} ミリ秒）、返した指摘 ${r.findings.length} 件、数だけ ${JSON.stringify(r.omitted)}、JSON ${json.length} 文字、ヒープの増加 ${((process.memoryUsage().heapUsed - heap) / 1e6).toFixed(0)}MB`);
    expect(r.findings.filter((f) => f.check === "G04").length).toBe(FINDING_LIMIT);
    expect(r.omitted?.find((o) => o.check === "G04")?.count).toBeGreaterThan(1_000_000);
    // 並列のテストの中では壁時計が延びるので、この点検が使った CPU の時間で縛る
    expect(cpu).toBeLessThan(2000);
    expect((process.memoryUsage().heapUsed - heap) / 1e6).toBeLessThan(300);
    expect(json.length).toBeLessThan(1_000_000);
    db.close();
  });

  it("データがないときは、飛ばした数を表示する（黙って通さない）", () => {
    if (!has) process.stderr.write(`段 12 の実データのテストを ${skipped} 件飛ばした（RESEMEN_MASTER_DIR に masters.db がない）\n`);
    expect(has ? 0 : skipped).toBe(has ? 0 : 11);
  });
});
