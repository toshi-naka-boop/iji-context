// 段 17e（design.md §15-5・§15-10）：G10（全項目の施設基準）、手書きのルール（R18・R12）との重なり、行の印、点検の範囲、正しい側（L-91）。
// データは同梱しないので、手で作った数行の masters.db（tests/generic/small-masters.ts）に、施設基準の組の列を入れて作る。
// 組の値は EM §2-11 表 2 の錨（A84・A110・A112・A113・A115）のもの。正しい側の兄弟の行は、区分番号の鍵と施設基準の組だけを手で合わせた作り物
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext, ClaimLine, Facility } from "../../src/engine/types";
import { declarationView, type DeclarationRow, type DeclarationView } from "../../src/facility/declaration";
import { evaluateGeneric } from "../../src/generic";
import { g10, g10MarksOf, g10NotDone, sidelessOf } from "../../src/generic/g10";
import { rowNamesOf } from "../../src/generic/lookup";
import { claimOfLines, overlap } from "../../src/generic/overlap";
import { genericScopeOf } from "../../src/generic/scope";
import type { GenericAbout, GenericClaim, GenericFinding } from "../../src/generic/types";
import { genericView } from "../../src/generic/view";
import { loadCase } from "../engine/helpers";
import { day, month, YM } from "../helpers/period";
import { smallMasters } from "./small-masters";

const REV = resolveRevision(YM);
const code = (kubun: string) => REV.codes[kubun].primary;
/** 錨 A110（在医総管・在支診・重症・1人）、A84（在宅医療DX情報活用加算1）、A115（ベースアップ評価料(Ⅰ) 訪問診療時イ の注5）と、その通常の側 */
const KANRI = code("C002_2I1");
const DX = code("C001_N13_DX");
const DX2 = code("C001_N13_DX2");
const BASEUP = code("O001_3I");
const BASEUP5 = code("O001_3I_N5");
/** 錨 A113 の名寄せ（訪問診療料の逓減の行。版の表にないので、ここでは訪問診療料の行に組を置いた作り物）と、A112 の注14 */
const HOUMON = code("C001_1I");
const OUSHIN = code("C000");

const PREV = month(-1);
const TODAY = day(13);
let nextId = 1;
/** 申告の 1 行。既定は「前月から・届出あり・要件を満たす・算定開始は前月の初日・確かめた日は今日・確かめ直す日はずっと先」 */
function row(itemKey: string, over: Partial<DeclarationRow> = {}): DeclarationRow {
  return { id: nextId++, itemKey, fromMonth: PREV, notified: "yes", notifiedOn: null, startOn: `${PREV}-01`, requirement: "met", choice: null, checkedBy: "事務長", checkedRole: "manager", checkedOn: TODAY, recheckOn: "2099-12-31", source: "input", createdAt: "", ...over };
}
const view = (rows: DeclarationRow[]): DeclarationView => declarationView(rows, TODAY);
/** デモの種に近い申告：在支診（(3)）・721 あり・4100 加算1・4307 あり・4303 なし */
const BASE = () => [row("grade", { choice: "zaishishin3" }), row("code:721"), row("code:4100", { choice: "1" }), row("code:4307"), row("code:4303", { notified: "no", startOn: null })];

/** 手作りの masters.db に、施設基準の組の列と G10 の準備を入れる */
function mastersWithKijun(): Database.Database {
  const db = smallMasters();
  const set = (c: string, g1: string, g2 = "0", g3 = "0") => db.prepare("UPDATE shinryo SET shisetsu_g1 = ?, shisetsu_g2 = ?, shisetsu_g3 = ? WHERE code = ?").run(g1, g2, g3, c);
  set(KANRI, "3168/3169/3056", "721");
  set(DX, "4100");
  set(BASEUP, "4307");
  set(BASEUP5, "4303");
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G10', 1, '')").run();
  return db;
}
const aboutOf = (rows: DeclarationRow[] | null): GenericAbout => ({ yearMonth: YM, generation: REV.generation, ...(rows ? { declaration: view(rows), sideless: sidelessOf(REV) } : {}) });
const claimOf = (...units: { code: string; days?: number[] }[]): GenericClaim =>
  ({ units: units.map((u) => ({ items: [{ kind: "SI" as const, code: u.code }], ...(u.days ? { days: Array.from({ length: 31 }, (_, i) => (u.days!.includes(i + 1) ? 1 : 0)) } : {}) })) }) as GenericClaim;
const runG10 = (db: Database.Database, claim: GenericClaim, rows: DeclarationRow[] | null) => g10.run(claim, db, aboutOf(rows));
const keys = (fs: GenericFinding[] | { skip: string }) => (Array.isArray(fs) ? fs.map((f) => `${f.messageKey}:${f.codes[0]}:${f.params.kijunCodes}`) : fs);

describe("G10 の三値（合成の請求）", () => {
  it("申告で持たない → G10.not_held、持つ → 消える、分からない・確かめ直す日を過ぎた → G10.unknown（0 件にならない）", () => {
    const db = mastersWithKijun();
    const c = claimOf({ code: DX });
    expect(keys(runG10(db, c, BASE()))).toEqual([]);
    const no = runG10(db, c, [row("code:4100", { notified: "no", startOn: null })]) as GenericFinding[];
    expect(keys(no)).toEqual([`G10.not_held:${DX}:4100`]);
    expect(no[0].params.reason).toBe("届出なし");
    for (const rows of [[], [row("code:4100", { notified: "unknown" })], [row("code:4100", { choice: "1", recheckOn: day(12) })]]) expect(keys(runG10(db, c, rows))).toEqual([`G10.unknown:${DX}:4100`]);
    const expired = (runG10(db, c, [row("code:4100", { choice: "1", recheckOn: day(12) })]) as GenericFinding[])[0];
    expect(expired.params.reason).toBe("確かめ直す日を過ぎた");
    // 文は「施設の申告による」で終わり、「問題なし」とは言わない（FR-190）
    const v = genericView({ findings: [expired], ran: [], notRun: [] }, null).findings[0];
    expect(v.text).toBe(`${expired.params.name}（コード ${DX}）に要る施設基準「在宅医療ＤＸ情報活用加算」（4100）の申告が確かめ直す日を過ぎたので、算定できるかは言えません。施設の申告で入れてください（施設の申告による）`);
    // 施設の申告の確認の入口：確かめ直す日を過ぎた項目は、その診療月で効く行を選んだ「変わりなし」を開ける（design.md §15-9。round-53 C-274）
    expect(v.declaration).toEqual({ month: YM, items: [{ item: "code:4100", reconfirm: true }] });
    expect(genericView({ findings: no, ran: [], notRun: [] }, null).findings[0].declaration).toEqual({ month: YM, items: [{ item: "code:4100", reconfirm: false }] });
  });

  it("組の中は「どれか」、組のあいだは「どれも」。在支病のコードは持たないが、組のほかのコードで決まる。種別で決まるコードの入口は種別の行", () => {
    const db = mastersWithKijun();
    const c = claimOf({ code: KANRI });
    expect(keys(runG10(db, c, BASE()))).toEqual([]);
    // 組①（3168/3169/3056）を持たない：機能強化型の申告
    const strong = runG10(db, c, [row("grade", { choice: "solo_nobeds" }), row("code:721")]) as GenericFinding[];
    expect(keys(strong)).toEqual([`G10.not_held:${KANRI}:3168/3169/3056`]);
    // 在支病のコード（3169）は文に出さない（組のほかのコードで決まる。§15-3）
    expect(strong[0].params.kijun).toBe("「在宅療養支援診療所（３）」（3168）・「在宅療養支援診療所（２）のイ」（3056）のどれか");
    expect(JSON.parse(strong[0].params.decl).items).toEqual([{ item: "grade", reconfirm: false }]);
    // 組②（721）だけを持たない
    expect(keys(runG10(db, c, [row("grade", { choice: "zaishishin3" }), row("code:721", { notified: "no", startOn: null })]))).toEqual([`G10.not_held:${KANRI}:721`]);
    // 組①が持たない・組②が分からない → 持たない（持たない組を言う）
    expect(keys(runG10(db, c, [row("grade", { choice: "solo_nobeds" })]))).toEqual([`G10.not_held:${KANRI}:3168/3169/3056`]);
  });

  it("算定日ごとに比べる：算定開始年月日より前の算定日があれば持たない（その日を添える）、全部の日で持てば言わない（C-217）", () => {
    const db = mastersWithKijun();
    const c = claimOf({ code: DX, days: [5, 19] });
    const late = runG10(db, c, [row("code:4100", { choice: "1", fromMonth: YM, startOn: day(15) })]) as GenericFinding[];
    expect(keys(late)).toEqual([`G10.not_held:${DX}:4100`]);
    expect(late[0].params.reason).toBe(`算定開始年月日（${day(15)}）より前の算定日（${Number(YM.slice(5))}月5日）`);
    expect(keys(runG10(db, c, [row("code:4100", { choice: "1", fromMonth: YM, startOn: day(1) })]))).toEqual([]);
    // 算定日の分からない単位で、算定開始が月の途中 → 分からない
    expect(keys(runG10(db, claimOf({ code: DX }), [row("code:4100", { choice: "1", fromMonth: YM, startOn: day(15) })]))).toEqual([`G10.unknown:${DX}:4100`]);
  });

  it("名寄せ（8032）は 4 つに開く。注14 の基準（4101）を含む行は判定せず、点検の範囲に数を出す", () => {
    const db = mastersWithKijun();
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '8032/3057/3058/3169' WHERE code = ?").run(HOUMON);
    db.prepare("UPDATE shinryo SET shisetsu_g1 = '3055/4247/3057/3058', shisetsu_g2 = '721', shisetsu_g3 = '4101' WHERE code = ?").run(OUSHIN);
    const c = claimOf({ code: HOUMON }, { code: OUSHIN });
    // 在支診（(3)）は 8032 の名寄せ元（3168）なので持つ。注14 の行は、どの申告でも言わない
    expect(keys(runG10(db, c, BASE()))).toEqual([]);
    const outside = runG10(db, c, [row("grade", { choice: "outside" }), row("code:721")]) as GenericFinding[];
    expect(keys(outside)).toEqual([`G10.not_held:${HOUMON}:3055/4247/3056/3168/3057/3058/3169`]);
    expect(g10NotDone(c, db, aboutOf([row("grade", { choice: "outside" }), row("code:721")]))).toEqual(["施設基準の要る行：1 行（申告で持つ 0・持たない 1・分からない 0）", "注14 の基準の行は見ていません：1 行",
      // 手作りの表では、同じ区分番号の鍵（C001）に施設基準のない行が並ぶので、正しい側は 1 つに決まらない
      "正しい側をマスターで 1 つに決められなかった行：1 行（見ていません）",
    ]);
  });

  it("施設の申告を渡さない呼び出し（試算・measure-generic の既定）では動かない（理由つき）", () => {
    const db = mastersWithKijun();
    const r = evaluateGeneric(claimOf({ code: DX }), db, aboutOf(null));
    expect(r.notRun.find((n) => n.check === "G10")).toEqual({ check: "G10", kind: "施設基準", reason: "noSnapshot", detail: "施設の申告を渡していないので、施設基準は見ていません" });
  });
});

describe("手書きのルールと 2 回言わない（C-216）", () => {
  const K1 = loadCase("K1");
  const declared = (f: Facility, over: Partial<Facility>): Facility => ({ ...f, ...over });
  /** 行 lines の請求を手書きのルールと G10 に掛け、重なりの規則を通した G10 の指摘と、判定済みに数えた数 */
  function both(db: Database.Database, lines: ClaimLine[], facility: Partial<Facility>, rows: DeclarationRow[], more: Partial<ClaimContext> = {}) {
    const ctx: ClaimContext = { ...K1, lines, facility: declared(K1.facility, facility), ...more };
    const hand = evaluate(ctx);
    const { claim, mapped } = claimOfLines(lines, REV);
    const r = evaluateGeneric(claim, db, aboutOf(rows));
    const o = overlap(hand, REV, ctx.recordsKnown, mapped, r.findings);
    return { hand: hand.findings, g10: o.findings.filter((f) => f.check === "G10").map((f) => `${f.messageKey}:${f.codes[0]}:${f.params.kijunCodes}`), judged: o.judged };
  }
  const lineOf = (kubun: string): ClaimLine => ({ kubun, count: 1, dates: [day(14)] });

  it("機能強化型の申告で、在支診の在医総管のコードに R18 use_grade が出て、G10 は組①を言わない（spec の受け入れ条件 A）", () => {
    const db = mastersWithKijun();
    const rows = [row("grade", { choice: "solo_nobeds" }), row("code:721")];
    const r = both(db, [lineOf("C002_2I1")], { grade: { known: true, value: "1N" }, zaishishin: true, kyokagata: true, hasBeds: false }, rows);
    expect(r.hand.some((f) => f.messageKey === "R18.use_grade")).toBe(true);
    expect(r.g10).toEqual([]);
    expect(r.judged).toBe(1);
  });

  it("同じ行の表にないコード（721）は、担当のルールが言っても G10 が言う", () => {
    const db = mastersWithKijun();
    const rows = [row("grade", { choice: "solo_nobeds" }), row("code:721", { notified: "no", startOn: null })];
    const r = both(db, [lineOf("C002_2I1")], { grade: { known: true, value: "1N" }, zaishishin: true, kyokagata: true, hasBeds: false }, rows);
    // 組①（種別）は R18 が言うので出さず、組②（721）は G10 が言う
    expect(r.g10).toEqual([`G10.not_held:${KANRI}:721`]);
  });

  it("注5 の申告で、通常の 180725910 に R18 だけが言い、G10 は言わない（X-133）", () => {
    const db = mastersWithKijun();
    const rows = [row("code:4307", { notified: "no", startOn: null }), row("code:4303")];
    const r = both(db, [lineOf("O001_3I")], { baseUp: { known: true, value: "注5" } }, rows);
    expect(BASEUP).toBe("180725910");
    expect(r.hand.map((f) => f.messageKey)).toContain("R18.use_baseup_note5");
    expect(r.g10).toEqual([]);
  });

  it("4100 を届出なしにすると、在宅医療DX情報活用加算に R12 dx_not_notified だけが出る。分からない・期限切れでは R12 の情報不足だけ。R12 が partial で指摘を捨てたときは G10 が言う", () => {
    const db = mastersWithKijun();
    const dx = [lineOf("C001_N13_DX")];
    expect(DX).toBe("114746310");
    const no = both(db, dx, { dxTier: { known: true, value: "なし" } }, [row("code:4100", { notified: "no", startOn: null })]);
    expect(no.hand.filter((f) => f.ruleId === "R12").map((f) => f.messageKey)).toEqual(["R12.dx_not_notified"]);
    expect(no.g10).toEqual([]);
    for (const rows of [[row("code:4100", { notified: "unknown" })], [row("code:4100", { choice: "1", recheckOn: day(12) })]]) {
      const u = both(db, dx, { dxTier: { known: false } }, rows);
      expect(u.hand.filter((f) => f.ruleId === "R12").map((f) => `${f.kind}:${f.missing?.field}`)).toEqual(["情報不足:facility.dxTier"]);
      expect(u.g10).toEqual([]);
    }
    // 対象外の単位がある請求（partial）：R12 の dx_not_notified は捨てられ、情報不足（unsupportedLines）だけ → G10 が言う
    const partial = both(db, dx, { dxTier: { known: true, value: "なし" } }, [row("code:4100", { notified: "no", startOn: null })], { partial: true });
    expect(partial.hand.filter((f) => f.ruleId === "R12").map((f) => f.missing?.field ?? f.messageKey)).toEqual(["unsupportedLines"]);
    expect(partial.g10).toEqual([`G10.not_held:${DX}:4100`]);
  });
});

describe("正しい側（L-91）", () => {
  /** DX を元の行にして、同じ区分番号の鍵・同じ点数識別の兄弟の行を作り物で置く（施設基準の組だけを変える） */
  function siblings(groups: string[]): Database.Database {
    const db = mastersWithKijun();
    const key = { sho: 2, bu: 2, kubun_no: 1, eda: 0, kou: 9, point_kind: "3" };
    const put = db.prepare("UPDATE shinryo SET sho = ?, bu = ?, kubun_no = ?, eda = ?, kou = ?, point_kind = ?, shisetsu_g1 = ? WHERE code = ?");
    put.run(key.sho, key.bu, key.kubun_no, key.eda, key.kou, key.point_kind, "4100", DX);
    const others = [DX2, code("A_DENSHI_RENKEI")];
    groups.forEach((g, i) => put.run(key.sho, key.bu, key.kubun_no, key.eda, key.kou, key.point_kind, g, others[i]));
    return db;
  }
  const NO_DX = () => [row("code:4100", { notified: "no", startOn: null }), row("code:4102"), row("code:721")];

  it("申告を満たす行がちょうど 1 つなら、文にその行の名称とコードを添える（条件つきのまま。点数は書かない）", () => {
    const db = siblings(["4102"]);
    const f = (runG10(db, claimOf({ code: DX }), NO_DX()) as GenericFinding[])[0];
    expect(f.params.side).toBe(`。同じ区分番号で、申告の施設基準を満たす行は「${REV.points.C001_N13_DX2.name}」（${DX2}）です。算定できるかは確かめてください`);
    expect(genericView({ findings: [f], ran: [], notRun: [] }, null).findings[0].text).toContain(`（${DX2}）です。算定できるかは確かめてください`);
    expect(g10NotDone(claimOf({ code: DX }), db, aboutOf(NO_DX())).some((t) => t.startsWith("正しい側"))).toBe(false);
  });

  it("2 行あるとき・申告が分からない行が混じるときは添えず、点検の範囲に数を出す", () => {
    for (const groups of [["4102", "721"], ["4102", "3825"]]) {
      const db = siblings(groups);
      const f = (runG10(db, claimOf({ code: DX }), NO_DX()) as GenericFinding[])[0];
      expect([groups, f.params.side]).toEqual([groups, ""]);
      expect(g10NotDone(claimOf({ code: DX }), db, aboutOf(NO_DX()))).toContain("正しい側をマスターで 1 つに決められなかった行：1 行（見ていません）");
    }
  });

  it("版の区分（R18 の区分）の行には添えない", () => {
    const db = mastersWithKijun();
    // 在支診の在医総管と同じ鍵に、組①が 3055 の行（機能強化型の側）を置く
    const strong = code("C002_1N_I1");
    const k = db.prepare("SELECT sho, bu, kubun_no, eda, kou, point_kind FROM shinryo WHERE code = ?").get(KANRI) as Record<string, number | string>;
    db.prepare("UPDATE shinryo SET sho = ?, bu = ?, kubun_no = ?, eda = ?, kou = ?, point_kind = ?, shisetsu_g1 = '3055/4247', shisetsu_g2 = '721' WHERE code = ?").run(k.sho, k.bu, k.kubun_no, k.eda, k.kou, k.point_kind, strong);
    expect(sidelessOf(REV).has(KANRI)).toBe(true);
    const f = (runG10(db, claimOf({ code: KANRI }), [row("grade", { choice: "solo_nobeds" }), row("code:721")]) as GenericFinding[])[0];
    expect([f.messageKey, f.params.side]).toEqual(["G10.not_held", ""]);
    expect(g10NotDone(claimOf({ code: KANRI }), db, aboutOf([row("grade", { choice: "solo_nobeds" }), row("code:721")])).some((t) => t.startsWith("正しい側"))).toBe(false);
  });
});

describe("行の印と点検の範囲", () => {
  it("G10 が動いたときは、施設基準の要る行に「申告あり／申告では持たない／申告が分からない」の印を付け、「届出が要ります」に替える", () => {
    const db = mastersWithKijun();
    db.prepare("INSERT INTO checks_ready (check_id, ready, reason) VALUES ('G03', 1, '')").run();
    const c = claimOf({ code: DX }, { code: KANRI }, { code: BASEUP5 });
    const about = aboutOf(BASE());
    const marks = g10MarksOf(c, db, about);
    expect(marks).toEqual({ [DX]: "held", [KANRI]: "held", [BASEUP5]: "not" });
    const items = c.units.flatMap((u) => u.items);
    const withMarks = rowNamesOf(db, about, { items, comments: [], diseases: [] }, marks).items;
    expect([withMarks[DX], withMarks[BASEUP5]].map((x) => [x.kijun, x.todokede])).toEqual([["held", undefined], ["not", undefined]]);
    // G10 が動かないときは「届出が要ります」のまま
    expect(rowNamesOf(db, about, { items, comments: [], diseases: [] }).items[DX].todokede).toBe(true);
    expect(g10MarksOf(c, db, aboutOf(null))).toBeNull();
  });

  it("点検の範囲に、施設基準の要る行の数と三値の内訳を出す", () => {
    const db = mastersWithKijun();
    const c = claimOf({ code: DX }, { code: KANRI }, { code: BASEUP5 });
    const about = aboutOf([row("grade", { choice: "zaishishin3" }), row("code:721"), row("code:4303", { notified: "no", startOn: null })]);
    const r = evaluateGeneric(c, db, about);
    expect(genericScopeOf(c, db, about, r).notDone).toContain("施設基準の要る行：3 行（申告で持つ 1・持たない 1・分からない 1）");
  });
});
