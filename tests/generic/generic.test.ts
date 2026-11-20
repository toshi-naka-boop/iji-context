// データで動く点検（design.md §12-2・§12-3）の骨組みと G01（コード）、名称、対象外の単位のコードの引き方。
// データは同梱しないので、手で作った数行の表（tests/generic/small-masters.ts。EM に採用済みのコードだけ）で確かめる。実データでの確認は tests/generic/real.test.ts
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { r2026 } from "../../src/engine/revisions/r2026";
import { CERTAIN, evaluateGeneric, unitsOfLines } from "../../src/generic";
import { outsideOf, rowNamesOf, sheetNotesOf } from "../../src/generic/lookup";
import type { GenericCheck, GenericClaim, GenericFinding } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { GENERIC_TEXT, genericText } from "../../src/messages";
import { loadCase, without } from "../engine/helpers";
import { YM } from "../helpers/period";
import { COMMENT, DEVICE, DISEASE, DRUG, GEN, put, putShinryo, smallMasters, source } from "./small-masters";

const about = { yearMonth: YM, generation: GEN };
const HOUMON = r2026.codes.C001_1I.primary;
const OUSHIN = r2026.codes.C000.primary;
/** どのマスターにもないコード（作り物） */
const UNKNOWN = "100000000";
const claimOf = (...units: [kind: "SI" | "IY" | "TO", code: string][][]): GenericClaim => ({ units: units.map((items) => ({ items: items.map(([kind, code]) => ({ kind, code })) })) });
const NOT_BUILT = ["G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09"];

describe("evaluateGeneric の骨組み", () => {
  it("masters.db がなければ、どの点検も動かさない。「指摘なし」ではなく、動かさなかった点検と理由を返す", () => {
    const r = evaluateGeneric(claimOf([["SI", UNKNOWN]]), null, about);
    expect(r.findings).toEqual([]);
    expect(r.ran).toEqual([]);
    expect(r.notRun.map((n) => [n.check, n.reason])).toEqual([["G01", "noMasters"], ...NOT_BUILT.map((c) => [c, "notBuilt"])]);
    expect(genericView(r, null).notRun[0]).toEqual({ check: "G01", kind: "コード", reason: "noMasters", text: "マスターが入っていないので、していません" });
  });

  it("この段で動くのは G01 だけ。G02〜G09 は「まだ入っていない」として返す（動いたことにしない）", () => {
    const db = smallMasters();
    const r = evaluateGeneric(claimOf([["SI", HOUMON]]), db, about);
    expect(r.ran).toEqual([{ check: "G01", kind: "コード" }]);
    expect(r.notRun.map((n) => [n.check, n.reason])).toEqual(NOT_BUILT.map((c) => [c, "notBuilt"]));
  });

  it("準備ができていない点検（checks_ready が偽・行がない）と、診療年月の世代の 1 枚がない点検は動かさない", () => {
    const db = smallMasters();
    db.prepare("UPDATE checks_ready SET ready = 0, reason = '錨がない：手作りの表' WHERE check_id = 'G01'").run();
    expect(evaluateGeneric(claimOf([["SI", UNKNOWN]]), db, about).notRun[0]).toEqual({ check: "G01", kind: "コード", reason: "notReady", detail: "錨がない：手作りの表" });
    db.prepare("DELETE FROM checks_ready").run();
    expect(evaluateGeneric(claimOf([["SI", UNKNOWN]]), db, about).notRun[0]).toMatchObject({ check: "G01", reason: "notReady" });
    // 世代の組がない（近い世代で代用しない）
    const r = evaluateGeneric(claimOf([["SI", UNKNOWN]]), smallMasters(), { yearMonth: YM, generation: "R6" });
    expect([r.findings, r.ran]).toEqual([[], []]);
    expect(r.notRun[0]).toMatchObject({ check: "G01", reason: "noSnapshot" });
  });

  it("言い切り（確定）は、一覧（config/generic-checks.json の certain）に載った種類だけ。一覧は空で、点検が確定と判定しても条件つきで出る", () => {
    expect([...CERTAIN]).toEqual([]);
    const sure: GenericCheck = { id: "G01", kind: "コード", run: () => [{ check: "G01", kind: "コード", certainty: "確定", units: [0], codes: ["x"], messageKey: "G01.fake", params: {}, source: { data: "shinryo", ref: "code=x" } }] };
    const db = smallMasters();
    expect(evaluateGeneric(claimOf(), db, about, [sure]).findings.map((f) => f.certainty)).toEqual(["条件つき"]);
    expect(evaluateGeneric(claimOf(), db, about, [sure], new Set(["G01.fake"])).findings.map((f) => f.certainty)).toEqual(["確定"]);
    // 一覧に載っていても、点検が条件つきと判定したものは上げない
    const soft: GenericCheck = { ...sure, run: (...a) => (sure.run(...a) as GenericFinding[]).map((f) => ({ ...f, certainty: "条件つき" })) };
    expect(evaluateGeneric(claimOf(), db, about, [soft], new Set(["G01.fake"])).findings.map((f) => f.certainty)).toEqual(["条件つき"]);
  });

  it("区分キーの行は、codes[kubun].primary でコードに直して掛ける。コードに直せない区分（包括の検査）は掛けない", () => {
    const u = unitsOfLines([{ kubun: "C001_1I" }, { kubun: "D007_5" }, { kubun: "C000" }], r2026);
    expect(u.units.map((x) => x.items)).toEqual([[{ kind: "SI", code: HOUMON }], [{ kind: "SI", code: OUSHIN }]]);
    expect(evaluateGeneric(u, smallMasters(), about).findings).toEqual([]);
  });
});

describe("G01 コード（design.md §12-1「版と履歴」・§12-3）", () => {
  it("診療年月に使う 1 枚にあるコードには、何も言わない（診療行為・医薬品・特定器材。それぞれのマスターで見る）", () => {
    const r = evaluateGeneric(claimOf([["SI", HOUMON], ["IY", DRUG]], [["TO", DEVICE]]), smallMasters(), about);
    expect([r.findings, r.ran.map((x) => x.check)]).toEqual([[], ["G01"]]);
  });

  it("持っているどの 1 枚にもないコード：条件つきで出す（言い切らない）。当たる単位をまとめ、出どころ（表と鍵）を添える", () => {
    const r = evaluateGeneric(claimOf([["SI", HOUMON]], [["SI", UNKNOWN]], [["IY", DRUG], ["SI", UNKNOWN]]), smallMasters(), about);
    expect(r.findings).toEqual([
      { check: "G01", kind: "コード", certainty: "条件つき", units: [1, 2], codes: [UNKNOWN], messageKey: "G01.not_in_any", params: { code: UNKNOWN, what: "診療行為" }, source: { data: "shinryo", ref: `code=${UNKNOWN}` } },
    ]);
    expect(genericText(r.findings[0])).toBe(`コード ${UNKNOWN}（診療行為）は、持っているどの版のマスターにもありません。打ち間違いか、マスターの更新もれを確かめてください`);
  });

  it("行の種類ごとのマスターで見る：医薬品のコードを診療行為の行に書くと、診療行為のマスターにないコードとして出る", () => {
    const r = evaluateGeneric(claimOf([["SI", DRUG]], [["IY", HOUMON]], [["TO", DRUG]]), smallMasters(), about);
    expect(r.findings.map((f) => [f.messageKey, f.params.what, f.source.data])).toEqual([["G01.not_in_any", "診療行為", "shinryo"], ["G01.not_in_any", "医薬品", "iyakuhin"], ["G01.not_in_any", "特定器材", "tokutei"]]);
  });

  /** 診療年月の前（10 月 1 日）と後（11 月 2 日）の 2 枚を持つ医科診療行為マスター。前にだけ往診料、後にだけ訪問診療料の別コード */
  const twoSheets = () => {
    const db = smallMasters();
    source(db, "shinryo", "20261102");
    for (const kubun of Object.keys(r2026.codes)) if (kubun !== "C000") putShinryo(db, "20261102", kubun);
    putShinryo(db, "20261102", "C001_1I", "114999999");
    return db;
  };

  it("診療年月の前後どちらかの 1 枚にしかないコード：条件つきで「前（後）の版にだけあります」。両方にあるコードには言わない", () => {
    const r = evaluateGeneric(claimOf([["SI", HOUMON]], [["SI", OUSHIN]], [["SI", "114999999"]]), twoSheets(), about);
    expect(r.findings.map((f) => [f.codes[0], f.messageKey, f.certainty, f.params.name])).toEqual([
      [OUSHIN, "G01.only_before", "条件つき", r2026.points.C000.name],
      ["114999999", "G01.only_after", "条件つき", r2026.points.C001_1I.name],
    ]);
    expect(genericText(r.findings[0])).toContain("診療年月の前の版にだけあります");
    expect(genericText(r.findings[1])).toContain("診療年月の後の版にだけあります");
    // 画面に出す形：名称は、指摘の値（そのコードがあった 1 枚の名称）から
    expect(genericView(r, null).findings[0].codes).toEqual([{ code: OUSHIN, name: r2026.points.C000.name }]);
  });

  it("持っているのが診療年月より後の 1 枚だけのとき：その 1 枚にあるコードには言わない（変更年月日を、使い始めの日として使わない）", () => {
    const db = smallMasters(":memory:", "20261113");
    // 変更年月日が診療年月より後の医薬品（経過措置の期限を付けただけでも変わる）
    put(db, "iyakuhin", "20261113", { code: "630010003", name: "手作りの医薬品 2", changed_on: "20261113", keika_until: 20270331 });
    const r = evaluateGeneric(claimOf([["IY", "630010003"], ["IY", DRUG]], [["SI", HOUMON]]), db, about);
    expect([r.findings, r.ran.map((x) => x.check)]).toEqual([[], ["G01"]]);
    expect(evaluateGeneric(claimOf([["IY", UNKNOWN]]), db, about).findings.map((f) => f.messageKey)).toEqual(["G01.not_in_any"]);
  });

  it("診療年月に使う 1 枚にはなく、ほかの 1 枚（もっと前の版・別の世代の版）にだけあるコード：ある側を条件つきで言う", () => {
    const db = smallMasters();
    // 令和6年度の世代の 1 枚（5 月）にだけある、廃止されたコード
    source(db, "shinryo", "20260501", "R6");
    putShinryo(db, "20260501", "C000", "114888888");
    // 令和8年度の世代の、12 月と翌年 1 月の 2 枚。翌年 1 月にだけある新設のコード
    for (const s of ["20261201", "20270105"]) source(db, "shinryo", s);
    putShinryo(db, "20270105", "C000", "114777777");
    const r = evaluateGeneric(claimOf([["SI", "114888888"]], [["SI", "114777777"]]), db, about);
    expect(r.findings.map((f) => [f.codes[0], f.messageKey])).toEqual([["114888888", "G01.only_before"], ["114777777", "G01.only_after"]]);
  });

  it("G01 の文は、どれも言い切らない（「できません」「超えています」と書かない）。確かめることを書く", () => {
    const g01 = Object.entries(GENERIC_TEXT).filter(([k]) => k.startsWith("G01."));
    expect(g01.map(([k]) => k).sort()).toEqual(["G01.not_in_any", "G01.only_after", "G01.only_before"]);
    for (const [, text] of g01) {
      expect(text).not.toMatch(/できません|超えています|使えません/);
      expect(text).toMatch(/確かめてください$/);
    }
  });
});

describe("名称（design.md §12-5）", () => {
  it("診療年月に使う 1 枚から、行（診療行為は区分番号も）・コメント・傷病名の名称を引く。マスターにないコードは載らない", () => {
    const names = rowNamesOf(smallMasters(), about, {
      items: [{ kind: "SI", code: HOUMON }, { kind: "SI", code: r2026.codes["C002-2_2I1"].primary }, { kind: "IY", code: DRUG }, { kind: "TO", code: DEVICE }, { kind: "SI", code: UNKNOWN }, { kind: "IY", code: HOUMON }],
      comments: [COMMENT, "820000000"],
      diseases: [DISEASE, "0000000"],
    });
    expect(names).toEqual({
      items: {
        [HOUMON]: { name: r2026.points.C001_1I.name, no: "C001" },
        [r2026.codes["C002-2_2I1"].primary]: { name: r2026.points["C002-2_2I1"].name, no: "C002-2" },
        [DRUG]: { name: "手作りの医薬品", no: null },
        [DEVICE]: { name: "手作りの特定器材", no: null },
      },
      comments: { [COMMENT]: "手作りのコメントの定型文" },
      diseases: { [DISEASE]: "手作りの傷病名" },
    });
  });

  it("使う 1 枚についての断り書き：診療年月より後の 1 枚で代えているマスターと、読み方を確かめた版より新しい 1 枚のマスターを挙げる", () => {
    const all = ["医科診療行為", "医薬品", "特定器材", "コメント", "傷病名"];
    expect(sheetNotesOf(smallMasters(), about)).toEqual({ later: [], newer: [] });
    const later = smallMasters(":memory:", "20261113");
    expect(sheetNotesOf(later, about)).toEqual({ later: all, newer: [] });
    later.prepare("UPDATE sources SET verified = '20261102' WHERE dataset IN ('shinryo', 'iyakuhin')").run();
    expect(sheetNotesOf(later, about)).toEqual({ later: all, newer: ["医科診療行為", "医薬品"] });
    expect(sheetNotesOf(later, { yearMonth: YM, generation: "R6" })).toEqual({ later: [], newer: [] });
  });

  it("診療年月の世代の 1 枚がないマスターの分は、空（近い世代で代用しない）", () => {
    expect(rowNamesOf(smallMasters(), { yearMonth: YM, generation: "R6" }, { items: [{ kind: "SI", code: HOUMON }], comments: [COMMENT], diseases: [DISEASE] })).toEqual({ items: {}, comments: {}, diseases: {} });
  });
});

describe("対象外の単位のコードを引いて、エンジンに渡す（design.md §12-4）", () => {
  const db = smallMasters();
  // 訪問診療料(Ⅱ) のような、訪問診療料と同じ区分番号（C001）で枝番の違う別コードと、関係のない区分（D026 の、表にない判断料のつもり）のコード
  put(db, "shinryo", "20261001", { code: "114999999", name: "手作りの別コード", alpha: "C", sho: 2, bu: 2, kubun_no: 1, eda: 2 });
  put(db, "shinryo", "20261001", { code: "160999999", name: "手作りの判断料", alpha: "D", sho: 2, bu: 3, kubun_no: 999 });

  it("医科診療行為にあるコードは区分番号つき（枝番は入れない）、医薬品・特定器材は区分番号なし、どれにもないコードは「マスターにない」", () => {
    const o = outsideOf(db, r2026, YM, ["114999999", DRUG, DEVICE, UNKNOWN, DRUG])!;
    expect(o.codes).toEqual([
      { code: "114999999", known: true, no: "2/2/1" },
      { code: DRUG, known: true, no: null },
      { code: DEVICE, known: true, no: null },
      { code: UNKNOWN, known: false, no: null },
    ]);
    expect(o.noOf.C001_1I).toEqual(["2/2/1"]);
    expect(o.noOf["C002-2_2I1"]).toEqual(o.noOf.C002_2I1);
    // 包括の検査の区分は、項目のコードの区分番号。小さな表には項目がないので、載らない（その区分を読むルールは、対象外の単位があれば止まる）
    expect(Object.hasOwn(o.noOf, "D007_5")).toBe(false);
    expect(Object.keys(r2026.codes).filter((k) => !Object.hasOwn(o.noOf, k))).toEqual([]);
  });

  it("医科診療行為マスターの、診療年月の世代の 1 枚がなければ、渡さない（エンジンは、どのルールも止める）", () => {
    expect(outsideOf(db, { ...r2026, generation: "R6" }, YM, [DRUG])).toBeUndefined();
  });

  const K1 = loadCase("K1");
  const r01 = (codes: string[]) => evaluate({ ...without(K1, "C001_1I"), partial: true, outside: outsideOf(db, r2026, YM, codes) }).findings.filter((f) => f.ruleId === "R01");

  it("訪問診療料のない月の在医総管：対象外の行が、関係のない区分番号の行・医薬品・特定器材なら、R01 の「訪問診療料のない月」が出る", () => {
    expect(r01(["160999999", DRUG, DEVICE]).map((f) => f.messageKey)).toEqual(["R01.no_visit"]);
  });

  it("対象外の行に、訪問診療料と同じ区分番号の別コードがあれば、R01 は決められない。マスターにないコードがあっても同じ", () => {
    expect(r01(["114999999"]).map((f) => f.missing?.field)).toEqual(["unsupportedLines"]);
    expect(r01([DRUG, UNKNOWN]).map((f) => f.missing?.field)).toEqual(["unsupportedLines"]);
  });
});
