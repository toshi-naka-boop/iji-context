// 施設の申告の三値（src/facility/declaration.ts。design.md §15-2・§15-10 の段 17b）。純関数だけを見る（DB・時計は使わない）
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { facilityOf, type FacilityJson } from "../../src/engine/facility";
import { declarationView, dispensingOf, effectiveRow, facilityFromDeclaration, heldOf, type DeclarationRow } from "../../src/facility/declaration";
import facilityConfig from "../../config/facility.json";
import { loadCase } from "../engine/helpers";
import { day, month, YM } from "../helpers/period";

/** 基準月の翌月・前月 */
const NEXT = month(1);
const PREV = month(-1);
/** 今日（基準月の 13 日） */
const TODAY = day(13);
const LATER = "2099-12-31";

let nextId = 1;
/** 申告の 1 行。既定は「前月から・届出あり・要件を満たす・算定開始は前月の初日・確かめた日は今日・確かめ直す日はずっと先」 */
function row(itemKey: string, over: Partial<DeclarationRow> = {}): DeclarationRow {
  return { id: nextId++, itemKey, fromMonth: PREV, notified: "yes", notifiedOn: null, startOn: `${PREV}-01`, requirement: "met", choice: null, checkedBy: "事務長", checkedRole: "manager", checkedOn: TODAY, recheckOn: LATER, source: "input", createdAt: "", ...over };
}
const tri = (rows: DeclarationRow[], code: string, on: { yearMonth: string; day?: string }, today = TODAY) => heldOf(rows, code, on, today);
const M = { yearMonth: YM };

describe("三値の各理由", () => {
  it("持つ：届出あり・要件を満たす・確かめ直す日が今日以降・算定開始年月日が算定日以前", () => {
    expect(tri([row("code:4102")], "4102", { yearMonth: YM, day: day(5) })).toEqual({ v: "held" });
    expect(tri([row("code:4102")], "4102", M)).toEqual({ v: "held" });
  });
  it("分からない：一覧にない／確かめた日・確かめ直す日が空／確かめ直す日を過ぎた／届出・要件が分からない／算定開始年月日が空", () => {
    expect(tri([], "4102", M)).toEqual({ v: "unknown", reason: "no_row" });
    expect(tri([row("code:4102", { checkedOn: null })], "4102", M)).toEqual({ v: "unknown", reason: "no_check_date" });
    expect(tri([row("code:4102", { recheckOn: null })], "4102", M)).toEqual({ v: "unknown", reason: "no_check_date" });
    expect(tri([row("code:4102", { recheckOn: day(12) })], "4102", M)).toEqual({ v: "unknown", reason: "expired" });
    // 確かめ直す日が今日なら、まだ過ぎていない
    expect(tri([row("code:4102", { recheckOn: TODAY })], "4102", M)).toEqual({ v: "held" });
    expect(tri([row("code:4102", { notified: "unknown" })], "4102", M)).toEqual({ v: "unknown", reason: "notified_unknown" });
    expect(tri([row("code:4102", { requirement: "unknown" })], "4102", M)).toEqual({ v: "unknown", reason: "requirement_unknown" });
    expect(tri([row("code:4102", { startOn: null })], "4102", M)).toEqual({ v: "unknown", reason: "no_start_on" });
  });
  it("持たない：届出なし／要件を満たさない", () => {
    expect(tri([row("code:4102", { notified: "no", startOn: null })], "4102", M)).toEqual({ v: "not", reason: "notified_no" });
    expect(tri([row("code:4102", { requirement: "not_met" })], "4102", M)).toEqual({ v: "not", reason: "requirement_not_met" });
  });
  it("在支病のコードは、一覧になくても申告によらず「持たない」", () => {
    for (const c of ["3057", "3058", "3169"]) expect(tri([], c, M)).toEqual({ v: "not", reason: "hospital" });
  });
  it("表 4 の病院の側のコード（4249・3341・3474）は、申告によらず「持たない」", () => {
    for (const c of ["4249", "3341", "3474"]) {
      expect(tri([], c, M)).toEqual({ v: "not", reason: "hospital" });
      expect(tri([row(`code:${c}`)], c, M)).toEqual({ v: "not", reason: "hospital" });
    }
  });
  it("種別が分からないときは zaishishin・kyokagata・hasBeds も null（config の値を残さない）", () => {
    for (const rows of [[], [row("grade", { choice: "unknown" })], [row("grade", { choice: "zaishishin3", recheckOn: day(1) })]]) {
      expect(facilityFromDeclaration(rows, TODAY, YM)).toMatchObject({ grade: null, zaishishin: null, kyokagata: null, hasBeds: null });
    }
  });
  it("種別から決まるコード：種別が持たないコードは「持たない」、種別の要件を満たさないと申告されたら「分からない」（種別を直す）", () => {
    const g = (over: Partial<DeclarationRow>) => [row("grade", { choice: "zaishishin3", ...over })];
    expect(tri(g({}), "3168", M)).toEqual({ v: "held" });
    for (const c of ["3055", "4247", "3056"]) expect(tri(g({}), c, M)).toEqual({ v: "not", reason: "grade_lacks" });
    expect(tri(g({ requirement: "not_met" }), "3168", M)).toEqual({ v: "unknown", reason: "grade_requirement_not_met" });
    expect(facilityFromDeclaration(g({ requirement: "not_met" }), TODAY, YM).grade).toBeNull();
    expect(tri(g({ choice: "unknown" }), "3168", M)).toEqual({ v: "unknown", reason: "grade_unknown" });
    // 在支診以外は届出がないので、算定開始年月日を見ずにどのコードも「持たない」
    expect(tri(g({ choice: "outside", startOn: null, notified: "no" }), "3168", M)).toEqual({ v: "not", reason: "grade_lacks" });
    expect(facilityFromDeclaration(g({ choice: "outside", startOn: null, notified: "no" }), TODAY, YM)).toMatchObject({ grade: "3", zaishishin: false, kyokagata: false });
    expect(tri([], "3168", M)).toEqual({ v: "unknown", reason: "no_row" });
  });
});

describe("決める順（X-141）", () => {
  it("確かめ直す日を過ぎた「届出なし」は「分からない（確かめ直す日を過ぎた）」で、「持たない」にならない", () => {
    expect(tri([row("code:4102", { notified: "no", startOn: null, recheckOn: day(1) })], "4102", M)).toEqual({ v: "unknown", reason: "expired" });
  });
  it("確かめ直す日が空の「要件を満たさない」も、期限切れで算定日が算定開始年月日より前の行も「分からない」", () => {
    expect(tri([row("code:4102", { requirement: "not_met", recheckOn: null })], "4102", M)).toEqual({ v: "unknown", reason: "no_check_date" });
    expect(tri([row("code:4102", { startOn: day(20), recheckOn: day(1) })], "4102", { yearMonth: YM, day: day(5) })).toEqual({ v: "unknown", reason: "expired" });
  });
  it("code:4100 を期限切れの「届出なし」にすると dxTier は分からない。R12 は dx_not_notified ではなく情報不足（facility.dxTier）", () => {
    const expired = [row("code:4100", { notified: "no", startOn: null, recheckOn: day(1) })];
    expect(facilityFromDeclaration(expired, TODAY, YM).dxTier).toBeNull();
    // 期限内の「届出なし」なら「なし」（R12 の dx_not_notified）
    expect(facilityFromDeclaration([row("code:4100", { notified: "no", startOn: null })], TODAY, YM).dxTier).toBe("なし");
    const { demoDeclaration: _d, recheckNoticeDays: _n, recheckDefaultMonths: _m, ...config } = facilityConfig;
    const k1 = loadCase("K1");
    const r12 = (decl: DeclarationRow[]) =>
      evaluate({ ...k1, facility: facilityOf({ ...(config as unknown as FacilityJson), ...facilityFromDeclaration(decl, TODAY, YM) }) })
        .findings.filter((f) => f.ruleId === "R12")
        .map((f) => `${f.kind}:${f.messageKey ?? ""}:${f.missing?.field ?? ""}`);
    expect(r12(expired).length).toBeGreaterThan(0);
    expect(r12(expired).every((s) => s.startsWith("情報不足:") && s.endsWith(":facility.dxTier"))).toBe(true);
    expect(r12([row("code:4100", { notified: "no", startOn: null })]).some((s) => s.includes("dx_not_notified"))).toBe(true);
    expect(r12([row("code:4100", { choice: "1" })])).toEqual([]);
  });
});

describe("算定開始年月日と算定日（C-217・C-223）", () => {
  it("算定開始年月日が行の算定日より後で「持たない」、同じ日なら「持つ」", () => {
    const rows = [row("code:4102", { startOn: day(15) })];
    expect(tri(rows, "4102", { yearMonth: YM, day: day(14) })).toEqual({ v: "not", reason: "before_start", startOn: day(15) });
    expect(tri(rows, "4102", { yearMonth: YM, day: day(15) })).toEqual({ v: "held" });
  });
  it("算定日が 2 日の単位（5 日・19 日）：算定開始 15 日なら 5 日が「持たない」（5 日を添える）、1 日なら両方「持つ」、片方の日だけ分からないなら「分からない」", () => {
    const view = (startOn: string) => declarationView([row("code:4102", { startOn })], TODAY);
    const days = [day(5), day(19)];
    expect(days.map((d) => view(day(15)).held("4102", { yearMonth: YM, day: d }).v)).toEqual(["not", "held"]);
    expect(days.map((d) => view(day(1)).held("4102", { yearMonth: YM, day: d }).v)).toEqual(["held", "held"]);
    // 効く行は診療年月で選び、算定日は効く行の算定開始年月日と比べるだけ（月の途中で行が替わらない。v30 P-2）
    const rows = [row("code:4102", { notified: "unknown", startOn: null }), row("code:4102", { startOn: day(10) })];
    expect(days.map((d) => heldOf(rows, "4102", { yearMonth: YM, day: d }, TODAY).v)).toEqual(["not", "held"]);
  });
  it("算定日の分からない単位（月で比べる）で算定開始が月の途中なら「分からない」。初日以前なら「持つ」、末日より後なら「持たない」", () => {
    expect(tri([row("code:4102", { startOn: day(15) })], "4102", M)).toEqual({ v: "unknown", reason: "mid_month_start" });
    expect(tri([row("code:4102", { startOn: day(1) })], "4102", M)).toEqual({ v: "held" });
    expect(tri([row("code:4102", { startOn: `${NEXT}-01` })], "4102", M)).toEqual({ v: "not", reason: "before_start", startOn: `${NEXT}-01` });
  });
  it("届出日が月の途中でも、月の初日に倒さない（届出日は判定に使わない）", () => {
    const rows = [row("code:4102", { notifiedOn: day(20), startOn: day(1) })];
    expect(tri(rows, "4102", M)).toEqual({ v: "held" });
    expect(tri(rows, "4102", { yearMonth: YM, day: day(5) })).toEqual({ v: "held" });
    expect(tri([row("code:4102", { notifiedOn: day(1), startOn: day(20) })], "4102", { yearMonth: YM, day: day(5) })).toEqual({ v: "not", reason: "before_start", startOn: day(20) });
  });
});

describe("いつの診療月からつきの履歴から効く行を選ぶ（C-215 を v30 で改める。P-2）", () => {
  it("種別を (3) から単独型へ、翌月から・算定開始 翌月 1 日で月末前に入れても、今月は (3)、翌月は単独型で判定される", () => {
    const rows = [row("grade", { choice: "zaishishin3" }), row("grade", { choice: "solo_nobeds", fromMonth: NEXT, startOn: `${NEXT}-01` })];
    expect(effectiveRow(rows, "grade", YM)?.row.choice).toBe("zaishishin3");
    expect(facilityFromDeclaration(rows, TODAY, YM)).toMatchObject({ grade: "2", zaishishin: true, kyokagata: false });
    expect(facilityFromDeclaration(rows, TODAY, NEXT)).toMatchObject({ grade: "1N", zaishishin: true, kyokagata: true, hasBeds: false });
    expect([tri(rows, "3168", M).v, tri(rows, "3055", M).v]).toEqual(["held", "not"]);
    expect([tri(rows, "3168", { yearMonth: NEXT }).v, tri(rows, "3055", { yearMonth: NEXT }).v]).toEqual(["not", "held"]);
  });
  it("前の行の確かめ直す日が今日より前でも、後の行を残した日より後なら、前の月は「持つ」", () => {
    // 前の行の確かめ直す日は 20 日。後の行は 18 日に残した。今日は翌月の 3 日
    const today = `${NEXT}-03`;
    const rows = [row("grade", { choice: "zaishishin3", recheckOn: day(20) }), row("grade", { choice: "solo_nobeds", fromMonth: NEXT, startOn: `${NEXT}-01`, checkedOn: day(18) })];
    expect(facilityFromDeclaration(rows, today, YM).grade).toBe("2");
    expect(facilityFromDeclaration(rows, today, NEXT).grade).toBe("1N");
    // 後の行を残した日が前の行の確かめ直す日より後なら、前の月は期限切れ（分からない）
    const late = [row("grade", { choice: "zaishishin3", recheckOn: day(20) }), row("grade", { choice: "solo_nobeds", fromMonth: NEXT, startOn: `${NEXT}-01`, checkedOn: day(25) })];
    expect(facilityFromDeclaration(late, today, YM).grade).toBeNull();
  });
  it("DX の加算2 → 加算1 でも同じ", () => {
    const rows = [row("code:4100", { choice: "2" }), row("code:4100", { choice: "1", fromMonth: NEXT, startOn: `${NEXT}-01` })];
    expect([facilityFromDeclaration(rows, TODAY, YM).dxTier, facilityFromDeclaration(rows, TODAY, NEXT).dxTier]).toEqual(["2", "1"]);
  });
  // v29（段 17b）は「算定開始年月日を持たない『届出なし』の行は、入れた時点から前の月にも効く（L-89）」を縛っていた。
  // v30 では、どの行も from_month より前の診療月には効かない（P-2・docs H-1）ので、期待を改めた
  it("算定開始年月日を持たない「届出なし」の行も、from_month より前の診療月には効かない（v30。L-89 の期待を改めた）", () => {
    const rows = [row("code:4100", { choice: "1" }), row("code:4100", { fromMonth: YM, notified: "no", startOn: null })];
    expect([facilityFromDeclaration(rows, TODAY, PREV).dxTier, facilityFromDeclaration(rows, TODAY, YM).dxTier]).toEqual(["1", "なし"]);
  });
  it("from_month が診療年月より後の行しかない項目は「分からない（その診療月の申告がない）」。算定開始年月日が先でも同じ月なら「持たない」", () => {
    expect(tri([row("code:4102", { fromMonth: NEXT, startOn: `${NEXT}-01` })], "4102", M)).toEqual({ v: "unknown", reason: "no_month_row" });
    expect(tri([row("code:4102", { fromMonth: YM, startOn: `${NEXT}-01` })], "4102", M)).toEqual({ v: "not", reason: "before_start", startOn: `${NEXT}-01` });
  });
  it("from_month が空の行（マイグレーション 13 の前に残した行）は効く行に選ばれず「分からない」", () => {
    expect(tri([row("code:4102", { fromMonth: null })], "4102", M)).toEqual({ v: "unknown", reason: "no_from_month" });
    expect(facilityFromDeclaration([row("note16", { fromMonth: null, notified: "na", startOn: null })], TODAY, YM).note16Met).toBeNull();
  });
});

describe("判定に渡す形", () => {
  it("ベースアップ：4303 を持つ → 注5、4307 だけ → 通常、4307 を持たない → なし、どちらかが分からない → 分からない", () => {
    const b = (n4307: Partial<DeclarationRow>, n4303: Partial<DeclarationRow>) => facilityFromDeclaration([row("code:4307", n4307), row("code:4303", n4303)], TODAY, YM).baseUp;
    const no = { notified: "no" as const, startOn: null };
    expect([b({}, {}), b({}, no), b(no, no), b({}, { notified: "unknown" }), b({ recheckOn: day(1) }, no)]).toEqual(["注5", "通常", "なし", null, null]);
  });
  it("注16：満たす・満たさない・分からない（算定開始年月日を見ない）", () => {
    const n = (o: Partial<DeclarationRow>) => facilityFromDeclaration([row("note16", { notified: "na", startOn: null, ...o })], TODAY, YM).note16Met;
    expect([n({}), n({ requirement: "not_met" }), n({ requirement: "unknown" }), n({ recheckOn: day(1) })]).toEqual([true, false, null, null]);
  });
  it("申告がなければ、種別・注16・DX・ベースアップはどれも分からない（config の既定値を使わない）", () => {
    expect(facilityFromDeclaration([], TODAY, YM)).toEqual({ grade: null, gradeChoice: null, note16Met: null, dxTier: null, baseUp: null, zaishishin: null, kyokagata: null, hasBeds: null });
    const { demoDeclaration: _d, recheckNoticeDays: _n, recheckDefaultMonths: _m, ...config } = facilityConfig;
    const f = facilityOf({ ...(config as unknown as FacilityJson), ...facilityFromDeclaration([], TODAY, YM) });
    expect([f.grade, f.note16Met, f.dxTier, f.baseUp]).toEqual([{ known: false }, { known: false }, { known: false }, { known: false }]);
  });
  it("dispensing の三値：院外処方だけ・院内処方もある・分からない（選んだ値か、期限切れ・日付なし・行なし）", () => {
    const d = (o: Partial<DeclarationRow>) => dispensingOf([row("dispensing", { notified: "na", startOn: null, ...o })], TODAY, YM);
    expect([d({ choice: "outside" }), d({ choice: "inside" }), d({ choice: "unknown" }), d({ choice: "inside", recheckOn: day(1) }), d({ choice: "inside", checkedOn: null }), dispensingOf([], TODAY, YM)]).toEqual(["outside", "inside", "unknown", "unknown", "unknown", "unknown"]);
  });
  it("dispensingOf は診療年月で効く行を選ぶ（今日の日では選ばない）", () => {
    const rows = [row("dispensing", { notified: "na", startOn: null, choice: "inside" }), row("dispensing", { notified: "na", startOn: null, fromMonth: NEXT, choice: "outside" })];
    expect([dispensingOf(rows, TODAY, PREV), dispensingOf(rows, TODAY, YM), dispensingOf(rows, TODAY, NEXT)]).toEqual(["inside", "inside", "outside"]);
  });
  it("名称：表 4 にあるコードは別紙7-8 の名称、ないコードは null（推測で名前を付けない）", () => {
    const v = declarationView([], TODAY);
    expect([v.nameOf("4100"), v.nameOf("3169"), v.nameOf("9999")]).toEqual(["在宅医療ＤＸ情報活用加算", "在宅療養支援病院（１）（２）（３）", null]);
  });
});
