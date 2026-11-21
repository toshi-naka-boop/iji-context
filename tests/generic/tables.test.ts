// 段 12：G04（包括）・G05（背反）・G06（算定回数）。design.md §12-3・§12-6 の当たる側・当たらない側。
// データは同梱しないので、EM §2-11 の錨の組だけで作った小さな表（tests/generic/small-tensuhyo.ts）で確かめる。実データでの確認は tests/generic/tables-real.test.ts。
// わざと誤りを入れた合成のレセプト（単位・コード・算定日）をここで作り、入れた誤りだけが出ること、同じ組を単位の外（別の日）に置くと出ないことを見る
import { describe, expect, it } from "vitest";
import { CERTAIN, evaluateGeneric } from "../../src/generic";
import { groupSameChild } from "../../src/generic/overlap";
import { genericScopeOf } from "../../src/generic/scope";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import type { GenericFinding } from "../../src/generic/types";
import { GENERIC_SCOPE_NOTE, GENERIC_TEXT_CERTAIN, genericText } from "../../src/messages";
import { YM } from "../helpers/period";
import { put, source, GEN } from "./small-masters";
import { C, putHaihan, tensuhyoMasters } from "./small-tensuhyo";

const about = { yearMonth: YM, generation: GEN };
/** 言い切りの候補の種類を、全部一覧に載せたつもりで掛ける（候補かどうかを見るため。出荷の一覧は 4 種類だけ） */
const ALL: ReadonlySet<string> = new Set(Object.keys(GENERIC_TEXT_CERTAIN));
type Unit = TimedClaim["units"][number];
/** 単位 1 つ：コードの並びと、算定日（同じ日を重ねれば、その日の回数） */
const unit = (codes: string[], days: number[]): Unit => {
  const d = Array.from({ length: 31 }, () => 0);
  for (const n of days) d[n - 1]++;
  return { items: codes.map((code) => ({ kind: "SI" as const, code })), count: days.length, days: d };
};
const run = (units: Unit[], db = tensuhyoMasters(), certain = ALL): GenericFinding[] => evaluateGeneric({ units }, db, about, undefined, certain).findings.filter((f) => f.check !== "G01");
/** 指摘の要点：種類・言い切りの候補か・コード */
const brief = (fs: GenericFinding[]) => fs.map((f) => [f.messageKey, f.certainty, ...f.codes]);

describe("骨組み", () => {
  it("出荷の一覧（config/generic-checks.json の certain）は標本で確かめた 4 種類だけ：一覧にない種類は、G04〜G06 がどう判定しても条件つきで出る。文も言い切らない", () => {
    // 2026-11-21 の利用者の判断（design/iji-context/sources/research/certain-sample.md で 30 行中 30 行が原文と合った種類）
    expect([...CERTAIN].sort()).toEqual(["G03.clinic_only", "G03.inpatient_only", "G05.same_unit", "G06.day"]);
    const fs = run([unit([C.zaiisoukan], [20]), unit([C.shohosen], [5]), unit([C.sanso], [20]), unit([C.jikochu], [20]), unit([C.handan], [5, 19])], tensuhyoMasters(), CERTAIN);
    expect(brief(fs)).toEqual([["G04.month", "条件つき", C.zaiisoukan, C.shohosen], ["G05.month", "条件つき", C.sanso, C.jikochu], ["G06.month", "条件つき", C.handan]]);
    for (const f of fs) {
      expect(genericText(f)).not.toMatch(/できません|超えています/);
      expect(genericText(f)).toMatch(/確かめてください$/);
    }
    // 一覧に載せた種類は、言い切りの文になる
    expect(genericText({ ...fs[0], certainty: "確定" })).toBe(`コード ${C.shohosen} は、同じ月の ${C.zaiisoukan} に含まれるので、別に算定できません。同じレセプトに両方あります`);
  });

  it("診療年月の世代の電子点数表がなければ、動かさない（近い世代で代用しない）。準備ができていなければ、動かさない", () => {
    const r = evaluateGeneric({ units: [unit([C.zaiisoukan], [20])] }, tensuhyoMasters(), { yearMonth: YM, generation: "R6" });
    expect(r.notRun.filter((n) => ["G04", "G05", "G06"].includes(n.check)).map((n) => [n.check, n.reason])).toEqual([["G04", "noSnapshot"], ["G05", "noSnapshot"], ["G06", "noSnapshot"]]);
    const db = tensuhyoMasters();
    db.prepare("UPDATE checks_ready SET ready = 0, reason = '錨がない：手作りの表' WHERE check_id = 'G05'").run();
    const r2 = evaluateGeneric({ units: [unit([C.sanso], [20]), unit([C.jikochu], [20])] }, db, about);
    expect([r2.ran.map((x) => x.check), r2.findings.filter((f) => f.check === "G05")]).toEqual([["G01", "G04", "G06"], []]);
  });

  it("医薬品・特定器材の行は数えない（電子点数表は診療行為の表）", () => {
    expect(run([{ items: [{ kind: "IY", code: C.zaiisoukan }], count: 1, days: unit([], [20]).days }, { items: [{ kind: "TO", code: C.shohosen }], count: 1, days: unit([], [5]).days }])).toEqual([]);
  });
});

describe("G04 包括", () => {
  it("同一月内（A34・A35）：在医総管と処方箋料が同じレセプトにあれば、別の日でも出る。言い切りの候補。出どころは表の名前と鍵", () => {
    const fs = run([unit([C.zaiisoukan], [20]), unit([C.houmon], [6, 20]), unit([C.shohosen], [6])]);
    expect(fs).toEqual([
      {
        check: "G04",
        kind: "包括",
        certainty: "確定",
        units: [0, 2],
        codes: [C.zaiisoukan, C.shohosen],
        messageKey: "G04.month",
        params: { parent: C.zaiisoukan, child: C.shohosen },
        source: { data: "包括・被包括テーブル", ref: `グループ番号=C002001, 診療行為コード=${C.shohosen}／医科診療行為マスター補助マスターテーブル 診療行為コード=${C.zaiisoukan}, 包括単位①=2` },
      },
    ]);
  });

  it("1 日につき（A40・A41）：同じ算定日に両方あれば、言い切りの候補。別の日なら出ない。算定日を持たない単位には掛けない", () => {
    expect(brief(run([unit([C.jutsugo], [7, 8]), unit([C.nyou], [8])]))).toEqual([["G04.day", "確定", C.jutsugo, C.nyou]]);
    expect(run([unit([C.jutsugo], [7, 8]), unit([C.nyou], [8])])[0].params).toEqual({ parent: C.jutsugo, child: C.nyou, days: "8" });
    expect(run([unit([C.jutsugo], [7, 8]), unit([C.nyou], [9])])).toEqual([]);
    expect(run([unit([C.jutsugo], [7, 8]), { items: [{ kind: "SI", code: C.nyou }] }])).toEqual([]);
  });

  it("同時（A36・A37）・1 手術につき（A42・A43）：同じ算定日に両方あれば、条件つき（一覧に載せても言い切らない）。同じ単位でも同じ。別の日なら出ない", () => {
    expect(brief(run([unit([C.naishikyo], [7]), unit([C.gas], [7])]))).toEqual([["G04.same", "条件つき", C.naishikyo, C.gas]]);
    expect(brief(run([unit([C.naishikyo, C.gas], [7])]))).toEqual([["G04.same", "条件つき", C.naishikyo, C.gas]]);
    expect(run([unit([C.naishikyo], [7]), unit([C.gas], [8])])).toEqual([]);
    expect(brief(run([unit([C.chokucho], [7]), unit([C.jinkoukoumon], [7])]))).toEqual([["G04.surgery", "条件つき", C.chokucho, C.jinkoukoumon]]);
    expect(run([unit([C.chokucho], [7]), unit([C.jinkoukoumon], [21])])).toEqual([]);
  });

  it("手術前 1 週間（A38・A39）：いつからの 1 週間かが決まらないので、点検しない（同じ日にあっても出ない）", () => {
    expect(run([unit([C.jutsuzen], [7]), unit([C.nyou], [7])])).toEqual([]);
  });

  it("親だけ・子だけなら出ない。子の側の行の順は関係ない", () => {
    expect(run([unit([C.zaiisoukan], [20])])).toEqual([]);
    expect(run([unit([C.shohosen], [20])])).toEqual([]);
    expect(brief(run([unit([C.shohosen], [6]), unit([C.zaiisoukan], [20])]))).toEqual([["G04.month", "確定", C.zaiisoukan, C.shohosen]]);
  });

  it("特例条件ありの行は、同一月内でも条件つき（条件の中身はデータにない）", () => {
    const db = tensuhyoMasters();
    db.prepare("UPDATE houkatsu SET tokurei = '1' WHERE code = ?").run(C.shohosen);
    const fs = run([unit([C.zaiisoukan], [20]), unit([C.shohosen], [6])], db);
    expect(brief(fs)).toEqual([["G04.month_cond", "条件つき", C.zaiisoukan, C.shohosen]]);
    expect(genericText(fs[0])).toContain("条件によっては");
  });

  it("画面では、同じ子の指摘を 1 つにまとめる（親が複数あるとき）。言い切りと条件つきは分ける", () => {
    const f = (check: string, certainty: string, ...codes: string[]) => ({ check, certainty, codes: codes.map((code) => ({ code })) });
    const list = [f("G01", "条件つき", "x"), f("G04", "条件つき", "p1", "c"), f("G05", "条件つき", "p1", "c"), f("G04", "条件つき", "p2", "c"), f("G04", "確定", "p3", "c"), f("G04", "条件つき", "p1", "d")];
    expect(groupSameChild(list).map((g) => g.map((x) => `${x.check}:${x.codes.map((c) => c.code).join(">")}`))).toEqual([["G01:x"], ["G04:p1>c", "G04:p2>c"], ["G05:p1>c"], ["G04:p3>c"], ["G04:p1>d"]]);
  });
});

describe("G05 背反", () => {
  it("1 日につき（A44）：初診料と訪問診療料が同じ算定日にあれば、言い切りの候補。残す側（背反区分 1＝コード①）を値に入れる。別の日なら出ない", () => {
    const fs = run([unit([C.shoshin], [6]), unit([C.houmon], [6, 20])]);
    expect(fs).toEqual([
      {
        check: "G05",
        kind: "背反",
        certainty: "確定",
        units: [0, 1],
        codes: [C.shoshin, C.houmon],
        messageKey: "G05.day",
        params: { a: C.shoshin, b: C.houmon, keep: C.shoshin, days: "6" },
        source: { data: "背反関連テーブル（1 日につき）", ref: `診療行為コード①=${C.shoshin}, 診療行為コード②=${C.houmon}` },
      },
    ]);
    expect(run([unit([C.shoshin], [5]), unit([C.houmon], [6, 20])])).toEqual([]);
    // 背反区分 2（A45）：残す側はコード②
    expect(run([unit([C.saishin], [20]), unit([C.houmon], [6, 20])])[0].params.keep).toBe(C.houmon);
  });

  it("特例条件あり（A46）：往診料と訪問診療料が同じ日にあっても、条件つきでしか出ない（急変の往診は算定できる。条件の中身はデータにない）", () => {
    const fs = run([unit([C.oushin], [6]), unit([C.houmon], [6, 20])]);
    expect(brief(fs)).toEqual([["G05.day_cond", "条件つき", C.oushin, C.houmon]]);
    expect(fs[0].params.keep).toBe("いずれか一方");
    expect(run([unit([C.oushin], [7]), unit([C.houmon], [6, 20])])).toEqual([]);
  });

  it("同一月内（A47）：在宅酸素と在宅自己注射の指導管理料が同じレセプトにあれば、別の日でも言い切りの候補。特例条件あり（A51）は条件つき", () => {
    expect(brief(run([unit([C.sanso], [6]), unit([C.jikochu], [20])]))).toEqual([["G05.month", "確定", C.sanso, C.jikochu]]);
    expect(brief(run([unit([C.sanso], [6]), unit([C.sansoKyunyu], [20])]))).toEqual([["G05.month_cond", "条件つき", C.sanso, C.sansoKyunyu]]);
  });

  it("両向きに行がある組（A48・A49）は、1 回だけ言う。残す側は、どちらの向きの行で見ても同じ（看取り加算）", () => {
    const fs = run([unit([C.shibou], [22]), unit([C.mitori], [22])]);
    expect(fs).toHaveLength(1);
    expect([fs[0].messageKey, fs[0].certainty, fs[0].params.keep, [...fs[0].codes].sort()]).toEqual(["G05.month", "確定", C.mitori, [C.mitori, C.shibou].sort()]);
    // 片向きの行しかない組（コードの大きいほうがコード①）でも、同じに出る
    const db = tensuhyoMasters();
    db.prepare("DELETE FROM haihan WHERE code1 = ? AND code2 = ?").run(C.mitori, C.shibou);
    const one = run([unit([C.shibou], [22]), unit([C.mitori], [22])], db);
    expect([one.length, one[0].params.keep, one[0].codes]).toEqual([1, C.mitori, [C.shibou, C.mitori]]);
  });

  it("同時（A52・A53）：同じ算定単位に両方あれば、言い切りの候補。別の単位でも、同じ算定日なら条件つき。別の日なら出ない", () => {
    const same = run([unit([C.oushin, C.kyodo], [6])]);
    expect(brief(same)).toEqual([["G05.same_unit", "確定", C.oushin, C.kyodo]]);
    expect([same[0].units, same[0].params.keep]).toEqual([[0], C.kyodo]);
    const apart = run([unit([C.oushin], [6]), unit([C.kyodo], [6])]);
    expect(brief(apart)).toEqual([["G05.same_day", "条件つき", C.oushin, C.kyodo]]);
    expect(genericText(apart[0])).toContain("別の算定単位ですが、同じ日（6日）に両方あります");
    expect(run([unit([C.oushin], [6]), unit([C.kyodo], [7])])).toEqual([]);
    // 特例条件あり（A54）は、同じ単位でも条件つき
    expect(brief(run([unit([C.oushin, C.kyukyu], [6])]))).toEqual([["G05.same_unit_cond", "条件つき", C.oushin, C.kyukyu]]);
  });

  it("1 週間につき（A58・A56）：7 日以内に両方あれば、条件つき（暦の週をまたいでも出る。言い切らない）。7 日離れていれば出ない", () => {
    // 3 日は土曜、5 日は月曜（暦の週は別）
    const fs = run([unit([C.bnp], [3]), unit([C.anp], [5])]);
    expect(brief(fs)).toEqual([["G05.week", "条件つき", C.bnp, C.anp]]);
    expect(fs[0].params).toMatchObject({ dayA: "3", dayB: "5" });
    expect(run([unit([C.bnp], [3]), unit([C.anp], [9])])).toHaveLength(1);
    expect(run([unit([C.bnp], [3]), unit([C.anp], [10])])).toEqual([]);
    expect(brief(run([unit([C.shoshin], [1]), unit([C.gairaiReha], [6])]))).toEqual([["G05.week_cond", "条件つき", C.shoshin, C.gairaiReha]]);
  });

  it("行の新設・廃止の年月日で、診療年月に有効な行だけを使う。月の途中で新設された行は、条件つき", () => {
    const pair = [unit([C.pf4a], [6]), unit([C.pf4b], [6])];
    const ym = YM.replace("-", "");
    const withRow = (more: Record<string, string>) => {
      const db = tensuhyoMasters();
      db.prepare("DELETE FROM haihan WHERE tani = 3").run();
      putHaihan(db, "20261001", 1, C.pf4a, C.pf4b, "3", "0", more);
      return brief(run(pair, db));
    };
    expect(withRow({})).toEqual([["G05.day", "確定", C.pf4a, C.pf4b]]);
    // 診療年月より後に新設された行・診療年月より前に廃止された行・抹消の行は、使わない
    expect(withRow({ created_on: "20991201" })).toEqual([]);
    expect(withRow({ abolished_on: "20100331" })).toEqual([]);
    expect(withRow({ change: "1" })).toEqual([]);
    expect(withRow({ created_on: `${ym}15` })).toEqual([["G05.day", "条件つき", C.pf4a, C.pf4b]]);
    expect(withRow({ abolished_on: `${ym}15` })).toEqual([["G05.day", "条件つき", C.pf4a, C.pf4b]]);
  });

  it("診療年月より後の 1 枚で代えているとき：「変更」の行（いつ変わったかがデータにない）は条件つき。「異動なし」の行は言い切りの候補のまま", () => {
    const db = tensuhyoMasters("20261102");
    const pair = [unit([C.sanso], [6]), unit([C.jikochu], [20])];
    expect(brief(run(pair, db))).toEqual([["G05.month", "確定", C.sanso, C.jikochu]]);
    db.prepare("UPDATE haihan SET change = '5' WHERE code1 = ?").run(C.sanso);
    expect(brief(run(pair, db))).toEqual([["G05.month", "条件つき", C.sanso, C.jikochu]]);
  });
});

describe("G06 算定回数", () => {
  it("日（A60）：訪問診療料が同じ日に 2 回あれば、言い切りの候補（単位をまたいで足す）。別の日に 1 回ずつなら出ない", () => {
    const fs = run([unit([C.houmon], [6]), unit([C.houmon], [6, 20])]);
    expect(fs).toEqual([
      {
        check: "G06",
        kind: "回数",
        certainty: "確定",
        units: [0, 1],
        codes: [C.houmon],
        messageKey: "G06.day",
        params: { code: C.houmon, limit: "1", days: "6", count: "2" },
        source: { data: "算定回数テーブル", ref: `診療行為コード=${C.houmon}, 算定単位コード=121` },
      },
    ]);
    expect(run([unit([C.houmon], [6, 6])]).map((f) => f.messageKey)).toEqual(["G06.day"]);
    expect(run([unit([C.houmon], [6]), unit([C.houmon], [20])])).toEqual([]);
  });

  it("月（A62・A64）：判断料が同じレセプトに 2 回あれば、言い切りの候補。1 回なら出ない。算定日を持たない単位も、月の回数には数える", () => {
    expect(brief(run([unit([C.handan], [6]), unit([C.handan], [20])]))).toEqual([["G06.month", "確定", C.handan]]);
    expect(run([unit([C.handan], [6]), unit([C.handan], [20])])[0].params).toEqual({ code: C.handan, limit: "1", count: "2" });
    expect(run([unit([C.handan], [6]), unit([C.dx], [6])])).toEqual([]);
    expect(brief(run([{ items: [{ kind: "SI", code: C.dx }] }, { items: [{ kind: "SI", code: C.dx }] }]))).toEqual([["G06.month", "確定", C.dx]]);
  });

  it("週（A61。特例条件あり）：暦の週（日曜〜土曜）に上限を超え、かつ連続する 7 日に上限の 2 倍を超えるときだけ、条件つき", () => {
    // 4 日（日）〜10 日（土）の週に 7 回（上限 3 の 2 倍を超える）
    const fs = run([unit([C.houmon], [4, 5, 6, 7, 8, 9, 10])]);
    expect(brief(fs)).toEqual([["G06.week_cond", "条件つき", C.houmon]]);
    expect(fs[0].params).toEqual({ code: C.houmon, limit: "3", days: "4・5・6・7・8・9・10", count: "7" });
    // 同じ週に 4 回（上限は超えるが 2 倍以下）：起算日から数える 7 日の期間が 2 つに分かれていれば正しい請求であり得るので、出ない（round-32 codex-2）
    expect(run([unit([C.houmon], [5, 6, 7, 8])])).toEqual([]);
    // 2 日（金）・3 日（土）｜4 日（日）・5 日（月）：暦の週では 2 回ずつ
    expect(run([unit([C.houmon], [2, 3, 4, 5])])).toEqual([]);
    expect(run([unit([C.houmon], [5, 6, 7])])).toEqual([]);
    // 特例条件のない週の上限でも、言い切らない（数え方がデータにない）
    const db = tensuhyoMasters();
    db.prepare("UPDATE kaisu SET tokurei = '0' WHERE unit_code = 138").run();
    expect(brief(run([unit([C.houmon], [4, 5, 6, 7, 8, 9, 10])], db))).toEqual([["G06.week", "条件つき", C.houmon]]);
  });

  it("週の上限 1（round-32 codex-2）：同じ週の 2 回（別々の期間であり得る）は出ない。同じ週に 3 回あれば出る", () => {
    const db = tensuhyoMasters();
    db.prepare("UPDATE kaisu SET tokurei = '0', limit_count = 1 WHERE unit_code = 138").run();
    db.prepare("DELETE FROM kaisu WHERE unit_code = 121").run();
    // 5 日（月）・8 日（木）：同じ暦の週に 2 回。指示日から 7 日の期間が 2 つなら正しい
    expect(run([unit([C.houmon], [5, 8])], db)).toEqual([]);
    // 5 日・6 日・8 日：同じ週に 3 回（7 日の中に、上限 1 の 2 倍を超える回数）
    const fs = run([unit([C.houmon], [5, 6, 8])], db);
    expect(brief(fs)).toEqual([["G06.week", "条件つき", C.houmon]]);
    expect(fs[0].params).toEqual({ code: C.houmon, limit: "1", days: "5・6・8", count: "3" });
  });

  it("特例条件ありの上限は、日・月でも条件つき", () => {
    const db = tensuhyoMasters();
    db.prepare("UPDATE kaisu SET tokurei = '1' WHERE unit_code IN (121, 131)").run();
    expect(brief(run([unit([C.houmon], [6, 6]), unit([C.handan], [6, 20])], db))).toEqual([["G06.day_cond", "条件つき", C.houmon], ["G06.month_cond", "条件つき", C.handan]]);
  });

  it("レセプト 1 枚から数えられない単位（2 月以上・一連・入院中・患者当り など）は、言わない", () => {
    const db = tensuhyoMasters();
    for (const u of [142, 143, 144, 145, 146, 147, 148, 141, 133, 132, 134, 135, 53, 56, 159, 150, 151]) put(db, "kaisu", "20261001", { change: "0", created_on: "20100401", abolished_on: "99999999", code: C.bnp, unit_code: u, limit_count: 1, tokurei: "0" });
    expect(run([unit([C.bnp], [1, 2, 3, 4, 5, 6, 7, 8])], db)).toEqual([]);
  });

  it("医科診療行為マスターの上限回数（A17。単位が仕様にない）：レセプトの回数が超えていれば、条件つき。月の上限で同じことを言ったコードには言わない", () => {
    expect(run([unit([C.tokutei], [6, 20])])).toEqual([]);
    const fs = run([unit([C.tokutei], [6, 13, 20])]);
    expect(brief(fs)).toEqual([["G06.master_limit", "条件つき", C.tokutei]]);
    expect(fs[0].source).toEqual({ data: "医科診療行為マスター", ref: `診療行為コード=${C.tokutei}, 上限回数` });
    const db = tensuhyoMasters();
    db.prepare("UPDATE shinryo SET limit_count = 1 WHERE code = ?").run(C.handan);
    expect(run([unit([C.handan], [6, 20])], db).map((f) => f.messageKey)).toEqual(["G06.month"]);
  });

  it("数え方は少なく数える側：同じ単位に同じコードが 2 行あっても 1 回分", () => {
    expect(run([unit([C.handan, C.handan], [6])])).toEqual([]);
  });

  it("医科診療行為マスターの、診療年月の世代の 1 枚がなければ、動かさない", () => {
    const db = tensuhyoMasters();
    db.prepare("DELETE FROM sources WHERE dataset = 'shinryo'").run();
    source(db, "shinryo", "20261001", "R6");
    expect(evaluateGeneric({ units: [unit([C.handan], [6, 20])] }, db, about).notRun.find((n) => n.check === "G06")).toMatchObject({ reason: "noSnapshot" });
  });
});

describe("細工した請求でも重くならない", () => {
  it("同じコードを上限いっぱい並べた請求・コードの種類が多い請求（200 行）：1 秒以内。指摘の数は、コード・組ごとに 1 件", () => {
    const db = tensuhyoMasters();
    const many: Unit[] = Array.from({ length: 5000 }, (_, i) => unit([i % 2 ? C.sanso : C.jikochu], [(i % 28) + 1]));
    const codes = Object.values(C);
    const wide: Unit[] = Array.from({ length: 200 }, (_, i) => unit([codes[i % codes.length]], [(i % 28) + 1]));
    for (const units of [many, wide]) {
      const t0 = performance.now();
      const fs = run(units, db);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(new Set(fs.map((f) => `${f.messageKey}:${f.codes.join(":")}`)).size).toBe(fs.length);
      expect(fs.length).toBeLessThan(60);
    }
  });
});

describe("点検していないこと（round-32 O-19）", () => {
  it("G04〜G06 が動いたら、点検していないことを点検の範囲（scope.notDone）に出す。月末の点検・算定プレビューの行（区分キーの行）でも同じ", () => {
    const db = tensuhyoMasters();
    const claim: TimedClaim = { units: [unit([C.houmon], [6])] };
    const result = evaluateGeneric(claim, db, about);
    expect(result.ran.map((r) => r.check)).toEqual(expect.arrayContaining(["G04", "G05", "G06"]));
    const notDone = genericScopeOf(claim, db, about, result).notDone;
    for (const [id, kind] of [["G04", "包括"], ["G05", "背反"], ["G06", "回数"]]) expect(notDone).toContain(`${id}（${kind}）が点検していないこと：${GENERIC_SCOPE_NOTE[id]}`);
    // 動かなかった点検の断りは出さない
    expect(genericScopeOf(claim, null, about, evaluateGeneric(claim, null, about)).notDone).toEqual([]);
  });
});
